import { and, eq, inArray, sql } from 'drizzle-orm';
import { withToken } from './accounts.js';
import type { SenderContext } from './context.js';
import { inbox, optouts } from './db/schema.js';
import { meterRead } from './metering.js';
import type { XPost } from './normalize.js';

/**
 * Consent checks that need the agent's inbox or a live X lookup (H-4). Everything here runs in the
 * sender, the only process that sees every outgoing post.
 */

export type Transient = { kind: 'transient'; status: 429 | 503; message: string; retryAt?: number };

export type ReplyTarget =
  | { kind: 'found'; authorId: string; username: string | null; source: 'inbox' | 'x' }
  | { kind: 'not_found' }
  | Transient;

/** X errors that definitively mean "this post/user cannot be read" (deleted, protected, bad id). */
const DEFINITE_MISSING = new Set(['x_not_found', 'x_forbidden', 'x_bad_request']);

function transient(res: { status: number; message: string; retryAt?: number }): Transient {
  return {
    kind: 'transient',
    status: res.status === 429 ? 429 : 503,
    message: res.message,
    ...(res.retryAt ? { retryAt: res.retryAt } : {}),
  };
}

/**
 * Author of the post being replied to. The inbox row wins (it is what the agent was shown); a caller
 * supplied author id is never trusted. Posts outside the inbox are looked up on X (`GET /2/tweets/:id`).
 */
export async function resolveReplyTarget(
  ctx: SenderContext,
  agentId: string,
  postId: string,
  opts: { lookup?: boolean } = {},
): Promise<ReplyTarget | { kind: 'not_looked_up' }> {
  const [row] = await ctx.db
    .select({ authorId: inbox.authorId, post: inbox.post })
    .from(inbox)
    .where(and(eq(inbox.agentId, agentId), eq(inbox.postId, postId)))
    .limit(1);
  if (row?.authorId) {
    return {
      kind: 'found',
      authorId: row.authorId,
      username: (row.post as XPost | null)?.author?.username ?? null,
      source: 'inbox',
    };
  }
  if (opts.lookup === false) return { kind: 'not_looked_up' };
  const res = await withToken(ctx, agentId, (token) => ctx.x.getPost(token, postId));
  if (!res.ok) return DEFINITE_MISSING.has(res.error) ? { kind: 'not_found' } : transient(res);
  await meterRead(ctx, agentId, 'thread', 1);
  const tweet = res.data.data;
  if (!tweet?.author_id) return { kind: 'not_found' };
  const user = res.data.includes?.users?.find((u) => u.id === tweet.author_id);
  return {
    kind: 'found',
    authorId: tweet.author_id,
    username: user?.username ?? null,
    source: 'x',
  };
}

export async function isOptedOut(
  ctx: SenderContext,
  agentId: string,
  authorIds: readonly string[],
): Promise<boolean> {
  if (authorIds.length === 0) return false;
  const rows = await ctx.db
    .select({ authorId: optouts.authorId })
    .from(optouts)
    .where(
      and(
        eq(optouts.agentId, agentId),
        eq(optouts.enabled, true),
        inArray(optouts.authorId, [...authorIds]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * True when any @mentioned handle belongs to an author who opted out of this agent. Opt-outs are
 * keyed by stable X user id, so each handle is resolved: first through the inbox (authors the agent
 * has seen), then through `GET /2/users/by/username` (handles change hands and users rename). Skipped
 * entirely when the agent has no opt-outs, so ordinary posts cost no extra X reads.
 */
export async function mentionsOptedOut(
  ctx: SenderContext,
  agentId: string,
  handles: readonly string[],
): Promise<{ kind: 'ok'; optedOut: boolean; handle?: string } | Transient> {
  const unique = [...new Set(handles.map((h) => h.toLowerCase()))];
  if (unique.length === 0) return { kind: 'ok', optedOut: false };
  const [any] = await ctx.db
    .select({ authorId: optouts.authorId })
    .from(optouts)
    .where(and(eq(optouts.agentId, agentId), eq(optouts.enabled, true)))
    .limit(1);
  if (!any) return { kind: 'ok', optedOut: false };

  for (const handle of unique) {
    const seen = await ctx.db
      .selectDistinct({ authorId: inbox.authorId })
      .from(inbox)
      .where(
        and(
          eq(inbox.agentId, agentId),
          sql`lower(${inbox.post}->'author'->>'username') = ${handle}`,
        ),
      );
    const ids = seen.map((r) => r.authorId);
    if (await isOptedOut(ctx, agentId, ids)) return { kind: 'ok', optedOut: true, handle };
    const res = await withToken(ctx, agentId, (token) => ctx.x.userByUsername(token, handle));
    if (!res.ok) {
      if (DEFINITE_MISSING.has(res.error)) continue; // no such user: nobody to protect
      return transient(res);
    }
    await meterRead(ctx, agentId, 'account', 1);
    const id = res.data.data?.id;
    if (id && (await isOptedOut(ctx, agentId, [id]))) return { kind: 'ok', optedOut: true, handle };
  }
  return { kind: 'ok', optedOut: false };
}
