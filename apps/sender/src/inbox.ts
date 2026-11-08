import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getAccount, withToken } from './accounts.js';
import type { SenderContext } from './context.js';
import { inbox, optouts, quotas, type InboxRow } from './db/schema.js';
import { meterRead } from './metering.js';
import { toXPost, type XPost } from './normalize.js';
import { consentCommand } from './policy-shim.js';
import { claimMentionRead } from './quota.js';
import { budgetExhausted, maxResultsWithin, readBudget, requireReads } from './read-budget.js';
import type { XListResponse, XTweet, XUser } from './x-client.js';

const xId = z.string().regex(/^\d{1,25}$/);

/** `POST /internal/read/timeline`: posts per read, at most; the default when `max` is absent. */
export const MAX_TIMELINE_POSTS = 10;
export const DEFAULT_TIMELINE_POSTS = 5;
/** The timeline read looks this far back. */
export const TIMELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const mentionsSchema = z.object({ agentId: z.string().min(1), sinceId: xId.optional() });
export const threadSchema = z.object({ agentId: z.string().min(1), postId: xId });
export const accountReadSchema = z.object({
  agentId: z.string().min(1),
  username: z.string().regex(/^@?\w{1,15}$/),
});
export const timelineSchema = z.object({
  agentId: z.string().min(1),
  username: z.string().regex(/^@?\w{1,15}$/),
  max: z.number().int().min(1).max(MAX_TIMELINE_POSTS).optional(),
});
export const resolveSchema = z.object({
  agentId: z.string().min(1),
  postId: xId,
  outcome: z.enum(['skip', 'opt_out', 'defer']),
  reason: z.string().min(1).max(500),
  reviewAt: z.string().datetime({ offset: true }).optional(),
});

export const MAX_MENTION_PAGES = 3;
export const MAX_THREAD_DEPTH = 8;
const ELIGIBLE_LIMIT = 50;

type Fail = { ok: false; status: number; error: string; message: string; retryAt?: number };

export interface InboxItem {
  postId: string;
  authorId: string;
  conversationId: string | null;
  status: InboxRow['status'];
  reason: string | null;
  observedAt: string;
  deferredUntil: string | null;
  post: XPost;
}

const toItem = (r: InboxRow): InboxItem => ({
  postId: r.postId,
  authorId: r.authorId,
  conversationId: r.conversationId,
  status: r.status,
  reason: r.reason,
  observedAt: r.observedAt.toISOString(),
  deferredUntil: r.deferredUntil?.toISOString() ?? null,
  post: r.post as XPost,
});

const cmpId = (a: string, b: string) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Pending mentions the supervisor may act on: not deferred into the future, author not opted out. */
export async function eligibleInbox(ctx: SenderContext, agentId: string): Promise<InboxItem[]> {
  const now = ctx.now();
  const rows = await ctx.db
    .select()
    .from(inbox)
    .where(
      and(
        eq(inbox.agentId, agentId),
        eq(inbox.status, 'pending'),
        or(isNull(inbox.deferredUntil), lte(inbox.deferredUntil, now)),
      ),
    )
    .orderBy(asc(inbox.observedAt), asc(inbox.postId))
    .limit(ELIGIBLE_LIMIT * 2);
  if (rows.length === 0) return [];
  const blocked = await ctx.db
    .select({ authorId: optouts.authorId })
    .from(optouts)
    .where(
      and(
        eq(optouts.agentId, agentId),
        eq(optouts.enabled, true),
        inArray(
          optouts.authorId,
          rows.map((r) => r.authorId),
        ),
      ),
    );
  const blockedSet = new Set(blocked.map((b) => b.authorId));
  const eligible = rows.filter((r) => !blockedSet.has(r.authorId)).slice(0, ELIGIBLE_LIMIT);
  const unseen = eligible.filter((r) => !r.seenAt).map((r) => r.postId);
  if (unseen.length > 0) {
    await ctx.db
      .update(inbox)
      .set({ seenAt: now })
      .where(and(eq(inbox.agentId, agentId), inArray(inbox.postId, unseen)));
  }
  return eligible.map(toItem);
}

/**
 * agent-core `applyConsent` semantics: only a post newer (numerically larger id) than the one
 * that last changed the state may change it again, so an old "resume" can never undo a newer
 * "stop".
 */
async function setOptout(
  ctx: SenderContext,
  agentId: string,
  authorId: string,
  enabled: boolean,
  postId: string,
) {
  const now = ctx.now();
  await ctx.db
    .insert(optouts)
    .values({ agentId, authorId, enabled, postId, updatedAt: now })
    .onConflictDoUpdate({
      target: [optouts.agentId, optouts.authorId],
      set: { enabled, postId, updatedAt: now },
      setWhere: sql`${optouts.postId} is null or ${optouts.postId}::numeric < ${postId}::numeric`,
    });
}

