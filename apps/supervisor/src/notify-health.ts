/**
 * The notifier's pass: looks at agents on its own clock, apart from the tick, and turns what it reads into notification
 * events (notifications.ts). It only reads the chain and the sender and only writes its own tables, so nothing here can
 * delay or disturb a turn. A read that fails leaves that event as it was rather than guessing either way.
 *
 * An own-agent coin (docs/design/byo-agent.md sections 1.4 and 11; `isOwn`, the stored config, whatever the flag says)
 * thinks in its creator's own client: it buys no thought and never sleeps for fuel. The notices that are about paid
 * thinking (fuel low with its thoughts left, asleep, failing turns, model not available) are never raised for it, and
 * one left open from the coin's hosted days is closed. Everything that still applies is told as for any coin: gas, the
 * X connection, a pause or a held action, posts waiting for review, the session key.
 */
import { averageThoughtCost, fuelIsLow, runwayDays, thoughtsLeft } from '@bootr/shared/fuel';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { erc20Abi, type Abi, type Address } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';
import { APPROVAL_TTL_MS, expireApprovals } from './approvals.js';
import type { AgentRow, RuntimeRow, SupervisorContext } from './context.js';
import { agents, approvals, notificationSettings, runtimes } from './db/schema.js';
import { agentHasGasRule, gasReading, gasSelfFunded, MULTICALL3_ADDRESS, multicall3BalanceAbi, type GasStatus } from './gas.js';
import { fuelReport, recentThoughtCost } from './inference.js';
import { agentSource, clankerV5QuoteOf, pairedAssetOf } from './launch-source.js';
import { applyOutcomes, flushNotifications, MODEL_CHANGED_VISIBLE_MS, pruneNotifications, resolveNotification, type FlushReport, type HealthOutcomes, type NotificationData } from './notifications.js';
import { notifications } from './db/schema.js';
import { isOwn } from './own/registry.js';
import type { SenderAccount } from './sender-client.js';

/** Under this many days of runway at the recent rate fuel counts as low, whatever is left in thoughts. */
export const LOW_RUNWAY_DAYS = 2;
/** A waiting post counts as about to expire this long before its 48 h are up. */
export const REVIEW_EXPIRING_MS = 6 * 3_600_000;
/** Consecutive failed turns before the creator hears about it. */
export const FAILING_TURNS = 5;
/** Agents the notifier looks at in one pass; each costs a few chain reads and one sender read. */
export const CHECK_BATCH = 25;

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

export interface FuelFacts {
  spendableMicro: number;
  reserveMicro: number;
  recent: { thoughts: number; spentMicroUsdc: number };
  week: { thoughts: number; spentMicroUsdc: number; firstAt: number | null };
}

export interface ReviewFacts {
  pending: number;
  expiring: number;
  soonestExpiry: number | null;
}

export interface HealthFacts {
  now: number;
  agentStatus: AgentRow['status'];
  runtime: Pick<RuntimeRow, 'status' | 'pausedBy' | 'failures'> | null;
  reviews: ReviewFacts;
  /** null: the balances could not be read. */
  fuel: FuelFacts | null;
  /** null: could not be read. */
  gas: GasStatus | null;
  /**
   * True for an agent whose own fees can never become gas (a Clanker v5 coin paired with USDC; owner's answer 6,
   * 2026-11-10): the out-of-gas notice then says the gas comes only from the creator. Absent = false.
   */
  gasFromCreatorOnly?: boolean;
  /** null: the sender could not be reached. */
  x: Pick<SenderAccount, 'connected' | 'revoked'> | null;
  key: { validUntil: number | null; rotateBeforeMs: number; outdated: boolean };
  /** True for an own-agent coin (`isOwn`): no notice about paid thinking is raised, and an open one is closed. Absent = false, a hosted coin. */
  own?: boolean;
}

/**
 * Fuel for a notification is everything the agent can still spend: the spendable float plus the reserve, because the
 * reserve moves over by itself and a float that is merely low needs nothing from the creator. Same arithmetic as the
 * console's runway line (`@bootr/shared/fuel`). Null when fuel is not low.
 */
