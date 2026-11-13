/**
 * Scheduled posts (docs/design/agent-tools-2.md sections 5 and 17): the agent decides an original now with
 * `schedule_post` and the tick sends it at its time. Nothing here thinks: code holds the queue, and code sends.
 *
 * The one rule: originals, sent now or scheduled, are never closer together than the coin's post interval. It is held
 * at three places. `schedule_post` takes only a time that is one interval after the last original and one interval
 * away from every waiting post. A post sent now is refused, and its slot is not due, while a waiting post is due within
 * one interval (`beforeOriginalNow`, `applyScheduled`). And the send waits while the last original is younger than one
 * interval. So scheduling adds no post: it lets the agent choose the minute of a slot it would have had anyway.
 *
 * The gate runs twice. When a post is scheduled the agent hears a refusal while it can still rewrite: the publish gate,
 * the question quota with the waiting posts counted as if sent, a repeat of what it said or queued, the picture, the
 * thread rules. When it is sent it passes what a post sent now passes at that moment: the pause and the holds, the
 * power, who runs the coin, approval mode, the platform's window and quiet hours, the question quota and the thread
 * count again, and then the sender's own gate, opt-outs, length limit and daily quota. A post refused for good then is
 * `failed` with the reason and is never rewritten by code; one that cannot go out within `SCHEDULE_GRACE_MS` of its
 * time is `missed` and is never sent late.
 *
 * Never sent twice. The row's id is the sender's action id of the post, and the sender writes its row before it
 * contacts X, so a repeated call returns the stored receipt. The sweep marks a row `sending` before it calls the
 * sender; a row found `sending` on a later tick is asked for at the sender: a receipt that says sent closes it, no
 * receipt at all means nothing was sent and it waits again, and an unknown outcome waits for the sender's reconciler.
 *
 * Every send holds the runtime lease, the lock a turn, a client's call and a runner switch take too, and no send
 * starts while a turn is stored: a turn that began before the post went out cannot post into the same slot after it.
 *
 * With `SCHEDULED_MAX_WAITING=0` the piece is off: the tools are not offered, nothing here reads the queue for a wake
 * or a publish, and the sweep returns at once.
 */
import {
  PolicyError,
  boundedState,
  linkedHosts,
  postLength,
  postLimitsFor,
  sha256Hex,
  toolEnabled,
  validatePost,
  type Action,
  type ActionOutcome,
  type ActionResult,
  type AgentConfig,
  type PendingAction,
  type ToolInput,
  type ToolName,
} from '@bootr/agent-core';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { getAddress, isAddressEqual, type Address } from 'viem';
import { APPROVAL_TTL_MS, queueForApproval, requiresApproval, textHash, type ApprovalRow, type ApprovalView, type DecisionResult } from './approvals.js';
import type { BrokerEnv } from './broker/index.js';
import type { AgentRow, RuntimeRow, SupervisorContext } from './context.js';
import { actions, agents, approvals, runtimes, scheduledPosts, type ScheduledPostStatus } from './db/schema.js';
import type { AuthEnv } from './hmac.js';
import { imageStoredAt, loadImage } from './images.js';
import { altTextRisk } from './image-rules.js';
import { rpcErrorText } from './log.js';
import { agentConfigOf } from './onboarding.js';
import { isOwn, ownEnabled } from './own/registry.js';
import { postHooks, setPostHooks, type OriginalPost, type OriginalResult } from './post-send.js';
import { QUESTION_LOOKBACK, asksQuestion } from './recent-posts.js';
import { creditsHold, forbiddenHold, formatQuietHours, isXCreditsError, isXForbiddenError, originalPostGate, parseQuietHours, quietUntil, quotaHold, type Hold, type QuietHours, type RhythmSchedule } from './rhythm.js';
import { LEASE_MS, accountPremium, acquireLease, afterSettledAction, releaseLease, renewLease, saveRuntime, trimState, type AgentState, type Turn } from './runtime.js';

export type ScheduledRow = typeof scheduledPosts.$inferSelect;

export const SCHEDULE_TOOLS: readonly ToolName[] = ['schedule_post', 'scheduled_list', 'scheduled_cancel'];
export const SCHEDULED_ID_RE = /^sch_[0-9a-f]{16}$/;
/** A row that has not gone out and is not closed: it holds its time. `sending` is one whose outcome is not known yet. */
export const OPEN_STATUSES: readonly ScheduledPostStatus[] = ['waiting_review', 'waiting', 'sending'];
/** What counts against `SCHEDULED_MAX_WAITING` and what the agent or the creator may still cancel. */
export const WAITING_STATUSES: readonly ScheduledPostStatus[] = ['waiting_review', 'waiting'];
/** Posts one coin may schedule per rolling 24 hours, whatever became of them: no coin posts more than this in a day, and each call is a stored row. */
export const SCHEDULE_CREATED_PER_DAY = 48;
/** A time the agent is told it can take is this far inside the bounds, so the same time still holds when it calls again a moment later. */
export const SCHEDULE_SUGGEST_SLACK_MS = 2 * 60_000;
/** Rows the sweep looks at in one tick beyond the ones it may send: enough to pass over coins that cannot send now. */
export const SCHEDULED_SCAN_PER_SEND = 10;
/** Rows whose outcome is unknown that one tick asks the sender about. */
export const SCHEDULED_RECONCILE_PER_TICK = 20;
/** The sweep starts no new send once it has run this long: the tick has agents to get to. */
export const SCHEDULED_SWEEP_BUDGET_MS = 30_000;
/** Closed rows (sent, failed, missed, cancelled) are deleted after this long. */
export const SCHEDULED_KEEP_MS = 30 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 3_600_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EXCERPT = 140;
const MAX_ERROR_CHARS = 500;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface ScheduleLimits {
  hosted: boolean;
  maxWaiting: number;
  minAheadMs: number;
  maxAheadMs: number;
  graceMs: number;
  sendsPerTick: number;
}

export function scheduleLimits(ctx: Pick<SupervisorContext, 'config'>): ScheduleLimits {
  const c = ctx.config;
  return { hosted: c.SCHEDULED_POSTS_HOSTED, maxWaiting: c.SCHEDULED_MAX_WAITING, minAheadMs: c.SCHEDULE_MIN_AHEAD_MS, maxAheadMs: c.SCHEDULE_MAX_AHEAD_MS, graceMs: c.SCHEDULE_GRACE_MS, sendsPerTick: c.SCHEDULED_SENDS_PER_TICK };
}

/** Whether the piece is on at all: a limit of 0 switches it off. */
export function schedulingOn(ctx: Pick<SupervisorContext, 'config'>): boolean {
  const limits = scheduleLimits(ctx);
  return limits.maxWaiting > 0 && limits.maxAheadMs > 0;
}

/** Whether this coin's agent holds the schedule tools: the piece is on, and the coin is an own agent's or hosted agents hold them too. `raw` is the stored config. */
export function scheduleToolsOffered(ctx: Pick<SupervisorContext, 'config'>, raw: Record<string, unknown>): boolean {
  return schedulingOn(ctx) && (isOwn({ config: raw }) || scheduleLimits(ctx).hosted);
}

/** `roleTools` asks this for every tool of the social catalog: the three schedule tools exist only where `scheduleToolsOffered` says so. */
export function scheduleToolOffered(ctx: Pick<SupervisorContext, 'config'>, raw: Record<string, unknown>, name: string): boolean {
  return !(SCHEDULE_TOOLS as readonly string[]).includes(name) || scheduleToolsOffered(ctx, raw);
}

/** A limit another workstream owns, read loosely from the config (section 17.1 rule 3): its number when the config carries one, else the default. */
function looseLimit(ctx: Pick<SupervisorContext, 'config'>, name: string, fallback: number): number {
  const value = (ctx.config as unknown as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Refusals (section 17.6, verbatim where the contract gives the text)
// ---------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();

export function scheduleTimeRefusal(reason: string, nearest: number | null, windowMs: number): string {
  return nearest === null ? `schedule_time: ${reason}; no time is free in the next ${spanWords(windowMs)}. Nothing was scheduled.` : `schedule_time: ${reason}; the nearest time you can take is ${iso(nearest)}. Nothing was scheduled.`;
}
export function scheduleFull(waiting: number): string {
  return `schedule_full: ${waiting} posts are already waiting, the most allowed; nothing was scheduled. Cancel one or wait.`;
}
export const SCHEDULED_MENTION_FORBIDDEN = 'scheduled_mention_forbidden: a scheduled post names nobody; nothing was scheduled. Remove the @.';
export function postScheduledSoon(sendAt: number): string {
  return `post_scheduled_soon: your next post is already scheduled for ${iso(sendAt)}; nothing was posted. Replies may still go out.`;
}
export function scheduledNotFound(id: string): string {
  return `scheduled_not_found: you have no waiting post ${id}.`;
}
export const SCHEDULE_UNAVAILABLE = 'schedule_unavailable: scheduling is switched off; nothing was scheduled.';
export const SCHEDULE_DAILY_CAP = `schedule_daily_cap: at most ${SCHEDULE_CREATED_PER_DAY} posts may be scheduled per 24 hours; nothing was scheduled.`;
export const SCHEDULE_IMAGE_NOT_FROM_THIS_TURN = 'image_not_from_this_turn: attach only a picture uploaded in this turn; nothing was scheduled. Schedule your post without an imageId.';
export function scheduleQuestionQuota(lookback: number): string {
  return `question_quota: a post next to that time already asks something, and at most one original post in ${lookback + 1} may carry a question. Make this one a statement: say the thing itself and drop the question. Nothing was scheduled.`;
}
export function threadDailyCap(limit: number, done: 'scheduled' | 'sent'): string {
  return `thread_daily_cap: at most ${limit} threads per 24 hours; nothing was ${done}.${done === 'scheduled' ? ' Schedule it as one post.' : ''}`;
}

function failed(error: string, retryAt?: number): ActionOutcome {
  return { kind: 'failed', error, ...(retryAt ? { retryAt } : {}) };
}

/** "10 minutes", "2 hours", "36 hours": a span as the agent reads it. */
export function spanWords(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes >= 120 && minutes % 60 === 0) return `${minutes / 60} hours`;
  if (minutes === 60) return '1 hour';
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** `sch_` and 16 hex characters derived from the id of the `schedule_post` action: the same action never makes two rows. */
export function scheduledIdOf(actionId: string): string {
  return `sch_${sha256Hex(`bootr-scheduled:${actionId}`).slice(0, 16)}`;
}

/** The coin's posts that hold a time: waiting for review, waiting for their time, or sent with an outcome not known yet. Soonest first. */
export async function waitingScheduled(ctx: Pick<SupervisorContext, 'db'>, agentId: string): Promise<ScheduledRow[]> {
  return ctx.db
    .select()
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.agentId, agentId), inArray(scheduledPosts.status, [...OPEN_STATUSES])))
    .orderBy(asc(scheduledPosts.sendAt));
}