async function isOptedOut(ctx: SenderContext, agentId: string, authorId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ enabled: optouts.enabled })
    .from(optouts)
    .where(and(eq(optouts.agentId, agentId), eq(optouts.authorId, authorId)))
    .limit(1);
  return row?.enabled ?? false;
}

export async function readMentions(
  ctx: SenderContext,
  input: z.infer<typeof mentionsSchema>,
): Promise<
  | {
      ok: true;
      throttled: boolean;
      nextReadAt?: string;
      fetched: number;
      sinceId: string | null;
      items: InboxItem[];
    }
  | Fail
> {
  const account = await getAccount(ctx, input.agentId);
  if (!account || account.revokedAt) {
    return {
      ok: false,
      status: 409,
      error: account ? 'revoked' : 'not_connected',
      message: 'X account unavailable',
    };
  }
  // The read budget comes before the mention slot: an agent past it gets the refusal that says so, and keeps its slot.
  let budget = await readBudget(ctx, input.agentId);
  if (budget.remaining <= 0) return budgetExhausted(ctx, budget);
  const slot = await claimMentionRead(ctx, input.agentId);
  if (!slot.ok) {
    return {
      ok: true,
      throttled: true,
      nextReadAt: slot.nextReadAt.toISOString(),
      fetched: 0,
      sinceId: slot.quota.mentionsSinceId,
      items: await eligibleInbox(ctx, input.agentId),
    };
  }

  const sinceId = input.sinceId ?? slot.quota.mentionsSinceId ?? undefined;
  const tweets: XTweet[] = [];
  const users = new Map<string, XUser>();
  let paginationToken: string | undefined;
  for (let page = 0; page < MAX_MENTION_PAGES; page++) {
    if (page > 0) {
      budget = await readBudget(ctx, input.agentId);
      if (budget.remaining <= 0) break;
    }
    // Each page asks X for no more posts than the budget has left (X's floor is 5).
    const maxResults = maxResultsWithin(budget.remaining);
    const res = await withToken(ctx, input.agentId, (token, acct) =>
      ctx.x.mentions(token, acct.xUserId, { sinceId, paginationToken, maxResults }),
    );
    if (!res.ok) {
      if (page === 0) return res;
      break;
    }
    const body: XListResponse = res.data;
    tweets.push(...(body.data ?? []));
    for (const u of body.includes?.users ?? []) users.set(u.id, u);
    await meterRead(ctx, input.agentId, 'mentions', body.data?.length ?? 0);
    paginationToken = body.meta?.next_token;
    if (!paginationToken) break;
  }

  // Oldest first, so a later "resume" overrides an earlier "stop" from the same author.
  tweets.sort((a, b) => cmpId(a.id, b.id));
  const now = ctx.now();
  for (const t of tweets) {
    if (!t.author_id) continue;
    const post: XPost = toXPost(t, users);
    let status: InboxRow['status'] = 'pending';
    let reason: string | null = null;
    const command =
      t.author_id === account.xUserId ? null : consentCommand(t.note_tweet?.text ?? t.text);
    if (t.author_id === account.xUserId) {
      status = 'skipped';
      reason = 'own_post';
    } else if (command) {
      status = 'skipped';
      reason = command === 'stop' ? 'consent_stop' : 'consent_resume';
    }
    const inserted = await ctx.db
      .insert(inbox)
      .values({
        agentId: input.agentId,
        postId: t.id,
        authorId: t.author_id,
        conversationId: t.conversation_id ?? null,
        post,
        observedAt: now,
        status,
        reason,
      })
      .onConflictDoNothing()
      .returning({ postId: inbox.postId });
    if (inserted.length === 0) continue; // already observed: never re-apply consent or reset status
    if (command) {
      await setOptout(ctx, input.agentId, t.author_id, command === 'stop', t.id);
    } else if (status === 'pending' && (await isOptedOut(ctx, input.agentId, t.author_id))) {
      await ctx.db
        .update(inbox)
        .set({ status: 'skipped', reason: 'opted_out' })
        .where(and(eq(inbox.agentId, input.agentId), eq(inbox.postId, t.id)));
    }
  }

  let newest = slot.quota.mentionsSinceId;
  for (const t of tweets) if (!newest || cmpId(t.id, newest) > 0) newest = t.id;
  if (newest && newest !== slot.quota.mentionsSinceId) {
    await ctx.db
      .update(quotas)
      .set({ mentionsSinceId: newest })
      .where(eq(quotas.agentId, input.agentId));
  }

  return {
    ok: true,
    throttled: false,
    fetched: tweets.length,
    sinceId: newest ?? null,
    items: await eligibleInbox(ctx, input.agentId),
  };
}

