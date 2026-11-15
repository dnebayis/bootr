/**
 * The silence alarm: the creator hears about it when an agent has published no original post for longer than a
 * threshold while it was awake and woke for its due post slots without posting. On 2026-11-15 the platform account
 * published nothing from 06:22 to 10:45 UTC although it woke at every post slot (07:27, 08:32, 09:37) and each turn
 * finished without a post; the owner noticed before anything here did.
 *
 * Read from what is stored, never from the model: the newest original that reached X (`sv_said`, kind `original`, and
 * the cadence anchor `lastPostAt`), and the finished turns of `sv_turns`. A turn "woke for a due slot" when its wake
 * reasons hold `original_post_due` (tick.ts); one that published or queued an original for review (`posted > 0`) ends
 * the silent stretch like a post that went out. A due slot the quiet slot spent by rule (quiet-slot.ts,
 * platform-quiet.ts) buys no turn and is never counted: that is the rule working, not silence.
 *
 * Silent, all of:
 *   - the threshold is on (`PLATFORM_SILENCE_ALERT_MS` for the platform account; 0 = off);
 *   - the agent is active, awake (not paused, asleep or holding an action), its post schedule is on, no X hold stands
 *     (quota, credits, forbidden) and it is outside the quiet hours;
 *   - the time it was awake and free to post since the stretch began (`awakeSince`: the later of the stretch's start, the
 *     end of the last quiet window and the end of the last X hold) is at least the threshold;
 *   - in that time it woke for at least `SILENCE_MIN_SPENT_SLOTS` due slots and finished each without a post. Two, not
 *     one: a turn may pass on a slot by choice, and one pass plus a skipped quiet slot is the rules working.
 *
 * One row per stretch (notifications.ts `post_silence`): raised the first time the stretch is silent, refreshed with
 * the new numbers while it lasts (no new row, no new message, no new warning), and closed only when the agent posts
 * again (a new original, or a turn that queued one). A stretch that is held (paused, a hold, quiet hours) keeps its row
 * as it is. The warn line goes out once, when the row is opened.
 *
 * The platform account only for now (`checkPlatformSilence`, called from the notifier's per-agent check). A coin agent
 * could use `checkPostSilence` as it is with a threshold of its own (a per-coin setting or a deployment one): its due
 * slots are the same `original_post_due` turns, and its quiet slot already spends a slot without a turn, so a coin that
 * skips slots because nothing happened is never counted as silent.
 */
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { AgentRow, RuntimeRow, SupervisorContext } from './context.js';
import { notifications, said, turns } from './db/schema.js';
import { raiseNotification, resolveNotification, type NotificationData } from './notifications.js';
import { agentConfigOf } from './onboarding.js';
import { DAY_MS, HOUR_MS, jitteredSchedule, parseQuietHours, quietUntil, type QuietHours } from './rhythm.js';
import type { AgentState } from './runtime.js';

/** The wake reason of a turn that woke for a due original post (agent-core `wakeDecision`). */
export const DUE_SLOT_REASON = 'original_post_due';
/** Due slots spent without a post before a stretch counts as silent. */
export const SILENCE_MIN_SPENT_SLOTS = 2;
/** How far back turns are read when no post is known. */
export const SILENCE_LOOKBACK_MS = 7 * DAY_MS;

export interface SilenceTurn {
  startedAt: number;
  endedAt: number;
  wakeReasons: readonly string[];
  posted: number;
  /** Micro-USDC, a decimal string as `sv_turns` keeps it. */
  chargedMicroUsdc: string;
  outcome: string;
}

export interface SilenceFacts {
  now: number;
  /** 0 = off. */
  thresholdMs: number;
  agentStatus: AgentRow['status'];
  runtimeStatus: RuntimeRow['status'] | null;
  /** The post schedule is on (X publishing, no owner rule closing it, the social loop started). */
  publishing: boolean;
  /** The newest original post that reached X (epoch ms); null when none is known. */
  lastPostAt: number | null;
  /** The earliest the stretch may start: the reading window, or when the social loop started. */
  floor: number;
  /** Finished social turns that started after `max(lastPostAt, floor)`, any order. */
  turns: readonly SilenceTurn[];
  state: Pick<AgentState, 'postQuotaUntil' | 'postCreditsUntil' | 'postForbiddenUntil' | 'postHoldEndedNote'>;
  quietHours: QuietHours | null;
  minSpentSlots?: number;
}

export type SilenceHeld = 'inactive' | 'paused' | 'asleep' | 'blocked' | 'publishing_off' | 'x_quota' | 'x_credits' | 'x_forbidden' | 'quiet_hours';

/** What the notice keeps (notifications.ts `postSilenceText` reads it): numbers only. */
export interface PostSilenceData extends NotificationData {
  /** Minutes since the stretch began. */
  silentMinutes: number;
  /** When the stretch began (the last post, or the turn that last queued one), epoch ms; 0 when no post is known. */
  since: number;
  /** Due slots it woke for and finished without a post since `awakeSince`. */
  slots: number;
  /** What those turns cost, micro-USDC. */
  chargedMicroUsdc: number;
  /** When it was last free to post after a quiet window or an X hold (or the stretch's start), epoch ms. */
  awakeSince: number;
}

