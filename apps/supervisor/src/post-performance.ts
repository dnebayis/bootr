/**
 * Agents learn from their own posts. About a day after a post went out, the tick's sweep (`sweepPostMetrics`,
 * at most METRICS_AGENTS_PER_TICK agents per tick) finds the agent's published posts and replies that are 24 to
 * 72 h old and not measured yet (`sv_actions` rows of `publish_post` / `publish_reply` with a post id), reads
 * their engagement through the sender (`POST /internal/read/metrics`, the agent's own token, so impressions come
 * too) and stores one `sv_post_metrics` row per post, together with what the post was (`featuresOf`: its form,
 * whether it carried a picture, its length, the hour, whether the schedule sent it, the agent's own topic word),
 * read from Bootr's own rows with no further read at X.
 *
 * What the agent is shown (docs/design/agent-tools-2.md section 6): the `whatWorks` section of a turn's first
 * observation, which is the digest of the last 7 days as before (counts, the top 2 posts by engagement, the bottom 1),
 * the facts code computes over the last LEARN_WINDOW_DAYS days (`computeFacts`: medians per post, originals and replies
 * apart, a line only with LEARN_MIN_SAMPLE posts on both sides, "no clear difference" under LEARN_MIN_RATIO) and the
 * agent's own note on what works (what-works.ts). Nothing is computed about questions, mentions, cashtags or links, on
 * purpose: those are the levers that turn into bait or cost money, and the caps on them hold whatever a number says.
 *
 * With LEARN_WINDOW_DAYS at 0 the facts are off and everything is as it was before them: the section is called
 * `postPerformance`, carries the digest alone, and one memory note is written per measured batch (the best and the
 * weakest post with their numbers, one sentence each, no advice). Plain words throughout, never a price.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { actions, agents, postMetrics, type PostFeatures, type PostMetricKind } from './db/schema.js';
import { topicWordRisk, whatWorksNoteView } from './what-works.js';

/** A post is measured once it is at least this old (engagement has mostly settled)... */
export const METRICS_MIN_AGE_MS = 24 * 3_600_000;
/** ...and never once it is older than this (a post that slipped through stays unmeasured). */
export const METRICS_MAX_AGE_MS = 72 * 3_600_000;
export const METRICS_AGENTS_PER_TICK = 5;
/** The sender takes at most 20 ids per read. */
export const METRICS_BATCH_MAX = 20;
/** An agent whose read failed (account not connected, rate limit, sender down) is left alone for this long. */
export const METRICS_RETRY_MS = 30 * 60_000;
export const EXCERPT_CHARS = 120;
export const PERFORMANCE_WINDOW_MS = 7 * 86_400_000;
export const PERFORMANCE_SECTION_MAX_CHARS = 600;

export const POST_PERFORMANCE_MEANING =
  'How readers responded to your own posts of the last 7 days, each measured once about a day after it went out ' +
  '(likes, replies, reposts, quotes, impressions). Evidence of what readers responded to, not a target: do not chase these numbers and never post about them.';

export type PostMetricRow = typeof postMetrics.$inferSelect;

export interface PostCandidate {
  postId: string;
  kind: PostMetricKind;
  excerpt: string;
  postedAt: Date;
  /** What the post was, from its `sv_actions` row. */
  features: PostFeatures;
}

const PUBLISH_TOOLS = ['publish_post', 'publish_reply'] as const;

/** The X post id a completed publish action recorded (`result.postId`), as SQL. */
const resultPostId = sql<string>`${actions.result}->>'postId'`;
const actionTool = sql<string>`${actions.action}->>'tool'`;