const partsOf = (row: Pick<ScheduledRow, 'text' | 'thread'>): string[] => [row.text, ...(Array.isArray(row.thread) ? row.thread.map((p) => p.text) : [])];
const clip = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** One waiting post as the agent and the creator are shown it. */
export interface ScheduledItem {
  id: string;
  sendAt: string;
  status: ScheduledPostStatus;
  text: string;
  parts: number;
  picture: boolean;
}

function itemOf(row: ScheduledRow): ScheduledItem {
  return { id: row.id, sendAt: row.sendAt.toISOString(), status: row.status, text: row.text, parts: partsOf(row).length, picture: !!row.imageId };
}

const countWaiting = (rows: readonly ScheduledRow[]): number => rows.filter((r) => WAITING_STATUSES.includes(r.status)).length;

/**
 * When the coin's last original went out or was handed to the sender (epoch ms, 0 when it has none): the cadence
 * anchor on the state, and the newest `publish_post` row that reached or may have reached X, which also knows a post
 * the creator approved from the review queue and one whose outcome is still unknown. A post that only waits in the
 * review queue is not one.
 */
export async function lastOriginalAt(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, state: Pick<AgentState, 'lastPostAt'> | null, intervalMs: number): Promise<number> {
  const since = new Date(ctx.now() - Math.max(7 * DAY, 2 * intervalMs));
  const [row] = await ctx.db
    .select({ at: sql<Date | string | null>`max(${actions.createdAt})` })
    .from(actions)
    .where(
      and(
        eq(actions.agentId, agentId),
        gt(actions.createdAt, since),
        inArray(actions.status, ['sending', 'sent', 'held', 'completed']),
        sql`${actions.action}->>'tool' = 'publish_post'`,
        sql`coalesce(${actions.result}->'result'->>'queued', 'false') <> 'true'`,
      ),
    );
  const recorded = row?.at ? new Date(row.at).getTime() : 0;
  return Math.max(state?.lastPostAt ?? 0, Number.isFinite(recorded) ? recorded : 0);
}

// ---------------------------------------------------------------------------
// Which times can be taken
// ---------------------------------------------------------------------------

export interface TimeContext {
  now: number;
  limits: Pick<ScheduleLimits, 'minAheadMs' | 'maxAheadMs'>;
  intervalMs: number;
  /** 0 when the coin never posted. */
  lastOriginalAt: number;
  /** The posts that already hold a time. */
  taken: readonly { id: string; sendAt: number }[];
  quiet: QuietHours | null;
}

/** Why `sendAt` cannot be taken, in the agent's words, or null when it can. */
export function timeProblem(sendAt: number, c: TimeContext): string | null {
  if (!Number.isFinite(sendAt)) return 'sendAt is not a time';
  if (sendAt < c.now + c.limits.minAheadMs) return `sendAt is less than ${spanWords(c.limits.minAheadMs)} from now`;
  if (sendAt > c.now + c.limits.maxAheadMs) return `sendAt is more than ${spanWords(c.limits.maxAheadMs)} from now`;
  if (c.lastOriginalAt > 0 && sendAt < c.lastOriginalAt + c.intervalMs) return `sendAt is less than one post interval (${spanWords(c.intervalMs)}) after your last post`;
  const near = c.taken.find((t) => Math.abs(sendAt - t.sendAt) < c.intervalMs);
  if (near) return `sendAt is less than one post interval (${spanWords(c.intervalMs)}) from your scheduled post ${near.id} at ${iso(near.sendAt)}`;
  if (c.quiet && quietUntil(c.quiet, sendAt) !== null) return `sendAt falls in Bootr's quiet hours (${formatQuietHours(c.quiet)})`;
  return null;
}

/**
 * Every time on a whole minute that sits at an edge of what is taken and can itself be taken, soonest first: the
 * edges of the window, one interval before and after each waiting post, the end of each quiet window and the minute
 * before its start. The free time nearest to any wish is one of these.
 */
export function freeTimes(c: TimeContext): number[] {
  const up = (t: number) => Math.ceil(t / MINUTE) * MINUTE;
  const down = (t: number) => Math.floor(t / MINUTE) * MINUTE;
  const lo = Math.max(c.now + c.limits.minAheadMs + SCHEDULE_SUGGEST_SLACK_MS, c.lastOriginalAt > 0 ? c.lastOriginalAt + c.intervalMs : 0);
  const hi = c.now + c.limits.maxAheadMs - SCHEDULE_SUGGEST_SLACK_MS;
  if (hi < lo) return [];
  const edges = [up(lo), down(hi)];
  for (const t of c.taken) edges.push(up(t.sendAt + c.intervalMs), down(t.sendAt - c.intervalMs));
  if (c.quiet) {
    for (let day = Math.floor(lo / DAY) - 1; day <= Math.floor(hi / DAY) + 1; day++) {
      const startAt = day * DAY + c.quiet.start * HOUR;
      const endAt = day * DAY + c.quiet.end * HOUR + (c.quiet.start < c.quiet.end ? 0 : DAY);
      edges.push(endAt, startAt - MINUTE);
    }
  }
  return [...new Set(edges)].filter((t) => t >= lo && t <= hi && timeProblem(t, c) === null).sort((a, b) => a - b);
}

/** The free time nearest to `wanted` (the later one of two equally near), or null when none is free in the window. */
export function nearestFreeTime(wanted: number, c: TimeContext): number | null {
  let best: number | null = null;
  for (const t of freeTimes(c)) if (best === null || Math.abs(t - wanted) <= Math.abs(best - wanted)) best = t;
  return best;
}

async function timeContext(ctx: Pick<SupervisorContext, 'db' | 'now' | 'config'>, agentId: string, config: Pick<AgentConfig, 'postIntervalMs'>, state: Pick<AgentState, 'lastPostAt'> | null, waiting: readonly ScheduledRow[]): Promise<TimeContext> {
  return {
    now: ctx.now(),
    limits: scheduleLimits(ctx),
    intervalMs: config.postIntervalMs,
    lastOriginalAt: await lastOriginalAt(ctx, agentId, state, config.postIntervalMs),
    taken: waiting.map((r) => ({ id: r.id, sendAt: r.sendAt.getTime() })),
    quiet: parseQuietHours(ctx.config.PLATFORM_QUIET_HOURS_UTC),
  };
}

// ---------------------------------------------------------------------------
// The gate when a post is scheduled
// ---------------------------------------------------------------------------

/** An `@` that X would read as naming somebody, in the plain or the full-width form. */
const MENTION_SIGN = /[@＠][A-Za-z0-9_]/;

/** The publish gate over a post as it is scheduled: every part, with no credits, since a scheduled post names nobody. Null when it passes. */
export function scheduleGateProblem(ctx: Pick<SupervisorContext, 'config'>, parts: readonly string[], opts: { hasImage: boolean; platform: boolean; accountLimit: number }): string | null {
  const gate = (text: string, format: 'short' | 'original', hasMedia: boolean): string | null => {
    try {
      validatePost(text, [], format, hasMedia, { platform: opts.platform });
      return null;
    } catch (err) {
      return err instanceof PolicyError ? err.code : 'invalid_post';
    }
  };
  if (parts.length === 1) {
    const code = gate(parts[0]!, 'original', opts.hasImage);
    if (code) return `${code}: the post does not pass the publish gate; rewrite it. Nothing was scheduled.`;
    const length = postLength(parts[0]!);
    if (length > opts.accountLimit) return `post_too_long_for_account: this X account has no Premium: posts are limited to ${opts.accountLimit} characters (this one is ${length}). Shorten it. Nothing was scheduled.`;
    return null;
  }
  const maxParts = looseLimit(ctx, 'THREAD_MAX_PARTS', 4);
  const partMax = looseLimit(ctx, 'THREAD_PART_MAX_CHARS', 280);
  if (maxParts <= 1) return 'thread_not_available: threads are switched off; nothing was scheduled. Schedule it as one post.';
  if (parts.length > maxParts) return `thread_too_long: a thread has at most ${maxParts} posts; nothing was scheduled. Say it in fewer.`;
  for (const [i, part] of parts.entries()) {
    const length = postLength(part);
    if (length > partMax) return `thread_part_too_long: part ${i + 1} has ${length} characters; every part of a thread is ${partMax} at most. Nothing was scheduled.`;
  }
  const said = new Set<string>();
  for (const part of parts) {
    const key = clip(part, 4000).toLowerCase();
    if (said.has(key)) return 'thread_repeat: two parts of the thread say the same; nothing was scheduled.';
    said.add(key);
  }
  if (parts.filter((part) => linkedHosts(part).length > 0).length > looseLimit(ctx, 'THREAD_MAX_LINK_PARTS', 1)) return 'thread_links: only one part of a thread may carry a link; nothing was scheduled.';
  for (const [i, part] of parts.entries()) {
    const code = gate(part, 'short', i === 0 && opts.hasImage);
    if (code) return `${code}: part ${i + 1} does not pass the publish gate; rewrite it. Nothing was scheduled.`;
  }
  return null;
}

