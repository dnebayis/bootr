/**
 * Agents learn from their own posts. About a day after a post went out, the tick's sweep (`sweepPostMetrics`,
 * at most METRICS_AGENTS_PER_TICK agents per tick) finds the agent's published posts and replies that are 24 to
 * 72 h old and not measured yet (`sv_actions` rows of `publish_post` / `publish_reply` with a post id), reads
 * their engagement through the sender (`POST /internal/read/metrics`, the agent's own token, so impressions come
 * too), stores one `sv_post_metrics` row per post and writes ONE memory note per measured batch: the best and the
 * weakest post with their numbers, one sentence each, no advice. `postPerformanceSection` renders the last 7 days
 * (counts, the top 2 posts by engagement, the bottom 1) into the first observation of a turn, capped at
 * PERFORMANCE_SECTION_MAX_CHARS. Plain words throughout, never a price.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { actions, agents, postMetrics, type PostMetricKind } from './db/schema.js';

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
    .select({ postId: resultPostId, tool: actionTool, action: actions.action, createdAt: actions.createdAt })
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
    out.push({ postId: r.postId, kind: r.tool === 'publish_reply' ? 'reply' : 'post', excerpt: excerptOf(typeof text === 'string' ? text : ''), postedAt: r.createdAt });
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
 * no advice. A batch of one post gets one sentence.
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

export interface MeasureResult {
  measured: number;
  unavailable: number;
  noteId: string | null;
}

/** Reads and stores the metrics of one agent's due posts and writes the batch note. Throws on a sender failure. */
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
      rows.push({ postId: c.postId, agentId, kind: c.kind, excerpt: c.excerpt, postedAt: c.postedAt, measuredAt, likes: m.likes, replies: m.replies, reposts: m.reposts, quotes: m.quotes, impressions: m.impressions ?? null, unavailable: false });
    } else if (missing.has(c.postId)) {
      rows.push({ postId: c.postId, agentId, kind: c.kind, excerpt: c.excerpt, postedAt: c.postedAt, measuredAt, unavailable: true });
    }
    // Neither returned nor reported missing: left for a later sweep.
  }
  if (rows.length === 0) return { measured: 0, unavailable: 0, noteId: null };
  await ctx.db.insert(postMetrics).values(rows).onConflictDoNothing();
  const measured = rows.filter((r) => !r.unavailable);
  let noteId: string | null = null;
  if (measured.length > 0) {
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

/** Renders the top `top` and the bottom one of the ranked rows within `maxChars`, shrinking excerpts first. */
export function renderPerformance(rows: PostMetricRow[], now: number, maxChars = PERFORMANCE_SECTION_MAX_CHARS, top = 2): string {
  const ranked = rank(rows);
  const posts = ranked.filter((r) => r.kind === 'post').length;
  const replies = ranked.length - posts;
  const parts = [plural(posts, 'post'), ...(replies ? [plural(replies, 'reply')] : [])].join(' and ');
  const since = day(new Date(now - PERFORMANCE_WINDOW_MS));
  const leaders = ranked.slice(0, top);
  const trailer = ranked.length > top ? ranked[ranked.length - 1]! : null;
  const build = (excerptMax: number) => {
    const item = (r: PostMetricRow) => `${r.kind} of ${day(r.postedAt)} "${excerptOf(r.excerpt, excerptMax)}" (${countsOf(r)})`;
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
 * The `postPerformance` observation section, spread into the turn's first observation: the agent's measured posts
 * of the last 7 days. Empty for an agent with nothing measured yet.
 */
export async function postPerformanceSection(ctx: SupervisorContext, agentId: string): Promise<Record<string, unknown>> {
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
