/**
 * `recentPosts`: what the agent itself said in the last two days, so a turn does not repeat a fact or a phrasing and sees
 * what the creator rejected (with the note). Sources: completed `publish_post` / `publish_reply` actions (sv_actions)
 * and the review queue (sv_approvals: pending, approved, rejected, failed). Newest first, at most RECENT_POSTS_MAX,
 * texts clipped. Empty object when there is nothing, so the observation stays small.
 *
 * A thread is one item. Its first post is the item's text, as for any post; the posts after it are in `more`, each
 * cut to THREAD_PART_EXCERPT characters, so the agent sees everything it said without the section growing by four
 * whole posts. A thread that was cut shows the posts that went out, and `of` says how many it was meant to have. The
 * checks that keep an agent from repeating itself already read every post of a thread: the question quota
 * (`questionBudget`), the review queue's and the scheduler's "same text" checks (a hash over all posts), and X's own
 * duplicate rule per post. This section is what the model itself goes by, so it shows them too.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { actions, approvals, scheduledPosts } from './db/schema.js';

export const RECENT_POSTS_WINDOW_MS = 48 * 60 * 60 * 1000;
export const RECENT_POSTS_MAX = 16;
const EXCERPT = 140;
/** How much of each later post of a thread an item shows. */
export const THREAD_PART_EXCERPT = 80;

export interface RecentPost {
  at: string;
  kind: 'post' | 'reply';
  /** `sent` (on X), the review queue state (`pending_review`, `approved`, `rejected`, `failed`), or `scheduled`: it waits for its time, which is `at`. */
  status: 'sent' | 'pending_review' | 'approved' | 'rejected' | 'failed' | 'scheduled';
  text: string;
  /** The creator's note on a rejection, when there is one. */
  note?: string;
  /** A thread: the start of each post after the first, in order (the posts that went out, for a sent one). Absent for a single post. */
  more?: string[];
  /** A thread that was cut: how many posts it was meant to have (`more` holds the ones that went out). */
  of?: number;
}

/** The texts of the posts after the first, from a stored `thread` (`[{ text }]`); none for anything else. */
function laterParts(thread: unknown): string[] {
  return Array.isArray(thread) ? thread.map((p) => (p as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : [];
}

/** What an item says of a thread: `more` for the later posts (`sent` of them when the thread was cut), `of` when it was cut. Nothing for a single post. */
function threadFields(thread: unknown, sent?: unknown): Pick<RecentPost, 'more' | 'of'> {
  const later = laterParts(thread);
  if (later.length === 0) return {};
  const total = 1 + later.length;
  const out = typeof sent === 'number' && Number.isInteger(sent) && sent >= 1 && sent < total ? sent : total;
  const more = later.slice(0, out - 1).map((t) => clip(t, THREAD_PART_EXCERPT));
  return { ...(more.length ? { more } : {}), ...(out < total ? { of: total } : {}) };
}

const clip = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export async function recentPosts(ctx: Pick<SupervisorContext, 'db' | 'now'> & Partial<Pick<SupervisorContext, 'config'>>, agentId: string): Promise<RecentPost[]> {
  const since = new Date(ctx.now() - RECENT_POSTS_WINDOW_MS);
  // With scheduling switched off by its limit nothing in the queue goes out, so nothing in it counts as said.
  const queue = ctx.config?.SCHEDULED_MAX_WAITING !== 0 && ctx.config?.SCHEDULE_MAX_AHEAD_MS !== 0;
  const [sent, reviewed, scheduled] = await Promise.all([
    ctx.db
      .select({ at: actions.createdAt, tool: sql<string>`${actions.action}->>'tool'`, text: sql<string>`${actions.action}->'input'->>'text'`, thread: sql<unknown>`${actions.action}->'input'->'thread'`, sent: sql<number | null>`coalesce(${actions.result}->'result'->'sent', ${actions.result}->'sent')` })
      .from(actions)
      .where(and(eq(actions.agentId, agentId), eq(actions.status, 'completed'), gte(actions.createdAt, since), sql`${actions.action}->>'tool' in ('publish_post', 'publish_reply')`))
      .orderBy(desc(actions.createdAt))
      .limit(RECENT_POSTS_MAX),
    ctx.db
      .select({ at: approvals.createdAt, kind: approvals.kind, text: approvals.text, status: approvals.status, note: approvals.note, thread: sql<unknown>`${approvals.meta}->'thread'` })
      .from(approvals)
      .where(and(eq(approvals.agentId, agentId), gte(approvals.createdAt, since), inArray(approvals.status, ['pending_approval', 'approved', 'rejected', 'failed'])))
      .orderBy(desc(approvals.createdAt))
      .limit(RECENT_POSTS_MAX),
    // Posts the agent scheduled that have not gone out (scheduled.ts): said already, so nothing is said twice.
    queue
      ? ctx.db
          .select({ at: scheduledPosts.sendAt, text: scheduledPosts.text, thread: scheduledPosts.thread })
          .from(scheduledPosts)
          .where(and(eq(scheduledPosts.agentId, agentId), gte(scheduledPosts.sendAt, since), inArray(scheduledPosts.status, ['waiting_review', 'waiting', 'sending'])))
          .orderBy(desc(scheduledPosts.sendAt))
          .limit(RECENT_POSTS_MAX)
      : [],
  ]);
  const out: RecentPost[] = [];
  const seen = new Set<string>();
  for (const r of scheduled) {
    const text = clip(r.text, EXCERPT);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ at: r.at.toISOString(), kind: 'post', status: 'scheduled', text, ...threadFields(r.thread) });
  }
  for (const r of reviewed) {
    const text = clip(r.text, EXCERPT);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const status: RecentPost['status'] = r.status === 'pending_approval' ? 'pending_review' : r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'failed';
    out.push({ at: r.at.toISOString(), kind: r.kind === 'reply' ? 'reply' : 'post', status, text, ...(r.note && status === 'rejected' ? { note: clip(r.note, 200) } : {}), ...(r.kind === 'reply' ? {} : threadFields(r.thread)) });
  }
  for (const r of sent) {
    const text = clip(r.text, EXCERPT);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ at: r.at.toISOString(), kind: r.tool === 'publish_reply' ? 'reply' : 'post', status: 'sent', text, ...(r.tool === 'publish_reply' ? {} : threadFields(r.thread, r.sent)) });
  }
  out.sort((a, b) => (a.at < b.at ? 1 : -1));
  return out.slice(0, RECENT_POSTS_MAX);
}

