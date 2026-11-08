/**
 * `bootrPromotion`: whether a coin agent's next original post may mention that it runs on Bootr. The persona line
 * (`coinPromotionLine` in onboarding.ts) allows at most one original post in six; this section does the counting the
 * model cannot, from its own last `PROMOTION_SPACING` original posts (completed `publish_post` actions, sv_actions): a
 * slot is free when none of them names Bootr. One indexed read; empty for the platform agent, whose persona promotes
 * Bootr on its own. Never a nudge to post: the agent says it next to what it was going to say anyway.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AgentConfig } from '@bootr/agent-core';
import type { SupervisorContext } from './context.js';
import { actions } from './db/schema.js';

/** The "one post in six" rule: Bootr may be named again once this many original posts went out without it. */
export const PROMOTION_SPACING = 5;

const BOOTR = /\bbootr\b/i;

export interface BootrPromotionView {
  meaning: string;
  /** True when none of the last `PROMOTION_SPACING` original posts named Bootr. */
  slotFree: boolean;
  /** Original posts since Bootr was last named, capped at `PROMOTION_SPACING` (`PROMOTION_SPACING` also when it never was). */
  postsSinceLast: number;
}

/** The view for the given recent original posts, newest first. Pure. */
export function bootrPromotionView(recentOriginals: readonly string[]): BootrPromotionView {
  const recent = recentOriginals.slice(0, PROMOTION_SPACING);
  const idx = recent.findIndex((t) => BOOTR.test(t));
  const postsSinceLast = idx === -1 ? PROMOTION_SPACING : idx;
  const slotFree = idx === -1;
  return {
    meaning: slotFree
      ? 'you may mention that you run on Bootr in your next original post if it fits what you are saying anyway (at most one post in six, never a whole post about it, never in a reply to an unrelated question)'
      : `you named Bootr ${postsSinceLast === 0 ? 'in your last original post' : `${postsSinceLast} original post${postsSinceLast === 1 ? '' : 's'} ago`}: not again until ${PROMOTION_SPACING - postsSinceLast} more went out without it`,
    slotFree,
    postsSinceLast,
  };
}

/** Texts of the agent's last `PROMOTION_SPACING` original posts that went out, newest first. */
export async function recentOriginalPosts(ctx: Pick<SupervisorContext, 'db'>, agentId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ text: sql<string | null>`${actions.action}->'input'->>'text'` })
    .from(actions)
    .where(and(eq(actions.agentId, agentId), eq(actions.status, 'completed'), sql`${actions.action}->>'tool' = 'publish_post'`))
    .orderBy(desc(actions.createdAt))
    .limit(PROMOTION_SPACING);
  return rows.map((r) => (typeof r.text === 'string' ? r.text : ''));
}

/** The observation section for a coin agent that may publish; `{}` for the platform agent, without the power, or when the read fails. */
export async function bootrPromotionSection(ctx: Pick<SupervisorContext, 'db' | 'log'>, agentId: string, config: Pick<AgentConfig, 'platform' | 'capabilities'>): Promise<Record<string, unknown>> {
  if (config.platform || !config.capabilities.xPublish) return {};
  try {
    return { bootrPromotion: bootrPromotionView(await recentOriginalPosts(ctx, agentId)) };
  } catch (err) {
    ctx.log.warn({ agentId, err }, 'bootr promotion read failed; turn goes on without the section');
    return {};
  }
}
