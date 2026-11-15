/**
 * The quiet slot (docs/design/agent-behaviour.md rule R9 and stage 3): a due original-post slot of a coin agent buys
 * no turn when nothing is new since the agent last had one. Before this a slot woke the agent whatever had happened,
 * and an agent whose coin stood still read around, wrote a note and posted its holder count again: one coin gave
 * "112 holders" in four posts out of five.
 *
 * What counts as new, any one of:
 *   - its own coin changed, read from what the turn's own-coin sections show (`market.snapshot`, `coinToday`):
 *       holders: the count moved by one holder or by 1% of the count (rounded down), whichever is more, against the
 *         count the agent was shown at its last slot (one holder is news on a coin of six or of 112, a flicker on a
 *         coin of five thousand, where it takes fifty);
 *       a trade: the index holds a trade made after that slot (a trade is the only thing that moves the coin's volume,
 *         fees and price, so with none of them since, the other figures only changed because a day-old trade left
 *         the 24-hour window);
 *       a milestone of the coin reached after that slot (the kinds `coinToday` names);
 *   - a mention is waiting that may wake the agent;
 *   - the creator asked for something in the private chat that no turn has closed, or changed the agent's settings;
 *   - an X hold just ended (quota, credits, a refused account): the slot it held back is the agent's to use;
 *   - a platform update is waiting to be announced (the platform account's section; a coin agent is never shown one).
 * A coin the index says nothing about (no holder count and no trade list, or no answer at all) is not known to be
 * unchanged: its slot is never skipped. Neither is the first slot of an agent that has no mark yet.
 *
 * "Since the agent last had a slot", not "since its last post". A turn that starts with a due slot records what it
 * was shown (`AgentState.quietSeen`: when, and the holders), and once that slot is used (the turn posted, or finished
 * without a post) the record becomes the mark the next slot is measured against (`quietMark`). An agent that was
 * shown a change and chose not to post about it has passed on it; the same change does not buy the next slot's turn
 * again. A turn that never got to use its slot (the model did not answer, the runtime cut it short) leaves the mark
 * where it was, so what was new for it is still new when the slot is tried again. When the turn posts, "since its
 * last slot" and "since its last post" are the same.
 *
 * The ceiling on quiet (`QUIET_SLOT_MAX_QUIET_MS`, a day unless set otherwise; 0 = none): a slot is not skipped once
 * the agent's last original post and the last slot a turn of its used are both older than that. A coin where nothing
 * changes then still gets a turn about once a day, and its creator does not take it for dead. That turn is told
 * nothing special: the repeat rules still hold, so it finds something else to say or finishes without a post, and
 * either way the day starts again.
 *
 * A skipped slot is spent the way a slot is that the agent passed on (`lastSlotSkippedAt`): the next slot is the next
 * chance, and nothing is asked again in between. No model is called and nothing is written but the runtime's state.
 *
 * Who gets it: hosted coin agents, unless the deployment (`QUIET_SLOT=false`) or the coin's creator (`quietSlot:
 * false` in the stored config; on when absent, so existing coins need no migration) switched it off. An own agent is
 * told by `due` that its post slot is not due under the same rule (own/social.ts). The platform account gets its own
 * version once the dataset feeds it records (platform-quiet.ts); this file never skips its slot.
 */
import type { AgentConfig } from '@bootr/agent-core';
import { COIN_BRIEF_MILESTONE_KINDS } from './coin-today.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { openRequests } from './creator-requests.js';
import { cachedPlatformFeedData, type PlatformFeedData } from './platform-feed.js';
import type { AgentState } from './runtime.js';

/** The count must move by this share of itself, and by one holder at least. */
export const QUIET_HOLDERS_SHARE = 0.01;

/** What the state keeps: when the agent had a due slot in front of it, and the holders it was shown then. */
export interface QuietMark {
  at: number;
  holders: number | null;
}

