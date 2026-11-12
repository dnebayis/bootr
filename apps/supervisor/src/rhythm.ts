/**
 * Platform posting rhythm: the rules that sit between an agent's own original-post cadence (agent-core
 * `originalPostSchedule`: anchor + interval) and the moment a post actually goes out, so Bootr's agents do not
 * all post in the same minute and the launchpad keeps quiet hours.
 *
 * 1. Jitter: every agent's slot is pushed later by a fixed offset derived from its kernel address (up to 20 % of
 *    its interval). Two agents with the same cadence therefore sit at different minutes and, because the next
 *    slot anchors on the last post, drift further apart with every post. The cadence itself (anchor, interval)
 *    is untouched.
 * 2. Slots: at most `PLATFORM_POST_SLOTS_PER_10M` original posts across every Bootr agent per ten-minute
 *    window, counted from `sv_actions`. A due post that finds the window full waits for a later tick; the
 *    agent's slot is kept (nothing in its schedule moves), so it is not a skipped slot.
 * 3. Quiet hours: `PLATFORM_QUIET_HOURS_UTC` (`02-06`). Original posts wait until the window ends; replies are
 *    never held by the rhythm.
 *
 * The wake side (`applyRhythm`, called from tick.ts) turns a held slot into `mayCompose: false` so the schedule
 * does not wake the agent; the publish side (`originalPostGate`, called by the broker on `publish_post`) refuses
 * the post with a clear tool error if the agent tries anyway or if the window filled up meanwhile.
 *
 * 4. X quota (per agent): when the sender refuses a publish with `quota_exceeded`, the runtime keeps its
 *    `retryAt` (`AgentState.postQuotaUntil`) and the tick neither wakes the agent for a post nor for a mention
 *    until then (`quotaHold` / `applyQuotaHold`), so no model turn is bought for a post that cannot go out.
 * 5. X credits (the X app's pay-per-use credits): when X answers 402 `credits depleted` to a publish or to a
 *    mention read, the same hold applies with reason `x_credits` (`creditsHold`). There is no `retryAt`: a publish
 *    holds for `X_CREDITS_RETRY_MS`, and a mention read that still answers 402 holds the current tick.
 * 6. X forbids the account (403 "not permitted", not a duplicate): the account is locked, restricted or its token
 *    lost write access, which no retry fixes. The same hold applies with reason `x_forbidden` for hours
 *    (`forbiddenHoldMs`, doubling on each repeat up to a day), the creator is told (`x_forbidden` notification), and
 *    a publish that later goes through clears both.
 * 7. Every X hold message ends with `HOLD_AGENDA_NOTE`, and the first turn after a hold (ran out, cleared, or a 403 lifted by
 *    the creator's reconnect) opens with `holdEndedMessage` once (runtime.ts `postHoldEndedNote`), so a note the model
 *    wrote itself during the hold ("do not post until the platform recovers") does not outlive it.
 */
import { originalPostSchedule, publicChannelBlocked, sha256Hex, type AgentConfig, type PostSchedule } from '@bootr/agent-core';
import { and, gt, inArray, ne, sql } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { actions } from './db/schema.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** The slot window: `PLATFORM_POST_SLOTS_PER_10M` original posts platform-wide per this long. */
export const SLOT_WINDOW_MS = 10 * 60_000;
/** The jitter never exceeds this share of the agent's own interval. */
export const MAX_JITTER_FRACTION = 0.2;

// ---------------------------------------------------------------------------
// Jitter
// ---------------------------------------------------------------------------

/**
 * Deterministic per-agent offset in [0, 20 % of the interval): the first 32 bits of sha256(kernel) scaled to the
 * interval. Pure, so two supervisors (or two restarts) agree on it; the kernel address is the agent's stable id.
 */
export function jitterMs(kernel: string, intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  const word = parseInt(sha256Hex(`bootr-rhythm:${kernel.trim().toLowerCase()}`).slice(0, 8), 16);
  return Math.floor((word / 0x1_0000_0000) * MAX_JITTER_FRACTION * intervalMs);
}

export type HoldReason = 'quiet_hours' | 'no_slot' | 'x_quota' | 'x_credits' | 'x_forbidden';

export interface Hold {
  reason: HoldReason;
  /** Epoch ms when it is worth trying again (end of the quiet window; the next tick for a full slot window). */
  until: number;
  /** The tool error / observation note, in the model's words. */
  message: string;
}

/** The agent's cadence with the platform rhythm applied. */
export interface RhythmSchedule extends PostSchedule {
  jitterMs: number;
  /** The cadence's own verdict (before quiet hours and slots). */
  dueByCadence: boolean;
  /** False while the post is held: the schedule then neither wakes the agent nor tells it to post. */
  mayCompose: boolean;
  held: Hold | null;
}

