import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { carriesLink } from '@bootr/agent-core';
import type { SenderContext } from './context.js';
import { actions, reads } from './db/schema.js';

/**
 * X's pay-per-use prices per call (https://docs.x.com/x-api/getting-started/pricing, read 2026-11-13): a post, a post
 * that contains a link, a reply to somebody who addressed the account, a post read, a user read. A part of a thread
 * after the first is stored as a post and priced as one (whether X prices a reply to one's own post lower is not
 * known), and anything with a link is priced as a post with a link, a reply included: the estimate errs high.
 */
export const PRICE_USD = { post: 0.015, postWithLink: 0.2, reply: 0.01, read: 0.005, userRead: 0.01 } as const;

/** The read kinds that are lookups of a user, not of posts (`meterRead` callers: the account lookup, `users/me`). */
export const USER_READ_KINDS: readonly string[] = ['account', 'users_me'];

export type ReadKind = 'mentions' | 'thread' | 'account' | 'timeline' | 'users_me' | 'metrics' | 'replies';

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
  // Sent rows by what X charges for them: with a link (any kind), else a reply, else a post. The texts are read and
  // the link looked for here (agent-core `carriesLink`, the function the link budget uses): a month is a few hundred rows.
  const sent = await ctx.db
    .select({ kind: actions.kind, text: actions.text })
    .from(actions)
    .where(
      and(
        eq(actions.agentId, agentId),
        eq(actions.status, 'sent'),
        gte(actions.sentAt, range.start),
        lt(actions.sentAt, range.end),
      ),
    );
  let postsWithLink = 0;
  let replies = 0;
  let postsPlain = 0;
  for (const row of sent) {
    if (carriesLink(row.text)) postsWithLink += 1;
    else if (row.kind === 'reply') replies += 1;
    else postsPlain += 1;
  }
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
  let userReads = 0;
  for (const r of rows) {
    byKind[r.kind] = Number(r.n);
    readsTotal += Number(r.n);
    if (USER_READ_KINDS.includes(r.kind)) userReads += Number(r.n);
  }
  const posts = sent.length;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const postsUsd = postsPlain * PRICE_USD.post + postsWithLink * PRICE_USD.postWithLink + replies * PRICE_USD.reply;
  const readsUsd = (readsTotal - userReads) * PRICE_USD.read + userReads * PRICE_USD.userRead;
  return {
    agentId,
    month,
    /** Everything sent in the month: posts, thread parts and replies. */
    posts,
    /** The same, by price: without a link (`postsPlain` and `replies`), and with one whatever the kind. */
    postsPlain,
    postsWithLink,
    replies,
    heldPosts: Number(held?.n ?? 0),
    reads: byKind,
    readsTotal,
    userReads,
    unitPriceUsd: PRICE_USD,
    estimatedUsd: {
      posts: round(postsUsd),
      reads: round(readsUsd),
      total: round(postsUsd + readsUsd),
    },
  };
}