/** The texts of one stored `publish_post` action, all its parts (section 17.4: `input.thread` is `[{ text }]`). */
function actionParts(action: unknown): string[] {
  const input = (action as { input?: { text?: unknown; thread?: unknown } } | null)?.input;
  const head = typeof input?.text === 'string' ? [input.text] : [];
  const rest = Array.isArray(input?.thread) ? input.thread.map((p) => (p as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === 'string') : [];
  return [...head, ...rest];
}

/** The coin's originals that reached X in the last `sinceMs`, newest first: when each went out and what it said. */
async function sentOriginals(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, opts: { sinceMs?: number; limit: number; excludeActionId?: string }): Promise<{ at: number; parts: string[] }[]> {
  const rows = await ctx.db
    .select({ id: actions.actionId, at: actions.createdAt, action: actions.action })
    .from(actions)
    .where(
      and(
        eq(actions.agentId, agentId),
        eq(actions.status, 'completed'),
        sql`${actions.action}->>'tool' = 'publish_post'`,
        sql`coalesce(${actions.result}->'result'->>'queued', 'false') <> 'true'`,
        ...(opts.sinceMs ? [gt(actions.createdAt, new Date(ctx.now() - opts.sinceMs))] : []),
      ),
    )
    .orderBy(desc(actions.createdAt))
    .limit(opts.limit + 1);
  return rows
    .filter((r) => r.id !== opts.excludeActionId)
    .slice(0, opts.limit)
    .map((r) => ({ at: r.at.getTime(), parts: actionParts(r.action) }));
}

/**
 * The question quota (recent-posts.ts) with the waiting posts counted as if sent: a post that asks something may not
 * have another that asks among the `QUESTION_LOOKBACK` originals before its time or after it. Null when it may go.
 */
async function questionProblem(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, parts: readonly string[], sendAt: number, waiting: readonly ScheduledRow[]): Promise<string | null> {
  if (!parts.some(asksQuestion)) return null;
  const asks = (texts: readonly string[]) => texts.some(asksQuestion);
  const before = waiting.filter((r) => r.sendAt.getTime() < sendAt).sort((a, b) => b.sendAt.getTime() - a.sendAt.getTime());
  const after = waiting.filter((r) => r.sendAt.getTime() > sendAt).sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
  if (after.slice(0, QUESTION_LOOKBACK).some((r) => asks(partsOf(r)))) return scheduleQuestionQuota(QUESTION_LOOKBACK);
  const sent = before.length < QUESTION_LOOKBACK ? await sentOriginals(ctx, agentId, { limit: QUESTION_LOOKBACK }) : [];
  const earlier = [...before.map((r) => partsOf(r)), ...sent.map((s) => s.parts)].slice(0, QUESTION_LOOKBACK);
  return earlier.some(asks) ? scheduleQuestionQuota(QUESTION_LOOKBACK) : null;
}

/** The hash a post is known by for the repeat check: `approvals.ts` `textHash` over all its parts. */
export function scheduledTextHash(parts: readonly string[]): string {
  return textHash(parts.join('\n'));
}

/** The same text as a post of the last day or one in the queue: X refuses a repeat, and the agent should not say a thing twice. Null when it is new. */
async function duplicateProblem(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, hash: string): Promise<string | null> {
  const dayAgo = new Date(ctx.now() - DAY);
  const queued = await ctx.db
    .select({ id: scheduledPosts.id, status: scheduledPosts.status, sendAt: scheduledPosts.sendAt })
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.agentId, agentId), eq(scheduledPosts.textHash, hash), or(inArray(scheduledPosts.status, [...OPEN_STATUSES]), and(eq(scheduledPosts.status, 'sent'), gt(scheduledPosts.updatedAt, dayAgo)))))
    .limit(1);
  if (queued[0]) return `schedule_duplicate: the same text ${queued[0].status === 'sent' ? 'already went out as' : 'is already scheduled as'} ${queued[0].id}; nothing was scheduled. Say something new.`;
  const sent = await sentOriginals(ctx, agentId, { sinceMs: DAY, limit: 60 });
  if (sent.some((s) => s.parts.length > 0 && scheduledTextHash(s.parts) === hash)) return 'schedule_duplicate: you posted the same text in the last day; nothing was scheduled. Say something new.';
  return null;
}

/** Threads count per rolling 24 hours (`THREADS_PER_DAY`, the posting workstream's limit): the sent ones and the waiting ones, with this one at `sendAt`. */
async function threadCountProblem(ctx: Pick<SupervisorContext, 'db' | 'now' | 'config'>, agentId: string, sendAt: number, waiting: readonly ScheduledRow[]): Promise<string | null> {
  const limit = looseLimit(ctx, 'THREADS_PER_DAY', 2);
  const sent = (await sentOriginals(ctx, agentId, { sinceMs: DAY, limit: 60 })).filter((s) => s.parts.length > 1).map((s) => s.at);
  const times = [...sent, ...waiting.filter((r) => partsOf(r).length > 1).map((r) => r.sendAt.getTime()), sendAt];
  // No 24 hours may hold more than the limit: every thread's own last day is counted.
  const over = times.some((t) => times.filter((other) => other <= t && other > t - DAY).length > limit);
  return over ? threadDailyCap(limit, 'scheduled') : null;
}

// ---------------------------------------------------------------------------
// The three tools
// ---------------------------------------------------------------------------

function scheduleResult(row: ScheduledRow, waiting: number, limits: ScheduleLimits): Record<string, unknown> {
  const at = row.sendAt.toISOString();
  const note =
    row.status === 'waiting_review'
      ? `Queued for your creator's review; it goes out at ${at} only if approved by then. It holds the post slot of that time: do not publish the same thought now.`
      : `It goes out by itself at ${at}, after passing the publish gate again. It holds the post slot of that time: do not publish the same thought now, and ask finish for a wake after it.`;
  return { scheduledId: row.id, sendAt: at, status: row.status, waiting, mayQueue: Math.max(0, limits.maxWaiting - waiting), note };
}

/** The `publish_post` a scheduled row stands for, as the review queue and the sender are handed it. */
function postInputOf(row: Pick<ScheduledRow, 'text' | 'thread' | 'imageId' | 'topic'>): Record<string, unknown> {
  return { text: row.text, ...(Array.isArray(row.thread) && row.thread.length ? { thread: row.thread } : {}), ...(row.imageId ? { imageId: row.imageId } : {}), ...(row.topic ? { topic: row.topic } : {}) };
}

/**
 * Hands a row to the creator's review (approval mode) through the existing queue, under the row's own id, and marks
 * the queue item as a scheduled one. The queue's own refusals (the same text, a text the gate refuses) come back as
 * they are. Safe to repeat: the queue finds its row by the id.
 */
async function queueRowForReview(ctx: SupervisorContext, agent: AgentRow, row: ScheduledRow, env: BrokerEnv): Promise<ActionOutcome> {
  const pending = { id: row.id, cycleKey: `scheduled:${row.id}`, action: { tool: 'publish_post', input: postInputOf(row) }, status: 'sent', createdAt: ctx.now(), attempts: 1 } as unknown as PendingAction;
  const outcome = await queueForApproval(ctx, agent, pending, env);
  if (outcome.kind !== 'completed') return outcome;
  const queued = await ctx.db.query.approvals.findFirst({ where: and(eq(approvals.id, row.id), eq(approvals.agentId, agent.agentId)) });
  if (!queued) return failed('schedule_review_failed: the post could not be handed to your creator for review; nothing was scheduled.');
  const meta = (queued.meta ?? {}) as Record<string, unknown>;
  const thread = Array.isArray(row.thread) && row.thread.length ? row.thread : null;
  await ctx.db
    .update(approvals)
    .set({ meta: { ...meta, ...(thread && !meta.thread ? { thread } : {}), scheduled: { id: row.id, sendAt: row.sendAt.toISOString() } } })
    .where(eq(approvals.id, row.id));
  return outcome;
}

