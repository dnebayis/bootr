import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { pino } from 'pino';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, erc20Abi, getAddress, keccak256, parseAbiParameters, type Address, type Hex, type Log, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi, entryPoint07Address, type PackedUserOperation } from 'viem/account-abstraction';
import { getAddresses } from '@bootr/shared/addresses';
import { baseSepolia } from 'viem/chains';
import { loadConfig, type Config } from '../src/config.js';
import type { ChainContext } from '../src/chain.js';
import type { AgentRow, SupervisorContext } from '../src/context.js';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import type { AdminSigner } from '../src/admin-signer.js';
import type { KernelClient } from '../src/kernel.js';
import { enableDigest } from '../src/session-key.js';
import { MemoryStore } from '../src/memories.js';
import { SenderError, type SenderAccount, type SenderClient, type SenderInboxItem } from '../src/sender-client.js';
import type { IndexerClient } from '../src/indexer-client.js';
import { initialState } from '../src/runtime.js';
import { spenderAccount } from '../src/spender.js';

export const SESSION_PK: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const ADMIN_PK: Hex = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
export const SPENDER_MASTER: Hex = '0x7a9c0f1e2d3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5';
export const GUARDIAN: Address = '0x1000000000000000000000000000000000000001';
export const LAUNCHER: Address = '0x1000000000000000000000000000000000000002';
export const KERNEL: Address = '0x2000000000000000000000000000000000000002';
export const TOKEN: Address = '0x3000000000000000000000000000000000000003';
export const CREATOR: Address = '0x4000000000000000000000000000000000000004';
export const PAYTO: Address = '0x5000000000000000000000000000000000000005';
/** Placeholder deployment of the Bootr module that is still `null` in addresses.ts for the chain. */
export const SWAP_HELPER: Address = '0x6000000000000000000000000000000000000006';
/** RWAGMI v3 placeholders (no deployment on Base Sepolia; `RWAGMI_*_ADDRESS` in the test config). */
export const RWAGMI_LAUNCHER: Address = '0x7000000000000000000000000000000000000007';
export const RWAGMI_LP_LOCKER: Address = '0x8000000000000000000000000000000000000008';
/** Primary RWAGMI pool id of the test coin (`deploymentInfo(TOKEN).primaryPoolId`). */
export const POOL_ID: Hex = '0x9000000000000000000000000000000000000000000000000000000000000009';
export const SERVICE_KEY = 'test-service-key-0123456789abcdef0123456789';
/** The supervisor's own admin-API key (must differ from the sender and indexer keys). */
export const SUPERVISOR_KEY = 'test-supervisor-key-fedcba9876543210fedcba';
export const INDEXER_KEY = 'test-indexer-key-00112233445566778899aabbcc';
const base = getAddresses(84532);
export const ADDR = { ...base, bootr: { ...base.bootr, swapHelper: base.bootr.swapHelper ?? SWAP_HELPER } };
/** The spender EOA of the test agent (AGENT_ID = '7') under SPENDER_MASTER. */
export const SPENDER: Address = spenderAccount(SPENDER_MASTER, '7').address;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://test',
    CHAIN_ID: '84532',
    BASE_SEPOLIA_RPC_URL: 'http://rpc.test',
    BUNDLER_URL: 'http://bundler.test',
    SESSION_SIGNER_PRIVATE_KEY: SESSION_PK,
    SPENDER_MASTER_KEY: SPENDER_MASTER,
    ADMIN_PRIVATE_KEY: ADMIN_PK,
    BOOTR_LAUNCHER_ADDRESS: LAUNCHER,
    BOOTR_GUARDIAN_ADDRESS: GUARDIAN,
    RWAGMI_LAUNCHER_V3_ADDRESS: RWAGMI_LAUNCHER,
    RWAGMI_LOCKER_V3_ADDRESS: RWAGMI_LP_LOCKER,
    SENDER_URL: 'http://sender.test',
    SENDER_SERVICE_KEY: SERVICE_KEY,
    SUPERVISOR_SERVICE_KEY: SUPERVISOR_KEY,
    INDEXER_SERVICE_KEY: INDEXER_KEY,
    INFERENCE_PROVIDER_URL: 'http://inference.test',
    INFERENCE_PAYTO_ADDRESS: PAYTO,
    INDEXER_URL: 'http://indexer.test',
    ...overrides,
  });
}

