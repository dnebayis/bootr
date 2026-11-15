import { and, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { withToken } from './accounts.js';
import { hmacAuth, type AuthEnv } from './auth.js';
import { DATASET_X_HARD_CEILING } from './config.js';
import { nowSec, type SenderContext } from './context.js';
import { reads } from './db/schema.js';
import { log } from './log.js';
import { nextUtcMidnight } from './read-budget.js';
import type { XResult, XTweet, XUser } from './x-client.js';

/**
 * The X reads of Bootr's own dataset (docs/design/agent-behaviour.md section 6.4, layer c): a short list of X accounts
 * is read once, by the platform, and what they reported is shared with every agent through the dataset. The dataset
 * process (apps/supervisor/src/dataset) holds no X credential; it asks here, over the same HMAC scheme as the internal
 * API but through its own door, `/dataset/x/*`, with its own key (`DATASET_SENDER_KEY`). That key opens these read
 * routes and nothing else: the process that reads megabytes of other people's pages is never handed the key that
 * publishes as every agent.
 *
 * Which token reads. The sender holds user tokens only (OAuth 2.0 with PKCE, one per connected agent); it has no
 * app-only token and what it is configured with cannot mint one. So the reads are made with the token of one connected
 * account, named by `DATASET_X_READER_AGENT_ID` (the platform's own agent), exactly as the watchlist's reads are made
 * with that agent's token today. X bills the app, whichever token reads. The caller cannot choose the token.
 *
 * Metered apart. Every read here is counted under the reserved id `dataset` (`sender_reads`, kinds `dataset_posts`,
 * `dataset_users`, `dataset_checks`), never under the reading agent: an agent's own read budget
 * (`SENDER_DEFAULT_READS_PER_DAY`, read-budget.ts) neither pays for the dataset nor is spent by it.
 *
 * The budget. The owner pays X for every post read (0.005 USD) and every user read (0.01 USD), so the day has a cap in
 * units of one post read: `DATASET_X_POSTS_PER_DAY`. A post returned is one unit, a post checked is one unit, a user
 * read is two. The default is 0: the layer is off, every route here answers `dataset_x_off` and nothing is spent.
 * No setting passes DATASET_X_HARD_CEILING (700 units, 3.50 USD a day). The cap is enforced here, where the money is
 * spent, whatever the caller believes: units are claimed BEFORE the call to X (under an advisory lock, so two calls
 * cannot both take the last ones) for the most the call can return, and what X did not return is given back
 * afterwards. A call whose outcome is unknown (a timeout, a 5xx) keeps its claim: the count errs high, never low.
 *
 * What a read returns, and what it does not. `POST /dataset/x/posts` reads one account by its USER ID (never by a
 * handle: a handle can change hands) for original posts newer than `sinceId`: no replies and no reposts
 * (`exclude=replies,retweets`); a quote is kept and says which post it quotes. No expansion is asked for: X charges per
 * resource returned, and an expanded author or quoted post would be one more. A read that finds nothing costs nothing.
 */

export const DATASET_AGENT_ID = 'dataset';
export { DATASET_X_HARD_CEILING };
/** What one unit costs: X's price for one post read. */
export const DATASET_UNIT_USD = 0.005;
export const DATASET_KINDS = ['dataset_posts', 'dataset_users', 'dataset_checks'] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];
/** Units per resource: a user read costs what two post reads do. */
export const DATASET_UNITS: Record<DatasetKind, number> = { dataset_posts: 1, dataset_users: 2, dataset_checks: 1 };
/** X's smallest page of a timeline: a read may return this many whatever is asked, so less is never claimed. */
export const DATASET_PAGE_MIN = 5;
export const DATASET_PAGE_MAX = 20;
export const DATASET_CHECK_MAX = 100;
export const DATASET_TEXT_MAX = 4_000;
export const DATASET_URLS_MAX = 10;
export const DATASET_X_OFF = 'dataset_x_off';
export const DATASET_X_CAP_REACHED = 'dataset_x_cap_reached';
/** Only what a sighting is built from: the time, the links X found in the text, what the post quotes, a long post's text. */
export const DATASET_TWEET_FIELDS = 'created_at,entities,referenced_tweets,note_tweet';
export const DATASET_USER_FIELDS = 'username,protected,public_metrics';
export const DATASET_BODY_LIMIT = 8 * 1024;

