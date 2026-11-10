/**
 * The treasury path of an agent by launch source (docs/design/clanker-launch.md section 3,
 * docs/design/clanker-v5-migration.md section 3): `sv_agents.source` says which launcher emitted the agent's
 * `AgentLaunched`, the config's `clanker` block (decoded from `ClankerLaunched` in the launch receipt) names the
 * Clanker v4 lockers its fees sit in, and the `clankerV5` block (from `ClankerV5Launched`) the v5 escrow. Shared by onboarding.ts (session-key
 * rules) and treasury.ts (reads and claim calls); kept apart from both so neither imports the other.
 */
import { getAddress, isAddress, isHex, size, type Address, type Hex } from 'viem';
import type { LaunchSource } from './chain.js';
import type { AgentRow, SupervisorContext } from './context.js';

/** A stored source string as a `LaunchSource`: `bootr` for rows written before the column existed and for anything unknown. */
export function launchSourceFrom(source: unknown): LaunchSource {
  return source === 'clanker' || source === 'clanker-v5' ? source : 'bootr';
}

/** `bootr` for rows written before the column existed and for anything that is not `clanker` or `clanker-v5`. */
export function agentSource(agent: Pick<AgentRow, 'source'>): LaunchSource {
  return launchSourceFrom(agent.source);
}

/** What `BootrClankerLauncher.ClankerLaunched` says about a coin, stored in `sv_agents.config.clanker`. */
export interface ClankerLaunchDetails {
  /** Uniswap v4 pool id of the coin / WETH pool. */
  poolId: Hex;
  /** The Clanker hook the pool runs (static or dynamic fee V2). */
  hook: Address;
  /** `ClankerLpLockerFeeConversion` holding the positions: the `collectRewards(token)` target. */
  locker: Address;
  /** `ClankerFeeLocker` the locker deposits into (`CLANKER_FEE_LOCKER_ADDRESS` at registration): the `claim` target. */
  feeLocker: Address;
  mevModule: Address;
  startingTick: number;
  lpFeeBps: number;
}

const ZERO_BYTES32: Hex = `0x${'0'.repeat(64)}`;
const isPoolId = (v: unknown): v is Hex => typeof v === 'string' && isHex(v) && size(v) === 32 && v !== ZERO_BYTES32;
const isAddr = (v: unknown): v is Address => typeof v === 'string' && isAddress(v);

/** The stored `config.clanker` block, or null when absent or malformed (the receipt could not be read at registration). */
export function clankerDetailsOf(config: Record<string, unknown>): ClankerLaunchDetails | null {
  const raw = config.clanker;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (!isPoolId(c.poolId) || !isAddr(c.hook) || !isAddr(c.locker) || !isAddr(c.feeLocker) || !isAddr(c.mevModule)) return null;
  return {
    poolId: c.poolId,
    hook: getAddress(c.hook),
    locker: getAddress(c.locker),
    feeLocker: getAddress(c.feeLocker),
    mevModule: getAddress(c.mevModule),
    startingTick: typeof c.startingTick === 'number' ? c.startingTick : 0,
    lpFeeBps: typeof c.lpFeeBps === 'number' ? c.lpFeeBps : 0,
  };
}

/**
 * The Clanker lockers an agent's fees sit in: the ones `ClankerLaunched` named (the launch is the truth), else the
 * configured defaults (`CLANKER_LOCKER_ADDRESS` / `CLANKER_FEE_LOCKER_ADDRESS`) while the receipt is unread.
 */
export function clankerLockersFor(ctx: Pick<SupervisorContext, 'chain'>, agent: Pick<AgentRow, 'config'>): { lpLocker: Address; feeLocker: Address; details: ClankerLaunchDetails | null } {
  const details = clankerDetailsOf(agent.config);
  return { lpLocker: details?.locker ?? ctx.chain.clanker.lpLocker, feeLocker: details?.feeLocker ?? ctx.chain.clanker.feeLocker, details };
}

/**
 * What `BootrClankerLauncherV5.ClankerV5Launched(token, poolId, hook, feeEscrow, quoteToken, tickSpacing, taxBps,
 * antiSnipe)` says about a v5 coin, stored in `sv_agents.config.clankerV5` (docs/design/clanker-v5-migration.md).
 */
export interface ClankerV5LaunchDetails {
  /** Uniswap v4 pool id of the coin / quote pool (fee 0, the v5 hook). */
  poolId: Hex;
  /** `TaxLaunchHook`: takes the tax on every swap and credits the escrow. */
  hook: Address;
  /** `FeeEscrow`: the kernel's `owed(kernel, quote)` balance and the `claimFor(kernel, quote)` target. */
  feeEscrow: Address;
  /** The pool's quote: `0x0` = native ETH (the recommended, and today the only built, quote). */
  quoteToken: Address;
  tickSpacing: number;
  /** The tax in hundredths of a bip (15_000 = 1.5%), buy and sell alike. */
  taxBps: number;
  antiSnipe: boolean;
}

/** The stored `config.clankerV5` block, or null when absent or malformed (the receipt could not be read at registration). */
export function clankerV5DetailsOf(config: Record<string, unknown>): ClankerV5LaunchDetails | null {
  const raw = config.clankerV5;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (!isPoolId(c.poolId) || !isAddr(c.hook) || !isAddr(c.feeEscrow) || !isAddr(c.quoteToken)) return null;
  return {
    poolId: c.poolId,
    hook: getAddress(c.hook),
    feeEscrow: getAddress(c.feeEscrow),
    quoteToken: getAddress(c.quoteToken),
    tickSpacing: typeof c.tickSpacing === 'number' ? c.tickSpacing : 0,
    taxBps: typeof c.taxBps === 'number' ? c.taxBps : 0,
    antiSnipe: c.antiSnipe === true,
  };
}

/**
 * The v5 `FeeEscrow` an agent's fees sit in: the one `ClankerV5Launched` named (the launch is the truth), else the
 * address book's (`addresses.clankerV5.feeEscrow`) while the receipt is unread. Throws when neither is known (a chain
 * without Clanker v5): a v5 agent must never get a claim rule or a claim call to a guessed address.
 */
export function clankerV5EscrowFor(ctx: Pick<SupervisorContext, 'chain'>, agent: Pick<AgentRow, 'config'>): { feeEscrow: Address; details: ClankerV5LaunchDetails | null } {
  const details = clankerV5DetailsOf(agent.config);
  const feeEscrow = details?.feeEscrow ?? ctx.chain.clankerV5.feeEscrow;
  if (!feeEscrow) throw new Error(`clankerV5.feeEscrow address is not configured for chain ${ctx.chain.chainId}`);
  return { feeEscrow, details };
}