export async function schedulePost(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, pending: PendingAction, input: ToolInput<'schedule_post'>, env: BrokerEnv): Promise<ActionOutcome> {
  if (!scheduleToolsOffered(ctx, agent.config)) return failed(SCHEDULE_UNAVAILABLE);
  const limits = scheduleLimits(ctx);
  const now = ctx.now();
  const id = scheduledIdOf(pending.id);
  const reviewed = requiresApproval(agent.config);
  const emptyEnv: BrokerEnv = { inbox: new Map(), eligibility: new Map(), ...(env.own ? { own: env.own } : {}) };

  // The same call again (a resumed step, a client's retry): its row is the answer, and nothing is made twice.
  const existing = await ctx.db.query.scheduledPosts.findFirst({ where: eq(scheduledPosts.id, id) });
  if (existing) {
    if (existing.agentId !== agent.agentId) return failed('schedule_conflict: nothing was scheduled.');
    if (existing.status === 'waiting_review') {
      // A crash between the row and its review item: the item is made now.
      const queued = await queueRowForReview(ctx, agent, existing, emptyEnv);
      if (queued.kind !== 'completed') {
        await ctx.db.delete(scheduledPosts).where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.status, 'waiting_review')));
        return queued;
      }
    }
    return { kind: 'completed', result: scheduleResult(existing, countWaiting(await waitingScheduled(ctx, agent.agentId)), limits) };
  }

  const thread = input.thread?.length ? input.thread.map((p) => ({ text: p.text })) : null;
  const parts = [input.text, ...(thread ?? []).map((p) => p.text)];
  // Whether a mention is welcome is a question about the moment a post is sent, so a scheduled post carries none.
  if (parts.some((part) => MENTION_SIGN.test(part))) return failed(SCHEDULED_MENTION_FORBIDDEN);

  const waiting = await waitingScheduled(ctx, agent.agentId);
  const waitingCount = countWaiting(waiting);
  if (waitingCount >= limits.maxWaiting) return failed(scheduleFull(waitingCount));
  const [made] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.agentId, agent.agentId), gt(scheduledPosts.createdAt, new Date(now - DAY))));
  if (Number(made?.n ?? 0) >= SCHEDULE_CREATED_PER_DAY) return failed(SCHEDULE_DAILY_CAP);

  const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agent.agentId), columns: { state: true } });
  const times = await timeContext(ctx, agent.agentId, config, (runtime?.state as unknown as AgentState | undefined) ?? null, waiting);
  const sendAt = Date.parse(input.sendAt);
  const untimely = timeProblem(sendAt, times);
  if (untimely) return failed(scheduleTimeRefusal(untimely, nearestFreeTime(Number.isFinite(sendAt) ? sendAt : now, times), limits.maxAheadMs));

  const platform = agent.config.platform === true;
  if (input.imageId) {
    const image = await loadImage(ctx, agent.agentId, input.imageId);
    if (!image) return failed(`image_not_found: ${input.imageId} (a picture you made this turn, else none); nothing was scheduled. Schedule your post without an imageId.`);
    // The alt text is public text: the same gates as the post (image-rules.ts).
    const alt = altTextRisk(image.alt, { platform });
    if (alt) return failed(`${alt.message}; nothing was scheduled. Schedule your post without an imageId.`);
    // An own agent attaches only a picture it uploaded in this turn (byo-agent.md section 7.1), here as in a post sent now.
    if (env.own) {
      const storedAt = await imageStoredAt(ctx, agent.agentId, input.imageId);
      if (storedAt !== null && storedAt < env.own.openedAt) return failed(SCHEDULE_IMAGE_NOT_FROM_THIS_TURN);
    }
  }
  const accountLimit = parts.length === 1 && postLength(input.text) > postLimitsFor(false).original ? postLimitsFor(await accountPremium(ctx, agent.agentId)).original : postLimitsFor(null).original;
  const gate = scheduleGateProblem(ctx, parts, { hasImage: !!input.imageId, platform, accountLimit });
  if (gate) return failed(gate);
  const asked = await questionProblem(ctx, agent.agentId, parts, sendAt, waiting);
  if (asked) return failed(asked);
  const hash = scheduledTextHash(parts);
  const repeat = await duplicateProblem(ctx, agent.agentId, hash);
  if (repeat) return failed(repeat);
  if (parts.length > 1) {
    const threads = await threadCountProblem(ctx, agent.agentId, sendAt, waiting);
    if (threads) return failed(threads);
  }

  // Who thought is on the record with the row, as it is on the action that made it (own/turns.ts).
  const made0 = await ctx.db.query.actions.findFirst({ where: eq(actions.actionId, pending.id), columns: { action: true } });
  const by = (made0?.action ?? {}) as { via?: unknown; clientId?: unknown };
  const [inserted] = await ctx.db
    .insert(scheduledPosts)
    .values({
      id,
      agentId: agent.agentId,
      actionId: pending.id,
      text: input.text,
      textHash: hash,
      thread,
      imageId: input.imageId ?? null,
      topic: input.topic ?? null,
      via: by.via === 'own' ? 'own' : null,
      clientId: by.via === 'own' && typeof by.clientId === 'string' ? by.clientId : null,
      sendAt: new Date(sendAt),
      status: reviewed ? 'waiting_review' : 'waiting',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted ?? (await ctx.db.query.scheduledPosts.findFirst({ where: eq(scheduledPosts.id, id) }))!;
  if (reviewed) {
    // Approval mode: the creator reads it ahead and has until its time. The own-agent rule "one queued original per
    // slot" is not asked here: `SCHEDULED_MAX_WAITING` and the spacing bound what waits.
    const queued = await queueRowForReview(ctx, agent, row, emptyEnv);
    if (queued.kind !== 'completed') {
      await ctx.db.delete(scheduledPosts).where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.status, 'waiting_review')));
      return queued;
    }
  }
  ctx.log.info({ agentId: agent.agentId, scheduledId: id, sendAt: row.sendAt.toISOString(), parts: parts.length, reviewed }, 'post scheduled');
  return { kind: 'completed', result: scheduleResult(row, waitingCount + 1, limits) };
}

/** `{ items, mayQueue, nextFreeAt }`: what waits, how many more may, and the soonest time that can be taken (null when none is free). */
export async function scheduledList(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig): Promise<ActionOutcome> {
  const waiting = await waitingScheduled(ctx, agent.agentId);
  const limits = scheduleLimits(ctx);
  const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agent.agentId), columns: { state: true } });
  const free = freeTimes(await timeContext(ctx, agent.agentId, config, (runtime?.state as unknown as AgentState | undefined) ?? null, waiting));
  return { kind: 'completed', result: { items: waiting.map(itemOf), mayQueue: Math.max(0, limits.maxWaiting - countWaiting(waiting)), nextFreeAt: free[0] !== undefined ? iso(free[0]) : null } };
}

/**
 * Takes a post that has not gone out from the queue. Only a row that still waits can be cancelled: one that is being
 * sent may already be on X. Its review item, if it has one, closes with it. The creator's cancel is told to the agent
 * on its next turn; the agent's own is not.
 */
export async function cancelScheduled(ctx: Pick<SupervisorContext, 'db' | 'now' | 'log'>, agentId: string, id: string, who: { by: 'agent' } | { by: 'creator'; address: string }): Promise<ScheduledRow | null> {
  const now = new Date(ctx.now());
  const [row] = await ctx.db
    .update(scheduledPosts)
    .set({ status: 'cancelled', error: who.by === 'agent' ? 'cancelled by the agent' : 'cancelled by the creator', updatedAt: now, feedbackAt: who.by === 'agent' ? now : null })
    .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.agentId, agentId), inArray(scheduledPosts.status, [...WAITING_STATUSES])))
    .returning();
  if (!row) return null;
  const decidedBy = who.by === 'agent' ? 'system' : who.address;
  // The agent hears of it from here (`takeScheduledFeedback`), so the review queue's own note is marked told.
  await ctx.db.update(approvals).set({ status: 'rejected', decision: 'reject', decidedBy, note: 'cancelled', decidedAt: now, feedbackAt: now }).where(and(eq(approvals.id, id), eq(approvals.status, 'pending_approval')));
  await ctx.db.update(approvals).set({ status: 'failed', note: 'cancelled before it went out', feedbackAt: now }).where(and(eq(approvals.id, id), eq(approvals.status, 'approved'), isNull(approvals.postId)));
  ctx.log.info({ agentId, scheduledId: id, by: who.by }, 'scheduled post cancelled');
  return row;
}

export async function scheduledCancel(ctx: SupervisorContext, agent: AgentRow, input: ToolInput<'scheduled_cancel'>): Promise<ActionOutcome> {
  const row = await cancelScheduled(ctx, agent.agentId, input.id, { by: 'agent' });
  return row ? { kind: 'completed', result: { id: row.id, cancelled: true } } : failed(scheduledNotFound(input.id));
}

// ---------------------------------------------------------------------------
// What the agent is shown
// ---------------------------------------------------------------------------

export interface ScheduledFeedback {
  id: string;
  sendAt: string;
  /** The first 140 characters of what did not go out. */
  text: string;
  status: ScheduledPostStatus;
  message: string;
}

/** Scheduled posts that did not go out and were not yet told to the agent, marked as told: failed for good, missed, or cancelled by the creator. */
export async function takeScheduledFeedback(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string): Promise<ScheduledFeedback[]> {
  const rows = await ctx.db
    .update(scheduledPosts)
    .set({ feedbackAt: new Date(ctx.now()) })
    .where(and(eq(scheduledPosts.agentId, agentId), inArray(scheduledPosts.status, ['failed', 'missed', 'cancelled']), isNull(scheduledPosts.feedbackAt)))
    .returning();
  return rows
    .sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime())
    .map((r) => ({
      id: r.id,
      sendAt: r.sendAt.toISOString(),
      text: clip(r.text, EXCERPT),
      status: r.status,
      message: `your scheduled post ${r.id} was not sent: ${r.status === 'missed' ? 'its time passed before it could go out' : r.status === 'cancelled' ? 'your creator cancelled it' : (r.error ?? 'refused')}`,
    }));
}