/** Walk the reply chain upward from `postId`, at most MAX_THREAD_DEPTH posts. Root first. */
export async function readThread(
  ctx: SenderContext,
  input: z.infer<typeof threadSchema>,
): Promise<{ ok: true; posts: XPost[]; truncated: boolean } | Fail> {
  const chain: XTweet[] = [];
  const users = new Map<string, XUser>();
  let current: string | undefined = input.postId;
  let truncated = false;
  while (current) {
    if (chain.length >= MAX_THREAD_DEPTH) {
      truncated = true;
      break;
    }
    const id: string = current;
    // One post, one read unit: the walk stops where the day's budget ends, and a walk that cannot start says why.
    const refused = await requireReads(ctx, input.agentId, 1);
    if (refused) {
      if (chain.length === 0) return refused;
      truncated = true;
      break;
    }
    const res = await withToken(ctx, input.agentId, (token) => ctx.x.getPost(token, id));
    if (!res.ok) {
      if (chain.length === 0) return res;
      truncated = true;
      break;
    }
    const tweet = res.data.data;
    if (!tweet) break;
    await meterRead(ctx, input.agentId, 'thread', 1);
    chain.push(tweet);
    for (const u of res.data.includes?.users ?? []) users.set(u.id, u);
    current = tweet.referenced_tweets?.find((r) => r.type === 'replied_to')?.id;
  }
  return { ok: true, posts: chain.reverse().map((t) => toXPost(t, users)), truncated };
}

/** An account is `recent` when it posted within this window, `stale` when its last post is older, `unknown` when the timeline could not be read. */
export const ACCOUNT_RECENT_MS = 180 * 24 * 60 * 60 * 1000;
export type AccountActivity = 'recent' | 'stale' | 'unknown';

/** Pure: the activity label for a latest-post time (ISO or null = nothing in the window) at `now`. */
export function activityOf(latestPostAt: string | null | undefined, now: number): AccountActivity {
  if (latestPostAt === undefined) return 'unknown';
  if (latestPostAt === null) return 'stale';
  const t = Date.parse(latestPostAt);
  if (!Number.isFinite(t)) return 'unknown';
  return now - t <= ACCOUNT_RECENT_MS ? 'recent' : 'stale';
}

export async function readAccount(
  ctx: SenderContext,
  input: z.infer<typeof accountReadSchema>,
): Promise<{ ok: true; user: XUser; latestPostAt: string | null | undefined; activity: AccountActivity } | Fail> {
  const username = input.username.replace(/^@/, '');
  const refused = await requireReads(ctx, input.agentId, 1);
  if (refused) return refused;
  const res = await withToken(ctx, input.agentId, (token) => ctx.x.userByUsername(token, username));
  if (!res.ok) return res;
  if (!res.data.data)
    return { ok: false, status: 404, error: 'x_not_found', message: 'user not found' };
  await meterRead(ctx, input.agentId, 'account', 1);
  const user = res.data.data;
  // The account's latest post within the recency window: one timeline page of the newest five posts (X's smallest
  // page; the newest one is all that is needed), each a read unit. A read that fails (rate limit, protected account)
  // or a budget with nothing left leaves the activity unknown rather than failing the lookup.
  let latestPostAt: string | null | undefined;
  try {
    const now = Date.now();
    const tl =
      (await readBudget(ctx, input.agentId)).remaining >= 1
        ? await withToken(ctx, input.agentId, (token) =>
            ctx.x.userTimeline(token, user.id, { startTime: new Date(now - ACCOUNT_RECENT_MS).toISOString().replace(/\.\d{3}Z$/, 'Z'), endTime: new Date(now - 10_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), maxResults: 5 }),
          )
        : null;
    if (tl?.ok) {
      await meterRead(ctx, input.agentId, 'timeline', tl.data.data?.length ?? 0);
      const times = (tl.data.data ?? []).map((t) => t.created_at).filter((v): v is string => typeof v === 'string').sort();
      latestPostAt = times.length ? times[times.length - 1]! : null;
    }
  } catch {
    latestPostAt = undefined;
  }
  return { ok: true, user, latestPostAt, activity: activityOf(latestPostAt, Date.now()) };
}