export async function testDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)), migrationsTable: MIGRATIONS_TABLE, migrationsSchema: MIGRATIONS_SCHEMA });
  return { db, close: () => pglite.close() };
}

/** Controllable on-chain state for the mocked public client. */
export interface ChainState {
  usdc: bigint;
  /** USDC held by the agent's spender EOA. */
  spenderUsdc: bigint;
  /** `BootrCallPolicy.windowOf` state of the funding rule. */
  fundingWindow: { windowEnd: bigint; spent: bigint; windowSeconds: number; cap: bigint };
  weth: bigint;
  eth: bigint;
  /** Kernel's EntryPoint v0.7 deposit (its gas; `deposit + eth` is what the fee policy calls gas). */
  deposit: bigint;
  token: bigint;
  /** `RwagmiLpLockerV3.pendingQuote(poolId, kernel)`: fees credited to the pool, not settled to the kernel yet. */
  pendingWeth: bigint;
  /** `RwagmiLpLockerV3.claimableQuote(kernel, WETH)`: settled, payable balance. */
  claimableWeth: bigint;
  /** `RwagmiB20LauncherV3.deploymentInfo(token).primaryPoolId`; null = not an RWAGMI launch (zero pool id). */
  poolId: Hex | null;
  ethUsd: bigint; // 8 dp
  paused: boolean;
  logs: unknown[];
  blockNumber: bigint;
  calls: { fn: string; args: unknown[] }[];
  /** `validationConfig(vId).hook == guardian` (false = the permission is not installed: enable mode). */
  sessionInstalled: boolean;
  /** Kernel `currentNonce()` (valid nonce); a permission installed at nonce 1 is dead once this passes 1. */
  kernelNonce?: number;
  /** EntryPoint nonce sequence returned by `getNonce` (the key is taken from the call). */
  nonceSeq: bigint;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** Logs returned by `getTransactionReceipt`, keyed by lowercase tx hash. */
  receipts: Record<string, Log[]>;
  /** Unix seconds returned by `getBlock` for any block. */
  blockTimestamp: bigint;
  /** Chainlink `updatedAt` (unix seconds); defaults to `blockTimestamp` (fresh). */
  feedUpdatedAt?: bigint;
}

export function chainState(over: Partial<ChainState> = {}): ChainState {
  return {
    usdc: 50_000_000n,
    spenderUsdc: 20_000_000n,
    fundingWindow: { windowEnd: 1_792_843_200n + 86_400n, spent: 0n, windowSeconds: 86_400, cap: 50_000_000n },
    weth: 0n,
    eth: 0n,
    deposit: 1_000_000_000_000_000n, // 0.001 ETH: gas is healthy unless a test drains it
    token: 0n,
    pendingWeth: 0n,
    claimableWeth: 0n,
    poolId: POOL_ID,
    ethUsd: 3000_00000000n,
    paused: false,
    logs: [],
    blockNumber: 100n,
    calls: [],
    sessionInstalled: true,
    nonceSeq: 0n,
    fees: { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 100_000n },
    receipts: {},
    blockTimestamp: 1_792_843_200n, // 2026-10-24T12:00:00Z
    ...over,
  };
}