export const SCHEDULED_MEANING =
  'Posts you scheduled with schedule_post that have not gone out yet. Each holds the post slot of its time, so do not publish the same thought now; scheduled_cancel frees one. nextFreeAt is the soonest time schedule_post can take. notSent lists scheduled posts that did not go out, once: they are gone, write anew if the thought still matters.';

/**
 * The `scheduled` section of a turn's first observation: the waiting posts (id, time, the first 140 characters), how
 * many more may wait, the next free time, and once the posts that did not go out. `{}` for an agent that does not hold
 * the schedule tools, so its observation is what it was.
 */
export async function scheduledSection(ctx: Pick<SupervisorContext, 'db' | 'now' | 'config' | 'log'>, agentId: string): Promise<Record<string, unknown>> {
  if (!schedulingOn(ctx)) return {};
  try {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, agentId) });
    if (!agent || !scheduleToolsOffered(ctx, agent.config)) return {};
    const config = agentConfigOf(agent);
    if (!config || !toolEnabled(config, 'schedule_post')) return {};
    const limits = scheduleLimits(ctx);
    const waiting = await waitingScheduled(ctx, agentId);
    const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agentId), columns: { state: true } });
    const free = freeTimes(await timeContext(ctx, agentId, config, (runtime?.state as unknown as AgentState | undefined) ?? null, waiting));
    const notSent = await takeScheduledFeedback(ctx, agentId);
    return {
      scheduled: {
        meaning: SCHEDULED_MEANING,
        waiting: waiting.map((r) => ({ id: r.id, sendAt: r.sendAt.toISOString(), status: r.status, text: clip(r.text, EXCERPT), ...(partsOf(r).length > 1 ? { parts: partsOf(r).length } : {}), ...(r.imageId ? { picture: true } : {}) })),
        mayQueue: Math.max(0, limits.maxWaiting - countWaiting(waiting)),
        nextFreeAt: free[0] !== undefined ? iso(free[0]) : null,
        ...(notSent.length ? { notSent: notSent.map((f) => ({ id: f.id, sendAt: f.sendAt, text: f.text, message: f.message })) } : {}),
      },
    };
  } catch (err) {
    ctx.log.warn({ agentId, err }, 'scheduled posts read failed; turn goes on without the section');
    return {};
  }
}

// ---------------------------------------------------------------------------
// A post sent now, and the slot on the wake side
// ---------------------------------------------------------------------------

/**
 * The scheduled post that covers the slot of this moment: one that holds a time within one post interval from now, or
 * one whose send is under way or of unknown outcome. A post past its grace no longer covers anything: it is about to
 * be marked missed.
 */
export async function coveringPost(ctx: Pick<SupervisorContext, 'db' | 'config'>, agentId: string, intervalMs: number, now: number): Promise<ScheduledRow | null> {
  const rows = await ctx.db
    .select()
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.agentId, agentId), inArray(scheduledPosts.status, [...OPEN_STATUSES]), lte(scheduledPosts.sendAt, new Date(now + intervalMs))))
    .orderBy(asc(scheduledPosts.sendAt))
    .limit(8);
  const grace = scheduleLimits(ctx).graceMs;
  return rows.find((r) => r.status === 'sending' || r.sendAt.getTime() >= now - grace) ?? null;
}

/** The hold a covered slot carries (rhythm.ts `Hold`, reason `scheduled`): the observation says why no post is due and until when. */
export function scheduledHold(ctx: Pick<SupervisorContext, 'config'>, sendAt: number, now: number): Hold {
  return {
    reason: 'scheduled',
    until: Math.max(sendAt, now + ctx.config.SUPERVISOR_TICK_MS),
    message: `scheduled: your next post is already scheduled for ${iso(sendAt)} and goes out by itself; it holds this post slot. Do not post now. Replies may still go out.`,
  };
}

/**
 * The wake side of the one rule, beside `applyRhythm`: a due slot that a scheduled post covers is not due, so a hosted
 * agent buys no thought for it and an own agent's client is not told a post is due. A schedule that is not due passes
 * through untouched and costs no read.
 */
export async function applyScheduled(ctx: Pick<SupervisorContext, 'db' | 'config'>, agentId: string, schedule: RhythmSchedule | null, now: number): Promise<RhythmSchedule | null> {
  if (!schedule || !schedule.due || !schedulingOn(ctx)) return schedule;
  const covering = await coveringPost(ctx, agentId, schedule.intervalMs, now);
  if (!covering) return schedule;
  return { ...schedule, due: false, mayCompose: false, missedIntervals: 0, held: scheduledHold(ctx, covering.sendAt.getTime(), now) };
}

/** `PostHooks.beforeOriginalNow`: the refusal an original sent now gets while a scheduled post is due within one post interval, else null. */
export async function beforeOriginalNow(ctx: SupervisorContext, agent: AgentRow, now: number): Promise<string | null> {
  if (!schedulingOn(ctx)) return null;
  const interval = (agent.config as { postIntervalMs?: unknown }).postIntervalMs;
  const intervalMs = typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : agentConfigOf(agent)?.postIntervalMs;
  if (!intervalMs) return null;
  const covering = await coveringPost(ctx, agent.agentId, intervalMs, now);
  return covering ? postScheduledSoon(covering.sendAt.getTime()) : null;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface ScheduledSweepReport {
  /** Went out on X. */
  sent: number;
  /** Refused for good. */
  failed: number;
  /** Past their grace, never sent late. */
  missed: number;
  /** Handed to the sender, outcome not known yet. */
  unknown: number;
  /** Moved to the creator's review because approval mode came on after they were scheduled. */
  toReview: number;
}

type SendResult = 'sent' | 'failed' | 'unknown' | 'review' | 'waits' | 'window';

/** The X hold on the coin's state right now, if any. */
function stateHold(state: AgentState, now: number): Hold | null {
  return quotaHold(state.postQuotaUntil, now) ?? creditsHold(state.postCreditsUntil, now) ?? forbiddenHold(state.postForbiddenUntil, now);
}

/**
 * Why a coin cannot send a scheduled post at this moment, from its rows alone (no read): the first thing that stands
 * in the way, or null. Everything here passes by itself, so the post waits for a later tick, up to its grace.
 */
export function sendBlocked(ctx: Pick<SupervisorContext, 'config'>, agent: AgentRow, runtime: Pick<RuntimeRow, 'status' | 'turn' | 'pending' | 'state'>, now: number): string | null {
  if (agent.status !== 'active') return 'agent_not_active';
  if (runtime.status === 'paused') return 'paused';
  if (runtime.status === 'held') return 'held_action';
  const pending = runtime.pending as { status?: unknown } | null;
  if (pending?.status === 'held' || pending?.status === 'sent' || pending?.status === 'sending') return 'action_in_flight';
  // A turn that is stored began before this post went out: sending under it would let it post into the same slot after.
  if (runtime.turn) return 'turn_open';
  // With the own-agent flag off an own coin is silent, and silent is what was promised.
  if (isOwn(agent) && !ownEnabled(ctx)) return 'own_agent_disabled';
  if (!scheduleToolsOffered(ctx, agent.config)) return 'scheduling_off';
  const config = agentConfigOf(agent);
  if (!config) return 'config_incomplete';
  if (!toolEnabled(config, 'publish_post')) return 'posting_off';
  const hold = stateHold(runtime.state as unknown as AgentState, now);
  if (hold) return hold.reason;
  const last = (runtime.state as unknown as AgentState).lastPostAt ?? 0;
  if (last > 0 && now - last < config.postIntervalMs) return 'interval_not_over';
  return null;
}

/** A refused send that passes by itself: nothing was recorded at the sender, so the same post may be tried again. */
export function sendPasses(error: string): boolean {
  const e = error.trim();
  if (/^original_sender_not_mounted\b/.test(e)) return true;
  if (/^(no_slot|quiet_hours)\b/.test(e)) return true;
  return /^sender:(quota_exceeded|consent_lookup_failed|not_connected|revoked|refresh_failed|rate_limited|storage_unavailable|internal_error|http_(429|5\d\d))(?![A-Za-z0-9_])/.test(e);
}

/** A "failure" that says X was already contacted: the outcome is not known, whatever the word. */
const MAYBE_SENT = /after_send|sender_(held|pending)\b|outcome_unknown/;

const emptyTurn = (now: number): Turn => ({ startedAt: now, steps: 0, nudged: false, reasons: [], messages: [], inbox: {}, recentSteps: [] });

/** The stored `publish_post` of a scheduled row, as `afterSettledAction` and the action row read it. */
function publishActionOf(row: ScheduledRow): Action {
  return { tool: 'publish_post', input: postInputOf(row) } as unknown as Action;
}

/**
 * The bookkeeping a post sent now gets when it settles (runtime.ts `afterSettledAction`), with a turn that carries
 * nothing: a 403, a quota or a credits refusal sets its hold and the creator's notice; a post that went out clears
 * them and moves the cadence anchor. Written under the lease the caller holds; when that lease was lost while the
 * sender worked, only the anchor is written, in one statement, so a post that went out still moves the cadence.
 */
async function settleOnState(ctx: SupervisorContext, agent: AgentRow, lease: string, row: ScheduledRow, result: ActionResult, retryAt?: number): Promise<void> {
  const log = ctx.log.child({ agentId: agent.agentId, scheduledId: row.id });
  if (!(await renewLease(ctx, agent.agentId, lease))) {
    log.warn('the runtime lease was lost while a scheduled post was sent; only the cadence anchor is written');
    if (result.status === 'completed') await ctx.db.update(runtimes).set({ state: sql`jsonb_set(${runtimes.state}, '{lastPostAt}', to_jsonb(${ctx.now()}::bigint))` }).where(eq(runtimes.agentId, agent.agentId));
    return;
  }
  const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agent.agentId) });
  if (!runtime) return;
  const state = { ...(runtime.state as unknown as AgentState) };
  await afterSettledAction(ctx, agent, state, emptyTurn(ctx.now()), publishActionOf(row), { id: row.id, ...(retryAt ? { nextAt: retryAt } : {}) }, result, log);
  await saveRuntime(ctx, agent.agentId, { state: boundedState(trimState(state)) as unknown as Record<string, unknown> });
}

