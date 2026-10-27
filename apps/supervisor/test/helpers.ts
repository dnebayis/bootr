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

export const SESSION_PK: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const ADMIN_PK: Hex = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
export const GUARDIAN: Address = '0x1000000000000000000000000000000000000001';
export const LAUNCHER: Address = '0x1000000000000000000000000000000000000002';
export const KERNEL: Address = '0x2000000000000000000000000000000000000002';
export const TOKEN: Address = '0x3000000000000000000000000000000000000003';
export const CREATOR: Address = '0x4000000000000000000000000000000000000004';
export const PAYTO: Address = '0x5000000000000000000000000000000000000005';
export const SERVICE_KEY = 'test-service-key-0123456789abcdef0123456789';
export const ADDR = getAddresses(84532);

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://test',
    CHAIN_ID: '84532',
    BASE_SEPOLIA_RPC_URL: 'http://rpc.test',
    BUNDLER_URL: 'http://bundler.test',
    SESSION_SIGNER_PRIVATE_KEY: SESSION_PK,
    ADMIN_PRIVATE_KEY: ADMIN_PK,
    BOOTR_LAUNCHER_ADDRESS: LAUNCHER,
    BOOTR_GUARDIAN_ADDRESS: GUARDIAN,
    SENDER_URL: 'http://sender.test',
    SENDER_SERVICE_KEY: SERVICE_KEY,
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
  weth: bigint;
  eth: bigint;
  token: bigint;
  claimableWeth: bigint;
  claimableToken: bigint;
  ethUsd: bigint; // 8 dp
  paused: boolean;
  logs: unknown[];
  blockNumber: bigint;
  calls: { fn: string; args: unknown[] }[];
  /** `validationConfig(vId).hook == guardian` (false = the permission is not installed: enable mode). */
  sessionInstalled: boolean;
  /** EntryPoint nonce sequence returned by `getNonce` (the key is taken from the call). */
  nonceSeq: bigint;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** Logs returned by `getTransactionReceipt`, keyed by lowercase tx hash. */
  receipts: Record<string, Log[]>;
  /** Unix seconds returned by `getBlock` for any block. */
  blockTimestamp: bigint;
}

export function chainState(over: Partial<ChainState> = {}): ChainState {
  return {
    usdc: 50_000_000n,
    weth: 0n,
    eth: 0n,
    token: 0n,
    claimableWeth: 0n,
    claimableToken: 0n,
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
        case 'balanceOf':
          if (addr === ADDR.usdc) return state.usdc;
          if (addr === ADDR.weth) return state.weth;
          return state.token;
        case 'availableFees':
          return getAddress((args.args as Address[])[1]!) === ADDR.weth ? state.claimableWeth : state.claimableToken;
        case 'latestRoundData':
          return [1n, state.ethUsd, 0n, 0n, 1n];
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
  return { chain: baseSepolia, chainId: 84532, publicClient, addresses: ADDR, launcher: LAUNCHER, guardian: GUARDIAN, ethUsdFeed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1' };
}

export interface MockSender {
  /** X accounts by agent id; null = every agent id reports the default connected account. */
  accounts: Record<string, SenderAccount & { connectedAt?: string }> | null;
  rebinds: { from: string; to: string; connectedBefore?: string }[];
  items: SenderInboxItem[];
  published: unknown[];
  publishStatus: 'sent' | 'held' | 'rejected';
  receipts: Record<string, { status: string; providerPostId?: string | null; error?: string | null }>;
  client: SenderClient;
}

export function mockSender(): MockSender {
  const m: MockSender = { accounts: null, rebinds: [], items: [], published: [], publishStatus: 'sent', receipts: {}, client: null as unknown as SenderClient };
  let n = 9000;
  m.client = {
    async publish(body: { actionId: string }) {
      m.published.push(body);
      const providerPostId = m.publishStatus === 'sent' ? String(++n) : null;
      m.receipts[body.actionId] = { status: m.publishStatus, providerPostId };
      return { status: m.publishStatus, providerPostId, receipt: { actionId: body.actionId, agentId: 'a', kind: 'post', status: m.publishStatus, providerPostId, error: m.publishStatus === 'rejected' ? 'policy:invalid_short_post' : null } };
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
      return '0x02112233440000000000000000000000000000000000ff00' as Hex;
    },
    async signMessage() {
      return '0x00' as Hex;
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
  handled: { ops: readonly PackedUserOperation[]; beneficiary: Address }[];
  /** Outcome of the next `handleOps`: the op's `UserOperationEvent.success`, or an error thrown by the simulation. */
  outcome: 'success' | 'reverted' | Error;
  /** `UserOperationRevertReason.revertReason` attached when `outcome === 'reverted'`. */
  revertReason: Hex;
}

/** Admin signer whose `handleOps` behaves like a mined EntryPoint tx: it emits one `UserOperationEvent` per op. */
export function mockAdminSigner(): MockAdminSigner {
  const admin = privateKeyToAccount(ADMIN_PK);
  const m: MockAdminSigner = { signer: null as unknown as AdminSigner, approved: [], revoked: [], handled: [], outcome: 'success', revertReason: '0x' };
  let kernelNonce = 0;
  m.signer = {
    address: admin.address,
    async approveSessionKey(kernel, permissionId, validatorData) {
      m.approved.push({ kernel, permissionId, validatorData });
      const nonce = kernelNonce++;
      return { txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', digest: enableDigest({ kernel, chainId: 84532, guardian: GUARDIAN, permissionId, nonce, validatorData }), nonce };
    },
    async revokeSessionKey(_kernel, permissionId) {
      m.revoked.push(permissionId);
      return { txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' };
    },
    async revokeAllSessionKeys() {
      return { txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' };
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
    if (url.includes('/v1/requests/')) return new Response(JSON.stringify({ status: 'unknown' }), { status: 200 });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchImpl, calls };
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
    kernelFor: async () => kernel.client,
    fetch: inference.fetch,
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
