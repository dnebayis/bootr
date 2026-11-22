/**
 * The quiet slot for the platform account (docs/design/agent-behaviour.md rule R9 and stage 5): a due original-post
 * slot of @AgentBootr buys no turn when nothing is new for it. quiet-slot.ts is the same rule for coin agents, where
 * "new" is read from the coin; here it is read from what the platform account writes about, and above all from the
 * dataset's records.
 *
 * On only while all of these hold, so it can never take a slot from an account the dataset is not feeding:
 *   - the deployment's quiet slot is on (`QUIET_SLOT`) and the dataset is on (`DATASET_ENABLED=true`, records-turn.ts
 *     `recordsOn`: the platform account, X publishing on, `PLATFORM_RECORDS` above 0);
 *   - the dataset really handed this account a record in a turn of the last day (`sv_records_served`,
 *     dataset/served.ts `servedLately`). A dataset that is on but empty, stuck or serving nothing that fits leaves
 *     the account exactly as it was before this file: every due slot is a turn. The owner's complaint is that the
 *     account posts too rarely, so the rule switches itself off the day the dataset stops being a source of posts.
 *
 * What counts as new, any one of:
 *   - a mention that may wake the account is waiting, its settings changed, an X hold just ended, the creator (the
 *     owner) asked for something;
 *   - a platform update waits to be announced, or the daily numbers post or the weekly digest is due (they ride a
 *     turn of their own, and a skipped slot must never be the reason one is late);
 *   - the watchlist has something: a handle that was never read or is due for a read (the reads happen in a turn, so
 *     skipping would also stop them), or a watched post newer than the last slot;
 *   - the serving seam has a record in its beat that the account has not posted, not cited in a post that waits and
 *     not passed over `OFFERS_MAX` times (dataset/serve.ts). Those records are handed to the turn the slot buys, so the
 *     seam is asked once.
 * The first slot after the rule switches on, and any slot once the account has neither posted nor used a slot for
 * the ceiling (`QUIET_SLOT_MAX_QUIET_MS`, a day unless set otherwise), is never skipped.
 *
 * A skipped slot is spent the way quiet-slot.ts spends one (`lastSlotSkippedAt`), with no model call and nothing
 * written but the runtime's state. A read that fails keeps the slot.
 */
import type { AgentConfig } from '@bootr/agent-core';
import type { AgentRow, SupervisorContext } from './context.js';
import { openRequests } from './creator-requests.js';
import type { ServedRecord } from './dataset/serve.js';
import { servedLately } from './dataset/served.js';
import { numbersDue, parseNumbersAt } from './platform-numbers.js';
import { pendingUpdate } from './platform-updates.js';
import { quietCeilingMs, quietTooLong, settledMark, type QuietOutcome, type QuietReason, type QuietSignals, type QuietState } from './quiet-slot.js';
import { recordsInBeat, recordsOn } from './records-turn.js';
import type { AgentState } from './runtime.js';
import { parseWatchlist, watchlistNews } from './watchlist.js';
import { digestDue, parseDigestAt } from './weekly-digest.js';

const DAY_MS = 86_400_000;
/** How far back a record handed to the account keeps the rule on. */
export const PLATFORM_QUIET_SERVED_WITHIN_MS = DAY_MS;

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'log' | 'config'>;
type PlatformState = QuietState & Pick<AgentState, 'lastNumbersDay' | 'lastDigestWeek' | 'lastUpdateDay' | 'announcedUpdates'>;

/** The part of the switch that needs no read: the deployment's quiet slot and the dataset are on, and this is the platform account. */
export function platformQuietOn(ctx: { config?: { QUIET_SLOT?: unknown; DATASET_ENABLED?: unknown; PLATFORM_RECORDS?: unknown } | null }, config: Pick<AgentConfig, 'platform' | 'capabilities'>): boolean {
  return ctx.config?.QUIET_SLOT === true && recordsOn(ctx, config);
}

/** The numbers post or the weekly digest is due now (each rides a turn of its own). A setting that does not parse counts as due: the slot is kept. Pure. */
export function platformPostDue(ctx: { config?: { PLATFORM_NUMBERS_AT?: unknown; PLATFORM_DIGEST_AT?: unknown } | null }, state: Pick<AgentState, 'lastNumbersDay' | 'lastDigestWeek'>, now: number): 'numbers_due' | 'digest_due' | null {
  try {
    if (numbersDue(parseNumbersAt(String(ctx.config?.PLATFORM_NUMBERS_AT ?? '')), state.lastNumbersDay ?? null, now)) return 'numbers_due';
    if (digestDue(parseDigestAt(String(ctx.config?.PLATFORM_DIGEST_AT ?? '')), state.lastDigestWeek ?? null, now)) return 'digest_due';
    return null;
  } catch {
    return 'numbers_due';
  }
}