export type SilenceVerdict =
  | { kind: 'off' }
  /** `postedAt`: the last post, or the end of the last turn that queued one (0 when none is known); `stretchStart`: that, or the reading window's start. */
  | { kind: 'held'; reason: SilenceHeld; postedAt: number; stretchStart: number }
  | { kind: 'not_silent'; postedAt: number; stretchStart: number }
  | { kind: 'silent'; postedAt: number; stretchStart: number; data: PostSilenceData; outcomes: Record<string, number> };

const microOf = (v: string): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The end of the last quiet window at or before `now` (epoch ms); null without quiet hours. Pure. */
export function lastQuietEnd(hours: QuietHours | null, now: number): number | null {
  if (!hours) return null;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const end = dayStart + (hours.end % 24) * HOUR_MS;
  return end <= now ? end : end - DAY_MS;
}

/** The X hold that stands now, if any. */
function standingHold(state: SilenceFacts['state'], now: number): SilenceHeld | null {
  if ((state.postQuotaUntil ?? 0) > now) return 'x_quota';
  if ((state.postCreditsUntil ?? 0) > now) return 'x_credits';
  if ((state.postForbiddenUntil ?? 0) > now) return 'x_forbidden';
  return null;
}

/** When the last X hold ended (epoch ms, at or before `now`), or 0. */
function holdEndedAt(state: SilenceFacts['state'], now: number): number {
  const ends = [state.postQuotaUntil, state.postCreditsUntil, state.postForbiddenUntil, state.postHoldEndedNote?.at].filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t <= now);
  return ends.length ? Math.max(...ends) : 0;
}

/** The pure part: facts in, verdict out. */
export function evaluateSilence(f: SilenceFacts): SilenceVerdict {
  if (!(f.thresholdMs > 0)) return { kind: 'off' };
  const isDue = (t: SilenceTurn) => t.wakeReasons.includes(DUE_SLOT_REASON);
  // A turn that queued an original for review decided to post: the stretch starts after it, as after a post.
  const queued = f.turns.filter((t) => t.posted > 0).map((t) => t.endedAt);
  const postedAt = Math.max(f.lastPostAt ?? 0, ...queued);
  const stretchStart = Math.max(postedAt, f.floor);
  const held = (reason: SilenceHeld): SilenceVerdict => ({ kind: 'held', reason, postedAt, stretchStart });
  if (f.agentStatus !== 'active') return held('inactive');
  if (f.runtimeStatus === 'paused') return held('paused');
  if (f.runtimeStatus === 'sleeping') return held('asleep');
  if (f.runtimeStatus === 'held') return held('blocked');
  if (!f.publishing) return held('publishing_off');
  const hold = standingHold(f.state, f.now);
  if (hold) return held(hold);
  if (quietUntil(f.quietHours, f.now) !== null) return held('quiet_hours');

  const awakeSince = Math.max(stretchStart, lastQuietEnd(f.quietHours, f.now) ?? 0, holdEndedAt(f.state, f.now));
  const spent = f.turns.filter((t) => isDue(t) && t.posted === 0 && t.startedAt >= awakeSince && t.endedAt <= f.now);
  if (f.now - awakeSince < f.thresholdMs || spent.length < (f.minSpentSlots ?? SILENCE_MIN_SPENT_SLOTS)) return { kind: 'not_silent', postedAt, stretchStart };
  const outcomes: Record<string, number> = {};
  for (const t of spent) outcomes[t.outcome] = (outcomes[t.outcome] ?? 0) + 1;
  return {
    kind: 'silent',
    postedAt,
    stretchStart,
    outcomes,
    data: {
      silentMinutes: Math.floor((f.now - stretchStart) / 60_000),
      since: postedAt > 0 ? stretchStart : 0,
      slots: spent.length,
      chargedMicroUsdc: spent.reduce((n, t) => n + microOf(t.chargedMicroUsdc), 0),
      awakeSince,
    },
  };
}

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'log' | 'config'>;

/** The newest original of the agent that reached X: the said-ledger and the cadence anchor, whichever is later. */
async function lastOriginalPostAt(ctx: Ctx, agentId: string, state: Pick<AgentState, 'lastPostAt'>): Promise<number | null> {
  const [row] = await ctx.db
    .select({ at: said.postedAt })
    .from(said)
    .where(and(eq(said.agentId, agentId), eq(said.kind, 'original')))
    .orderBy(desc(said.postedAt))
    .limit(1);
  const at = Math.max(row?.at.getTime() ?? 0, typeof state.lastPostAt === 'number' && Number.isFinite(state.lastPostAt) ? state.lastPostAt : 0);
  return at > 0 ? at : null;
}

