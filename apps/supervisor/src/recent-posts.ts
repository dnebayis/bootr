/**
 * `recentPosts`: what the agent itself said in the last day, so a turn does not repeat a fact or a phrasing and sees
 * what the creator rejected (with the note). Sources: completed `publish_post` / `publish_reply` actions (sv_actions)
 * and the review queue (sv_approvals: pending, approved, rejected, failed). Newest first, at most RECENT_POSTS_MAX,
 * texts clipped. Empty object when there is nothing, so the observation stays small.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { actions, approvals } from './db/schema.js';

export const RECENT_POSTS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RECENT_POSTS_MAX = 8;
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

/** The observation section, or `{}` when the agent said nothing in the last day. */
export async function recentPostsSection(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string): Promise<Record<string, unknown>> {
  const items = await recentPosts(ctx, agentId);
  if (items.length === 0) return {};
  return { recentPosts: { meaning: 'what you already said in the last 24 hours, newest first; never repeat a fact or a phrasing from here, and a rejected item carries the creator\'s note', items } };
}