/**
 * Whether the watchlist has something for a turn: a handle never read or due for a read, or a watched post newer than
 * `since` (epoch ms; null: any post is). One read of `sv_cursors`; none without the X read power or a list.
 */
export async function watchlistHasNews(ctx: Ctx, config: Pick<AgentConfig, 'capabilities'>, since: number | null): Promise<boolean> {
  if (!config.capabilities.xRead) return false;
  // The read itself is the one a coin's quiet slot makes for its own list (watchlist.ts `watchlistNews`).
  return watchlistNews(ctx, parseWatchlist(ctx.config.PLATFORM_WATCHLIST), since);
}

/** What the platform account's quiet slot decided; `records`: what the seam found, for the turn the slot buys. */
export interface PlatformQuietOutcome extends QuietOutcome {
  records?: ServedRecord[];
}

/**
 * Asks the rule for a due slot of the platform account. Nothing is read for a slot that is not due, while the rule is
 * off, or when a mention, a changed setting, an ended hold, an update, the numbers post or the digest already makes
 * the slot new. With nothing new the slot is marked spent on `state`; the caller persists it. Never throws.
 */
export async function platformQuietSlot(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'token'>, config: Pick<AgentConfig, 'platform' | 'capabilities'>, state: PlatformState, signals: QuietSignals): Promise<PlatformQuietOutcome> {
  if (!signals.due || !platformQuietOn(ctx, config)) return { skipped: false, reasons: [] };
  const now = ctx.now();
  const known: QuietReason[] = [];
  if (signals.mentionWaiting) known.push('mention');
  if (signals.configChanged) known.push('config_changed');
  if (state.postHoldEndedNote?.at != null) known.push('hold_ended');
  if (signals.platformUpdate || pendingUpdate(state, now)) known.push('platform_update');
  const post = platformPostDue(ctx, state, now);
  if (post) known.push(post);
  if (known.length) return { skipped: false, reasons: known };
  try {
    if (!(await servedLately(ctx.db, agent.agentId, now - PLATFORM_QUIET_SERVED_WITHIN_MS))) return { skipped: false, reasons: ['records_unserved'] };
    const creatorRequest = signals.creatorRequest ?? (await openRequests(ctx, agent.agentId, 'social')).length > 0;
    if (creatorRequest) return { skipped: false, reasons: ['creator_request'] };
    const mark = settledMark(state);
    if (!mark) return { skipped: false, reasons: ['first_slot'] };
    if (quietTooLong(state, mark, now, quietCeilingMs(ctx))) return { skipped: false, reasons: ['quiet_ceiling'] };
    const records = await recordsInBeat(ctx, agent, config);
    if (records.length) return { skipped: false, reasons: ['new_record'], records };
    if (await watchlistHasNews(ctx, config, mark.at)) return { skipped: false, reasons: ['watchlist'] };
    state.lastSlotSkippedAt = now;
    state.quietSeen = null;
    state.quietSkipped = { count: (state.quietSkipped?.count ?? 0) + 1, lastAt: now };
    ctx.log.info({ agentId: agent.agentId, since: new Date(mark.at).toISOString(), inARow: state.quietSkipped.count }, 'quiet slot: no record, mention or other news for the platform account; no turn bought');
    return { skipped: true, reasons: [], records: [] };
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err: err instanceof Error ? err.message : String(err) }, 'platform quiet slot: the check failed; the slot is kept');
    return { skipped: false, reasons: ['check_failed'] };
  }
}

/** Records what a platform turn that starts with a due slot is shown, while the rule is on: the mark the next slot is measured from. Mutates `state`. */
export function markPlatformQuietSlot(ctx: { config?: { QUIET_SLOT?: unknown; DATASET_ENABLED?: unknown; PLATFORM_RECORDS?: unknown } | null }, config: Pick<AgentConfig, 'platform' | 'capabilities'>, state: QuietState, now: number): void {
  if (!platformQuietOn(ctx, config)) return;
  state.quietSeen = { at: now, holders: null };
  state.quietSkipped = null;
}
