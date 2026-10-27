import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { SenderContext } from './context.js';
import { actions, reads } from './db/schema.js';

export const PRICE_USD = { post: 0.01, read: 0.005 } as const;

export type ReadKind = 'mentions' | 'thread' | 'account' | 'timeline' | 'users_me';

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Record `count` read resources for charge-back. Best effort: metering never fails a request. */
export async function meterRead(
  ctx: SenderContext,
  agentId: string,
  kind: ReadKind,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  try {
    await ctx.db
      .insert(reads)
      .values({ agentId, kind, day: utcDay(ctx.now()), count })
      .onConflictDoUpdate({
        target: [reads.agentId, reads.kind, reads.day],
        set: { count: sql`${reads.count} + ${count}` },
      });
  } catch {
    // swallow: losing a metering increment is preferable to failing an agent read
  }
}

export function monthRange(month: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}

export async function getMetering(ctx: SenderContext, agentId: string, month: string) {
  const range = monthRange(month);
  if (!range) return null;
  const [posted] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .where(
      and(
        eq(actions.agentId, agentId),
        eq(actions.status, 'sent'),
        gte(actions.sentAt, range.start),
        lt(actions.sentAt, range.end),
      ),
    );
  const [held] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .where(
      and(
        eq(actions.agentId, agentId),
        eq(actions.status, 'held'),
        gte(actions.createdAt, range.start),
        lt(actions.createdAt, range.end),
      ),
    );
  const rows = await ctx.db
    .select({ kind: reads.kind, n: sql<number>`sum(${reads.count})::int` })
    .from(reads)
    .where(
      and(
        eq(reads.agentId, agentId),
        gte(reads.day, utcDay(range.start)),
        lt(reads.day, utcDay(range.end)),
      ),
    )
    .groupBy(reads.kind);
  const byKind: Record<string, number> = {};
  let readsTotal = 0;
  for (const r of rows) {
    byKind[r.kind] = Number(r.n);
    readsTotal += Number(r.n);
  }
  const posts = Number(posted?.n ?? 0);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    agentId,
    month,
    posts,
    heldPosts: Number(held?.n ?? 0),
    reads: byKind,
    readsTotal,
    unitPriceUsd: PRICE_USD,
    estimatedUsd: {
      posts: round(posts * PRICE_USD.post),
      reads: round(readsTotal * PRICE_USD.read),
      total: round(posts * PRICE_USD.post + readsTotal * PRICE_USD.read),
    },
  };
}