export interface TimelinePost {
  id: string;
  text: string;
  createdAt: string | null;
  /** `public_metrics` when X returned them. */
  metrics: { likes: number; replies: number; reposts: number; quotes: number } | null;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function toTimelinePost(t: XTweet): TimelinePost {
  const m = t.public_metrics;
  return {
    id: t.id,
    text: t.note_tweet?.text ?? t.text,
    createdAt: typeof t.created_at === 'string' ? t.created_at : null,
    metrics: m ? { likes: count(m.like_count), replies: count(m.reply_count), reposts: count(m.retweet_count), quotes: count(m.quote_count) } : null,
  };
}

/**
 * An account's latest original posts (no replies, no reposts) of the last TIMELINE_WINDOW_MS, newest first, at most
 * `max` (DEFAULT_TIMELINE_POSTS; never more than MAX_TIMELINE_POSTS). Two X calls (user lookup, one timeline page),
 * metered as one `account` and one `timeline` read; the supervisor's watchlist reads each handle at most every 6 h.
 */
export async function readTimeline(
  ctx: SenderContext,
  input: z.infer<typeof timelineSchema>,
): Promise<{ ok: true; user: { id: string; username: string; name?: string }; posts: TimelinePost[] } | Fail> {
  const username = input.username.replace(/^@/, '');
  const max = Math.min(input.max ?? DEFAULT_TIMELINE_POSTS, MAX_TIMELINE_POSTS);
  const refused = await requireReads(ctx, input.agentId, 1);
  if (refused) return refused;
  const res = await withToken(ctx, input.agentId, (token) => ctx.x.userByUsername(token, username));
  if (!res.ok) return res;
  if (!res.data.data) return { ok: false, status: 404, error: 'x_not_found', message: 'user not found' };
  await meterRead(ctx, input.agentId, 'account', 1);
  const user = res.data.data;
  const budget = await readBudget(ctx, input.agentId);
  if (budget.remaining < 1) return budgetExhausted(ctx, budget);
  const now = ctx.now().getTime();
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // X returns the newest first, so one page of `max` posts is the whole read; every post returned is a read unit.
  const tl = await withToken(ctx, input.agentId, (token) =>
    ctx.x.userTimeline(token, user.id, { startTime: iso(now - TIMELINE_WINDOW_MS), endTime: iso(now - 10_000), exclude: 'replies,retweets', maxResults: maxResultsWithin(budget.remaining, max) }),
  );
  if (!tl.ok) return tl;
  await meterRead(ctx, input.agentId, 'timeline', tl.data.data?.length ?? 0);
  const posts = (tl.data.data ?? [])
    .map(toTimelinePost)
    .sort((a, b) => cmpId(b.id, a.id))
    .slice(0, max);
  return { ok: true, user: { id: user.id, username: user.username, ...(user.name ? { name: user.name } : {}) }, posts };
}

export async function resolveInbox(
  ctx: SenderContext,
  input: z.infer<typeof resolveSchema>,
): Promise<{ ok: true; item: InboxItem } | Fail> {
  const [row] = await ctx.db
    .select()
    .from(inbox)
    .where(and(eq(inbox.agentId, input.agentId), eq(inbox.postId, input.postId)))
    .limit(1);
  if (!row) return { ok: false, status: 404, error: 'not_found', message: 'post not in inbox' };
  if (row.status === 'answered' || row.status === 'retrying') {
    return {
      ok: false,
      status: 409,
      error: 'already_replied',
      message: `inbox item is ${row.status}`,
    };
  }
  const now = ctx.now();
  let set: Partial<typeof inbox.$inferInsert>;
  if (input.outcome === 'defer') {
    if (!input.reviewAt)
      return {
        ok: false,
        status: 400,
        error: 'invalid_request',
        message: 'reviewAt is required for defer',
      };
    const reviewAt = new Date(input.reviewAt);
    if (reviewAt <= now)
      return {
        ok: false,
        status: 400,
        error: 'invalid_request',
        message: 'reviewAt must be in the future',
      };
    set = {
      status: 'pending',
      reason: input.reason,
      deferredUntil: reviewAt,
      seenAt: row.seenAt ?? now,
    };
  } else {
    set = {
      status: 'skipped',
      reason: input.outcome === 'opt_out' ? `opt_out: ${input.reason}` : input.reason,
      seenAt: row.seenAt ?? now,
    };
    if (input.outcome === 'opt_out')
      await setOptout(ctx, input.agentId, row.authorId, true, row.postId);
  }
  await ctx.db
    .update(inbox)
    .set(set)
    .where(and(eq(inbox.agentId, input.agentId), eq(inbox.postId, input.postId)));
  return { ok: true, item: toItem({ ...row, ...set } as InboxRow) };
}