/**
 * The question habit (found 2026-11-10: the platform agent closed about one post in two with "Builders, what's yours?").
 * An original post may carry a question only when none of the agent's last `QUESTION_LOOKBACK` sent original posts did,
 * so at most one in `QUESTION_LOOKBACK + 1`. Replies are not counted and not limited: answering a person may ask back.
 * The broker refuses a post over the quota (`question_quota`) and the observation says where the agent stands, so the
 * rule is code and the prompts stay as they are.
 */
export const QUESTION_LOOKBACK = 4;

/** Whether a post asks something: a question mark outside links. */
export function asksQuestion(text: string): boolean {
  return text.replace(/https?:\/\/\S+/gi, ' ').includes('?');
}

export interface QuestionBudget {
  /** Of the agent's last QUESTION_LOOKBACK sent original posts, how many asked something. */
  recentWithQuestion: number;
  lookback: number;
  mayAskNow: boolean;
}

/** The question quota from the agent's last sent original posts (completed `publish_post` actions, newest first); a thread asks when any of its parts does. */
export async function questionBudget(ctx: Pick<SupervisorContext, 'db'>, agentId: string, opts: { excludeActionId?: string } = {}): Promise<QuestionBudget> {
  const rows = await ctx.db
    // The text of every part: the first, then the thread's (one per line), so a question in a later part counts too.
    .select({ id: actions.actionId, text: sql<string>`concat_ws(E'\n', ${actions.action}->'input'->>'text', case when jsonb_typeof(${actions.action}->'input'->'thread') = 'array' then (select string_agg(part->>'text', E'\n') from jsonb_array_elements(${actions.action}->'input'->'thread') as part) end)` })
    .from(actions)
    .where(and(eq(actions.agentId, agentId), eq(actions.status, 'completed'), sql`${actions.action}->>'tool' = 'publish_post'`))
    .orderBy(desc(actions.createdAt))
    .limit(QUESTION_LOOKBACK + 1);
  const last = rows.filter((r) => r.id !== opts.excludeActionId).slice(0, QUESTION_LOOKBACK);
  const recentWithQuestion = last.filter((r) => typeof r.text === 'string' && asksQuestion(r.text)).length;
  return { recentWithQuestion, lookback: QUESTION_LOOKBACK, mayAskNow: recentWithQuestion === 0 };
}

/** The refusal a post over the quota gets (broker `publish_post`), or null when it may go. */
export function questionQuotaRefusal(text: string, budget: QuestionBudget): string | null {
  if (budget.mayAskNow || !asksQuestion(text)) return null;
  return `question_quota: ${budget.recentWithQuestion} of your last ${budget.lookback} original posts already asked something, and at most one original post in ${budget.lookback + 1} may carry a question. Make this one a statement: say the thing itself, drop the closing question, and do not ask the audience what they think. Nothing was posted.`;
}

/** The observation section, or `{}` when the agent said nothing in the last day. */
export async function recentPostsSection(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string): Promise<Record<string, unknown>> {
  const [items, budget] = await Promise.all([recentPosts(ctx, agentId), questionBudget(ctx, agentId)]);
  const questions = {
    questions: {
      meaning: `At most one original post in ${budget.lookback + 1} may ask a question; the rest say something. Never close a post with a question to the audience ("what's yours?", "what would you build?") just to invite replies. Replies are not counted.`,
      recentWithQuestion: budget.recentWithQuestion,
      mayAskNow: budget.mayAskNow,
    },
  };
  if (items.length === 0) return budget.recentWithQuestion ? questions : {};
  // Said only when a thread is listed, so a coin that never wrote one reads the words it always read.
  const threads = items.some((i) => i.more || i.of) ? '. A thread is one item: text is its first post and more holds the start of each post after it (with of, the thread was cut and only these went out)' : '';
  return { recentPosts: { meaning: `what you already said in the last two days, newest first; never repeat a fact or a phrasing from here, and a rejected item carries the creator's note${threads}`, items }, ...questions };
}