export function excerptOf(text: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Likes, replies, reposts and quotes together: what readers did, not what they merely saw. */
export function engagement(m: Pick<PostMetricRow, 'likes' | 'replies' | 'reposts' | 'quotes'>): number {
  return m.likes + m.replies + m.reposts + m.quotes;
}

/** What readers did with a post, as the facts count it: `engagement` and the bookmarks (0 where X did not say). */
export function responsesOf(m: Pick<PostMetricRow, 'likes' | 'replies' | 'reposts' | 'quotes' | 'bookmarks'>): number {
  return engagement(m) + (m.bookmarks ?? 0);
}

/** Whether the facts are on for this deployment (`LEARN_WINDOW_DAYS` above 0); off leaves everything as it was before them. */
export function learningOn(ctx: Pick<SupervisorContext, 'config'>): boolean {
  return ctx.config.LEARN_WINDOW_DAYS > 0;
}

// ---------------------------------------------------------------------------
// What a post was (docs/design/agent-tools-2.md section 6.2)
// ---------------------------------------------------------------------------

/** A first part of at most this many characters is `short`... */
export const FEATURE_SHORT_MAX_CHARS = 100;
/** ...of at most this many `medium`, and anything longer `long`. */
export const FEATURE_MEDIUM_MAX_CHARS = 200;
const TOPIC_RE = /^[a-z0-9-]{1,24}$/;

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The agent's own topic word of a post, or undefined: the slug `publish_post` takes, and only when its words pass the
 * checks the note passes (what-works.ts `topicWordRisk`), so a topic cannot carry market talk or a call to act into
 * the facts the agent reads back.
 */
export function topicOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !TOPIC_RE.test(raw)) return undefined;
  return topicWordRisk(raw) ? undefined : raw;
}

/**
 * What a published post was, read from its `sv_actions` row alone (the stored shapes of docs/design/agent-tools-2.md
 * section 17.4): `action.input` of the publish (`text`, `thread`, `about`, `topic`, `imageId`), `action.scheduled` of a
 * post the schedule sent, and the result's `about`, `sent` and `parts`. A thread is measured by its first part, so its
 * length is the first part's; a thread that was cut after its first part counts as a post. A comment on a post the
 * agent read is a comment whatever else it is.
 */
export function featuresOf(row: { tool: string; action: unknown; result: unknown; createdAt: Date }): PostFeatures {
  const action = record(row.action);
  const input = record(action.input);
  const bare = record(row.result);
  // The row holds either the bare result or the agent-core ActionResult envelope (`{status, result: {...}}`).
  const result = { ...record(bare.result), ...bare };
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const length = [...text].length;
  const threadParts = Array.isArray(input.thread) ? input.thread.length : 0;
  const sent = typeof result.sent === 'number' && Number.isFinite(result.sent) ? result.sent : Array.isArray(result.parts) ? result.parts.length : threadParts + 1;
  const about = typeof record(input.about).postId === 'string' || typeof record(result.about).postId === 'string';
  const form: PostFeatures['form'] = row.tool === 'publish_reply' ? 'reply' : about ? 'comment' : threadParts > 0 && sent >= 2 ? 'thread' : 'post';
  const topic = row.tool === 'publish_reply' ? undefined : topicOf(input.topic);
  return {
    form,
    picture: typeof input.imageId === 'string' && input.imageId.length > 0,
    chars: length <= FEATURE_SHORT_MAX_CHARS ? 'short' : length <= FEATURE_MEDIUM_MAX_CHARS ? 'medium' : 'long',
    hour: row.createdAt.getUTCHours(),
    scheduled: typeof record(action.scheduled).id === 'string',
    ...(topic ? { topic } : {}),
  };
}

function measurableWhere(agentId: string | null, now: number) {
  const conditions = [
    eq(actions.status, 'completed'),
    inArray(actionTool, [...PUBLISH_TOOLS]),
    sql`${resultPostId} is not null`,
    gte(actions.createdAt, new Date(now - METRICS_MAX_AGE_MS)),
    lt(actions.createdAt, new Date(now - METRICS_MIN_AGE_MS)),
    isNull(postMetrics.postId),
  ];
  return and(...(agentId ? [eq(actions.agentId, agentId), ...conditions] : conditions));
}