/**
 * `originalPostSchedule` with the agent's jitter added to the slot. Null when publishing is off for this agent
 * (no capability, an owner rule closed the channel, or the social loop has not started).
 */
export function jitteredSchedule(config: AgentConfig, lastPostAt: number | null, now: number): RhythmSchedule | null {
  if (!config.capabilities.xPublish || publicChannelBlocked(config.ownerRules, 'publish_post') || !config.socialStartedAt) return null;
  const base = originalPostSchedule(config.socialStartedAt, lastPostAt, now, config.postIntervalMs);
  const jitter = jitterMs(config.kernel.address, base.intervalMs);
  const nextAt = base.nextAt + jitter;
  const due = now >= nextAt;
  return {
    ...base,
    nextAt,
    nextAtIso: new Date(nextAt).toISOString(),
    due,
    missedIntervals: due ? Math.floor((now - nextAt) / base.intervalMs) : 0,
    jitterMs: jitter,
    dueByCadence: due,
    mayCompose: true,
    held: null,
  };
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

export interface QuietHours {
  /** Start hour (UTC, inclusive, 0..23). */
  start: number;
  /** End hour (UTC, exclusive, 1..24). `end <= start` wraps past midnight. */
  end: number;
}

/** `HH-HH` in UTC (`02-06`, `2-6`, `22-06`, `22-24`); null when unset or empty. Throws on anything else. */
export function parseQuietHours(spec: string | null | undefined): QuietHours | null {
  const text = (spec ?? '').trim();
  if (!text) return null;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!m) throw new Error(`invalid PLATFORM_QUIET_HOURS_UTC: ${text} (expected HH-HH in UTC, e.g. 02-06)`);
  const startRaw = Number(m[1]);
  const endRaw = Number(m[2]);
  if (startRaw > 24 || endRaw > 24) throw new Error(`invalid PLATFORM_QUIET_HOURS_UTC: ${text} (hours run 0..24)`);
  const start = startRaw % 24;
  const end = endRaw === 0 ? 24 : endRaw;
  if (start === end % 24) throw new Error(`invalid PLATFORM_QUIET_HOURS_UTC: ${text} (start and end must differ)`);
  return { start, end };
}

/** Epoch ms when the current quiet window ends, or null when `now` is outside it (or there are no quiet hours). */
export function quietUntil(hours: QuietHours | null, now: number): number | null {
  if (!hours) return null;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const startAt = dayStart + hours.start * HOUR_MS;
  const endAt = dayStart + hours.end * HOUR_MS;
  if (hours.start < hours.end) return now >= startAt && now < endAt ? endAt : null;
  // Wraps midnight: [start, 24) today, or [0, end) today.
  if (now >= startAt) return endAt + DAY_MS;
  if (now < endAt) return endAt;
  return null;
}

