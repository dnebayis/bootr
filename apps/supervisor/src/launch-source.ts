/**
 * The treasury path of an agent by launch source (docs/design/clanker-launch.md section 3): `sv_agents.source`
 * says which launcher emitted the agent's `AgentLaunched`, the config's `clanker` block (decoded from
 * `ClankerLaunched` in the launch receipt) names the lockers its fees sit in. Shared by onboarding.ts (session-key
 * rules) and treasury.ts (reads and claim calls); kept apart from both so neither imports the other.
 */
import { getAddress, isAddress, isHex, size, type Address, type Hex } from 'viem';
import type { LaunchSource } from './chain.js';
import type { AgentRow, SupervisorContext } from './context.js';

/** `bootr` for rows written before the column existed and for anything that is not `clanker`. */
export function agentSource(agent: Pick<AgentRow, 'source'>): LaunchSource {
  return agent.source === 'clanker' ? 'clanker' : 'bootr';
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