/** Closes a row whose post is on X: the `sv_actions` row every query of posts reads, the row itself, its review item, and the state. */
async function closeSent(ctx: SupervisorContext, agent: AgentRow, lease: string, row: ScheduledRow, sent: OriginalResult): Promise<void> {
  const now = new Date(ctx.now());
  const postId = typeof sent.postId === 'string' && sent.postId ? sent.postId : null;
  const actionId = `${row.id}-sent`;
  const result = { ...sent, scheduledId: row.id };
  await ctx.db
    .insert(actions)
    .values({
      actionId,
      agentId: agent.agentId,
      cycleKey: `scheduled:${row.id}`,
      // An ordinary post to the platform's window, the cadence, the metrics, the question quota and the tape (section 17.4).
      action: { ...(publishActionOf(row) as unknown as Record<string, unknown>), scheduled: { id: row.id }, ...(row.via === 'own' ? { via: 'own', ...(row.clientId ? { clientId: row.clientId } : {}) } : {}) },
      status: 'completed',
      result,
      receipt: postId ? { postId } : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await ctx.db.update(scheduledPosts).set({ status: 'sent', postId, error: null, updatedAt: now }).where(and(eq(scheduledPosts.id, row.id), eq(scheduledPosts.status, 'sending')));
  if (postId) await ctx.db.update(approvals).set({ postId }).where(and(eq(approvals.id, row.id), eq(approvals.status, 'approved')));
  await settleOnState(ctx, agent, lease, row, { actionId, tool: 'publish_post', status: 'completed', result });
  ctx.log.info({ agentId: agent.agentId, scheduledId: row.id, postId, parts: partsOf(row).length, sentParts: sent.sent ?? null }, 'scheduled post sent');
}

/** Closes a row that was refused for good: failed with the reason, told to the agent on its next turn, nothing rewritten. */
async function closeFailed(ctx: SupervisorContext, agent: AgentRow, lease: string, row: ScheduledRow, error: string, from: ScheduledPostStatus, opts: { settle?: boolean } = {}): Promise<void> {
  const now = new Date(ctx.now());
  const reason = error.slice(0, MAX_ERROR_CHARS);
  await ctx.db.update(scheduledPosts).set({ status: 'failed', error: reason, updatedAt: now }).where(and(eq(scheduledPosts.id, row.id), eq(scheduledPosts.status, from)));
  // A post the creator approved and that could not go out shows so in the review queue; the agent hears it from here.
  await ctx.db.update(approvals).set({ status: 'failed', note: reason, feedbackAt: now }).where(and(eq(approvals.id, row.id), eq(approvals.status, 'approved'), isNull(approvals.postId)));
  if (opts.settle !== false) await settleOnState(ctx, agent, lease, row, { actionId: `${row.id}-sent`, tool: 'publish_post', status: 'failed', error });
  ctx.log.info({ agentId: agent.agentId, scheduledId: row.id, code: error.trim().split(/\s/)[0]!.replace(/:$/, '').slice(0, 120) }, 'scheduled post refused for good');
}

/** The receipt of a thread's first part as the posting workstream's sender gives it (section 17.5), read loosely. */
function resultFromReceipt(row: ScheduledRow, receipt: { providerPostId?: string | null; thread?: unknown }): OriginalResult {
  const postId = receipt.providerPostId ?? undefined;
  const total = partsOf(row).length;
  if (total === 1) return { ...(postId ? { postId } : {}) };
  // A thread whose send was cut off stays cut (section 3.4): the parts the sender knows as sent, and where it stopped.
  const listed = ((receipt.thread as { parts?: unknown } | undefined)?.parts ?? []) as { n?: unknown; status?: unknown; providerPostId?: unknown }[];
  const parts = Array.isArray(listed) ? listed.filter((p) => p?.status === 'sent' && typeof p.n === 'number' && typeof p.providerPostId === 'string').map((p) => ({ n: p.n as number, postId: p.providerPostId as string })) : [];
  const known = parts.length ? parts : postId ? [{ n: 1, postId }] : [];
  const sent = known.length;
  return { ...(postId ? { postId } : {}), parts: known, sent, of: total, ...(sent < total ? { cut: { n: sent + 1, error: 'the send was interrupted; the rest was not sent' } } : {}) };
}

/**
 * Sends one due row, or says why not. Holds the runtime lease from before the last checks until the outcome is on
 * record, and re-reads everything it decides on under that lease. Never throws.
 */
export async function sendScheduled(ctx: SupervisorContext, id: string): Promise<SendResult> {
  const first = await ctx.db.query.scheduledPosts.findFirst({ where: eq(scheduledPosts.id, id) });
  if (!first || first.status !== 'waiting') return 'waits';
  const lease = `scheduled:${id}:${ctx.now()}:${Math.random().toString(36).slice(2)}`;
  const leaseMs = Math.max(LEASE_MS, ctx.config.TOOL_TIMEOUT_MS + 30_000);
  // The lease is the lock of a turn, of a client's call and of a runner switch: when one of them holds it, this post waits.
  const runtime = await acquireLease(ctx, first.agentId, lease, leaseMs);
  if (!runtime) return 'waits';
  const log = ctx.log.child({ agentId: first.agentId, scheduledId: id });
  try {
    const now = ctx.now();
    const limits = scheduleLimits(ctx);
    const [agent, row] = await Promise.all([ctx.db.query.agents.findFirst({ where: eq(agents.agentId, first.agentId) }), ctx.db.query.scheduledPosts.findFirst({ where: eq(scheduledPosts.id, id) })]);
    if (!agent || !row || row.status !== 'waiting') return 'waits';
    const at = row.sendAt.getTime();
    if (at > now || now > at + limits.graceMs) return 'waits';
    const blocked = sendBlocked(ctx, agent, runtime, now);
    if (blocked) return 'waits';
    const config = agentConfigOf(agent)!;
    const state = runtime.state as unknown as AgentState;
    // The send waits while the last original is younger than one interval, whoever sent it and however.
    const last = await lastOriginalAt(ctx, agent.agentId, state, config.postIntervalMs);
    if (last > 0 && now - last < config.postIntervalMs) return 'waits';
    // No second scheduled post of the coin while one is still on its way.
    const inFlight = await ctx.db.query.scheduledPosts.findFirst({ where: and(eq(scheduledPosts.agentId, agent.agentId), eq(scheduledPosts.status, 'sending')), columns: { id: true } });
    if (inFlight) return 'waits';
    // The platform's window and quiet hours, as for a post sent now (rhythm.ts).
    const gate = await originalPostGate(ctx, now);
    if (!gate.open) return 'window';

    // Approval mode came on after this post was scheduled: it goes to the creator first, like any post now.
    if (requiresApproval(agent.config)) {
      const review = await ctx.db.query.approvals.findFirst({ where: and(eq(approvals.id, row.id), eq(approvals.agentId, agent.agentId)), columns: { status: true } });
      if (review?.status !== 'approved') {
        if (review && review.status !== 'pending_approval') {
          await closeFailed(ctx, agent, lease, row, `review_${review.status}: your creator's review did not approve it`, 'waiting', { settle: false });
          return 'failed';
        }
        const queued = review ? ({ kind: 'completed', result: null } as ActionOutcome) : await queueRowForReview(ctx, agent, row, { inbox: new Map(), eligibility: new Map() });
        if (queued.kind === 'failed') {
          await closeFailed(ctx, agent, lease, row, queued.error, 'waiting', { settle: false });
          return 'failed';
        }
        await ctx.db.update(scheduledPosts).set({ status: 'waiting_review', updatedAt: new Date(now) }).where(and(eq(scheduledPosts.id, row.id), eq(scheduledPosts.status, 'waiting')));
        log.info('approval mode is on: the scheduled post was handed to the creator before it goes out');
        return 'review';
      }
    }

    // What a post sent now is asked at this moment, beyond the sender's own gate: the question quota and the day's threads.
    const parts = partsOf(row);
    if (parts.some(asksQuestion) && (await sentOriginals(ctx, agent.agentId, { limit: QUESTION_LOOKBACK })).some((s) => s.parts.some(asksQuestion))) {
      await closeFailed(ctx, agent, lease, row, `question_quota: one of your last ${QUESTION_LOOKBACK} original posts already asked something, and at most one original post in ${QUESTION_LOOKBACK + 1} may carry a question. Nothing was posted.`, 'waiting', { settle: false });
      return 'failed';
    }
    if (parts.length > 1) {
      const threadLimit = looseLimit(ctx, 'THREADS_PER_DAY', 2);
      const threads = (await sentOriginals(ctx, agent.agentId, { sinceMs: DAY, limit: 60 })).filter((s) => s.parts.length > 1).length;
      if (threads >= threadLimit) {
        await closeFailed(ctx, agent, lease, row, threadDailyCap(threadLimit, 'sent'), 'waiting', { settle: false });
        return 'failed';
      }
    }

    // Marked before the sender is called: from here on only a receipt decides what became of it.
    const [claimed] = await ctx.db
      .update(scheduledPosts)
      .set({ status: 'sending', attempts: row.attempts + 1, updatedAt: new Date(now) })
      .where(and(eq(scheduledPosts.id, row.id), eq(scheduledPosts.status, 'waiting')))
      .returning();
    if (!claimed) return 'waits';
    const post: OriginalPost = { actionId: row.id, text: row.text, ...(Array.isArray(row.thread) && row.thread.length ? { thread: row.thread.map((p) => ({ text: p.text })) } : {}), ...(row.imageId ? { imageId: row.imageId } : {}) };
    let outcome: ActionOutcome;
    try {
      outcome = await postHooks.sendOriginal(ctx, agent, post);
    } catch (err) {
      // The hook does not throw; should it, nothing is known about the post.
      outcome = { kind: 'unknown', error: rpcErrorText(err) };
    }
    if (outcome.kind === 'failed' && MAYBE_SENT.test(outcome.error)) outcome = { kind: 'unknown', error: outcome.error };

    if (outcome.kind === 'completed') {
      await closeSent(ctx, agent, lease, claimed, (outcome.result ?? {}) as OriginalResult);
      return 'sent';
    }
    if (outcome.kind === 'unknown') {
      await ctx.db.update(scheduledPosts).set({ error: outcome.error.slice(0, MAX_ERROR_CHARS), updatedAt: new Date(ctx.now()) }).where(and(eq(scheduledPosts.id, row.id), eq(scheduledPosts.status, 'sending')));
      log.warn({ reason: outcome.error.slice(0, 120) }, 'scheduled post handed to the sender with no known outcome; it is settled from its receipt');
      return 'unknown';
    }
    if (sendPasses(outcome.error)) {
      // Nothing was recorded at the sender: the post waits again. A quota refusal sets its hold, as for a post sent now.
      await ctx.db.update(scheduledPosts).set({ status: 'waiting', error: outcome.error.slice(0, MAX_ERROR_CHARS), updatedAt: new Date(ctx.now()) }).where(and(eq(scheduledPosts.id, row.id), eq(scheduledPosts.status, 'sending')));
      if (outcome.error === 'sender:quota_exceeded') await settleOnState(ctx, agent, lease, claimed, { actionId: `${row.id}-sent`, tool: 'publish_post', status: 'failed', error: outcome.error }, outcome.retryAt);
      return 'waits';
    }
    // A 403 or a credits refusal holds the account and tells the creator, as for a post sent now (`settleOnState`).
    await closeFailed(ctx, agent, lease, claimed, outcome.error, 'sending', { settle: isXForbiddenError(outcome.error) || isXCreditsError(outcome.error) });
    return 'failed';
  } catch (err) {
    log.error({ err: rpcErrorText(err) }, 'scheduled post: the send step failed');
    return 'waits';
  } finally {
    await releaseLease(ctx, first.agentId, lease);
  }
}

/** A row left `sending` (a crash, a lost answer, an unknown outcome): the sender's receipt says what became of it. */
async function reconcileSending(ctx: SupervisorContext, id: string): Promise<SendResult> {
  const first = await ctx.db.query.scheduledPosts.findFirst({ where: eq(scheduledPosts.id, id) });
  if (!first || first.status !== 'sending') return 'waits';
  const lease = `scheduled:${id}:${ctx.now()}:${Math.random().toString(36).slice(2)}`;
  if (!(await acquireLease(ctx, first.agentId, lease))) return 'waits';
  try {
    const [agent, row] = await Promise.all([ctx.db.query.agents.findFirst({ where: eq(agents.agentId, first.agentId) }), ctx.db.query.scheduledPosts.findFirst({ where: eq(scheduledPosts.id, id) })]);
    if (!agent || !row || row.status !== 'sending') return 'waits';
    let receipt: Awaited<ReturnType<SupervisorContext['sender']['receipt']>>;
    try {
      receipt = await ctx.sender.receipt(row.id);
    } catch (err) {
      if ((err as { status?: unknown } | null)?.status === 404) {
        // No receipt at all: the sender never saw it, so nothing was sent. It waits again; its grace still decides.
        await ctx.db.update(scheduledPosts).set({ status: 'waiting', updatedAt: new Date(ctx.now()) }).where(and(eq(scheduledPosts.id, row.id), eq(scheduledPosts.status, 'sending')));
        return 'waits';
      }
      return 'unknown';
    }
    if (receipt.status === 'sent') {
      await closeSent(ctx, agent, lease, row, resultFromReceipt(row, receipt));
      return 'sent';
    }
    if (receipt.status === 'rejected') {
      const error = `sender_rejected:${receipt.error ?? 'rejected'}`;
      await closeFailed(ctx, agent, lease, row, error, 'sending', { settle: isXForbiddenError(error) || isXCreditsError(error) });
      return 'failed';
    }
    // pending or held: the sender's own reconciler settles it; asked again on a later tick, never sent again.
    await ctx.db.update(scheduledPosts).set({ updatedAt: new Date(ctx.now()) }).where(and(eq(scheduledPosts.id, row.id), eq(scheduledPosts.status, 'sending')));
    return 'unknown';
  } catch (err) {
    ctx.log.error({ scheduledId: id, err: rpcErrorText(err) }, 'scheduled post: the receipt step failed');
    return 'unknown';
  } finally {
    await releaseLease(ctx, first.agentId, lease);
  }
}

/** Posts past their grace are missed, never sent late; one that was still in the creator's review leaves the queue with it. */
async function expireScheduled(ctx: SupervisorContext, now: number): Promise<number> {
  const cutoff = new Date(now - scheduleLimits(ctx).graceMs);
  const at = new Date(now);
  const unreviewed = await ctx.db
    .update(scheduledPosts)
    // The review queue's own note tells the agent ("rejected: expired..."), so this row is marked told.
    .set({ status: 'missed', error: 'missed: it was not reviewed before its time passed', updatedAt: at, feedbackAt: at })
    .where(and(eq(scheduledPosts.status, 'waiting_review'), lt(scheduledPosts.sendAt, cutoff)))
    .returning({ id: scheduledPosts.id });
  if (unreviewed.length) {
    await ctx.db
      .update(approvals)
      .set({ status: 'rejected', decision: 'reject', decidedBy: 'system', note: 'expired: its time passed before it was reviewed', decidedAt: at })
      .where(and(inArray(approvals.id, unreviewed.map((r) => r.id)), eq(approvals.status, 'pending_approval')));
  }
  const late = await ctx.db
    .update(scheduledPosts)
    .set({ status: 'missed', error: 'missed: it could not go out in time', updatedAt: at })
    .where(and(eq(scheduledPosts.status, 'waiting'), lt(scheduledPosts.sendAt, cutoff)))
    .returning({ id: scheduledPosts.id });
  if (late.length) await ctx.db.update(approvals).set({ status: 'failed', note: 'missed: it could not go out in time', feedbackAt: at }).where(and(inArray(approvals.id, late.map((r) => r.id)), eq(approvals.status, 'approved'), isNull(approvals.postId)));
  if (unreviewed.length + late.length) ctx.log.info({ missed: [...unreviewed, ...late].map((r) => r.id) }, 'scheduled posts missed their time');
  return unreviewed.length + late.length;
}

let lastPruneAt = 0;

/**
 * The tick's part, beside the bounty sweep. Rows of unknown outcome are asked for at the sender; rows past their grace
 * are marked missed; then at most `SCHEDULED_SENDS_PER_TICK` due rows are sent, each under its coin's lease. Coins that
 * are paused, held, in a turn or silent are not in the line at all; the rest are taken least recently looked at first
 * and every row looked at is touched, so coins that cannot send now (a hold, the interval not over) never keep the
 * others from their turn. The sweep stops sending as soon as the platform's window is full or its quiet hours run.
 * Never throws.
 */
export async function sweepScheduled(ctx: SupervisorContext): Promise<ScheduledSweepReport> {
  const report: ScheduledSweepReport = { sent: 0, failed: 0, missed: 0, unknown: 0, toReview: 0 };
  if (!schedulingOn(ctx)) return report;
  const started = Date.now();
  const now = ctx.now();
  const limits = scheduleLimits(ctx);
  const count = (result: SendResult) => {
    if (result === 'sent') report.sent += 1;
    else if (result === 'failed') report.failed += 1;
    else if (result === 'unknown') report.unknown += 1;
    else if (result === 'review') report.toReview += 1;
  };
  try {
    const sending = await ctx.db.select({ id: scheduledPosts.id }).from(scheduledPosts).where(eq(scheduledPosts.status, 'sending')).orderBy(asc(scheduledPosts.updatedAt)).limit(SCHEDULED_RECONCILE_PER_TICK);
    for (const { id } of sending) count(await reconcileSending(ctx, id));
    report.missed = await expireScheduled(ctx, now);

    if (limits.sendsPerTick > 0) {
      const due = await ctx.db
        .select({ row: scheduledPosts, agent: agents, runtime: runtimes })
        .from(scheduledPosts)
        .innerJoin(agents, eq(agents.agentId, scheduledPosts.agentId))
        .innerJoin(runtimes, eq(runtimes.agentId, scheduledPosts.agentId))
        .where(
          and(
            eq(scheduledPosts.status, 'waiting'),
            lte(scheduledPosts.sendAt, new Date(now)),
            // What the rows themselves rule out is left out here, so a crowd of paused, held or busy coins takes no place in the line.
            eq(agents.status, 'active'),
            notInArray(runtimes.status, ['paused', 'held']),
            isNull(runtimes.turn),
            or(isNull(runtimes.leaseUntil), lt(runtimes.leaseUntil, new Date(now))),
            ...(ownEnabled(ctx) ? [] : [sql`(${agents.config}->>'runner' is distinct from 'own')`]),
          ),
        )
        .orderBy(asc(scheduledPosts.updatedAt), asc(scheduledPosts.sendAt))
        .limit(limits.sendsPerTick * (SCHEDULED_SCAN_PER_SEND + 1));
      const looked: string[] = [];
      const tried = new Set<string>();
      let sends = 0;
      for (const { row, agent, runtime } of due) {
        if (sends >= limits.sendsPerTick || Date.now() - started > SCHEDULED_SWEEP_BUDGET_MS) break;
        looked.push(row.id);
        // One send per coin and tick, and none where the rows already say it cannot go now: no lease taken, no read made.
        if (tried.has(agent.agentId) || (runtime.leaseUntil && runtime.leaseUntil.getTime() > now) || sendBlocked(ctx, agent, runtime, now)) continue;
        tried.add(agent.agentId);
        const result = await sendScheduled(ctx, row.id);
        count(result);
        if (result === 'window') break;
        if (result === 'sent' || result === 'failed' || result === 'unknown') sends += 1;
      }
      // Looked at: these go to the back of the line. A row that left `waiting` meanwhile is not touched.
      if (looked.length) await ctx.db.update(scheduledPosts).set({ updatedAt: new Date(ctx.now()) }).where(and(inArray(scheduledPosts.id, looked), eq(scheduledPosts.status, 'waiting')));
    }
    if (now - lastPruneAt >= PRUNE_EVERY_MS) {
      lastPruneAt = now;
      await ctx.db.delete(scheduledPosts).where(and(inArray(scheduledPosts.status, ['sent', 'failed', 'missed', 'cancelled']), lt(scheduledPosts.updatedAt, new Date(now - SCHEDULED_KEEP_MS))));
    }
  } catch (err) {
    ctx.log.error({ err: rpcErrorText(err) }, 'scheduled posts sweep failed');
  }
  return report;
}

// ---------------------------------------------------------------------------
// The creator's review of a scheduled post (approvals.ts `decideApproval` hands these over)
// ---------------------------------------------------------------------------

/** A review item that stands for a scheduled post: `meta.scheduled = { id, sendAt }` (section 17.4). */
export function isScheduledApproval(row: Pick<ApprovalRow, 'meta'>): boolean {
  const scheduled = (row.meta as { scheduled?: { id?: unknown } } | null)?.scheduled;
  return !!scheduled && typeof scheduled.id === 'string' && SCHEDULED_ID_RE.test(scheduled.id);
}

async function approvalViewOf(ctx: SupervisorContext, agent: AgentRow, row: ApprovalRow): Promise<ApprovalView> {
  const image = row.imageId ? await loadImage(ctx, agent.agentId, row.imageId) : null;
  const handle = (agent.config as { xHandle?: unknown }).xHandle;
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    text: row.text,
    inReplyTo: row.inReplyTo,
    image: row.imageId ? (image ? { id: image.id, alt: image.alt, mime: image.mime } : { id: row.imageId, alt: '', mime: '' }) : null,
    status: row.status,
    decision: row.decision,
    decidedBy: row.decidedBy,
    note: row.note,
    postId: row.postId,
    url: row.postId && typeof handle === 'string' && handle ? `https://x.com/${handle}/status/${row.postId}` : null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    expiresAt: new Date(row.createdAt.getTime() + APPROVAL_TTL_MS).toISOString(),
    bounty: null,
  };
}

/**
 * The creator's decision on a scheduled post. Approved before its time, it goes out at its time; approved inside the
 * grace, at once (the sweep tries again when it cannot go this moment); past the grace it has expired and nothing is
 * sent. Rejected, it is cancelled and the agent hears the note the way any rejected post's note is heard
 * (approvals.ts `takeFeedback`). The caller checked the creator and that the item is still pending.
 */
export async function decideScheduled(ctx: SupervisorContext, agent: AgentRow, approval: ApprovalRow, decision: 'approve' | 'reject', by: string, note: string | null): Promise<DecisionResult> {
  const now = ctx.now();
  const at = new Date(now);
  const id = approval.id;
  const refuse = (status: 404 | 409, error: string, message: string): DecisionResult => ({ ok: false, status, error, message });
  const row = await ctx.db.query.scheduledPosts.findFirst({ where: and(eq(scheduledPosts.id, id), eq(scheduledPosts.agentId, agent.agentId)) });
  const view = async () => ({ ok: true as const, approval: await approvalViewOf(ctx, agent, (await ctx.db.query.approvals.findFirst({ where: eq(approvals.id, id) })) ?? approval) });

  if (decision === 'reject') {
    await ctx.db.update(approvals).set({ status: 'rejected', decision: 'reject', decidedBy: by, note, decidedAt: at }).where(and(eq(approvals.id, id), eq(approvals.status, 'pending_approval')));
    await ctx.db.update(scheduledPosts).set({ status: 'cancelled', error: 'rejected by the creator', updatedAt: at, feedbackAt: at }).where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.status, 'waiting_review')));
    ctx.log.info({ agentId: agent.agentId, scheduledId: id, by }, 'scheduled post rejected by the creator');
    return view();
  }

  if (!row || row.status !== 'waiting_review') {
    // The post is no longer there to approve (cancelled, missed): the item closes with it.
    await ctx.db.update(approvals).set({ status: 'rejected', decision: 'reject', decidedBy: 'system', note: 'the scheduled post is no longer waiting', decidedAt: at, feedbackAt: at }).where(and(eq(approvals.id, id), eq(approvals.status, 'pending_approval')));
    return refuse(409, 'already_decided', 'this scheduled post is no longer waiting');
  }
  if (now > row.sendAt.getTime() + scheduleLimits(ctx).graceMs) {
    await expireScheduled(ctx, now);
    return refuse(409, 'scheduled_expired', 'the time this post was scheduled for has passed; it was not sent');
  }
  const [moved] = await ctx.db.update(scheduledPosts).set({ status: 'waiting', updatedAt: at }).where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.status, 'waiting_review'))).returning({ id: scheduledPosts.id });
  if (!moved) return refuse(409, 'already_decided', 'this scheduled post is no longer waiting');
  await ctx.db.update(approvals).set({ status: 'approved', decision: 'approve', decidedBy: by, note, decidedAt: at }).where(and(eq(approvals.id, id), eq(approvals.status, 'pending_approval')));
  ctx.log.info({ agentId: agent.agentId, scheduledId: id, by, sendAt: row.sendAt.toISOString() }, 'scheduled post approved by the creator');
  // Its time has come already: it goes now, through the same step the tick uses, with every check of that step.
  if (row.sendAt.getTime() <= now && schedulingOn(ctx) && scheduleLimits(ctx).sendsPerTick > 0) await sendScheduled(ctx, id);
  return view();
}

