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
import type { ChainContext, LauncherEntry } from '../src/chain.js';
import type { AgentRow, SupervisorContext } from '../src/context.js';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import type { AdminSigner } from '../src/admin-signer.js';
import type { KernelClient } from '../src/kernel.js';
import { enableDigest } from '../src/session-key.js';
import { MemoryStore } from '../src/memories.js';
import { SenderError, type SenderAccount, type SenderClient, type SenderInboxItem, type SenderPostMetrics, type SenderTimelinePost } from '../src/sender-client.js';
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
/** `BootrClankerLauncher` placeholder (`BOOTR_CLANKER_LAUNCHER_ADDRESS` in a test config; unset by default). */
export const CLANKER_LAUNCHER: Address = '0xA00000000000000000000000000000000000000A';
/** Clanker v4 locker placeholders (`CLANKER_LOCKER_ADDRESS` / `CLANKER_FEE_LOCKER_ADDRESS` in the test config). */
export const CLANKER_LP_LOCKER: Address = '0xB00000000000000000000000000000000000000B';
export const CLANKER_FEE_LOCKER: Address = '0xC000000000000000000000000000000000000000';
/** `BootrClankerLauncherV5` placeholder (`BOOTR_CLANKER_V5_LAUNCHER_ADDRESS` in a test config; unset by default). */
export const CLANKER_V5_LAUNCHER: Address = '0xD00000000000000000000000000000000000000D';
/** Clanker v5 `FeeEscrow`: the real Base address (`addresses[8453].clankerV5.feeEscrow`), so the v5 fixture carries the real rule bytes. */
export const CLANKER_V5_FEE_ESCROW: Address = '0x5dd237d1f716C65426CCd2FAe82B95109825FA61';
/** The v5 `TaxLaunchHook` on Base (`ClankerV5Launched.hook`). */
export const CLANKER_V5_HOOK: Address = '0x5E320eA6278107968C119942E57d876c5F922AcC';
/** Uniswap v4 pool id of a Clanker v5 test coin (`ClankerV5Launched.poolId`). */
export const CLANKER_V5_POOL_ID: Hex = '0xd500000000000000000000000000000000000000000000000000000000000d5d';
/** Uniswap v4 pool id of a Clanker test coin (`ClankerLaunched.poolId`). */
export const CLANKER_POOL_ID: Hex = '0xc000000000000000000000000000000000000000000000000000000000000c0c';
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
    CLANKER_LOCKER_ADDRESS: CLANKER_LP_LOCKER,
    CLANKER_FEE_LOCKER_ADDRESS: CLANKER_FEE_LOCKER,
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
  /** `ClankerFeeLocker.availableFees(kernel, WETH)`: what the Clanker LP locker has deposited for the kernel so far. */
  clankerAvailableWeth: bigint;
  /** Clanker v5 `FeeEscrow.owed(kernel, 0x0)`: native ETH the hook has credited to the kernel's slot. */
  clankerV5OwedEth: bigint;
  /** Clanker v5 `FeeEscrow.owed(kernel, USDC)`: USDC (6 dp) the hook has credited to the kernel's slot of a USDC-paired coin. */
  clankerV5OwedUsdc?: bigint;
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
  /** Payment nonces already spent: `bytes32` hex for USDC's EIP-3009, a decimal string for Permit2 (direct mode). */
  spentNonces?: Set<string>;
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
    clankerAvailableWeth: 0n,
    clankerV5OwedEth: 0n,
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

/**
 * The mocked chain context. `clankerLauncher` adds `BootrClankerLauncher` to the followed launchers (what a config
 * with `BOOTR_CLANKER_LAUNCHER_ADDRESS` does in `createChainContext`), `clankerV5Launcher` adds `BootrClankerLauncherV5`
 * (`BOOTR_CLANKER_V5_LAUNCHER_ADDRESS`); `makeWorld` passes the test config's values.
 */
