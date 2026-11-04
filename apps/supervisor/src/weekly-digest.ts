/**
 * "This week on Bootr": once per ISO week the platform's own agent (@AgentBootr, `config.platform`) is handed the
 * week's facts from the indexer feed (platform-feed.ts) and asked to write one post about them, in plain words with
 * names and dates, no prices, no hype, and to skip it when nothing happened.
 *
 * Schedule: the digest is due at `PLATFORM_DIGEST_AT` (`sun:16` = Sunday 16:00 UTC) when the agent's state does not
 * yet carry that slot's ISO week (`AgentState.lastDigestWeek`), and stays due for DIGEST_GRACE_MS after the slot; a
 * slot missed for longer (the agent slept through it) is not caught up. It wakes the agent on its own
 * (`weeklyDigestWake`, called from tick.ts) and respects the platform rhythm like any original post: a schedule held
 * by quiet hours or a full slot window keeps the digest waiting, and the broker's `originalPostGate` still runs at
 * publish time. It is not the agent's cadence post: the cadence anchor (`lastPostAt`) does not move for it, so the
 * agent may still post its regular post the same day.
 *
 * Done: the supervisor cannot tell which `publish_post` is the digest (the model passes nothing special), so the week
 * is marked done when any original post completes in a turn that carried the digest, or when that turn ends with
 * `finish` (the agent judged there was nothing worth a post), or when the runtime ends it itself (step cap), so a turn
 * that could not post does not nag every tick. A week whose facts are all zero is marked done at the tick without
 * waking the agent. An original post that completes outside the turn loop (a publish settled on a later tick) is not
 * recognised as the digest.
 */
import type { AgentConfig, RuntimeStatus, WakeDecision } from '@bootr/agent-core';
import type { AgentRow, SupervisorContext } from './context.js';
import { cachedPlatformFeedData, clean, handleOf, iso, milestoneWords, selectWindow, type PlatformFeedData, WEEK_MS } from './platform-feed.js';
import type { RhythmSchedule } from './rhythm.js';
import { originalPostGate } from './rhythm.js';
import { saveRuntime, type AgentState } from './runtime.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** How long after its slot a digest stays due; past that the week is skipped, not caught up. */
export const DIGEST_GRACE_MS = 2 * DAY_MS;
export const DEFAULT_DIGEST_AT = 'sun:16';
/** Most items of one kind handed to the model (the counts stay exact). */
export const DIGEST_MAX_ITEMS = 12;
/** The wake reason the digest adds to the decision. */
export const DIGEST_WAKE_REASON = 'weekly_digest_due';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

// ---------------------------------------------------------------------------
// Slot and week arithmetic (pure)
// ---------------------------------------------------------------------------

export interface DigestSlot {
  /** 0 = Sunday .. 6 = Saturday (UTC). */
  day: number;
  /** 0..23 UTC. */
  hour: number;
}

/** `<day>:<hour>` in UTC (`sun:16`, `Mon:9`); the default when unset or empty. Throws on anything else. */
export function parseDigestAt(spec: string | null | undefined): DigestSlot {
  const text = (spec ?? '').trim().toLowerCase() || DEFAULT_DIGEST_AT;
  const m = /^([a-z]{3}):(\d{1,2})$/.exec(text);
  const day = m ? DAYS.indexOf(m[1] as (typeof DAYS)[number]) : -1;
  const hour = m ? Number(m[2]) : NaN;
  if (!m || day < 0 || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`invalid PLATFORM_DIGEST_AT: ${text} (expected <day>:<hour> in UTC, e.g. sun:16)`);
  return { day, hour };
}

/** ISO 8601 week of an instant, `YYYY-Www` (weeks start on Monday; the year is the week-year). */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Epoch ms of the latest slot at or before `now`. */
export function lastSlotAt(slot: DigestSlot, now: number): number {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const weekday = new Date(dayStart).getUTCDay();
  const at = dayStart - ((weekday - slot.day + 7) % 7) * DAY_MS + slot.hour * HOUR_MS;
  return at > now ? at - 7 * DAY_MS : at;
}

export interface DigestDue {
  /** The ISO week the slot falls in: the key stored in `AgentState.lastDigestWeek`. */
  week: string;
  /** Epoch ms of the slot. */
  slotAt: number;
}

/**
 * The slot that is due now, or null: the latest slot at or before `now` whose week is not `lastDigestWeek`, within
 * DIGEST_GRACE_MS of the slot.
 */
