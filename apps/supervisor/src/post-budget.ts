/**
 * `postBudget`: how much of the creator's daily budget of posts and replies (the sender's rolling 24 h quota,
 * `config.postsPerDay`, agent-config.ts) the agent has left, so the model paces itself instead of running into the
 * sender's refusal and the quota hold (rhythm.ts `quotaHold`, which keeps working underneath). Counted from the agent's
 * own publishes of the last day in sv_actions (in flight or sent; a thread counts once per part, as the sender counts
 * it: the parts that went out, or all of them while it is in flight), which is what the sender counts too; a small
 * difference (a publish the sender refused, a review the creator has not approved) is fine for pacing. One indexed read,
 * omitted when it fails.
 */
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { AgentConfig } from '@bootr/agent-core';
import { POSTS_PER_DAY } from '@bootr/shared/workers';
import type { SupervisorContext } from './context.js';
import { actions } from './db/schema.js';

export const POST_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PostBudgetView {
  meaning: string;
  /** The creator's budget: original posts and replies together, over a rolling 24 hours. */
  postsPerDay: number;
  usedLast24h: number;
  remaining: number;
  /** When the oldest publish in the window drops out of it (ISO), when the budget is used up. */
  opensAt?: string;
}

/** The budget an agent config (parsed or stored) carries: the sender's default when the creator never set one. */
export function postsPerDayOf(config: { postsPerDay?: unknown }): number {
  const n = config.postsPerDay;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : POSTS_PER_DAY.default;
}

export function postBudgetView(postsPerDay: number, used: { count: number; oldest: number | null }, now: number): PostBudgetView {
  const remaining = Math.max(0, postsPerDay - used.count);
  const opensAt = remaining === 0 && used.oldest ? new Date(Math.max(now, used.oldest + POST_BUDGET_WINDOW_MS)).toISOString() : undefined;
  return {
    meaning:
      remaining === 0
        ? 'your daily budget of posts and replies is used up; publish_post and publish_reply are refused until it opens again'
        : `what you can still publish today, original posts and replies together, over a rolling 24 hours; pace yourself so that mentions later in the day can still be answered${remaining <= Math.max(2, Math.ceil(postsPerDay / 6)) ? ', and keep the last few for replies' : ''}`,
    postsPerDay,
    usedLast24h: used.count,
    remaining,
    ...(opensAt ? { opensAt } : {}),
  };
}

/** The agent's publishes of the last day that reached or may reach X (in flight or sent), and the oldest of them. */
export async function publishesLast24h(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string): Promise<{ count: number; oldest: number | null }> {
  const since = new Date(ctx.now() - POST_BUDGET_WINDOW_MS);
  const [row] = await ctx.db
    .select({
      // One per publish, and for a thread one per part: the parts that went out once it settled (`result.sent`), all of them before.
      n: sql<number>`coalesce(sum(coalesce((${actions.result}->'result'->>'sent')::int, (${actions.result}->>'sent')::int, 1 + case when jsonb_typeof(${actions.action}->'input'->'thread') = 'array' then jsonb_array_length(${actions.action}->'input'->'thread') else 0 end)), 0)::int`,
      oldest: sql<string | null>`min(${actions.createdAt})`,
    })
    .from(actions)
    .where(and(eq(actions.agentId, agentId), inArray(actions.status, ['sending', 'sent', 'completed']), gt(actions.createdAt, since), sql`${actions.action}->>'tool' in ('publish_post', 'publish_reply')`));
  return { count: Number(row?.n ?? 0), oldest: row?.oldest ? new Date(row.oldest).getTime() : null };
}

/** The observation section for an agent that can publish or reply; `{}` otherwise, or when the read fails. */
export async function postBudgetSection(ctx: Pick<SupervisorContext, 'db' | 'now' | 'log'>, agentId: string, config: Pick<AgentConfig, 'postsPerDay' | 'capabilities'>): Promise<Record<string, unknown>> {
  if (!config.capabilities.xPublish && !config.capabilities.xReply) return {};
  try {
    return { postBudget: postBudgetView(postsPerDayOf(config), await publishesLast24h(ctx, agentId), ctx.now()) };
  } catch (err) {
    ctx.log.warn({ agentId, err }, 'post budget read failed; turn goes on without the section');
    return {};
  }
}