// ---------------------------------------------------------------------------
// The creator's list (the console's Posting section), and the hook
// ---------------------------------------------------------------------------

/** `{ items, mayQueue }` for the creator: the waiting posts with every part's text, soonest first. */
export async function scheduledView(ctx: Pick<SupervisorContext, 'db' | 'config'>, agentId: string): Promise<{ items: (ScheduledItem & { thread: string[] })[]; mayQueue: number }> {
  const waiting = await waitingScheduled(ctx, agentId);
  return { items: waiting.map((r) => ({ ...itemOf(r), thread: partsOf(r).slice(1) })), mayQueue: schedulingOn(ctx) ? Math.max(0, scheduleLimits(ctx).maxWaiting - countWaiting(waiting)) : 0 };
}

/**
 * `GET /internal/agents/:id/scheduled` and `POST /internal/agents/:id/scheduled/:scheduledId/cancel {by}` (section
 * 17.5), behind the HMAC like every internal route; the web checks the creator's console session and `by` is checked
 * again here. Mounting also registers the hook a post sent now is asked through (post-send.ts `beforeOriginalNow`).
 */
export function mountScheduled(app: Hono<AuthEnv>, ctx: SupervisorContext): void {
  setPostHooks({ beforeOriginalNow });

  app.get('/internal/agents/:id/scheduled', async (c) => {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, c.req.param('id')), columns: { agentId: true } });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    return c.json(await scheduledView(ctx, agent.agentId));
  });

  app.post('/internal/agents/:id/scheduled/:scheduledId/cancel', async (c) => {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, c.req.param('id')) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { by?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body', message: 'JSON object expected' }, 400);
    let by: Address;
    try {
      by = getAddress(String(body.by ?? ''));
    } catch {
      return c.json({ error: 'invalid_by', message: '`by` must be the creator address' }, 400);
    }
    if (!isAddressEqual(by, agent.creator as Address)) return c.json({ error: 'not_creator', message: '`by` is not the creator of this agent' }, 403);
    const id = c.req.param('scheduledId');
    if (!SCHEDULED_ID_RE.test(id)) return c.json({ error: 'invalid_id', message: 'the id of a scheduled post is sch_ and 16 characters' }, 400);
    const row = await cancelScheduled(ctx, agent.agentId, id, { by: 'creator', address: by });
    if (!row) return c.json({ error: 'scheduled_not_found', message: 'No waiting post has that id; it may have gone out already.' }, 404);
    return c.json(await scheduledView(ctx, agent.agentId));
  });
}