export function mockChain(state: ChainState): ChainContext {
  const publicClient = {
    chain: baseSepolia,
    async readContract(args: { address: Address; functionName: string; args?: unknown[] }) {
      state.calls.push({ fn: args.functionName, args: args.args ?? [] });
      const addr = getAddress(args.address);
      switch (args.functionName) {
        case 'balanceOf': {
          const holder = getAddress((args.args as Address[])[0]!);
          if (addr === ADDR.usdc) return holder === KERNEL ? state.usdc : holder === SPENDER ? state.spenderUsdc : 0n;
          if (addr === ADDR.weth) return state.weth;
          if (addr === entryPoint07Address) return holder === KERNEL ? state.deposit : 0n;
          return state.token;
        }
        case 'windowOf':
          return [state.fundingWindow.windowEnd, state.fundingWindow.spent, state.fundingWindow.windowSeconds, state.fundingWindow.cap];
        case 'deploymentInfo': {
          const zero = '0x0000000000000000000000000000000000000000' as const;
          const zeroId = `0x${'0'.repeat(64)}` as const;
          if (addr !== RWAGMI_LAUNCHER) throw new Error('deploymentInfo on an unexpected address');
          const launched = state.poolId !== null && getAddress((args.args as Address[])[0]!) === TOKEN;
          return { token: launched ? TOKEN : zero, creator: launched ? CREATOR : zero, hook: zero, locker: launched ? RWAGMI_LP_LOCKER : zero, primaryPoolId: launched ? state.poolId : zeroId, poolIds: launched ? [state.poolId] : [], adminMode: 0, state: launched ? 1 : 0 };
        }
        case 'pendingQuote': {
          if (addr !== RWAGMI_LP_LOCKER) throw new Error('pendingQuote on an unexpected address');
          const [id, recipient] = args.args as [Hex, Address];
          return id === state.poolId && getAddress(recipient) === KERNEL ? state.pendingWeth : 0n;
        }
        case 'claimableQuote': {
          if (addr !== RWAGMI_LP_LOCKER) throw new Error('claimableQuote on an unexpected address');
          const [recipient, currency] = args.args as [Address, Address];
          return getAddress(recipient) === KERNEL && getAddress(currency) === ADDR.weth ? state.claimableWeth : 0n;
        }
        case 'latestRoundData':
          // a fresh answer: `updatedAt` = the mocked block time (= the world's `now`), same round
          return [1n, state.ethUsd, state.blockTimestamp, state.feedUpdatedAt ?? state.blockTimestamp, 1n];
        case 'agentInfo':
          return { token: TOKEN, creator: CREATOR, lastActivity: 0n, dormancyPeriod: 1000, paused: state.paused };
        case 'isRegistered':
          return true;
        case 'name':
          return 'Test Coin';
        case 'symbol':
          return 'TEST';
        case 'validationConfig':
          return { nonce: 1, hook: state.sessionInstalled ? GUARDIAN : '0x0000000000000000000000000000000000000000' };
        case 'currentNonce':
          return state.kernelNonce ?? 1;
        case 'getNonce': {
          const [, key] = args.args as [Address, bigint];
          return (key << 64n) | state.nonceSeq;
        }
        case 'enableDigest': {
          const [kernel, permissionId, nonce, validatorData] = args.args as [Address, Hex, number, Hex];
          return enableDigest({ kernel, chainId: 84532, guardian: GUARDIAN, permissionId, nonce, validatorData });
        }
        case 'approvedEnableDigests':
          return true;
        default:
          throw new Error(`unmocked readContract ${args.functionName}`);
      }
    },
    async getBalance() {
      return state.eth;
    },
    async estimateFeesPerGas() {
      return { ...state.fees };
    },
    async call() {
      return { data: encodeFunctionResult({ abi: erc20Abi, functionName: 'transfer', result: true }) };
    },
    async getBlockNumber() {
      return state.blockNumber;
    },
    async getLogs() {
      const out = state.logs;
      state.logs = [];
      return out;
    },
    async getTransactionReceipt({ hash }: { hash: Hex }) {
      state.calls.push({ fn: 'getTransactionReceipt', args: [hash] });
      const logs = state.receipts[hash.toLowerCase()];
      if (!logs) throw new Error(`receipt ${hash} not found`);
      return { transactionHash: hash, status: 'success', logs };
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { number: blockNumber, timestamp: state.blockTimestamp };
    },
  } as unknown as ChainContext['publicClient'];
  return { chain: baseSepolia, chainId: 84532, publicClient, addresses: ADDR, launcher: LAUNCHER, guardian: GUARDIAN, ethUsdFeed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1', rwagmi: { launcher: RWAGMI_LAUNCHER, lpLocker: RWAGMI_LP_LOCKER } };
}

export interface MockSender {
  /** X accounts by agent id; null = every agent id reports the default connected account. */
  accounts: Record<string, SenderAccount & { connectedAt?: string }> | null;
  rebinds: { from: string; to: string; connectedBefore?: string }[];
  items: SenderInboxItem[];
  published: unknown[];
  publishStatus: 'sent' | 'held' | 'rejected';
  /** When set, `publish` answers 503 `consent_lookup_failed` (X unreachable for the consent check) with this retryAt. */
  consentLookupFails: string | null;
  /** Handles the sender considers opted out of @mentions (`policy:mention_opted_out`). */
  optedOutHandles: Set<string>;
  receipts: Record<string, { status: string; providerPostId?: string | null; error?: string | null }>;
  client: SenderClient;
}

export function mockSender(): MockSender {
  const m: MockSender = { accounts: null, rebinds: [], items: [], published: [], publishStatus: 'sent', consentLookupFails: null, optedOutHandles: new Set(), receipts: {}, client: null as unknown as SenderClient };
  let n = 9000;
  m.client = {
    /** Mirrors apps/sender/src/publish.ts: reply eligibility is required, opt-outs are enforced, consent lookups can fail transiently. */
    async publish(body: { actionId: string; text: string; replyTo?: string; replyEligibility?: { eligible: boolean; reason?: string } }) {
      if (m.consentLookupFails) throw new SenderError(503, 'consent_lookup_failed', { error: 'consent_lookup_failed', retryAt: m.consentLookupFails }, true, Date.parse(m.consentLookupFails));
      m.published.push(body);
      const reasons: string[] = [];
      if (body.replyTo && !body.replyEligibility?.eligible) reasons.push(`reply_not_eligible:${body.replyEligibility?.reason ?? 'missing_eligibility'}`);
      for (const h of body.text.match(/@([A-Za-z0-9_]+)/g) ?? []) if (m.optedOutHandles.has(h.slice(1).toLowerCase())) reasons.push('mention_opted_out');
      const status = reasons.length ? 'rejected' : m.publishStatus;
      const error = reasons.length ? `policy:${reasons[0]}` : m.publishStatus === 'rejected' ? 'policy:invalid_short_post' : null;
      const providerPostId = status === 'sent' ? String(++n) : null;
      m.receipts[body.actionId] = { status, providerPostId, error };
      return { status, providerPostId, receipt: { actionId: body.actionId, agentId: 'a', kind: body.replyTo ? 'reply' : 'post', status, providerPostId, error } };
    },
    async receipt(actionId: string) {
      const r = m.receipts[actionId];
      if (!r) throw Object.assign(new Error('not found'), { status: 404, code: 'not_found', name: 'SenderError' });
      return { actionId, agentId: 'a', kind: 'post', ...r };
    },
    async readMentions() {
      return { throttled: false, items: m.items };
    },
    async readThread() {
      return { posts: [], truncated: false };
    },
    async readAccount() {
      return { user: {} };
    },
    async resolve() {
      return {};
    },
    async account(agentId: string) {
      if (!m.accounts) return { agentId, connected: true, revoked: false, handle: 'bootr_agent', xUserId: '1000' };
      return m.accounts[agentId] ?? { agentId, connected: false, revoked: false, handle: null, xUserId: null };
    },
    /** Mirrors apps/sender rebind semantics (src/rebind.ts). */
    async rebind(from: string, to: string, connectedBefore?: string) {
      m.rebinds.push({ from, to, ...(connectedBefore ? { connectedBefore } : {}) });
      const accounts = m.accounts ?? {};
      const src = accounts[from];
      const dst = accounts[to];
      if (!src && dst) return { from, to, status: 'already', handle: dst.handle ?? null };
      if (!src) throw new SenderError(404, 'not_found', { error: 'not_found' }, false);
      if (dst) throw new SenderError(409, 'conflict', { error: 'conflict' }, false);
      if (connectedBefore && src.connectedAt && Date.parse(src.connectedAt) > Date.parse(connectedBefore)) {
        throw new SenderError(409, 'connected_after_cutoff', { error: 'connected_after_cutoff' }, false);
      }
      delete accounts[from];
      accounts[to] = { ...src, agentId: to };
      return { from, to, status: 'moved', handle: src.handle ?? null };
    },
    async metering() {
      return {};
    },
  } as unknown as SenderClient;
  return m;
}

export function mockIndexer(market: Record<string, unknown> | null = { priceUsd: 0.01, marketCapUsd: 1000 }) {
  const posted: unknown[] = [];
  const client = {
    async market() {
      return market;
    },
    async treasury() {
      return null;
    },
    async postSocial(_k: string, stats: unknown) {
      posted.push(stats);
      return true;
    },
  } as unknown as IndexerClient;
  return { client, posted };
}

export interface MockKernel {
  client: KernelClient;
  receipt: { success: boolean; receipt: { transactionHash: Hex } } | null;
  /** When false, waitForReceipt times out (returns null). */
  waitSucceeds: boolean;
  submitted: Hex[];
}

export function mockKernel(): MockKernel {
  const m: MockKernel = { client: null as unknown as KernelClient, receipt: { success: true, receipt: { transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }, waitSucceeds: true, submitted: [] };
  let seq = 0;
  m.client = {
    address: KERNEL,
    permissionId: '0x11223344',
    chainId: 84532,
    async isSessionInstalled() {
      return true;
    },
    async prepareUserOp(calls: unknown[]) {
      seq += 1;
      return { userOp: { calls } as never, hash: `0x${(seq).toString(16).padStart(64, '0')}` as Hex, enableMode: false };
    },
    async submitUserOp(prepared: { hash: Hex }) {
      m.submitted.push(prepared.hash);
      return prepared.hash;
    },
    async waitForReceipt() {
      return m.waitSucceeds ? m.receipt : null;
    },
    async getReceipt() {
      return m.receipt;
    },
    async signTypedData() {
      throw new Error('kernel signing refused: the session key signs no typed data');
    },
    async signMessage() {
      throw new Error('kernel signing refused: the session key signs no messages');
    },
    async verifySignature() {
      return true;
    },
  } as unknown as KernelClient;
  return m;
}

/** EntryPoint v0.7 `getUserOpHash` recomputed from the PACKED op, independently of viem's `getUserOperationHash`. */
export function entryPointUserOpHash(op: PackedUserOperation, chainId = 84532, entryPoint: Address = entryPoint07Address): Hex {
  const inner = keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256, bytes32, bytes32, bytes32, uint256, bytes32, bytes32'), [
      op.sender,
      op.nonce,
      keccak256(op.initCode),
      keccak256(op.callData),
      op.accountGasLimits,
      op.preVerificationGas,
      op.gasFees,
      keccak256(op.paymasterAndData),
    ]),
  );
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, address, uint256'), [inner, entryPoint, BigInt(chainId)]));
}

