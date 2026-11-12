import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { SenderContext } from './context.js';
import type { Db } from './db/client.js';
import { actions, quotas } from './db/schema.js';

export const POST_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EffectiveQuota {
  agentId: string;
  postsPerDay: number;
  mentionReadIntervalSec: number;
  /**
   * X read units per UTC day in force for this agent (read-budget.ts): the agent's own value when one is set
   * (`sender_quotas.reads_per_day`), else the sender's default; 0 = no budget.
   */
  readsPerDay: number;
  lastMentionsReadAt: Date | null;
  mentionsSinceId: string | null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function getQuota(
  ctx: SenderContext,
  agentId: string,
  db: Db | Tx = ctx.db,
): Promise<EffectiveQuota> {
  const rows = await db.select().from(quotas).where(eq(quotas.agentId, agentId)).limit(1);
  const q = rows[0];
  return {
    agentId,
    postsPerDay: q?.postsPerDay ?? ctx.defaults.postsPerDay,
    mentionReadIntervalSec: q?.mentionReadIntervalSec ?? ctx.defaults.mentionReadIntervalSec,
    readsPerDay: q?.readsPerDay ?? ctx.defaults.readsPerDay,
    lastMentionsReadAt: q?.lastMentionsReadAt ?? null,
    mentionsSinceId: q?.mentionsSinceId ?? null,
  };
}

export async function setQuota(
  ctx: SenderContext,
  agentId: string,
  patch: {
    postsPerDay?: number | null;
    mentionReadIntervalSec?: number | null;
    readsPerDay?: number | null;
  },
): Promise<EffectiveQuota> {
  const set: Partial<typeof quotas.$inferInsert> = { updatedAt: ctx.now() };
  if (patch.postsPerDay !== undefined) set.postsPerDay = patch.postsPerDay;
  if (patch.mentionReadIntervalSec !== undefined)
    set.mentionReadIntervalSec = patch.mentionReadIntervalSec;
  if (patch.readsPerDay !== undefined) set.readsPerDay = patch.readsPerDay;
  await ctx.db
    .insert(quotas)
    .values({ agentId, ...set })
    .onConflictDoUpdate({ target: quotas.agentId, set });
  return getQuota(ctx, agentId);
}

/** Posts that count against the budget: everything that may have reached X. */
export async function postsInWindow(
  db: Db | Tx,
  agentId: string,
  since: Date,
): Promise<{ count: number; oldest: Date | null }> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${actions.createdAt})`,
    })
    .from(actions)
    .where(
      and(
        eq(actions.agentId, agentId),
        inArray(actions.status, ['pending', 'sent', 'held']),
        gt(actions.createdAt, since),
      ),
    );
  return { count: Number(row?.n ?? 0), oldest: row?.oldest ? new Date(row.oldest) : null };
}

/**
 * Atomically claim the mention-read slot. Returns null when the agent read too recently,
 * otherwise the quota as it was before the claim.
 */
export async function claimMentionRead(
  ctx: SenderContext,
  agentId: string,
): Promise<
  { ok: true; quota: EffectiveQuota } | { ok: false; nextReadAt: Date; quota: EffectiveQuota }
> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'sender_mentions:' + agentId}))`);
    const quota = await getQuota(ctx, agentId, tx);
    const now = ctx.now();
    if (quota.lastMentionsReadAt) {
      const next = new Date(
        quota.lastMentionsReadAt.getTime() + quota.mentionReadIntervalSec * 1000,
      );
      if (next > now) return { ok: false as const, nextReadAt: next, quota };
    }
    await tx
      .insert(quotas)
      .values({ agentId, lastMentionsReadAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: quotas.agentId,
        set: { lastMentionsReadAt: now, updatedAt: now },
      });
    return { ok: true as const, quota };
  });
}