export function fuelLow(f: FuelFacts, now: number): { thoughtsLeft: number | null; days: number | null } | null {
  const total = f.spendableMicro + f.reserveMicro;
  const left = thoughtsLeft(total, averageThoughtCost(f.recent.spentMicroUsdc, f.recent.thoughts));
  const days = f.week.firstAt === null ? null : runwayDays(total, f.week.spentMicroUsdc, f.week.thoughts, now - f.week.firstAt);
  const low = fuelIsLow(total, left) || (days !== null && days < LOW_RUNWAY_DAYS);
  return low ? { thoughtsLeft: left, days: days === null ? null : Math.round(days * 10) / 10 } : null;
}

function reviewOutcomes(reviews: ReviewFacts, now: number): Pick<HealthOutcomes, 'review_waiting' | 'review_expiring'> {
  return {
    review_waiting: reviews.pending > 0 ? { pending: reviews.pending } : false,
    review_expiring: reviews.expiring > 0 ? { expiring: reviews.expiring, hours: reviews.soonestExpiry === null ? null : Math.max(0, Math.round((reviews.soonestExpiry - now) / 3_600_000)) } : false,
  };
}

/** The pure part of the check: facts in, per-event outcome out; anything unknown is left out of the answer. */
export function evaluateHealth(f: HealthFacts): HealthOutcomes {
  const out: HealthOutcomes = reviewOutcomes(f.reviews, f.now);
  // `own: 1` only changes the wording of the creator-only notice: an own coin's USDC fees are fuel for paid services, not for thinking.
  if (f.gas) out.gas_out = f.gas === 'empty' ? (f.gasFromCreatorOnly ? { creatorOnly: 1, ...(f.own === true ? { own: 1 } : {}) } : {}) : false;
  // Before an agent is active it has no turns to speak of; gas is what can hold its setup up (onboarding.ts).
  if (f.agentStatus !== 'active') return out;

  const own = f.own === true;
  // An own coin never sleeps for fuel (the tick wakes one that was asleep when it became own): it is never told so.
  const asleep = !own && f.runtime?.status === 'sleeping';
  out.agent_asleep = asleep ? {} : false;
  const stopped: NotificationData | null =
    f.runtime?.status === 'paused'
      ? { reason: f.runtime.pausedBy === 'guardian' ? 'paused_onchain' : 'paused_by_bootr' }
      : f.runtime?.status === 'held'
        ? { reason: 'blocked' }
        : // Failing turns are hosted turns that crashed or could not buy a thought; a count left from hosted days says nothing of an own coin.
          !own && (f.runtime?.failures ?? 0) >= FAILING_TURNS
          ? { reason: 'failing', failures: f.runtime!.failures }
          : null;
  out.agent_stopped = stopped ?? false;
  if (own) {
    // Fuel pays for an own coin's paid services only; a call without it is refused in plain words to the client itself
    // (services.ts). No thought is bought, so there is no runway to warn about and no model to be unavailable.
    out.fuel_low = false;
    out.model_unavailable = false;
  } else if (asleep) {
    // Asleep already says it: no second message about the same empty tank.
    out.fuel_low = false;
  } else if (f.fuel) {
    out.fuel_low = fuelLow(f.fuel, f.now) ?? false;
  }
  if (f.x?.revoked) out.x_revoked = {};
  else if (f.x?.connected) out.x_revoked = false;
  const expiresIn = f.key.validUntil === null ? null : f.key.validUntil - f.now;
  if (expiresIn !== null && expiresIn <= f.key.rotateBeforeMs) out.key_rotation = { reason: 'expiring', days: Math.max(0, Math.floor(expiresIn / DAY_MS)) };
  else if (f.key.outdated) out.key_rotation = { reason: 'outdated' };
  else out.key_rotation = false;
  return out;
}

/**
 * Whether the installed key was issued under limits older than today's: a smaller lifetime count of operations (keys
 * from before `SESSION_USEROP_LIMIT` stop for good once it is used up), or a rule layout without the gas rule.
 */