export function digestDue(slot: DigestSlot, lastDigestWeek: string | null | undefined, now: number): DigestDue | null {
  const slotAt = lastSlotAt(slot, now);
  if (now - slotAt > DIGEST_GRACE_MS) return null;
  const week = isoWeekKey(slotAt);
  if (lastDigestWeek === week) return null;
  return { week, slotAt };
}

// ---------------------------------------------------------------------------
// Facts (third-party content from the indexer, cleaned; never a price, a volume or a USD amount)
// ---------------------------------------------------------------------------

export interface DigestFacts {
  source: 'indexer';
  totals: { coins: number; agentsAwake: number; agentsTotal: number };
  counts: { launches: number; milestones: number; firstPosts: number; statusChanges: number; posters: number; claims: number };
  /** Oldest first, at most DIGEST_MAX_ITEMS each; symbols without a cashtag. */
  launches: { name: string; symbol: string; agent: string | null; at: string }[];
  milestones: { symbol: string; what: string; at: string }[];
  firstPosts: { symbol: string; agent: string | null; at: string }[];
  statusChanges: { symbol: string; agent: string | null; status: string; at: string }[];
  /** Agents that posted in the window, by symbol and handle (no counts: a post is not a number to brag about). */
  posters: { symbol: string; agent: string | null }[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** A coin's symbol without a cashtag: the platform account may not use any cashtag but $BOOTR, so the facts never show one. */
const plainSymbol = (v: unknown): string => clean(v, 12).replace(/^\$/, '') || '?';

/** The week's facts from the raw feed: the window [now - 7 d, now], the reader's own kernel left out. */
export function digestFacts(data: PlatformFeedData, now: number, exclude: string | null): DigestFacts {
  const w = selectWindow(data, (now - WEEK_MS) / 1000, now / 1000 + 1, exclude ? exclude.toLowerCase() : null);
  const oldestFirst = <T>(xs: T[]): T[] => [...xs].reverse().slice(0, DIGEST_MAX_ITEMS);
  const t = data.totals ?? {};
  return {
    source: 'indexer',
    totals: { coins: num(t.tokens), agentsAwake: num(t.agentsAwake), agentsTotal: num(t.agentsTotal) },
    counts: { launches: w.launches.length, milestones: w.milestones.length, firstPosts: w.firstPosts.length, statusChanges: w.changes.length, posters: w.posts.length, claims: w.claims.length },
    launches: oldestFirst(w.launches).map((l) => ({ name: clean(l.name, 32) || 'Unnamed', symbol: plainSymbol(l.symbol), agent: handleOf(l.xHandle), at: iso(l.launchedAt) })),
    milestones: oldestFirst(w.milestones).map((m) => ({ symbol: plainSymbol(m.symbol), what: milestoneWords(m.kind, m.value), at: iso(m.at) })),
    firstPosts: oldestFirst(w.firstPosts).map((p) => ({ symbol: plainSymbol(p.symbol), agent: handleOf(p.xHandle), at: iso(p.firstPostAt ?? (now - WEEK_MS) / 1000) })),
    statusChanges: oldestFirst(w.changes).map((s) => ({ symbol: plainSymbol(s.symbol), agent: handleOf(s.xHandle), status: clean(s.status, 16) || 'unknown', at: iso(s.at) })),
    posters: w.posts.slice(0, DIGEST_MAX_ITEMS).map((p) => ({ symbol: plainSymbol(p.symbol), agent: handleOf(p.xHandle) })),
  };
}

/** True when nothing at all happened in the window: no launch, milestone, first post, wake/sleep change, post or claim. */
export function nothingHappened(facts: DigestFacts): boolean {
  const c = facts.counts;
  return c.launches + c.milestones + c.firstPosts + c.statusChanges + c.posters + c.claims === 0;
}

// ---------------------------------------------------------------------------
// The plan handed to a turn, and the observation section
// ---------------------------------------------------------------------------

export interface WeeklyDigestPlan {
  week: string;
  slotAt: number;
  /** The facts window, ms. */
  from: number;
  to: number;
  facts: DigestFacts;
}

export const WEEKLY_DIGEST_INSTRUCTION =
  'Your weekly digest is due: one original post that says what happened on Bootr this week, in plain words, with the coins and agents by name and handle and the dates, from the facts below and nothing else. ' +
  'Name a coin by its name or symbol as a word, never as a cashtag ($BOOTR is the only cashtag you may write). ' +
  'No prices, no market caps, no volumes, no returns, no predictions, no hype. One post only (publish_post makes one post; there are no threads). ' +
  'This digest is separate from your regular slot: it does not count as your regular post, and your regular post is still due or not as the schedule says. ' +
  'If the facts are too thin for a post worth reading, do not post it: call finish and say so; the week is then closed without a digest and you will not be asked again.';

export const WEEKLY_DIGEST_PICTURE =
  'You may make one picture for it with generate_image (your coin\'s style reference applies) and attach it as imageId; a picture is optional and the post must read well without it.';

/**
 * The `weeklyDigest` section of the platform agent's first observation (empty when no digest is due this turn).
 * `picture` is `optional` when the images capability is on and `generate_image` is among the tools, else `off`.
 */
export function weeklyDigestSection(config: Pick<AgentConfig, 'platform' | 'capabilities'>, plan: WeeklyDigestPlan | null, tools: readonly { name: string }[]): Record<string, unknown> {
  if (!plan || config.platform !== true) return {};
  const picture = config.capabilities.images && tools.some((t) => t.name === 'generate_image') ? 'optional' : 'off';
  return {
    weeklyDigest: {
      due: true,
      week: plan.week,
      from: new Date(plan.from).toISOString(),
      to: new Date(plan.to).toISOString(),
      facts: plan.facts,
      picture,
      instruction: picture === 'optional' ? `${WEEKLY_DIGEST_INSTRUCTION} ${WEEKLY_DIGEST_PICTURE}` : WEEKLY_DIGEST_INSTRUCTION,
    },
  };
}

// ---------------------------------------------------------------------------
// Wake side (tick.ts) and settle side (runtime.ts)
// ---------------------------------------------------------------------------

/**
 * The digest due for this agent at this tick, or null. For the platform agent only. Null while the rhythm holds
 * original posts (the schedule says `held`, or `originalPostGate` is closed when the schedule was not due and so not
 * checked), while the indexer does not answer (tried again next tick), and when the week's facts are all zero (the
 * week is then marked done in `state` and saved, no turn). When a digest is due and the agent is waiting, the wake
 * decision is folded in place: `run` becomes true and DIGEST_WAKE_REASON joins the reasons.
 */
export async function weeklyDigestWake(
  ctx: SupervisorContext,
  agent: Pick<AgentRow, 'agentId' | 'kernel'>,
  config: AgentConfig,
  state: AgentState,
  schedule: RhythmSchedule | null,
  status: RuntimeStatus,
  now: number,
  decision: WakeDecision,
): Promise<WeeklyDigestPlan | null> {
  if (config.platform !== true || !schedule || status !== 'waiting') return null;
  const due = digestDue(parseDigestAt(ctx.config.PLATFORM_DIGEST_AT), state.lastDigestWeek ?? null, now);
  if (!due) return null;
  const log = ctx.log.child({ agentId: agent.agentId, week: due.week });
  if (schedule.held) {
    log.debug({ reason: schedule.held.reason, until: schedule.held.until }, 'weekly digest waits for the rhythm');
    return null;
  }
  if (!schedule.due) {
    const gate = await originalPostGate(ctx, now);
    if (!gate.open) {
      log.debug({ reason: gate.hold.reason, until: gate.hold.until }, 'weekly digest waits for the rhythm');
      return null;
    }
  }
  const data = await cachedPlatformFeedData(ctx);
  if (!data) {
    log.warn('weekly digest: the indexer did not answer; trying again next tick');
    return null;
  }
  const facts = digestFacts(data, now, agent.kernel);
  if (nothingHappened(facts)) {
    state.lastDigestWeek = due.week;
    await saveRuntime(ctx, agent.agentId, { state: state as unknown as Record<string, unknown> });
    log.info('weekly digest: nothing happened this week; closed without a post');
    return null;
  }
  if (!decision.run) {
    decision.run = true;
    decision.reasons = [DIGEST_WAKE_REASON];
  } else if (!decision.reasons.includes(DIGEST_WAKE_REASON)) {
    decision.reasons.push(DIGEST_WAKE_REASON);
  }
  return { week: due.week, slotAt: due.slotAt, from: now - WEEK_MS, to: now, facts };
}

/**
 * Closes the digest a turn carried (`turn.digestWeek`): the week is recorded in the state and the turn forgets it, so
 * a second original post in the same turn moves the cadence anchor as usual. True when this call closed it (the
 * caller then treats the post as the digest, not the cadence post); false when the turn carried no open digest.
 */
export function settleWeeklyDigest(state: AgentState, turn: { digestWeek?: string | null }): boolean {
  const week = turn.digestWeek ?? null;
  if (!week) return false;
  state.lastDigestWeek = week;
  turn.digestWeek = null;
  return true;
}
