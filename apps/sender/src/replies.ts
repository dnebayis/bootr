import { z } from 'zod';
import { withToken } from './accounts.js';
import type { SenderContext } from './context.js';
import { meterRead } from './metering.js';
import { maxResultsWithin, readBudget, requireReads } from './read-budget.js';
import type { XListResponse, XMedia, XTweet, XUser } from './x-client.js';

/**
 * `POST /internal/read/replies {agentId, conversationId, max?}`: the replies in one conversation (the entries to a
 * bounty job, apps/supervisor/src/bounties.ts), read once after the job's window closed with the agent's own token
 * through `GET /2/tweets/search/recent` (the last 7 days; a job is open 72 hours at most). Every post X returns is a
 * read unit against the agent's day (read-budget.ts), like a mention page; at most MAX_REPLY_PAGES pages.
 *
 * What comes back is what the eligibility rules need and nothing the judge must not see twice over: the reply's id,
 * author id and time, its text (the supervisor keeps only the one address it finds in it, never the text), the
 * author's id, handle, creation date and badge, the expanded url entities and the attached media (key, type, url,
 * preview). The agent's own posts in the conversation (the job post itself, its template replies) are left out.
 */

const xId = z.string().regex(/^\d{1,25}$/);

export const MAX_REPLY_PAGES = 3;
export const MAX_REPLIES = 300;

export const repliesSchema = z.object({
  agentId: z.string().min(1),
  conversationId: xId,
  /** Stop after this many replies (default and ceiling MAX_REPLIES). */
  max: z.number().int().min(1).max(MAX_REPLIES).optional(),
});

export interface ReplyAuthor {
  id: string;
  username: string | null;
  createdAt: string | null;
  verified: boolean | null;
  verifiedType: string | null;
}

export interface ReplyMedia {
  mediaKey: string;
  type: string | null;
  url: string | null;
  previewImageUrl: string | null;
}

export interface ConversationReply {
  id: string;
  text: string;
  authorId: string;
  createdAt: string | null;
  conversationId: string | null;
  /** The post this reply answers, when X says. */
  inReplyToId: string | null;
  author: ReplyAuthor | null;
  urls: { url: string; expandedUrl: string }[];
  media: ReplyMedia[];
}

type Fail = { ok: false; status: number; error: string; message: string; retryAt?: number };

export function toReply(t: XTweet, users: Map<string, XUser>, media: Map<string, XMedia>): ConversationReply {
  const entities = t.note_tweet?.entities ?? t.entities;
  const user = t.author_id ? users.get(t.author_id) : undefined;
  return {
    id: t.id,
    text: t.note_tweet?.text ?? t.text,
    authorId: t.author_id ?? '',
    createdAt: typeof t.created_at === 'string' ? t.created_at : null,
    conversationId: t.conversation_id ?? null,
    inReplyToId: t.referenced_tweets?.find((r) => r.type === 'replied_to')?.id ?? null,
    author: user
      ? {
          id: user.id,
          username: user.username ?? null,
          createdAt: typeof user.created_at === 'string' ? user.created_at : null,
          verified: typeof user.verified === 'boolean' ? user.verified : null,
          verifiedType: typeof user.verified_type === 'string' ? user.verified_type : null,
        }
      : null,
    urls: (entities?.urls ?? []).filter((u) => typeof u.expanded_url === 'string' && u.expanded_url).map((u) => ({ url: u.url, expandedUrl: u.expanded_url! })),
    media: (t.attachments?.media_keys ?? []).map((key) => {
      const m = media.get(key);
      return { mediaKey: key, type: m?.type ?? null, url: m?.url ?? null, previewImageUrl: m?.preview_image_url ?? null };
    }),
  };
}

export async function readReplies(
  ctx: SenderContext,
  input: z.infer<typeof repliesSchema>,
): Promise<{ ok: true; items: ConversationReply[]; fetched: number; truncated: boolean } | Fail> {
  const max = Math.min(input.max ?? MAX_REPLIES, MAX_REPLIES);
  const refused = await requireReads(ctx, input.agentId, 1);
  if (refused) return refused;
  const tweets: XTweet[] = [];
  const users = new Map<string, XUser>();
  const media = new Map<string, XMedia>();
  let ownUserId: string | null = null;
  let paginationToken: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_REPLY_PAGES; page++) {
    const budget = await readBudget(ctx, input.agentId);
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    const wanted = max - tweets.length;
    if (wanted <= 0) break;
    const res = await withToken(ctx, input.agentId, (token, acct) => {
      ownUserId = acct.xUserId;
      return ctx.x.conversationReplies(token, input.conversationId, { paginationToken, maxResults: maxResultsWithin(budget.remaining, Math.max(10, wanted)) });
    });
    if (!res.ok) {
      if (page === 0) return res;
      truncated = true;
      break;
    }
    const body: XListResponse = res.data;
    tweets.push(...(body.data ?? []));
    for (const u of body.includes?.users ?? []) users.set(u.id, u);
    for (const m of body.includes?.media ?? []) media.set(m.media_key, m);
    await meterRead(ctx, input.agentId, 'replies', body.data?.length ?? 0);
    paginationToken = body.meta?.next_token;
    if (!paginationToken) break;
    if (page === MAX_REPLY_PAGES - 1) truncated = true;
  }
  const items = tweets
    .filter((t) => t.id !== input.conversationId && !!t.author_id && t.author_id !== ownUserId)
    .map((t) => toReply(t, users, media))
    .slice(0, max);
  return { ok: true, items, fetched: tweets.length, truncated: truncated || tweets.length > max };
}