export const HANDLE_OPS_TX: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

export interface MockAdminSigner {
  signer: AdminSigner;
  approved: { kernel: Address; permissionId: Hex; validatorData: Hex }[];
  revoked: Hex[];
  /** Kernels passed to `revokeAllSessionKeysBatch`, one entry per call. */
  nonceRevoked: Address[][];
  /** When set, `revokeSessionKey` throws for these permission ids (simulated failed admin tx). */
  failRevoke: Set<Hex>;
  handled: { ops: readonly PackedUserOperation[]; beneficiary: Address }[];
  /** Outcome of the next `handleOps`: the op's `UserOperationEvent.success`, or an error thrown by the simulation. */
  outcome: 'success' | 'reverted' | Error;
  /** `UserOperationRevertReason.revertReason` attached when `outcome === 'reverted'`. */
  revertReason: Hex;
  /** `EntryPoint.depositTo(kernel){value}` calls (gas bootstrap / admin top-up), in order. */
  deposits: { kernel: Address; wei: bigint }[];
}

/** Admin signer whose `handleOps` behaves like a mined EntryPoint tx: it emits one `UserOperationEvent` per op. */
export function mockAdminSigner(): MockAdminSigner {
  const admin = privateKeyToAccount(ADMIN_PK);
  const m: MockAdminSigner = { signer: null as unknown as AdminSigner, approved: [], revoked: [], nonceRevoked: [], failRevoke: new Set(), handled: [], outcome: 'success', revertReason: '0x', deposits: [] };
  let kernelNonce = 0;
  m.signer = {
    address: admin.address,
    async approveSessionKey(kernel, permissionId, validatorData) {
      m.approved.push({ kernel, permissionId, validatorData });
      const nonce = kernelNonce++;
      return { txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', digest: enableDigest({ kernel, chainId: 84532, guardian: GUARDIAN, permissionId, nonce, validatorData }), nonce };
    },
    async revokeSessionKey(_kernel, permissionId) {
      if (m.failRevoke.has(permissionId)) throw new Error('execution reverted: RootCallFailed');
      m.revoked.push(permissionId);
      return { txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' };
    },
    async revokeAllSessionKeys(kernel) {
      m.nonceRevoked.push([kernel]);
      return { txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' };
    },
    async revokeAllSessionKeysBatch(kernels) {
      m.nonceRevoked.push([...kernels]);
      return { txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' };
    },
    async depositGas(kernel, wei) {
      m.deposits.push({ kernel, wei });
      return { txHash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' };
    },
    async handleOps(ops, beneficiary) {
      m.handled.push({ ops, beneficiary });
      if (m.outcome instanceof Error) throw m.outcome;
      const logs: Log[] = [];
      ops.forEach((op, i) => {
        const userOpHash = entryPointUserOpHash(op);
        const base = { address: entryPoint07Address, blockNumber: 101n, blockHash: '0x01' as Hex, transactionHash: HANDLE_OPS_TX, transactionIndex: 0, removed: false };
        if (m.outcome === 'reverted') {
          logs.push({
            ...base,
            logIndex: logs.length,
            topics: encodeEventTopics({ abi: entryPoint07Abi, eventName: 'UserOperationRevertReason', args: { userOpHash, sender: op.sender } }) as [Hex, ...Hex[]],
            data: encodeAbiParameters(parseAbiParameters('uint256, bytes'), [op.nonce, m.revertReason]),
          });
        }
        logs.push({
          ...base,
          logIndex: logs.length,
          topics: encodeEventTopics({ abi: entryPoint07Abi, eventName: 'UserOperationEvent', args: { userOpHash, sender: op.sender, paymaster: '0x0000000000000000000000000000000000000000' } }) as [Hex, ...Hex[]],
          data: encodeAbiParameters(parseAbiParameters('uint256, bool, uint256, uint256'), [op.nonce, m.outcome === 'success', 1_000n + BigInt(i), 500_000n]),
        });
      });
      const receipt = { status: 'success', transactionHash: HANDLE_OPS_TX, blockNumber: 101n, logs, from: admin.address, to: entryPoint07Address } as unknown as TransactionReceipt;
      return { txHash: HANDLE_OPS_TX, receipt };
    },
  };
  return m;
}

/** Scripted relay: each POST /v1/chat/completions consumes the next scripted response. */
export function mockInference(script: (Response | (() => Response))[]) {
  const calls: { url: string; body: unknown; headers: Headers }[] = [];
  /** What `GET /v1/requests/:key` answers (a relay `requestView` subset), or a function of the request headers. */
  const state: { requests: Record<string, unknown> | ((headers: Headers) => Response) } = { requests: { status: 'unknown' } };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const req = input instanceof Request ? input : null;
    const body = req ? await req.clone().text() : typeof init?.body === 'string' ? init.body : '';
    const headers = req ? req.headers : new Headers(init?.headers);
    calls.push({ url, body: body ? JSON.parse(body) : null, headers });
    if (url.includes('/v1/chat/completions')) {
      const next = script.shift();
      if (!next) return new Response(JSON.stringify({ error: { code: 'script_exhausted' } }), { status: 500 });
      return typeof next === 'function' ? next() : next;
    }
    if (url.includes('/v1/requests/')) {
      if (typeof state.requests === 'function') return state.requests(headers);
      return new Response(JSON.stringify(state.requests), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchImpl, calls, state };
}

export function toolCallResponse(name: string, args: unknown, id = `call_${name}`): Response {
  return new Response(
    JSON.stringify({ id: 'cmpl', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-bootr-receipt': JSON.stringify({ requestId: 'r', quoteMicroUsdc: '1000', chargedMicroUsdc: '1000', paymentTxOrId: '0xtx', network: 'eip155:84532', usage: null }) } },
  );
}

export function finishResponse(nextAtMs: number): Response {
  return toolCallResponse('finish', { memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(nextAtMs).toISOString() });
}

export interface TestWorld {
  ctx: SupervisorContext;
  db: Db;
  state: ChainState;
  sender: MockSender;
  indexer: ReturnType<typeof mockIndexer>;
  kernel: MockKernel;
  inference: ReturnType<typeof mockInference>;
  close: () => Promise<void>;
  setNow: (ms: number) => void;
}

export async function makeWorld(opts: { chain?: Partial<ChainState>; script?: Response[]; config?: Record<string, string> } = {}): Promise<TestWorld> {
  const { db, close } = await testDb();
  const state = chainState(opts.chain);
  const sender = mockSender();
  const indexer = mockIndexer();
  const kernel = mockKernel();
  const inference = mockInference(opts.script ?? []);
  let now = Date.parse('2026-10-24T12:00:00Z');
  const config = testConfig(opts.config);
  const ctx: SupervisorContext = {
    config,
    db,
    chain: mockChain(state),
    sender: sender.client,
    indexer: indexer.client,
    memories: new MemoryStore(db),
    sessionSigner: privateKeyToAccount(SESSION_PK),
    adminSigner: null,
    spenderFor: (agent) => spenderAccount(SPENDER_MASTER, agent.agentId),
    kernelFor: async () => kernel.client,
    fetch: inference.fetch,
    // Every outbound host resolves to a public address: no real DNS in tests (private-host checks still run).
    resolveHost: async () => [{ address: '93.184.216.34' }],
    now: () => now,
    log: pino({ level: 'silent' }),
  };
  return { ctx, db, state, sender, indexer, kernel, inference, close, setNow: (ms) => (now = ms) };
}

export const AGENT_ID = '7';

export function agentConfig(now: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: AGENT_ID,
    token: { address: TOKEN, symbol: 'TEST', name: 'Test Coin', chainId: 84532 },
    kernel: { address: KERNEL },
    creator: { address: CREATOR },
    xHandle: 'bootr_agent',
    xUserId: '1000',
    model: 'openai/gpt-4.1-mini',
    identityText: 'You are a test agent.',
    ownerRules: [],
    capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false },
    postIntervalMs: 2 * 3_600_000,
    dormancyPeriodMs: 90 * 86_400_000,
    socialStartedAt: new Date(now - 3 * 3_600_000).toISOString(),
    replyAuthorIds: [],
    blockedAuthorIds: [],
    revision: 1,
    ...over,
  };
}

export async function seedAgent(world: TestWorld, over: { config?: Record<string, unknown>; runtime?: Partial<typeof schema.runtimes.$inferInsert>; agent?: Partial<typeof schema.agents.$inferInsert> } = {}): Promise<AgentRow> {
  const now = world.ctx.now();
  const [agent] = await world.db
    .insert(schema.agents)
    .values({ agentId: AGENT_ID, token: TOKEN, kernel: KERNEL, creator: CREATOR, config: agentConfig(now, over.config), permissionId: '0x11223344', sessionKeyInstalledAt: new Date(now), status: 'active', ...over.agent })
    .returning();
  await world.db.insert(schema.runtimes).values({ agentId: AGENT_ID, state: initialState() as unknown as Record<string, unknown>, cycle: 0, nextAt: new Date(now - 1000), status: 'waiting', configRevision: 1, lastDecisionAt: new Date(now - 60_000), lastDecisionRevision: 1, ...over.runtime });
  return agent!;
}