export function keyOutdated(agent: Pick<AgentRow, 'sessionPolicy' | 'permissionId'>, useropLimit: number): boolean {
  if (!agent.permissionId || !agent.sessionPolicy) return false;
  const count = Number((agent.sessionPolicy as { ratePerHour?: unknown }).ratePerHour);
  if (Number.isFinite(count) && count < useropLimit) return true;
  try {
    return !agentHasGasRule(agent);
  } catch {
    return false;
  }
}

async function reviewFacts(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string): Promise<ReviewFacts> {
  const now = ctx.now();
  const rows = await ctx.db
    .select({ createdAt: approvals.createdAt })
    .from(approvals)
    .where(and(eq(approvals.agentId, agentId), eq(approvals.status, 'pending_approval')));
  const expiries = rows.map((r) => r.createdAt.getTime() + APPROVAL_TTL_MS);
  const expiring = expiries.filter((e) => e - now <= REVIEW_EXPIRING_MS);
  return { pending: rows.length, expiring: expiring.length, soonestExpiry: expiring.length ? Math.min(...expiring) : null };
}

/** Brings the two review events up to date (database only): a decision or an expiry shows in the inbox at once. */
export async function refreshReviewNotifications(ctx: SupervisorContext, agent: Pick<AgentRow, 'agentId'>): Promise<void> {
  await expireApprovals(ctx, agent.agentId);
  await applyOutcomes(ctx, agent.agentId, reviewOutcomes(await reviewFacts(ctx, agent.agentId), ctx.now()));
}

/** The kernel's USDC, the spender's USDC, the EntryPoint deposit and the kernel's ETH, read in one multicall; a failed read is null. */
async function readHealthBalances(ctx: SupervisorContext, agent: AgentRow): Promise<{ reserve: bigint | null; spendable: bigint | null; deposit: bigint | null; eth: bigint | null }> {
  const kernel = agent.kernel as Address;
  const usdc = ctx.chain.addresses.usdc;
  const contracts = [
    { address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [kernel] },
    { address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.spenderFor(agent).address] },
    { address: entryPoint07Address, abi: entryPoint07Abi as Abi, functionName: 'balanceOf', args: [kernel] },
    { address: MULTICALL3_ADDRESS, abi: multicall3BalanceAbi, functionName: 'getEthBalance', args: [kernel] },
  ];
  const results = (await ctx.chain.publicClient.multicall({ contracts: contracts as never, allowFailure: true })) as unknown as ({ status: 'success'; result: unknown } | { status: 'failure'; error: unknown })[];
  const at = (i: number): bigint | null => (results[i]?.status === 'success' ? (results[i]!.result as bigint) : null);
  return { reserve: at(0), spendable: at(1), deposit: at(2), eth: at(3) };
}

async function readFuelFacts(ctx: SupervisorContext, agent: AgentRow, balances: { reserve: bigint | null; spendable: bigint | null }): Promise<FuelFacts | null> {
  try {
    if (balances.reserve === null || balances.spendable === null) throw new Error('balance read failed');
    const [recent, week] = await Promise.all([recentThoughtCost(ctx, agent.agentId), fuelReport(ctx, agent.agentId, new Date(ctx.now() - WEEK_DAYS * DAY_MS))]);
    return {
      spendableMicro: Number(balances.spendable),
      reserveMicro: Number(balances.reserve),
      recent,
      week: {
        thoughts: week.byModel.reduce((n, r) => n + r.thoughts, 0),
        spentMicroUsdc: week.byModel.reduce((n, r) => n + Number(r.chargedMicroUsdc), 0),
        firstAt: week.firstAt ? week.firstAt.getTime() : null,
      },
    };
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err }, 'notifier: fuel read failed');
    return null;
  }
}

/** A `model_changed` notice is said once and closes by itself after a week (the agent has long been running on the new model). */
export async function expireModelChanged(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string): Promise<void> {
  const open = await ctx.db
    .select({ firstAt: notifications.firstAt })
    .from(notifications)
    .where(and(eq(notifications.agentId, agentId), eq(notifications.event, 'model_changed'), isNull(notifications.resolvedAt)))
    .limit(1);
  if (open[0] && ctx.now() - open[0].firstAt.getTime() >= MODEL_CHANGED_VISIBLE_MS) await resolveNotification(ctx, agentId, 'model_changed');
}