const xId = z.string().regex(/^\d{1,25}$/);
export const datasetResolveSchema = z.object({ handle: z.string().regex(/^\w{1,15}$/) }).strict();
export const datasetUserSchema = z.object({ userId: xId }).strict();
export const datasetPostsSchema = z.object({ userId: xId, sinceId: xId, max: z.number().int().min(DATASET_PAGE_MIN).max(DATASET_PAGE_MAX) }).strict();
export const datasetCheckSchema = z.object({ ids: z.array(xId).min(1).max(DATASET_CHECK_MAX) }).strict();

type Fail = { ok: false; status: number; error: string; message: string; retryAt?: number };

export interface DatasetBudget {
  /** The UTC day the counts are of. */
  day: string;
  /** Units a day in force: the setting, never above the hard ceiling. 0 = the layer is off. */
  limit: number;
  units: number;
  remaining: number;
  posts: number;
  userReads: number;
  checks: number;
  /** What the day cost so far at X's prices. */
  usd: number;
}

export interface DatasetUser {
  id: string;
  /** The handle as X spells it. */
  username: string;
  /** Null when X did not say. */
  followers: number | null;
  protected: boolean;
}

export interface DatasetPost {
  id: string;
  text: string;
  createdAt: string | null;
  /** The links X found in the text: the short form as it stands in `text`, and where it leads. */
  urls: { url: string; expandedUrl: string }[];
  /** The post this one quotes, when it is a quote. */
  quotedId: string | null;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** The cap in force: the setting, clamped to the hard ceiling; 0 when unset. */
export function datasetLimit(ctx: SenderContext): number {
  const set = ctx.dataset?.postsPerDay ?? 0;
  return Number.isFinite(set) && set > 0 ? Math.min(Math.floor(set), DATASET_X_HARD_CEILING) : 0;
}

type Reader = Pick<SenderContext['db'], 'select'>;

async function countsToday(db: Reader, day: string): Promise<Record<DatasetKind, number>> {
  const rows = await db.select({ kind: reads.kind, count: reads.count }).from(reads).where(and(eq(reads.agentId, DATASET_AGENT_ID), eq(reads.day, day)));
  const out: Record<DatasetKind, number> = { dataset_posts: 0, dataset_users: 0, dataset_checks: 0 };
  for (const r of rows) if ((DATASET_KINDS as readonly string[]).includes(r.kind)) out[r.kind as DatasetKind] = Number(r.count);
  return out;
}

const unitsOf = (c: Record<DatasetKind, number>) => DATASET_KINDS.reduce((n, k) => n + c[k] * DATASET_UNITS[k], 0);

function budgetOf(limit: number, day: string, c: Record<DatasetKind, number>): DatasetBudget {
  const units = unitsOf(c);
  return { day, limit, units, remaining: Math.max(0, limit - units), posts: c.dataset_posts, userReads: c.dataset_users, checks: c.dataset_checks, usd: Math.round(units * DATASET_UNIT_USD * 1000) / 1000 };
}

/** The day so far, as metered here. */
export async function datasetBudget(ctx: SenderContext): Promise<DatasetBudget> {
  const day = utcDay(ctx.now());
  return budgetOf(datasetLimit(ctx), day, await countsToday(ctx.db, day));
}

/**
 * Takes `count` resources of `kind` out of the day, or refuses when the day does not have them. One transaction under
 * an advisory lock: the sum is read and the row written with nothing in between. Throws when the database does: a read
 * that cannot be counted is not made.
 */
export async function claimDatasetUnits(ctx: SenderContext, kind: DatasetKind, count: number): Promise<boolean> {
  const limit = datasetLimit(ctx);
  if (limit <= 0 || count <= 0) return false;
  const day = utcDay(ctx.now());
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'sender_dataset_x'}))`);
    if (unitsOf(await countsToday(tx, day)) + count * DATASET_UNITS[kind] > limit) return false;
    await tx
      .insert(reads)
      .values({ agentId: DATASET_AGENT_ID, kind, day, count })
      .onConflictDoUpdate({ target: [reads.agentId, reads.kind, reads.day], set: { count: sql`${reads.count} + ${count}` } });
    return true;
  });
}

/**
 * Corrects a claim once X has answered: `by` below zero gives back what X did not return, above zero adds what X
 * returned beyond what was asked (it should never; if it does, the count still says what was spent). Giving back is
 * best effort: a failure leaves the count high.
 */
async function adjustDatasetUnits(ctx: SenderContext, kind: DatasetKind, day: string, by: number): Promise<void> {
  if (by === 0) return;
  try {
    await ctx.db
      .update(reads)
      .set({ count: sql`greatest(${reads.count} + ${by}, 0)` })
      .where(and(eq(reads.agentId, DATASET_AGENT_ID), eq(reads.kind, kind), eq(reads.day, day)));
  } catch {
    log.warn('dataset x: a claim could not be corrected; the count stays as claimed', { kind, by });
  }
}

/** Errors after which X may still have answered (and charged): the claim is kept. Everything else made no read. */
const OUTCOME_UNKNOWN = new Set(['x_timeout', 'x_network_error', 'x_provider_unavailable', 'x_malformed_response']);

function capReached(ctx: SenderContext, budget: DatasetBudget): Fail {
  const retryAt = nextUtcMidnight(ctx.now());
  return { ok: false, status: 429, error: DATASET_X_CAP_REACHED, message: `The dataset's X reads for today are used up (${budget.units} of ${budget.limit} units). Reads open again at ${new Date(retryAt).toISOString()}.`, retryAt };
}