export type QuietState = Pick<AgentState, 'lastSlotSkippedAt' | 'lastPostAt'> & {
  /** What the agent was shown at the last slot it used: what "new" is measured against. */
  quietMark?: QuietMark | null;
  /** What the turn that last started with a due slot was shown; it becomes the mark once that slot is used. */
  quietSeen?: QuietMark | null;
  /** Slots skipped in a row since a turn last held one, and when the last was skipped: for the log and the console. */
  quietSkipped?: { count: number; lastAt: number } | null;
  /** runtime.ts: a hold X put on the account's posts, with `at` set once it ended and until the next turn was told. */
  postHoldEndedNote?: { at: number | null } | null;
};

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'log' | 'config' | 'indexer'>;

/** The ceiling on quiet in ms; 0 = none. A caller that holds only a part of the config has none. */
export function quietCeilingMs(ctx: { config?: { QUIET_SLOT_MAX_QUIET_MS?: unknown } | null }): number {
  const n = ctx.config?.QUIET_SLOT_MAX_QUIET_MS;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Whether the agent has been quiet for the ceiling or longer at `now`: its last original post and the last slot a
 * turn of its used (`mark`) both lie that far back. Without a mark it is the agent's first slot, which runs anyway. Pure.
 */
export function quietTooLong(state: Pick<QuietState, 'lastPostAt'>, mark: QuietMark | null, now: number, ceilingMs: number): boolean {
  if (!(ceilingMs > 0) || !mark) return false;
  return now - Math.max(state.lastPostAt ?? 0, mark.at) >= ceilingMs;
}

/** The creator's switch in a stored config: on unless it is exactly false. */
export function quietSlotOf(config: Record<string, unknown>): boolean {
  return config.quietSlot !== false;
}

/** Whether the rule applies to this agent: the deployment has it on, the creator did not switch it off, and it is not the platform account. */
export function quietSlotOn(ctx: { config?: { QUIET_SLOT?: unknown } | null }, agent: Pick<AgentRow, 'config'>): boolean {
  return ctx.config?.QUIET_SLOT === true && agent.config.platform !== true && quietSlotOf(agent.config);
}

function markOf(raw: unknown): QuietMark | null {
  const m = raw as QuietMark | null | undefined;
  if (!m || typeof m !== 'object' || typeof m.at !== 'number' || !Number.isFinite(m.at)) return null;
  return { at: m.at, holders: typeof m.holders === 'number' && Number.isFinite(m.holders) ? m.holders : null };
}

/**
 * The mark in force. What the last turn with a due slot was shown becomes the mark once its slot was used after it:
 * an original post went out or the slot was spent (`lastPostAt`, `lastSlotSkippedAt`). Mutates `state`.
 */
export function settledMark(state: QuietState): QuietMark | null {
  const seen = markOf(state.quietSeen);
  if (seen && Math.max(state.lastPostAt ?? 0, state.lastSlotSkippedAt ?? 0) >= seen.at) {
    state.quietMark = seen;
    state.quietSeen = null;
  }
  return markOf(state.quietMark);
}

const whole = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/** The coin as the index shows it now: the holders, and when its newest trade was made (epoch ms); null fields where the index does not say. */
export interface OwnCoinNow {
  holders: number | null;
  /** Null when the index lists no trade; `known` says whether it lists trades at all. */
  lastTradeAt: number | null;
  tradesKnown: boolean;
}

/** Reads `GET /market/<token>` as the turn's snapshot holds it. Null when there is no answer. Pure. */
export function ownCoinNow(market: Record<string, unknown> | null | undefined): OwnCoinNow | null {
  if (!market || typeof market !== 'object') return null;
  const trades = Array.isArray(market.trades) ? (market.trades as { timestamp?: unknown }[]) : null;
  // The index gives a trade's time in seconds.
  const times = (trades ?? []).map((t) => whole(t?.timestamp)).filter((t): t is number => t !== null);
  return { holders: whole(market.holders), lastTradeAt: times.length ? Math.max(...times) * 1000 : null, tradesKnown: trades !== null };
}

/** When the coin's newest milestone of a kind the brief names was reached (epoch ms), from the platform feed; null when there is none or no feed. */
export function lastMilestoneAt(feed: PlatformFeedData | null | undefined, agent: Pick<AgentRow, 'token' | 'kernel'>, now: number): number | null {
  const own = (m: { token?: unknown; kernel?: unknown }) => (typeof m.token === 'string' && m.token.toLowerCase() === agent.token.toLowerCase()) || (typeof m.kernel === 'string' && m.kernel.toLowerCase() === agent.kernel.toLowerCase());
  const times = (Array.isArray(feed?.milestones) ? feed!.milestones! : []).filter((m) => m && own(m) && COIN_BRIEF_MILESTONE_KINDS.includes(String(m.kind)) && typeof m.at === 'number' && Number.isFinite(m.at) && m.at * 1000 <= now + 60_000).map((m) => m.at * 1000);
  return times.length ? Math.max(...times) : null;
}

export type QuietReason =
  | 'mention'
  | 'creator_request'
  | 'config_changed'
  | 'hold_ended'
  | 'platform_update'
  | 'quiet_ceiling'
  | 'first_slot'
  | 'coin_unknown'
  | 'holders_changed'
  | 'new_trade'
  | 'new_milestone'
  // the platform account's (platform-quiet.ts)
  | 'numbers_due'
  | 'digest_due'
  | 'records_unserved'
  | 'new_record'
  | 'watchlist'
  | 'check_failed';

export interface QuietInput {
  /** The mark of the agent's last slot; null when it never had one. */
  mark: QuietMark | null;
  /** The coin now; null when the index did not answer. */
  coin: OwnCoinNow | null;
  /** The coin's newest milestone (epoch ms), when the feed was read. */
  milestoneAt?: number | null;
  mentionWaiting?: boolean;
  creatorRequest?: boolean;
  configChanged?: boolean;
  /** An X hold ended and the next turn has not been told yet. */
  holdEnded?: boolean;
  platformUpdate?: boolean;
}

/** What is new whatever the coin did: somebody wrote, the creator asked or changed something, a hold ended, an update waits. Pure. */
function newBesideTheCoin(input: Pick<QuietInput, 'mentionWaiting' | 'creatorRequest' | 'configChanged' | 'holdEnded' | 'platformUpdate'>): QuietReason[] {
  const reasons: QuietReason[] = [];
  if (input.mentionWaiting) reasons.push('mention');
  if (input.creatorRequest) reasons.push('creator_request');
  if (input.configChanged) reasons.push('config_changed');
  if (input.holdEnded) reasons.push('hold_ended');
  if (input.platformUpdate) reasons.push('platform_update');
  return reasons;
}

/** Everything that is new for a due slot, in the order the rule lists it; empty = nothing is new and the slot buys no turn. Pure. */
export function whatIsNew(input: QuietInput): QuietReason[] {
  const reasons = newBesideTheCoin(input);
  const { mark, coin } = input;
  if (!mark) reasons.push('first_slot');
  // No answer, or an answer with neither a holder count nor a trade list: nothing says the coin stood still.
  if (!coin || (coin.holders === null && !coin.tradesKnown)) reasons.push('coin_unknown');
  if (mark && coin) {
    if (coin.holders !== null && (mark.holders === null || Math.abs(coin.holders - mark.holders) >= Math.max(1, Math.floor(mark.holders * QUIET_HOLDERS_SHARE)))) reasons.push('holders_changed');
    if (coin.lastTradeAt !== null && coin.lastTradeAt > mark.at) reasons.push('new_trade');
    if (typeof input.milestoneAt === 'number' && input.milestoneAt > mark.at) reasons.push('new_milestone');
  }
  return reasons;
}

export interface QuietSignals {
  /** The slot is due and a turn would be bought for it now: the schedule says so, nothing holds it, no turn is open. */
  due: boolean;
  /** A mention that may wake the agent is waiting. */
  mentionWaiting: boolean;
  /** The stored config changed since the agent's last turn. */
  configChanged: boolean;
  /** An open request of the creator for the social turn; read here when the caller did not. */
  creatorRequest?: boolean;
  /** A platform update waits to be announced (the platform account only). */
  platformUpdate?: boolean;
}

export interface QuietOutcome {
  /** The slot was spent without a turn: the caller writes the state and reads the schedule again. */
  skipped: boolean;
  reasons: QuietReason[];
  /** The market snapshot, when it was read here: the caller hands it to the turn instead of reading it again. */
  market?: Record<string, unknown> | null;
}

/**
 * Asks the rule for a due slot. Nothing is read for a slot that is not due, for an agent the rule does not apply to,
 * or when a mention or a changed config already makes it new. Otherwise: the creator's open requests (one database
 * read, unless the caller knows), the coin's market snapshot (one indexer read, handed back), and the platform feed
 * the tick already caches. With nothing new the slot is marked spent on `state`; the caller persists it. Never throws:
 * a read that fails is "not known to be unchanged", and the turn is bought as before.
 */
export async function quietSlot(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'token' | 'kernel' | 'config'>, state: QuietState, signals: QuietSignals): Promise<QuietOutcome> {
  if (!signals.due || !quietSlotOn(ctx, agent)) return { skipped: false, reasons: [] };
  // What the caller already knows comes first: it costs no read.
  const known = newBesideTheCoin({ ...signals, holdEnded: state.postHoldEndedNote?.at != null });
  if (known.length) return { skipped: false, reasons: known };
  const now = ctx.now();
  try {
    const creatorRequest = signals.creatorRequest ?? (await openRequests(ctx, agent.agentId, 'social')).length > 0;
    if (creatorRequest) return { skipped: false, reasons: ['creator_request'] };
    const mark = settledMark(state);
    // Quiet for a day (the ceiling): the slot is the agent's whatever the coin did, and nothing more is read for it.
    if (quietTooLong(state, mark, now, quietCeilingMs(ctx))) return { skipped: false, reasons: ['quiet_ceiling'] };
    // A read that throws is left to the caller's own read of the snapshot (the catch below): this check only declines to skip.
    const market = (await ctx.indexer.market(agent.token)) as Record<string, unknown> | null;
    const coin = ownCoinNow(market);
    let reasons = whatIsNew({ mark, coin });
    // The feed is asked last, and only when nothing else is new: the tick caches it, so this is seldom a read of its own.
    if (!reasons.length) reasons = whatIsNew({ mark, coin, milestoneAt: lastMilestoneAt(await cachedPlatformFeedData(ctx).catch(() => null), agent, now) });
    if (reasons.length) return { skipped: false, reasons, market };
    state.lastSlotSkippedAt = now;
    // A record of a turn that never used its slot is not what the agent was last shown: it goes with the slot.
    state.quietSeen = null;
    state.quietSkipped = { count: (state.quietSkipped?.count ?? 0) + 1, lastAt: now };
    ctx.log.info({ agentId: agent.agentId, holders: coin?.holders ?? null, since: mark ? new Date(mark.at).toISOString() : null, inARow: state.quietSkipped.count }, 'quiet slot: nothing is new since the last slot; no turn bought');
    return { skipped: true, reasons: [], market };
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err: err instanceof Error ? err.message : String(err) }, 'quiet slot: the check failed; the slot is kept');
    return { skipped: false, reasons: ['coin_unknown'] };
  }
}