/** Reads the facts for one agent. */
export async function silenceFacts(ctx: Ctx, agent: AgentRow, runtime: RuntimeRow | null, thresholdMs: number): Promise<SilenceFacts> {
  const now = ctx.now();
  const state = (runtime?.state ?? {}) as unknown as AgentState;
  const config = agentConfigOf(agent);
  const lastPostAt = await lastOriginalPostAt(ctx, agent.agentId, state);
  const started = config?.socialStartedAt ? Date.parse(config.socialStartedAt) : NaN;
  const floor = Math.max(now - SILENCE_LOOKBACK_MS, Number.isFinite(started) ? started : 0);
  const rows = await ctx.db
    .select({ startedAt: turns.startedAt, endedAt: turns.endedAt, wakeReasons: turns.wakeReasons, posted: turns.posted, chargedMicroUsdc: turns.chargedMicroUsdc, outcome: turns.outcome })
    .from(turns)
    .where(and(eq(turns.agentId, agent.agentId), eq(turns.role, 'social'), gt(turns.startedAt, new Date(Math.max(lastPostAt ?? 0, floor)))));
  return {
    now,
    thresholdMs,
    agentStatus: agent.status,
    runtimeStatus: runtime?.status ?? null,
    publishing: !!config && jitteredSchedule(config, state.lastPostAt ?? null, now) !== null,
    lastPostAt,
    floor,
    turns: rows.map((r) => ({ ...r, startedAt: r.startedAt.getTime(), endedAt: r.endedAt.getTime(), wakeReasons: Array.isArray(r.wakeReasons) ? r.wakeReasons : [] })),
    state,
    quietHours: parseQuietHours(ctx.config.PLATFORM_QUIET_HOURS_UTC),
  };
}

/**
 * Opens the stretch's row (or refreshes the open one). A new row starts with no send on its clock: `raiseNotification`
 * carries the last stretch's send over, which would keep the first message of this one back for a day.
 * Returns true when the row was opened now.
 */
async function raisePostSilence(ctx: Ctx, agentId: string, data: PostSilenceData): Promise<boolean> {
  const open = and(eq(notifications.agentId, agentId), eq(notifications.event, 'post_silence'), isNull(notifications.resolvedAt));
  const [before] = await ctx.db.select({ id: notifications.id }).from(notifications).where(open).limit(1);
  await raiseNotification(ctx, agentId, 'post_silence', data);
  if (before) return false;
  await ctx.db.update(notifications).set({ lastSentAt: null, sendCount: 0, nextAttemptAt: null }).where(open);
  return true;
}

/**
 * Brings the agent's `post_silence` row up to date with `thresholdMs`. Never throws: a read that fails leaves the row
 * as it was. Returns the verdict (null when the check failed), for the caller's log and the tests.
 */
export async function checkPostSilence(ctx: Ctx, agent: AgentRow, runtime: RuntimeRow | null, thresholdMs: number): Promise<SilenceVerdict | null> {
  try {
    const [open] = await ctx.db
      .select({ firstAt: notifications.firstAt })
      .from(notifications)
      .where(and(eq(notifications.agentId, agent.agentId), eq(notifications.event, 'post_silence'), isNull(notifications.resolvedAt)))
      .limit(1);
    if (!(thresholdMs > 0)) {
      if (open) await resolveNotification(ctx, agent.agentId, 'post_silence');
      return { kind: 'off' };
    }
    const verdict = evaluateSilence(await silenceFacts(ctx, agent, runtime, thresholdMs));
    if (verdict.kind === 'off') return verdict;
    // It posted (or queued a post) after the row was opened: the stretch is over, whatever holds it now.
    if (open && verdict.postedAt > open.firstAt.getTime()) {
      await resolveNotification(ctx, agent.agentId, 'post_silence');
      ctx.log.info({ agentId: agent.agentId, postedAt: new Date(verdict.postedAt).toISOString() }, 'post silence over: the agent posted again');
      return verdict;
    }
    if (verdict.kind !== 'silent') return verdict;
    const opened = await raisePostSilence(ctx, agent.agentId, verdict.data);
    if (opened) {
      const d = verdict.data;
      ctx.log.warn(
        {
          agentId: agent.agentId,
          silentMinutes: d.silentMinutes,
          lastPostAt: d.since ? new Date(d.since).toISOString() : null,
          awakeSince: new Date(d.awakeSince).toISOString(),
          dueSlotsWithoutPost: d.slots,
          chargedMicroUsdc: d.chargedMicroUsdc,
          outcomes: verdict.outcomes,
          thresholdMs,
        },
        'post silence: no original post while awake and due to post; the creator is told',
      );
    }
    return verdict;
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err: err instanceof Error ? err.message : String(err) }, 'post silence check failed; the notice is left as it was');
    return null;
  }
}

/** The platform account's check (`config.platform`), with `PLATFORM_SILENCE_ALERT_MS`. Nothing for any other agent. */
export async function checkPlatformSilence(ctx: Ctx, agent: AgentRow, runtime: RuntimeRow | null): Promise<SilenceVerdict | null> {
  if (agent.config.platform !== true) return null;
  return checkPostSilence(ctx, agent, runtime, ctx.config.PLATFORM_SILENCE_ALERT_MS);
}