/**
 * One metered read: the claim, the call with the reading account's token, the correction. `returned` says how many
 * resources X sent back, which is what X charges for.
 */
async function meteredRead<T>(ctx: SenderContext, kind: DatasetKind, claim: number, call: (token: string) => Promise<XResult<T>>, returned: (data: T) => number): Promise<{ ok: true; data: T } | Fail> {
  if (datasetLimit(ctx) <= 0) return { ok: false, status: 409, error: DATASET_X_OFF, message: 'The dataset reads nothing on X: DATASET_X_POSTS_PER_DAY is 0.' };
  const reader = ctx.dataset?.readerAgentId;
  if (!reader) return { ok: false, status: 409, error: 'dataset_reader_unset', message: 'No account is named to read for the dataset (DATASET_X_READER_AGENT_ID).' };
  const day = utcDay(ctx.now());
  if (!(await claimDatasetUnits(ctx, kind, claim))) return capReached(ctx, await datasetBudget(ctx));
  const res = await withToken(ctx, reader, call);
  if (!res.ok) {
    if (!OUTCOME_UNKNOWN.has(res.error)) await adjustDatasetUnits(ctx, kind, day, -claim);
    return res;
  }
  await adjustDatasetUnits(ctx, kind, day, returned(res.data) - claim);
  return { ok: true, data: res.data };
}

function toDatasetUser(u: XUser | undefined): DatasetUser | null {
  if (!u || typeof u.id !== 'string' || !/^\d{1,25}$/.test(u.id) || typeof u.username !== 'string' || !/^\w{1,15}$/.test(u.username)) return null;
  const followers = u.public_metrics?.followers_count;
  return { id: u.id, username: u.username, followers: typeof followers === 'number' && Number.isFinite(followers) && followers >= 0 ? Math.floor(followers) : null, protected: u.protected === true };
}

/**
 * A user read, by handle (the first resolution of a listed account) or by id (the look at a pinned one). `user` is
 * null when X has no such account or will not show it (not found, suspended, deactivated): the caller decides what
 * that means. Two units, given back when X returned no user.
 */