/**
 * For an own agent, whose wake is its client's own and is not moved by the server: the wake the client asked for at
 * its last finish was the slot the rule then spent (a coin agent's wake never comes before its slot), so that wake
 * alone no longer makes the role due. Returns the time before which it does not (the next slot), or 0 when no slot
 * was spent since that wake was set.
 */
export function quietWakeFloor(state: QuietState, wakeAt: number, nextSlotAt: number | null | undefined): number {
  return state.quietSkipped && wakeAt <= state.quietSkipped.lastAt && typeof nextSlotAt === 'number' ? nextSlotAt : 0;
}

/**
 * Records what a turn that starts with a due slot is shown (`market`: the snapshot the turn gets). Once the turn uses
 * its slot this is what "new" is measured against (`settledMark`). Mutates `state`; the turn's own write persists it.
 * A coin the rule does not apply to keeps no record.
 */
export function markQuietSlot(ctx: { config?: { QUIET_SLOT?: unknown } | null }, agent: Pick<AgentRow, 'config'>, config: Pick<AgentConfig, 'platform'>, state: QuietState, market: Record<string, unknown> | null | undefined, now: number): void {
  if (config.platform === true || !quietSlotOn(ctx, agent)) return;
  const coin = ownCoinNow(market);
  // A snapshot that does not say keeps the count the last one did: one silent read must not make the next count look new.
  state.quietSeen = { at: now, holders: coin?.holders ?? settledMark(state)?.holders ?? null };
  state.quietSkipped = null;
}
