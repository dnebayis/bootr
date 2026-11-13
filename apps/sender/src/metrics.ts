import { z } from 'zod';
import { withToken } from './accounts.js';
import type { SenderContext } from './context.js';
import { meterRead } from './metering.js';
import { requireReads } from './read-budget.js';
import type { XPartialError, XTweet } from './x-client.js';

/**
 * `POST /internal/read/metrics {agentId, postIds}`: engagement counts of the agent's OWN posts, read
 * with the agent's user token so X also returns `non_public_metrics` (impressions, clicks). The
 * supervisor measures each post once, about a day after it went out, and feeds a short note back to
 * the agent (apps/supervisor/src/post-performance.ts).
 *
 * One `GET /2/tweets?ids=` call per request (at most MAX_METRICS_IDS ids), metered as one read per post X returned. When X refuses the
 * author-only field (a post from an earlier account, a reply X attributes elsewhere), the read is
 * repeated once with public fields only, so the caller still gets likes, replies, reposts, quotes and
 * (since X publishes them) impressions. Deleted or invisible posts are listed in `missing`.
 */

export const MAX_METRICS_IDS = 20;

const xId = z.string().regex(/^\d{1,25}$/);

export const metricsSchema = z.object({
  agentId: z.string().min(1),
  postIds: z.array(xId).min(1).max(MAX_METRICS_IDS),
});

export interface PostMetrics {
  postId: string;
  createdAt: string | null;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  bookmarks: number | null;
  /** From `non_public_metrics` when X returned it, else `public_metrics.impression_count`, else null. */
  impressions: number | null;
  /** Author-only counts, present only when X returned `non_public_metrics` for this post. */
  nonPublic: { impressions: number | null; urlLinkClicks: number | null; userProfileClicks: number | null } | null;
}

type Fail = { ok: false; status: number; error: string; message: string; retryAt?: number };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function toPostMetrics(t: XTweet): PostMetrics {
  const pub = t.public_metrics ?? {};
  const priv = t.non_public_metrics;
  const nonPublic = priv
    ? {
        impressions: num(priv.impression_count),
        urlLinkClicks: num(priv.url_link_clicks),
        userProfileClicks: num(priv.user_profile_clicks),
      }
    : null;
  return {
    postId: t.id,
    createdAt: t.created_at ?? null,
    likes: num(pub.like_count) ?? 0,
    replies: num(pub.reply_count) ?? 0,
    reposts: num(pub.retweet_count) ?? 0,
    quotes: num(pub.quote_count) ?? 0,
    bookmarks: num(pub.bookmark_count),
    impressions: nonPublic?.impressions ?? num(pub.impression_count),
    nonPublic,
  };
}

/** X answers a field it will not show for some of the ids inside a 200 (`errors[]`), or refuses the whole request. */
function refusesNonPublic(errors: XPartialError[] | undefined): boolean {
  return (errors ?? []).some((e) => e.parameter === 'non_public_metrics' || (e.title ?? '').toLowerCase().includes('not authorized') || (e.detail ?? '').includes('non_public_metrics'));
}

export async function readMetrics(
  ctx: SenderContext,
  input: z.infer<typeof metricsSchema>,
): Promise<{ ok: true; items: PostMetrics[]; missing: string[]; nonPublic: boolean } | Fail> {
  const ids = [...new Set(input.postIds)];
  const refused = await requireReads(ctx, input.agentId, 1);
  if (refused) return refused;
  const read = (nonPublic: boolean) =>
    withToken(ctx, input.agentId, (token) => ctx.x.getPosts(token, ids, { nonPublic }));

  let nonPublic = true;
  let res = await read(true);
  // The author-only field is refused for posts the token's user did not write: once more, public only.
  if ((!res.ok && (res.error === 'x_forbidden' || res.error === 'x_bad_request')) || (res.ok && refusesNonPublic(res.data.errors) && !res.data.data?.length)) {
    nonPublic = false;
    res = await read(false);
  }
  if (!res.ok) return res;

  const tweets = res.data.data ?? [];
  const items = tweets.map(toPostMetrics);
  const seen = new Set(items.map((i) => i.postId));
  const missing = ids.filter((id) => !seen.has(id));
  // X charges a read per post returned (and once per post per UTC day), not per request: the meter counts the posts.
  await meterRead(ctx, input.agentId, 'metrics', tweets.length);
  return { ok: true, items, missing, nonPublic: nonPublic && items.some((i) => i.nonPublic !== null) };
}