export async function readDatasetUser(ctx: SenderContext, by: { handle: string } | { userId: string }): Promise<{ ok: true; user: DatasetUser | null; budget: DatasetBudget } | Fail> {
  const res = await meteredRead(
    ctx,
    'dataset_users',
    1,
    (token) => ('handle' in by ? ctx.x.userByUsername(token, by.handle, DATASET_USER_FIELDS) : ctx.x.userById(token, by.userId, DATASET_USER_FIELDS)),
    (data) => (data.data ? 1 : 0),
  );
  // X answers a lookup of an account it does not have with 404 or with 200 and no `data`: both are "no such account".
  if (!res.ok) return res.status === 404 ? { ok: true, user: null, budget: await datasetBudget(ctx) } : res;
  return { ok: true, user: toDatasetUser(res.data.data), budget: await datasetBudget(ctx) };
}

const cmpId = (a: string, b: string) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

export function toDatasetPost(t: XTweet): DatasetPost {
  const entities = t.note_tweet?.entities ?? t.entities;
  const urls = (entities?.urls ?? [])
    .filter((u) => typeof u.url === 'string' && typeof u.expanded_url === 'string')
    .slice(0, DATASET_URLS_MAX)
    .map((u) => ({ url: u.url.slice(0, 200), expandedUrl: u.expanded_url!.slice(0, 2_000) }));
  const quoted = t.referenced_tweets?.find((r) => r.type === 'quoted')?.id;
  return {
    id: t.id,
    text: String(t.note_tweet?.text ?? t.text ?? '').slice(0, DATASET_TEXT_MAX),
    createdAt: typeof t.created_at === 'string' ? t.created_at.slice(0, 40) : null,
    urls,
    quotedId: typeof quoted === 'string' && /^\d{1,25}$/.test(quoted) ? quoted : null,
  };
}

/**
 * One account's original posts newer than `sinceId`, newest first, one page of at most `max`. `max` units are claimed
 * before the call and what X did not return is given back, so the day's cap holds even when every account answers
 * with a full page. A post that is a reply or a repost, or whose id is not above `sinceId`, is never handed on (X is
 * asked to leave them out; the filter is for the day it does not). `more` says X had older new posts than this page:
 * they are not read, the newest win.
 */
export async function readDatasetPosts(ctx: SenderContext, input: z.infer<typeof datasetPostsSchema>): Promise<{ ok: true; posts: DatasetPost[]; newestId: string | null; more: boolean; budget: DatasetBudget } | Fail> {
  const res = await meteredRead(
    ctx,
    'dataset_posts',
    input.max,
    (token) => ctx.x.userPostsSince(token, input.userId, { sinceId: input.sinceId, maxResults: input.max, fields: DATASET_TWEET_FIELDS }),
    (data) => (Array.isArray(data.data) ? data.data.length : 0),
  );
  if (!res.ok) return res;
  const posts = (Array.isArray(res.data.data) ? res.data.data : [])
    .filter((t) => t && typeof t.id === 'string' && /^\d{1,25}$/.test(t.id) && cmpId(t.id, input.sinceId) > 0)
    .filter((t) => !t.referenced_tweets?.some((r) => r.type === 'replied_to' || r.type === 'retweeted'))
    .sort((a, b) => cmpId(b.id, a.id))
    .slice(0, input.max)
    .map(toDatasetPost);
  return { ok: true, posts, newestId: posts[0]?.id ?? null, more: typeof res.data.meta?.next_token === 'string', budget: await datasetBudget(ctx) };
}

/**
 * Which of `ids` X still shows. The dataset keeps a few words of a post for a short time and must drop them when the
 * post is deleted, protected or withheld (X's developer policy: stored content is kept up to date with X). `gone` is
 * every id asked for that did not come back; it is only ever said after X answered. One unit per post that came back.
 */