export function mockChain(state: ChainState, opts: { clankerLauncher?: Address | null; clankerV5Launcher?: Address | null } = {}): ChainContext {
  const clankerLauncher = opts.clankerLauncher ?? null;
  const clankerV5Launcher = opts.clankerV5Launcher ?? null;
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
        case 'allowance':
          return 0n;
        case 'nonces':
          return 0n;
        case 'authorizationState':
          return state.spentNonces?.has(String((args.args as [Address, Hex])[1]).toLowerCase()) ?? false;
        case 'nonceBitmap': {
          const wordPos = (args.args as [Address, bigint])[1];
          let word = 0n;
          for (const spent of state.spentNonces ?? []) {
            if (!/^\d+$/.test(spent)) continue;
            if (BigInt(spent) >> 8n === wordPos) word |= 1n << (BigInt(spent) & 0xffn);
          }
          return word;
        }
        case 'getEthBalance':
          return state.eth;
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
        case 'availableFees': {
          if (addr !== CLANKER_FEE_LOCKER) throw new Error('availableFees on an unexpected address');
          const [feeOwner, token] = args.args as [Address, Address];
          return getAddress(feeOwner) === KERNEL && getAddress(token) === ADDR.weth ? state.clankerAvailableWeth : 0n;
        }
        case 'owed': {
          if (addr !== CLANKER_V5_FEE_ESCROW) throw new Error('owed on an unexpected address');
          const [recipient, currency] = args.args as [Address, Address];
          if (getAddress(recipient) !== KERNEL) return 0n;
          if (currency === '0x0000000000000000000000000000000000000000') return state.clankerV5OwedEth;
          return getAddress(currency) === ADDR.usdc ? (state.clankerV5OwedUsdc ?? 0n) : 0n;
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
    // Late-bound on purpose: a test that replaces `readContract` changes what the batch reads too.
    async multicall({ contracts }: { contracts: { address: Address; functionName: string; args?: unknown[] }[] }) {
      const client = publicClient as unknown as { readContract: (a: unknown) => Promise<unknown> };
      return Promise.all(
        contracts.map((c) =>
          client.readContract(c).then(
            (result) => ({ status: 'success', result }),
            (error: unknown) => ({ status: 'failure', error }),
          ),
        ),
      );
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
  const launchers: LauncherEntry[] = [
    { address: LAUNCHER, source: 'bootr' },
    ...(clankerLauncher ? [{ address: clankerLauncher, source: 'clanker' as const }] : []),
    ...(clankerV5Launcher ? [{ address: clankerV5Launcher, source: 'clanker-v5' as const }] : []),
  ];
  return {
    chain: baseSepolia,
    chainId: 84532,
    publicClient,
    addresses: ADDR,
    launcher: LAUNCHER,
    clankerLauncher,
    clankerV5Launcher,
    launchers,
    guardian: GUARDIAN,
    ethUsdFeed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
    rwagmi: { launcher: RWAGMI_LAUNCHER, lpLocker: RWAGMI_LP_LOCKER },
    clanker: { lpLocker: CLANKER_LP_LOCKER, feeLocker: CLANKER_FEE_LOCKER },
    clankerV5: { feeEscrow: CLANKER_V5_FEE_ESCROW },
  };
}

export interface MockSender {
  /** X accounts by agent id; null = every agent id reports the default connected account. */
  accounts: Record<string, SenderAccount & { connectedAt?: string }> | null;
  /** `readAccount` answers by lowercase handle: a record, or null for an account X does not know; absent = a recent account. */
  accountReads: Record<string, { user: Record<string, unknown>; activity: 'recent' | 'stale' | 'unknown'; latestPostAt: string | null } | null>;
  rebinds: { from: string; to: string; connectedBefore?: string }[];
  items: SenderInboxItem[];
  published: unknown[];
  publishStatus: 'sent' | 'held' | 'rejected';
  /** When set, `publish` answers 503 `consent_lookup_failed` (X unreachable for the consent check) with this retryAt. */
  consentLookupFails: string | null;
  /** When set, `publish` answers 429 `quota_exceeded` (the agent's 24 h post quota is used up) with this retryAt. */
  quotaExceeded: string | null;
  /** The sender is one from before the round's posting rules: its account read says no `addressedAt`, its quota read no link count, and a publish is not answered as a part of a thread. */
  oldSender?: boolean;
  /** When set, a publish the sender would send is rejected with this receipt error (e.g. X's `http_402(402): credits depleted`). */
  publishError: string | null;
  /** When set, `readMentions` throws this. */
  readMentionsError: Error | null;
  /** When set, `readMentions` answers throttled with this `nextReadAt` (the sender's mention-read interval), items from `items`. */
  nextReadAt: string | null;
  /** Handles the sender considers opted out of @mentions (`policy:mention_opted_out`). */
  optedOutHandles: Set<string>;
  receipts: Record<string, { status: string; providerPostId?: string | null; error?: string | null }>;
  /** `readTimeline` answers by lowercase handle: posts, or null for an account X does not know; absent = no posts. */
  timelines: Record<string, SenderTimelinePost[] | null>;
  /** Every `readTimeline` call: the handle asked for. */
  timelineReads: string[];
  /** `readMetrics` answers from here (postId -> counts); ids not listed come back in `missing`. */
  metrics: Record<string, Partial<SenderPostMetrics>>;
  /** When set, `readMetrics` throws this. */
  metricsError: Error | null;
  metricsReads: string[][];
  /** Every `setQuota` call, in order (agent id and patch), as the sender's `POST /internal/quota/:agentId` would receive it. */
  quotaWrites: { agentId: string; patch: { postsPerDay?: number | null; mentionReadIntervalSec?: number | null } }[];
  /** When set, `setQuota` throws this (the sender is down). */
  quotaError: Error | null;
  client: SenderClient;
}

export function mockSender(): MockSender {
  const m: MockSender = { accounts: null, accountReads: {}, rebinds: [], items: [], published: [], publishStatus: 'sent', consentLookupFails: null, quotaExceeded: null, publishError: null, readMentionsError: null, nextReadAt: null, optedOutHandles: new Set(), receipts: {}, timelines: {}, timelineReads: [], metrics: {}, metricsError: null, metricsReads: [], quotaWrites: [], quotaError: null, client: null as unknown as SenderClient };
  let n = 9000;
  m.client = {
    /** Mirrors apps/sender/src/publish.ts: reply eligibility is required, opt-outs are enforced, consent lookups can fail transiently. */
    async publish(body: { agentId?: string; actionId: string; text: string; replyTo?: string; replyEligibility?: { eligible: boolean; reason?: string } }) {
      if (m.consentLookupFails) throw new SenderError(503, 'consent_lookup_failed', { error: 'consent_lookup_failed', retryAt: m.consentLookupFails }, true, Date.parse(m.consentLookupFails));
      if (m.quotaExceeded) throw new SenderError(429, 'quota_exceeded', { error: 'quota_exceeded', limit: 24, window: '24h', retryAt: m.quotaExceeded }, true, Date.parse(m.quotaExceeded));
      m.published.push(body);
      const reasons: string[] = [];
      if (body.replyTo && !body.replyEligibility?.eligible) reasons.push(`reply_not_eligible:${body.replyEligibility?.reason ?? 'missing_eligibility'}`);
      for (const h of body.text.match(/@([A-Za-z0-9_]+)/g) ?? []) if (m.optedOutHandles.has(h.slice(1).toLowerCase())) reasons.push('mention_opted_out');
      // apps/sender/src/publish.ts `postTooLongForAccount`: an original over 280 characters from an account without Premium never reaches X.
      const length = [...body.text].length;
      const tooLong = !reasons.length && !body.replyTo && m.accounts?.[body.agentId ?? '']?.premium === false && length > 280 ? `post_too_long_for_account: this X account has no Premium: posts are limited to 280 characters (this one is ${length}). Shorten it and publish again.` : null;
      const status = reasons.length || tooLong || m.publishError ? 'rejected' : m.publishStatus;
      const error = reasons.length ? `policy:${reasons[0]}` : tooLong ? tooLong : m.publishError ? m.publishError : m.publishStatus === 'rejected' ? 'policy:invalid_short_post' : null;
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
      if (m.readMentionsError) throw m.readMentionsError;
      return { throttled: !!m.nextReadAt, ...(m.nextReadAt ? { nextReadAt: m.nextReadAt } : {}), items: m.items };
    },
    async readThread() {
      return { posts: [], truncated: false };
    },
    async readAccount(_agentId: string, username: string) {
      const h = username.replace(/^@/, '').toLowerCase();
      const hit = m.accountReads[h];
      if (hit === null) {
        const err = new Error('x_not_found: user not found') as Error & { status: number };
        err.status = 404;
        throw err;
      }
      // `addressedAt` (when the account last wrote to the agent) is null unless a test's record says otherwise: the
      // answer of today's sender. `oldSender` leaves the field out, as a sender from before the mention audience does.
      const answer = hit ?? { user: { username: h }, activity: 'recent' as const, latestPostAt: new Date().toISOString() };
      if (m.oldSender) return Object.fromEntries(Object.entries(answer).filter(([k]) => k !== 'addressedAt'));
      return { addressedAt: null, ...answer };
    },
    /** Mirrors apps/sender/src/inbox.ts `readTimeline`: 404 for an unknown account, else the posts newest first, at most `max`. */
    async readTimeline(_agentId: string, username: string, max = 5) {
      const h = username.replace(/^@/, '').toLowerCase();
      m.timelineReads.push(h);
      const posts = m.timelines[h];
      if (posts === null) {
        const err = new Error('x_not_found: user not found') as Error & { status: number };
        err.status = 404;
        throw err;
      }
      return { user: { id: `u_${h}`, username: h }, posts: (posts ?? []).slice(0, max) };
    },
    /** Mirrors apps/sender/src/metrics.ts: one read per call, unknown ids are `missing`. */
    async readMetrics(_agentId: string, postIds: string[]) {
      m.metricsReads.push(postIds);
      if (m.metricsError) throw m.metricsError;
      const items: SenderPostMetrics[] = [];
      const missing: string[] = [];
      for (const id of postIds) {
        const c = m.metrics[id];
        if (!c) {
          missing.push(id);
          continue;
        }
        items.push({ postId: id, createdAt: null, likes: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: null, impressions: null, nonPublic: null, ...c });
      }
      return { items, missing, nonPublic: true };
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
    /** Mirrors apps/sender/src/app.ts `POST /internal/quota/:agentId`: the patch is stored, the effective quota comes back. */
    async setQuota(agentId: string, patch: { postsPerDay?: number | null; mentionReadIntervalSec?: number | null }) {
      if (m.quotaError) throw m.quotaError;
      m.quotaWrites.push({ agentId, patch });
      const last = m.quotaWrites.filter((q) => q.agentId === agentId).reduce<{ postsPerDay?: number | null; mentionReadIntervalSec?: number | null }>((acc, q) => ({ ...acc, ...q.patch }), {});
      return { agentId, postsPerDay: last.postsPerDay ?? 24, mentionReadIntervalSec: last.mentionReadIntervalSec ?? 900, lastMentionsReadAt: null };
    },
    async quota(agentId: string) {
      const last = m.quotaWrites.filter((q) => q.agentId === agentId).reduce<{ postsPerDay?: number | null }>((acc, q) => ({ ...acc, ...q.patch }), {});
      // Today's sender reports its count of posts with a link; one from before (`oldSender`) knows none.
      return { agentId, postsPerDay: last.postsPerDay ?? 24, mentionReadIntervalSec: 900, lastMentionsReadAt: null, ...(m.oldSender ? {} : { linkPostsPerDay: null, linkPostsUsed24h: 0, linkPostsDefault: 3, linkPostsDefaultPlatform: 8 }) };
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
    async graphql() {
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
}

/** Admin signer whose `handleOps` behaves like a mined EntryPoint tx: it emits one `UserOperationEvent` per op. */
export function mockAdminSigner(): MockAdminSigner {
  const admin = privateKeyToAccount(ADMIN_PK);
  const m: MockAdminSigner = { signer: null as unknown as AdminSigner, approved: [], revoked: [], nonceRevoked: [], failRevoke: new Set(), handled: [], outcome: 'success', revertReason: '0x' };
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
    chain: mockChain(state, { clankerLauncher: (config.BOOTR_CLANKER_LAUNCHER_ADDRESS as Address | undefined) ?? null, clankerV5Launcher: (config.BOOTR_CLANKER_V5_LAUNCHER_ADDRESS as Address | undefined) ?? null }),
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