export function formatQuietHours(hours: QuietHours): string {
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return `${hh(hours.start)}-${hh(hours.end)} UTC`;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * Original posts (any Bootr agent) decided in the last slot window: in flight or sent. A refused post is not one, and
 * neither is a post queued for its creator's review (approvals.ts records it `completed` with `queued: true`): it has
 * not reached X and may never. The slot is counted when an approved post is sent, by the row `decideApproval` writes
 * then. Counting the queued row let one coin in approval mode fill the window for every agent with posts nobody saw.
 */
export async function slotsUsed(ctx: Pick<SupervisorContext, 'db'>, now: number, opts: { excludeActionId?: string } = {}): Promise<number> {
  const since = new Date(now - SLOT_WINDOW_MS);
  const rows = await ctx.db
    .select({ actionId: actions.actionId })
    .from(actions)
    .where(
      and(
        gt(actions.createdAt, since),
        inArray(actions.status, ['sending', 'sent', 'completed']),
        sql`${actions.action}->>'tool' = 'publish_post'`,
        sql`coalesce(${actions.result}->'result'->>'queued', 'false') <> 'true'`,
        ...(opts.excludeActionId ? [ne(actions.actionId, opts.excludeActionId)] : []),
      ),
    );
  return rows.length;
}

export type PostGate = { open: true } | { open: false; hold: Hold };

/**
 * Whether an original post may go out right now, platform-wide. Quiet hours first (cheap, no read), then the
 * slot count. `excludeActionId` is the caller's own in-flight `publish_post` row, which must not count against it.
 */
export async function originalPostGate(ctx: Pick<SupervisorContext, 'db' | 'config'>, now: number, opts: { excludeActionId?: string } = {}): Promise<PostGate> {
  const hours = parseQuietHours(ctx.config.PLATFORM_QUIET_HOURS_UTC);
  const quiet = quietUntil(hours, now);
  if (quiet !== null && hours) {
    return {
      open: false,
      hold: {
        reason: 'quiet_hours',
        until: quiet,
        message: `quiet_hours: original posts wait during Bootr's quiet hours (${formatQuietHours(hours)}); the next window opens at ${new Date(quiet).toISOString()}. Replies may still go out. Do not post now; your slot is kept and the schedule wakes you when it opens.`,
      },
    };
  }
  const limit = ctx.config.PLATFORM_POST_SLOTS_PER_10M;
  const used = await slotsUsed(ctx, now, opts);
  if (used >= limit) {
    return {
      open: false,
      hold: {
        reason: 'no_slot',
        until: now + ctx.config.SUPERVISOR_TICK_MS,
        message: `no_slot: Bootr's posting window is full (${used} original post${used === 1 ? '' : 's'} across all agents in the last 10 minutes, limit ${limit}). Your slot is kept: do not post now; you will be woken when a slot is free.`,
      },
    };
  }
  return { open: true };
}

/**
 * The wake-side rule: a due slot that the platform cannot take right now becomes a held schedule (`due: false`,
 * `mayCompose: false`, `held` says why and until when). Nothing in the agent's cadence moves, so the post is due
 * again on the next tick. A schedule that is not due passes through untouched (one DB read saved per agent).
 */
export async function applyRhythm(ctx: Pick<SupervisorContext, 'db' | 'config'>, schedule: RhythmSchedule | null, now: number): Promise<RhythmSchedule | null> {
  if (!schedule || !schedule.due) return schedule;
  const gate = await originalPostGate(ctx, now);
  if (gate.open) return schedule;
  return { ...schedule, due: false, mayCompose: false, missedIntervals: 0, held: gate.hold };
}

/**
 * Closes every X hold message (`quotaHold`, `creditsHold`, `forbiddenHold`). On 2026-11-09 one agent wrote "X platform
 * blocker, do not post until the platform recovers" into its agenda during a 403 hold, and when the hold was lifted it
 * trusted that note over the new observation and passed on its slot. The model is told to keep the hold as a dated
 * entry, and `holdEndedMessage` tells it when the hold is over.
 */
export const HOLD_AGENDA_NOTE = 'Note the time it ends in your agenda, not as a permanent fact: you will be told when it ends.';

/**
 * The agent's own X posting quota (apps/sender: posts + replies per rolling 24 h) is used up: the last publish was
 * refused with `sender:quota_exceeded` and `until` is the sender's `retryAt`. Null once that time has passed.
 */
export function quotaHold(until: number | null | undefined, now: number): Hold | null {
  if (!until || !Number.isFinite(until) || until <= now) return null;
  const at = new Date(until).toISOString();
  return {
    reason: 'x_quota',
    until,
    message: `x_quota: your X posting quota (original posts and replies in the last 24 hours) is used up until ${at}. publish_post and publish_reply fail until then: do not call them. Mentions wait for you; you are woken when the quota opens. ${HOLD_AGENDA_NOTE}`,
  };
}

/** How long a 402 `credits depleted` publish holds the agent before one new try (X sends no retry time). */
export const X_CREDITS_RETRY_MS = 30 * 60_000;

/** X refused for lack of credits (HTTP 402): a publish error (`sender_rejected:http_402...`) or a read (`x_http_402`). */
export function isXCreditsError(error: string | null | undefined): boolean {
  return !!error && /(^|[^0-9])http_402(?![0-9])|credits depleted/i.test(error);
}

/** The X app is out of credits until `until` (a guess, see `X_CREDITS_RETRY_MS`). Null once that time has passed. */
export function creditsHold(until: number | null | undefined, now: number): Hold | null {
  if (!until || !Number.isFinite(until) || until <= now) return null;
  const at = new Date(until).toISOString();
  return {
    reason: 'x_credits',
    until,
    message: `x_credits: X refuses posts and replies for now (the X app is out of API credits). publish_post and publish_reply fail: do not call them. Mentions wait for you; you are woken to try again at ${at}. ${HOLD_AGENDA_NOTE}`,
  };
}

/** The first hold after X refused a publish as forbidden (403); each repeat doubles it, up to `X_FORBIDDEN_HOLD_MAX_MS`. */
export const X_FORBIDDEN_HOLD_MS = 6 * HOUR_MS;
export const X_FORBIDDEN_HOLD_MAX_MS = DAY_MS;

/** How long the `strikes`-th forbidden refusal in a row holds the account: 6 h, 12 h, then a day. */
export function forbiddenHoldMs(strikes: number): number {
  const n = Number.isFinite(strikes) && strikes >= 1 ? Math.floor(strikes) : 1;
  return Math.min(X_FORBIDDEN_HOLD_MAX_MS, X_FORBIDDEN_HOLD_MS * 2 ** (n - 1));
}

/**
 * X refused the publish because the account may not post (the sender's `forbidden(403)`: "You are not permitted to
 * perform this action"). A duplicate post is also a 403 but comes back as `duplicate_content`, which is not this.
 */
export function isXForbiddenError(error: string | null | undefined): boolean {
  return !!error && /(^|[^a-z_])forbidden\(403\)/i.test(error);
}

/** The X account may not post until `until` (see `forbiddenHoldMs`). Null once that time has passed. */
export function forbiddenHold(until: number | null | undefined, now: number): Hold | null {
  if (!until || !Number.isFinite(until) || until <= now) return null;
  const at = new Date(until).toISOString();
  return {
    reason: 'x_forbidden',
    until,
    message: `x_forbidden: X refused your last post because this account is not permitted to post right now (locked, restricted or its connection lost the right to write). publish_post and publish_reply are held until ${at}: do not call them. Your creator was told to check the X account; you are woken to try again at ${at}. ${HOLD_AGENDA_NOTE}`,
  };
}

/**
 * The quota side of the wake rule: while the quota is used up, the schedule neither wakes the agent nor tells it
 * to post (any schedule, due or not, carries the hold so the observation says why and until when).
 */
export function applyQuotaHold(schedule: RhythmSchedule | null, hold: Hold | null): RhythmSchedule | null {
  if (!schedule || !hold) return schedule;
  return { ...schedule, due: false, mayCompose: false, missedIntervals: 0, held: hold };
}

/** The X holds that are kept in the agent's state (runtime.ts `postQuotaUntil`, `postCreditsUntil`, `postForbiddenUntil`). */
export type StateHoldReason = Extract<HoldReason, 'x_quota' | 'x_credits' | 'x_forbidden'>;

/**
 * The X hold the model was last told about and, once it is over, how it ended (runtime.ts `AgentState.postHoldEndedNote`).
 * `at` is null while the hold stands; set, the note waits for the next turn, whose first observation carries
 * `holdEnded: holdEndedMessage(note)` once (runtime.ts `startTurn`).
 */
export interface PostHoldEnded {
  reason: StateHoldReason;
  /** Epoch ms the hold was to end. */
  until: number;
  /** Epoch ms the hold ended; null while it stands. */
  at: number | null;
  /** Ran out, lifted by the creator's X reconnect (`liftForbiddenHoldOnReconnect`), or cleared from the state before `until`. */
  how?: 'expired' | 'reconnect' | 'cleared' | null;
  /** The sender account's `connectedAt` that lifted a 403 hold. */
  connectedAt?: number | null;
}

/**
 * The one line the first observation after a hold carries (key `holdEnded`): which hold ended, when and how, that the
 * model's own note about it is stale, and that a due post goes out this turn. No post text, one sentence per fact.
 */
export function holdEndedMessage(note: PostHoldEnded): string {
  const iso = (ms: number | null | undefined) => new Date(ms ?? 0).toISOString();
  const early = note.how === 'cleared' ? ` (lifted before its end at ${iso(note.until)})` : '';
  const tail = 'Your earlier note that posting is blocked is out of date. Posting is allowed now; if an original post is due, publish it this turn.';
  const again = 'If X refuses again, the hold returns and you will be told.';
  switch (note.reason) {
    case 'x_forbidden':
      if (note.how === 'reconnect') {
        const renewed = note.connectedAt ? `; the connection was renewed at ${iso(note.connectedAt)}` : '';
        return `x_hold_ended: X accepted this account again (the 403 hold ended at ${iso(note.at)}${renewed}). ${tail}`;
      }
      return `x_hold_ended: the 403 hold on this account ended at ${iso(note.at)}${early}; X may accept your posts again. ${tail} ${again}`;
    case 'x_quota':
      return `x_hold_ended: your X posting quota opened again at ${iso(note.at)}${early}. ${tail}`;
    case 'x_credits':
      return `x_hold_ended: the X credits hold ended at ${iso(note.at)}${early}; X may accept your posts again. ${tail} ${again}`;
  }
}

/** The `social.originalPost` section of the observation. While held, `nextAt` is when it is worth trying again. */
export function originalPostView(schedule: RhythmSchedule): { due: boolean; nextAt: string; [key: string]: unknown } {
  const nextAt = schedule.held ? new Date(Math.max(schedule.nextAt, schedule.held.until)).toISOString() : schedule.nextAtIso;
  return {
    due: schedule.due,
    nextAt,
    intervalMs: schedule.intervalMs,
    lastPostAt: schedule.lastPostAt ? new Date(schedule.lastPostAt).toISOString() : null,
    ...(schedule.held ? { waiting: { reason: schedule.held.reason, until: new Date(schedule.held.until).toISOString(), note: schedule.held.message } } : {}),
  };
}