export async function checkDatasetPosts(ctx: SenderContext, input: z.infer<typeof datasetCheckSchema>): Promise<{ ok: true; present: string[]; gone: string[]; budget: DatasetBudget } | Fail> {
  const ids = [...new Set(input.ids)];
  const res = await meteredRead(
    ctx,
    'dataset_checks',
    ids.length,
    (token) => ctx.x.postsExist(token, ids),
    (data) => (Array.isArray(data.data) ? data.data.length : 0),
  );
  if (!res.ok) return res;
  const back = new Set((Array.isArray(res.data.data) ? res.data.data : []).map((t) => t?.id).filter((id): id is string => typeof id === 'string'));
  return { ok: true, present: ids.filter((id) => back.has(id)), gone: ids.filter((id) => !back.has(id)), budget: await datasetBudget(ctx) };
}

function fail(c: Context, f: Fail) {
  return c.json({ error: f.error, message: f.message, ...(f.retryAt ? { retryAt: new Date(f.retryAt).toISOString() } : {}) }, f.status as 400);
}

function parse<T extends z.ZodTypeAny>(c: Context<AuthEnv>, schema: T): { ok: true; data: z.infer<T> } | { ok: false; res: Response } {
  let raw: unknown;
  try {
    raw = JSON.parse(c.get('rawBody') || '{}');
  } catch {
    return { ok: false, res: c.json({ error: 'invalid_request', message: 'body is not JSON' }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, res: c.json({ error: 'invalid_request', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400) };
  return { ok: true, data: parsed.data };
}

/**
 * Mounts `/dataset/x/*` when the dataset's own key is set. Without the key there is no door at all (404), and a key
 * that equals the internal API's is refused: the point of the second key is that it is not the first.
 *
 *   GET  /dataset/x/budget                      the day so far: {day, limit, units, remaining, posts, userReads, checks, usd}
 *   POST /dataset/x/resolve {handle}            one user read by handle: {user: {id, username, followers, protected} | null, budget}
 *   POST /dataset/x/user    {userId}            the same by id
 *   POST /dataset/x/posts   {userId, sinceId, max}  {posts[{id, text, createdAt, urls, quotedId}], newestId, more, budget}
 *   POST /dataset/x/check   {ids[1..100]}       {present[], gone[], budget}
 */
export function mountDatasetX(app: Hono, ctx: SenderContext): void {
  const key = ctx.dataset?.key;
  if (!key) return;
  if (key === ctx.serviceKey) {
    log.error('dataset x: DATASET_SENDER_KEY equals SENDER_SERVICE_KEY; the dataset routes stay closed until it has a key of its own');
    return;
  }
  const routes = new Hono<AuthEnv>();
  routes.use('*', bodyLimit({ maxSize: DATASET_BODY_LIMIT, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));
  routes.use(
    '*',
    hmacAuth(key, () => nowSec(ctx)),
  );
  routes.get('/budget', async (c) => c.json(await datasetBudget(ctx)));
  routes.post('/resolve', async (c) => {
    const body = parse(c, datasetResolveSchema);
    if (!body.ok) return body.res;
    const res = await readDatasetUser(ctx, { handle: body.data.handle });
    return res.ok ? c.json({ user: res.user, budget: res.budget }) : fail(c, res);
  });
  routes.post('/user', async (c) => {
    const body = parse(c, datasetUserSchema);
    if (!body.ok) return body.res;
    const res = await readDatasetUser(ctx, { userId: body.data.userId });
    return res.ok ? c.json({ user: res.user, budget: res.budget }) : fail(c, res);
  });
  routes.post('/posts', async (c) => {
    const body = parse(c, datasetPostsSchema);
    if (!body.ok) return body.res;
    const res = await readDatasetPosts(ctx, body.data);
    return res.ok ? c.json({ posts: res.posts, newestId: res.newestId, more: res.more, budget: res.budget }) : fail(c, res);
  });
  routes.post('/check', async (c) => {
    const body = parse(c, datasetCheckSchema);
    if (!body.ok) return body.res;
    const res = await checkDatasetPosts(ctx, body.data);
    return res.ok ? c.json({ present: res.present, gone: res.gone, budget: res.budget }) : fail(c, res);
  });
  app.route('/dataset/x', routes);
}