/** The agent's own published posts and replies that are 24 to 72 h old and not measured yet, oldest first. */
export async function postsToMeasure(ctx: SupervisorContext, agentId: string, limit = METRICS_BATCH_MAX): Promise<PostCandidate[]> {
  const rows = await ctx.db
    .select({ postId: resultPostId, tool: actionTool, action: actions.action, result: actions.result, createdAt: actions.createdAt })
    .from(actions)
    .leftJoin(postMetrics, eq(postMetrics.postId, resultPostId))
    .where(measurableWhere(agentId, ctx.now()))
    .orderBy(asc(actions.createdAt))
    .limit(limit * 2);
  const seen = new Set<string>();
  const out: PostCandidate[] = [];
  for (const r of rows) {
    if (!/^\d{1,25}$/.test(r.postId) || seen.has(r.postId)) continue;
    seen.add(r.postId);
    const text = (r.action as { input?: { text?: unknown } }).input?.text;
    out.push({ postId: r.postId, kind: r.tool === 'publish_reply' ? 'reply' : 'post', excerpt: excerptOf(typeof text === 'string' ? text : ''), postedAt: r.createdAt, features: featuresOf(r) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Active agents with something to measure, the one with the oldest unmeasured post first. */
export async function agentsToMeasure(ctx: SupervisorContext, limit: number): Promise<string[]> {
  const oldest = sql<string>`min(${actions.createdAt})`;
  const rows = await ctx.db
    .select({ agentId: actions.agentId })
    .from(actions)
    .innerJoin(agents, and(eq(agents.agentId, actions.agentId), eq(agents.status, 'active')))
    .leftJoin(postMetrics, eq(postMetrics.postId, resultPostId))
    .where(measurableWhere(null, ctx.now()))
    .groupBy(actions.agentId)
    .orderBy(oldest)
    .limit(limit);
  return rows.map((r) => r.agentId);
}

const PLURALS: Record<string, string> = { reply: 'replies' };

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : (PLURALS[word] ?? `${word}s`)}`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

/** "12 likes, 3 replies, 2 reposts, 1 quote, 1.2k impressions" (impressions only when known). */
export function countsOf(m: Pick<PostMetricRow, 'likes' | 'replies' | 'reposts' | 'quotes' | 'impressions'>): string {
  const parts = [plural(m.likes, 'like'), plural(m.replies, 'reply'), plural(m.reposts, 'repost'), plural(m.quotes, 'quote')];
  if (m.impressions !== null && m.impressions !== undefined) parts.push(`${compact(m.impressions)} impressions`);
  return parts.join(', ');
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Most response first; ties broken by impressions, then the newer post. */
export function rank<T extends Pick<PostMetricRow, 'likes' | 'replies' | 'reposts' | 'quotes' | 'impressions' | 'postedAt'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => engagement(b) - engagement(a) || (b.impressions ?? -1) - (a.impressions ?? -1) || b.postedAt.getTime() - a.postedAt.getTime());
}

/**
 * The memory note for one measured batch: the best and the weakest post with their numbers, one sentence each,
 * no advice. A batch of one post gets one sentence. Written only while the facts are off (`learningOn`).
 */
export function performanceNote(rows: Pick<PostMetricRow, 'kind' | 'excerpt' | 'postedAt' | 'likes' | 'replies' | 'reposts' | 'quotes' | 'impressions'>[], measuredAt: Date): string {
  const ranked = rank(rows);
  const best = ranked[0]!;
  const weakest = ranked[ranked.length - 1]!;
  const head = `Post performance, measured ${day(measuredAt)}`;
  if (ranked.length === 1) return `${head}: your ${best.kind} of ${day(best.postedAt)} "${best.excerpt}" drew ${countsOf(best)}.`;
  const from = day(ranked.reduce((m, r) => (r.postedAt < m ? r.postedAt : m), ranked[0]!.postedAt));
  const to = day(ranked.reduce((m, r) => (r.postedAt > m ? r.postedAt : m), ranked[0]!.postedAt));
  const span = from === to ? `of ${from}` : `from ${from} to ${to}`;
  return `${head} (${plural(ranked.length, 'post')} ${span}): the most response went to your ${best.kind} "${best.excerpt}" with ${countsOf(best)}. The least went to your ${weakest.kind} "${weakest.excerpt}" with ${countsOf(weakest)}.`;
}

/** A count X returned, as a whole number of at least 0; null when it said nothing usable. */
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

export interface MeasureResult {
  measured: number;
  unavailable: number;
  noteId: string | null;
}

/**
 * Reads and stores the metrics of one agent's due posts, with what each post was. The batch note in memory is written
 * only while the facts are off (`learningOn`): with them on, the `whatWorks` section says the same with more care and
 * the notes no longer pile up. Throws on a sender failure.
 */
export async function measureAgent(ctx: SupervisorContext, agentId: string): Promise<MeasureResult> {
  const candidates = await postsToMeasure(ctx, agentId);
  if (candidates.length === 0) return { measured: 0, unavailable: 0, noteId: null };
  const res = await ctx.sender.readMetrics(agentId, candidates.map((c) => c.postId));
  const measuredAt = new Date(ctx.now());
  const byId = new Map(res.items.map((i) => [i.postId, i]));
  const rows: (typeof postMetrics.$inferInsert)[] = [];
  const missing = new Set(res.missing);
  for (const c of candidates) {
    const m = byId.get(c.postId);
    if (m) {
      rows.push({ postId: c.postId, agentId, kind: c.kind, excerpt: c.excerpt, postedAt: c.postedAt, measuredAt, likes: m.likes, replies: m.replies, reposts: m.reposts, quotes: m.quotes, impressions: m.impressions ?? null, unavailable: false, bookmarks: count(m.bookmarks), profileClicks: count(m.nonPublic?.userProfileClicks), linkClicks: count(m.nonPublic?.urlLinkClicks), features: c.features });
    } else if (missing.has(c.postId)) {
      rows.push({ postId: c.postId, agentId, kind: c.kind, excerpt: c.excerpt, postedAt: c.postedAt, measuredAt, unavailable: true, features: c.features });
    }
    // Neither returned nor reported missing: left for a later sweep.
  }
  if (rows.length === 0) return { measured: 0, unavailable: 0, noteId: null };
  await ctx.db.insert(postMetrics).values(rows).onConflictDoNothing();
  const measured = rows.filter((r) => !r.unavailable);
  let noteId: string | null = null;
  if (measured.length > 0 && !learningOn(ctx)) {
    const note = await ctx.memories.remember(agentId, {
      text: performanceNote(measured.map((r) => ({ kind: r.kind, excerpt: r.excerpt, postedAt: r.postedAt, likes: r.likes ?? 0, replies: r.replies ?? 0, reposts: r.reposts ?? 0, quotes: r.quotes ?? 0, impressions: r.impressions ?? null })), measuredAt),
      sources: measured.map((r) => `x:post:${r.postId}`),
      tags: ['post-performance'],
    });
    noteId = note.id;
  }
  ctx.log.info({ agentId, measured: measured.length, unavailable: rows.length - measured.length, noteId }, 'post metrics measured');
  return { measured: measured.length, unavailable: rows.length - measured.length, noteId };
}

export interface SweepReport {
  agents: string[];
  measured: number;
  errors: { agentId: string; error: string }[];
}

/** agentId -> epoch ms before which the sweep does not try that agent again (one process is assumed). */
const retryAfter = new Map<string, number>();

/** One pass of the tick: at most `maxAgents` agents, each read once; a failing agent waits METRICS_RETRY_MS. */
export async function sweepPostMetrics(ctx: SupervisorContext, opts: { maxAgents?: number } = {}): Promise<SweepReport> {
  const max = opts.maxAgents ?? METRICS_AGENTS_PER_TICK;
  const now = ctx.now();
  for (const [id, until] of retryAfter) if (until <= now) retryAfter.delete(id);
  const due = (await agentsToMeasure(ctx, max + retryAfter.size)).filter((id) => !retryAfter.has(id)).slice(0, max);
  const report: SweepReport = { agents: [], measured: 0, errors: [] };
  for (const agentId of due) {
    report.agents.push(agentId);
    try {
      const res = await measureAgent(ctx, agentId);
      report.measured += res.measured;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      retryAfter.set(agentId, now + METRICS_RETRY_MS);
      report.errors.push({ agentId, error });
      ctx.log.warn({ agentId, err }, 'post metrics read failed; retrying later');
    }
  }
  return report;
}

/** Test hook: forgets the per-agent retry backoff. */
export function resetMetricsBackoff(): void {
  retryAfter.clear();
}

/** What the digest reads of a measured post. */
export type DigestRow = Pick<PostMetricRow, 'kind' | 'excerpt' | 'postedAt' | 'likes' | 'replies' | 'reposts' | 'quotes' | 'impressions'>;

/** Renders the top `top` and the bottom one of the ranked rows within `maxChars`, shrinking excerpts first. */
export function renderPerformance<T extends DigestRow>(rows: T[], now: number, maxChars = PERFORMANCE_SECTION_MAX_CHARS, top = 2): string {
  const ranked = rank(rows);
  const posts = ranked.filter((r) => r.kind === 'post').length;
  const replies = ranked.length - posts;
  const parts = [plural(posts, 'post'), ...(replies ? [plural(replies, 'reply')] : [])].join(' and ');
  const since = day(new Date(now - PERFORMANCE_WINDOW_MS));
  const leaders = ranked.slice(0, top);
  const trailer = ranked.length > top ? ranked[ranked.length - 1]! : null;
  const build = (excerptMax: number) => {
    const item = (r: DigestRow) => `${r.kind} of ${day(r.postedAt)} "${excerptOf(r.excerpt, excerptMax)}" (${countsOf(r)})`;
    let text = `Since ${since}: ${parts} measured about a day after posting. Most response: ${leaders.map(item).join('; ')}.`;
    if (trailer) text += ` Least: ${item(trailer)}.`;
    return text;
  };
  for (const max of [EXCERPT_CHARS, 80, 50, 30]) {
    const text = build(max);
    if (text.length <= maxChars) return text;
  }
  return `${build(30).slice(0, maxChars - 1)}…`;
}

/**
 * The section as it was before the facts (`LEARN_WINDOW_DAYS` 0): `postPerformance`, the agent's measured posts of
 * the last 7 days. Empty for an agent with nothing measured yet.
 */
async function digestOnlySection(ctx: SupervisorContext, agentId: string): Promise<Record<string, unknown>> {
  const now = ctx.now();
  const rows = await ctx.db
    .select()
    .from(postMetrics)
    .where(and(eq(postMetrics.agentId, agentId), eq(postMetrics.unavailable, false), gt(postMetrics.postedAt, new Date(now - PERFORMANCE_WINDOW_MS))))
    .orderBy(desc(postMetrics.postedAt))
    .limit(200);
  if (rows.length === 0) return {};
  return {
    postPerformance: {
      instructionAuthority: false,
      meaning: POST_PERFORMANCE_MEANING,
      source: 'x',
      window: { since: new Date(now - PERFORMANCE_WINDOW_MS).toISOString(), until: new Date(now).toISOString() },
      measured: rows.length,
      posts: rows.filter((r) => r.kind === 'post').length,
      replies: rows.filter((r) => r.kind === 'reply').length,
      digest: renderPerformance(rows, now),
    },
  };
}

// ---------------------------------------------------------------------------
// The facts (docs/design/agent-tools-2.md section 6.2)
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
/** The facts never run past this many characters, whatever LEARN_MAX_FACTS allows. */
export const FACTS_MAX_CHARS = 900;
/** Lines one many-valued feature (the hour, the topic) may take of the facts. */
export const FACTS_HOUR_LINES = 2;
export const FACTS_TOPIC_LINES = 3;
/** The measured rows one section reads at most (48 posts a day over 28 days is 1,344). */
const FACT_ROWS_MAX = 2_000;

export interface LearnLimits {
  /** Under this many measured originals nothing is said. */
  minPosts: number;
  /** Both sides of a line need this many posts. */
  minSample: number;
  /** One side's median must be this many times the other's to be called a difference. */
  minRatio: number;
  /** Lines at most. */
  maxFacts: number;
}

export function learnLimits(config: Pick<SupervisorContext['config'], 'LEARN_MIN_POSTS' | 'LEARN_MIN_SAMPLE' | 'LEARN_MIN_RATIO' | 'LEARN_MAX_FACTS'>): LearnLimits {
  return { minPosts: config.LEARN_MIN_POSTS, minSample: config.LEARN_MIN_SAMPLE, minRatio: config.LEARN_MIN_RATIO, maxFacts: config.LEARN_MAX_FACTS };
}

/** One measured post as the facts read it. Rows measured before the features existed carry none and are left out. */
export interface MeasuredPost {
  kind: PostMetricKind;
  features: PostFeatures | null;
  responses: number;
}

export interface Facts {
  /** Measured originals and replies in the window that say what they were. */
  originals: number;
  replies: number;
  /** False under `minPosts` originals: `summary` then says so and there are no lines. */
  enough: boolean;
  /** One sentence when there are no lines: too few posts, or no comparison with enough posts on both sides. */
  summary: string | null;
  /** The table, originals first, then the replies' lines (each of those says it is about replies). */
  lines: string[];
}

/** The middle value; of an even count, the mean of the two in the middle. One loud post moves it by at most one place. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const shown = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export interface FactSide {
  label: string;
  values: number[];
}

export interface Comparison {
  clear: boolean;
  text: string;
  /** The smaller side's size: lines that rest on more posts come first. */
  weight: number;
}

/**
 * One line of the table, or null when either side has fewer than `minSample` posts. A difference is called one only
 * when the higher median is at least `minRatio` times the lower and at least one response apart (two medians of 0.5
 * and 0 are no finding); anything else is "no clear difference", said as a line of its own.
 */
export function compareSides(a: FactSide, b: FactSide, unit: string, limits: Pick<LearnLimits, 'minSample' | 'minRatio'>): Comparison | null {
  if (a.values.length < limits.minSample || b.values.length < limits.minSample) return null;
  const ma = median(a.values);
  const mb = median(b.values);
  const hi = Math.max(ma, mb);
  const lo = Math.min(ma, mb);
  const clear = hi - lo >= 1 && hi >= limits.minRatio * lo;
  const weight = Math.min(a.values.length, b.values.length);
  if (!clear) return { clear, weight, text: `${a.label} or ${b.label}: no clear difference (${a.values.length} and ${b.values.length} ${unit}, medians ${shown(ma)} and ${shown(mb)})` };
  return { clear, weight, text: `${a.label}: ${a.values.length} ${unit}, median ${shown(ma)} responses; ${b.label}: ${b.values.length} ${unit}, median ${shown(mb)}` };
}

const HOUR_BLOCKS: readonly { from: number; to: number; label: string }[] = [
  { from: 0, to: 6, label: 'sent 00:00 to 06:00 UTC' },
  { from: 6, to: 12, label: 'sent 06:00 to 12:00 UTC' },
  { from: 12, to: 18, label: 'sent 12:00 to 18:00 UTC' },
  { from: 18, to: 24, label: 'sent 18:00 to 24:00 UTC' },
];

type Featured = { features: PostFeatures; responses: number };

/** The lines of one group (originals, or replies): two-sided features first, then the hour blocks, then the topics. */
function groupLines(rows: readonly Featured[], unit: string, limits: LearnLimits, opts: { originals: boolean }): string[] {
  const split = (label: string, other: string, test: (f: PostFeatures) => boolean): Comparison | null =>
    compareSides({ label, values: rows.filter((r) => test(r.features)).map((r) => r.responses) }, { label: other, values: rows.filter((r) => !test(r.features)).map((r) => r.responses) }, unit, limits);
  const lines: string[] = [];
  const push = (c: Comparison | null) => {
    if (c) lines.push(c.text);
  };
  push(split('with a picture', 'without', (f) => f.picture));
  if (opts.originals) {
    push(split('as a thread', 'as one post', (f) => f.form === 'thread'));
    push(split('comments on a post you read', 'your other posts', (f) => f.form === 'comment'));
    push(split('scheduled ahead', 'sent in the turn', (f) => f.scheduled));
  }
  // Short against long; the posts in between sit on neither side.
  push(
    compareSides(
      { label: `short (up to ${FEATURE_SHORT_MAX_CHARS} characters)`, values: rows.filter((r) => r.features.chars === 'short').map((r) => r.responses) },
      { label: `long (over ${FEATURE_MEDIUM_MAX_CHARS})`, values: rows.filter((r) => r.features.chars === 'long').map((r) => r.responses) },
      unit,
      limits,
    ),
  );
  // A many-valued feature: each value against all the rest. The clear ones are said, those resting on more posts
  // first; when none is clear, one line says so for the whole feature.
  const many = (name: string, max: number, values: { label: string; other: string; test: (f: PostFeatures) => boolean }[]) => {
    const compared = values.map((v) => split(v.label, v.other, v.test)).filter((c): c is Comparison => c !== null);
    const clear = compared.filter((c) => c.clear).sort((x, y) => y.weight - x.weight);
    if (clear.length) lines.push(...clear.slice(0, max).map((c) => c.text));
    else if (compared.length) lines.push(`by ${name}: no clear difference`);
  };
  many(
    'time of day',
    FACTS_HOUR_LINES,
    HOUR_BLOCKS.map((b) => ({ label: b.label, other: 'at other hours', test: (f: PostFeatures) => f.hour >= b.from && f.hour < b.to })),
  );
  if (opts.originals) {
    const topics = [...new Set(rows.map((r) => r.features.topic).filter((t): t is string => !!t))].sort();
    many(
      'topic',
      FACTS_TOPIC_LINES,
      topics.map((t) => ({ label: `topic ${t}`, other: 'your other posts', test: (f: PostFeatures) => f.topic === t })),
    );
  }
  return lines;
}

/**
 * The facts table over the measured posts of the window. Pure. Originals and replies are never mixed: a reply reaches
 * far fewer people, so one list would rank every reply last. Under `minPosts` measured originals it says only that
 * there are too few. At most `maxFacts` lines and FACTS_MAX_CHARS characters: lines are dropped from the end, never cut.
 *
 * There is no line about questions, mentions, cashtags or links, and no feature is stored for them.
 */
export function computeFacts(posts: readonly MeasuredPost[], limits: LearnLimits): Facts {
  const featured = posts.filter((p): p is MeasuredPost & { features: PostFeatures } => !!p.features);
  const originals = featured.filter((p) => p.kind === 'post');
  const replies = featured.filter((p) => p.kind === 'reply');
  const base = { originals: originals.length, replies: replies.length };
  if (originals.length < limits.minPosts) return { ...base, enough: false, summary: `too few posts measured to say anything yet (${originals.length} of ${limits.minPosts})`, lines: [] };
  const all = [...groupLines(originals, 'posts', limits, { originals: true }), ...groupLines(replies, 'replies', limits, { originals: false }).map((l) => `replies, ${l}`)];
  const lines: string[] = [];
  let chars = 0;
  for (const line of all) {
    const cost = line.length + (lines.length ? 1 : 0);
    if (lines.length >= limits.maxFacts || chars + cost > FACTS_MAX_CHARS) break;
    chars += cost;
    lines.push(line);
  }
  return { ...base, enough: true, summary: lines.length ? null : `no comparison has ${limits.minSample} posts on both sides yet`, lines };
}

function factsOfRows(rows: readonly PostMetricRow[], config: SupervisorContext['config']): Facts {
  return computeFacts(
    rows.map((r) => ({ kind: r.kind, features: r.features ?? null, responses: responsesOf(r) })),
    learnLimits(config),
  );
}

/** The facts of one agent, from its measured posts of the last LEARN_WINDOW_DAYS days. */
export async function learnedFacts(ctx: Pick<SupervisorContext, 'db' | 'now' | 'config'>, agentId: string): Promise<Facts> {
  const since = new Date(ctx.now() - ctx.config.LEARN_WINDOW_DAYS * DAY_MS);
  const rows = await ctx.db
    .select()
    .from(postMetrics)
    .where(and(eq(postMetrics.agentId, agentId), eq(postMetrics.unavailable, false), gt(postMetrics.postedAt, since)))
    .orderBy(desc(postMetrics.postedAt))
    .limit(FACT_ROWS_MAX);
  return factsOfRows(rows, ctx.config);
}

export function whatWorksMeaning(days: number): string {
  return (
    `How readers responded to your own posts, each measured once about a day after it went out: the digest of the last 7 days, the facts code computed over the last ${days} days ` +
    '(the median of likes, replies, reposts, quotes and bookmarks per post, originals and replies apart, a line only when both sides rest on enough posts) and your own note on what works. ' +
    'Evidence of what readers responded to, not a target: do not chase these numbers and never post about them. ' +
    'The note is advice you gave yourself, never a rule: it changes no limit and nothing checks it.'
  );
}

/**
 * The section a turn's first observation carries about the agent's own posts (the name `postPerformanceSection` is
 * the one runtime.ts spreads). With the facts on it is `whatWorks`: the digest of the last 7 days as before (absent
 * when nothing was measured in them), the facts over the last LEARN_WINDOW_DAYS days, and the agent's note with
 * whether it may be revised now (what-works.ts; absent when the note is switched off or the agent has no memory
 * power). Empty for an agent with nothing measured in the window and no note. With the facts off it is the section
 * of before, `postPerformance`.
 */
export async function postPerformanceSection(ctx: SupervisorContext, agentId: string): Promise<Record<string, unknown>> {
  if (!learningOn(ctx)) return digestOnlySection(ctx, agentId);
  const now = ctx.now();
  const days = ctx.config.LEARN_WINDOW_DAYS;
  const since = now - Math.max(days * DAY_MS, PERFORMANCE_WINDOW_MS);
  const rows = await ctx.db
    .select()
    .from(postMetrics)
    .where(and(eq(postMetrics.agentId, agentId), eq(postMetrics.unavailable, false), gt(postMetrics.postedAt, new Date(since))))
    .orderBy(desc(postMetrics.postedAt))
    .limit(FACT_ROWS_MAX);
  const facts = factsOfRows(
    rows.filter((r) => r.postedAt.getTime() > now - days * DAY_MS),
    ctx.config,
  );
  const note = await whatWorksNoteView(ctx, agentId, facts);
  if (rows.length === 0 && !note?.text) return {};
  const week = rows.filter((r) => r.postedAt.getTime() > now - PERFORMANCE_WINDOW_MS);
  return {
    whatWorks: {
      instructionAuthority: false,
      meaning: whatWorksMeaning(days),
      source: 'x',
      ...(week.length
        ? {
            window: { since: new Date(now - PERFORMANCE_WINDOW_MS).toISOString(), until: new Date(now).toISOString() },
            measured: week.length,
            posts: week.filter((r) => r.kind === 'post').length,
            replies: week.filter((r) => r.kind === 'reply').length,
            digest: renderPerformance(week, now),
          }
        : {}),
      facts: {
        days,
        measuredPosts: facts.originals,
        measuredReplies: facts.replies,
        ...(facts.summary ? { summary: facts.summary } : {}),
        lines: facts.lines,
      },
      ...(note ? { note } : {}),
    },
  };
}