/** Reads everything for one agent and updates its events. */
export async function checkAgentHealth(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow | null): Promise<void> {
  await expireApprovals(ctx, agent.agentId);
  await expireModelChanged(ctx, agent.agentId);
  const active = agent.status === 'active';
  const own = isOwn(agent);
  // One multicall for the four balances (it was four requests): the RPC key is shared with the indexer's block tail.
  const balances = await readHealthBalances(ctx, agent).catch((err) => {
    ctx.log.warn({ agentId: agent.agentId, err }, 'notifier: balance read failed');
    return { reserve: null, spendable: null, deposit: null, eth: null };
  });
  const gas = balances.deposit !== null && balances.eth !== null ? gasReading({ deposit: balances.deposit, balance: balances.eth, minWei: BigInt(ctx.config.GAS_MIN_WEI), selfFunded: gasSelfFunded(ctx.config) }).status : null;
  const [reviews, fuel, x] = await Promise.all([
    reviewFacts(ctx, agent.agentId),
    // An own coin's thought figures are never read: nothing is told from them.
    active && !own ? readFuelFacts(ctx, agent, balances) : Promise.resolve(null),
    active ? ctx.sender.account(agent.agentId).catch(() => null) : Promise.resolve(null),
  ]);
  const outcomes = evaluateHealth({
    now: ctx.now(),
    agentStatus: agent.status,
    runtime,
    reviews,
    fuel,
    gas,
    gasFromCreatorOnly: agentSource(agent) === 'clanker-v5' && pairedAssetOf(ctx, clankerV5QuoteOf(agent)) === 'USDC',
    x,
    key: {
      validUntil: agent.sessionValidUntil ? agent.sessionValidUntil.getTime() : null,
      rotateBeforeMs: ctx.config.SESSION_ROTATE_BEFORE_DAYS * DAY_MS,
      outdated: keyOutdated(agent, ctx.config.SESSION_USEROP_LIMIT),
    },
    ...(own ? { own: true } : {}),
  });
  await applyOutcomes(ctx, agent.agentId, outcomes);
}

/** The agents whose last check is oldest, up to `CHECK_BATCH`; one that fails is logged and the rest go on. */
export async function sweepHealth(ctx: SupervisorContext): Promise<number> {
  const now = new Date(ctx.now());
  const stale = new Date(ctx.now() - ctx.config.NOTIFY_CHECK_MS);
  const rows = await ctx.db
    .select({ agent: agents, runtime: runtimes })
    .from(agents)
    .leftJoin(runtimes, eq(runtimes.agentId, agents.agentId))
    .leftJoin(notificationSettings, eq(notificationSettings.agentId, agents.agentId))
    .where(and(inArray(agents.status, ['onboarding', 'active']), or(isNull(notificationSettings.checkedAt), lt(notificationSettings.checkedAt, stale))))
    .orderBy(sql`${notificationSettings.checkedAt} asc nulls first`)
    .limit(CHECK_BATCH);
  for (const { agent, runtime } of rows) {
    try {
      await checkAgentHealth(ctx, agent, runtime);
    } catch (err) {
      ctx.log.warn({ agentId: agent.agentId, err }, 'notifier: agent check failed');
    }
    await ctx.db
      .insert(notificationSettings)
      .values({ agentId: agent.agentId, checkedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: notificationSettings.agentId, set: { checkedAt: now } });
  }
  return rows.length;
}

export interface NotifierReport extends FlushReport {
  checked: number;
}

/** One pass of the notifier: its own timer calls this (index.ts), never the tick. Never throws. */
export async function notifierPass(ctx: SupervisorContext): Promise<NotifierReport> {
  let checked = 0;
  try {
    checked = await sweepHealth(ctx);
    await pruneNotifications(ctx);
  } catch (err) {
    ctx.log.warn({ err }, 'notifier sweep failed');
  }
  return { checked, ...(await flushNotifications(ctx)) };
}
