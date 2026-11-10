/**
 * `recentPosts`: what the agent itself said in the last two days, so a turn does not repeat a fact or a phrasing and sees
 * what the creator rejected (with the note). Sources: completed `publish_post` / `publish_reply` actions (sv_actions)
 * and the review queue (sv_approvals: pending, approved, rejected, failed). Newest first, at most RECENT_POSTS_MAX,
 * texts clipped. Empty object when there is nothing, so the observation stays small.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { actions, approvals } from './db/schema.js';

export const RECENT_POSTS_WINDOW_MS = 48 * 60 * 60 * 1000;
export const RECENT_POSTS_MAX = 16;
const EXCERPT = 140;

export interface RecentPost {
  at: string;
  kind: 'post' | 'reply';
  /** `sent` (on X), or the review queue state: `pending_review`, `approved`, `rejected`, `failed`. */
  status: 'sent' | 'pending_review' | 'approved' | 'rejected' | 'failed';
  text: string;
  /** The creator's note on a rejection, when there is one. */
  note?: string;
}

const clip = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export async function recentPosts(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string): Promise<RecentPost[]> {
  const since = new Date(ctx.now() - RECENT_POSTS_WINDOW_MS);
  const [sent, reviewed] = await Promise.all([
    ctx.db
      .select({ at: actions.createdAt, tool: sql<string>`${actions.action}->>'tool'`, text: sql<string>`${actions.action}->'input'->>'text'` })
      .from(actions)
      .where(and(eq(actions.agentId, agentId), eq(actions.status, 'completed'), gte(actions.createdAt, since), sql`${actions.action}->>'tool' in ('publish_post', 'publish_reply')`))
      .orderBy(desc(actions.createdAt))
      .limit(RECENT_POSTS_MAX),
    ctx.db
      .select({ at: approvals.createdAt, kind: approvals.kind, text: approvals.text, status: approvals.status, note: approvals.note })
      .from(approvals)
      .where(and(eq(approvals.agentId, agentId), gte(approvals.createdAt, since), inArray(approvals.status, ['pending_approval', 'approved', 'rejected', 'failed'])))
      .orderBy(desc(approvals.createdAt))
      .limit(RECENT_POSTS_MAX),
  ]);
  const out: RecentPost[] = [];
  const seen = new Set<string>();
  for (const r of reviewed) {
    const text = clip(r.text, EXCERPT);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const status: RecentPost['status'] = r.status === 'pending_approval' ? 'pending_review' : r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'failed';
    out.push({ at: r.at.toISOString(), kind: r.kind === 'reply' ? 'reply' : 'post', status, text, ...(r.note && status === 'rejected' ? { note: clip(r.note, 200) } : {}) });
  }
  for (const r of sent) {
    const text = clip(r.text, EXCERPT);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ at: r.at.toISOString(), kind: r.tool === 'publish_reply' ? 'reply' : 'post', status: 'sent', text });
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

/** The question quota from the agent's last sent original posts (completed `publish_post` actions, newest first). */
export async function questionBudget(ctx: Pick<SupervisorContext, 'db'>, agentId: string, opts: { excludeActionId?: string } = {}): Promise<QuestionBudget> {
  const rows = await ctx.db
    .select({ id: actions.actionId, text: sql<string>`${actions.action}->'input'->>'text'` })
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
  return { recentPosts: { meaning: 'what you already said in the last two days, newest first; never repeat a fact or a phrasing from here, and a rejected item carries the creator\'s note', items }, ...questions };
}
