/**
 * Comments (docs/design/agent-tools-2.md section 4): `publish_post {about: {postId}}` is an original post of the
 * agent's own about a post it read. X lets an automated account neither quote nor reply to somebody who did not
 * address it, so a comment appears in the agent's own timeline only: it is never a reply, it does not notify the
 * author, it may not link the post, and an `@` in it is held to accounts that wrote to the agent first whatever the
 * mention audience is set to (attributions.ts). The rules here decide which post may be commented on at all:
 *
 *   - the agent read the post through Bootr's tools in this turn: `read_x_thread`, `read_mentions`, its inbox, or the
 *     watchlist section of the turn's first observation (the turn keeps what it was shown, `Turn.seen`, at most
 *     `SEEN_MAX`); a post id it never read is refused;
 *   - the author is public: another Bootr agent, somebody who wrote to the agent within `ENGAGED_WINDOW_MS`, a
 *     verified account (the badge rule replies use, agent-core `eligibleBadge`), or, for the platform's own agent
 *     alone, one of the accounts it follows (`PLATFORM_WATCHLIST`; a coin's agent follows nobody);
 *   - never the agent itself, an author on the creator's blocked list, or one on the platform's own list
 *     (`PLATFORM_NEVER_COMMENT`); an author who told this agent to stop is refused by the sender at publish
 *     (`aboutAuthorId`, `policy:about_opted_out`), the only process that keeps those;
 *   - the post is at most `COMMENT_SOURCE_MAX_AGE_MS` old; `COMMENT_POSTS_PER_DAY` comments a day per coin, one per
 *     author a day and three a week, counted from `sv_actions`.
 *
 * A comment is the slot's original in every other rule. A limit of 0, or `comments: false` in the coin's config (the
 * creator's switch), switches the piece off. Nothing here contacts X except, when the turn does not already say it,
 * one account lookup through the sender for the author's stable id or for whether the author wrote to the agent.
 */
import { eligibleBadge, normalizedCommunication, type ToolInput } from '@bootr/agent-core';
import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { agentDirectory, bootrAgentOf } from './agent-directory.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { actions, runtimes } from './db/schema.js';
import type { Turn } from './runtime.js';
import type { SenderInboxItem } from './sender-client.js';

/** Posts a turn keeps of what it was shown. */
export const SEEN_MAX = 60;
export const DAY_MS = 24 * 3_600_000;
export const WEEK_MS = 7 * DAY_MS;

/** A post the agent was shown in this turn, as far as the read said who wrote it. */
export interface SeenPost {
  postId: string;
  /** The author's stable X id; null when the read gave a handle only (the watchlist). */
  authorId: string | null;
  /** Lowercase handle without the @; null when the read gave none. */
  handle: string | null;
  verified?: boolean;
  verifiedType?: string;
  /** ISO time of the post, or null when the read did not say (the id then says it, `postTimeMs`). */
  at: string | null;
  via: 'thread' | 'account' | 'mentions' | 'inbox' | 'watchlist';
}

/** `result.about` of a completed comment (section 17.4): the post, its author's stable id and handle. */
export interface CommentAbout {
  postId: string;
  authorId: string;
  handle: string;
}

export const COMMENT_SOURCE_UNREAD = 'comment_source_unread: you can comment only on a post you read in this turn; nothing was posted.';
export const COMMENT_AUTHOR_NOT_PUBLIC =
  'comment_author_not_public: you can comment only on posts by accounts you follow, other Bootr agents, accounts that wrote to you, or verified accounts; nothing was posted. Say your own thought without naming the author.';
/** The same refusal for a coin's agent, which follows no accounts: it is not told of a list it does not have. */
export const COMMENT_AUTHOR_NOT_PUBLIC_COIN =
  'comment_author_not_public: you can comment only on posts by other Bootr agents, accounts that wrote to you, or verified accounts; nothing was posted. Say your own thought without naming the author.';
export const COMMENT_AUTHOR_BLOCKED = 'comment_author_blocked: this account is not to be commented on; nothing was posted.';
export const commentDailyCap = (max: number): string => `comment_daily_cap: at most ${max} comments per 24 hours; nothing was posted.`;
export const commentAuthorCap = (count: number, span: 'day' | 'week'): string => `comment_author_cap: you already commented on this account's posts ${count} times this ${span}; nothing was posted.`;
export const COMMENT_LINK_FORBIDDEN = 'comment_link_forbidden: do not link the post you comment on; nothing was posted. Say whose post it is in words.';
/** The post is older than `COMMENT_SOURCE_MAX_AGE_MS` (the design names the rule and no text for it). */
export const commentSourceTooOld = (hours: number): string => `comment_source_too_old: you can comment only on a post of the last ${hours} hours; nothing was posted.`;
/** The author's stable id could not be read from X right now: without it neither the caps nor a stop request can be checked. */
export const commentAuthorUnknown = (handle: string): string => `comment_author_unknown: @${handle} could not be looked up on X right now; nothing was posted. Say your own thought without naming the author, or try again in a later turn.`;

const X_ID = /^[1-9][0-9]{0,18}$/;
const HANDLE = /^[a-z0-9_]{1,15}$/;
const handleOf = (v: unknown): string | null => {
  const h = typeof v === 'string' ? v.replace(/^@/, '').toLowerCase() : '';
  return HANDLE.test(h) ? h : null;
};
const idOf = (v: unknown): string | null => (typeof v === 'string' && X_ID.test(v) ? v : null);
const isoOf = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

/** X ids carry their own clock (a snowflake: milliseconds since 2010-11-04 in the high bits). */
const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;
export function postTimeMs(post: Pick<SeenPost, 'postId' | 'at'>): number | null {
  const stated = post.at ? Date.parse(post.at) : Number.NaN;
  if (Number.isFinite(stated)) return stated;
  try {
    const ms = Number((BigInt(post.postId) >> 22n) + SNOWFLAKE_EPOCH_MS);
    // Ids from before snowflakes (and test ids) carry no time.
    return BigInt(post.postId) >> 22n > 0n ? ms : null;
  } catch {
    return null;
  }
}

/** A post as X returned it through the sender (agent-core `XPost`), read leniently: tool results are stored JSON. */
function seenOfPost(post: unknown, via: SeenPost['via']): SeenPost | null {
  const p = post as { id?: unknown; authorId?: unknown; createdAt?: unknown; author?: { id?: unknown; username?: unknown; verified?: unknown; verifiedType?: unknown } | null } | null;
  const postId = idOf(p?.id);
  if (!p || !postId) return null;
  const author = p.author && idOf(p.author.id) === idOf(p.authorId) ? p.author : null;
  return {
    postId,
    authorId: idOf(p.authorId),
    handle: handleOf(author?.username),
    ...(typeof author?.verified === 'boolean' ? { verified: author.verified } : {}),
    ...(typeof author?.verifiedType === 'string' ? { verifiedType: author.verifiedType } : {}),
    at: isoOf(p.createdAt),
    via,
  };
}

/**
 * The posts a completed read tool showed the agent: `read_x_thread` (the post and its ancestors), `read_mentions`
 * (the inbox items) and whatever posts a `read_x_account` result carries (today it carries the account alone).
 */
export function seenInResult(tool: string, result: unknown): SeenPost[] {
  const r = (result ?? {}) as { posts?: unknown; items?: unknown };
  const out: SeenPost[] = [];
  const via: SeenPost['via'] = tool === 'read_mentions' ? 'mentions' : tool === 'read_x_account' ? 'account' : 'thread';
  if (Array.isArray(r.posts)) for (const post of r.posts) out.push(...[seenOfPost(post, via)].filter((p): p is SeenPost => p !== null));
  if (Array.isArray(r.items)) for (const item of r.items) out.push(...[seenOfPost((item as { post?: unknown } | null)?.post, via)].filter((p): p is SeenPost => p !== null));
  return out;
}

/** Adds what a read showed to the turn, newest last, at most `SEEN_MAX` (the oldest go first). Mutates `turn`. */
export function noteSeen(turn: { seen?: SeenPost[] }, posts: readonly SeenPost[]): void {
  if (posts.length === 0) return;
  const byId = new Map((turn.seen ?? []).map((p) => [p.postId, p]));
  for (const post of posts) {
    byId.delete(post.postId);
    byId.set(post.postId, post);
  }
  turn.seen = [...byId.values()].slice(-SEEN_MAX);
}

/**
 * The posts the turn's first observation showed: the watchlist section's latest posts (a handle and a post id each;
 * the read keeps no author id) and the inbox messages. Read from what the turn stores, so it is exactly what the
 * agent was handed: the hosted loop keeps the observation as its first user message, an own turn as `ownOpen`.
 */
export function seenInObservation(turn: Pick<Turn, 'messages' | 'ownOpen'> | null): SeenPost[] {
  if (!turn) return [];
  let observation: unknown = turn.ownOpen?.observation ?? null;
  if (!observation) {
    const first = turn.messages?.[1];
    if (first?.role === 'user' && typeof first.content === 'string') {
      try {
        observation = JSON.parse(first.content);
      } catch {
        observation = null;
      }
    }
  }
  const o = (observation ?? {}) as { watchlist?: { accounts?: unknown }; social?: { messages?: unknown } };
  const out: SeenPost[] = [];
  for (const account of Array.isArray(o.watchlist?.accounts) ? o.watchlist.accounts : []) {
    const a = account as { handle?: unknown; latestPosts?: unknown } | null;
    const handle = handleOf(a?.handle);
    if (!handle || !Array.isArray(a?.latestPosts)) continue;
    for (const post of a.latestPosts) {
      const p = post as { postId?: unknown; at?: unknown } | null;
      const postId = idOf(p?.postId);
      if (postId) out.push({ postId, authorId: null, handle, at: isoOf(p?.at), via: 'watchlist' });
    }
  }
  for (const message of Array.isArray(o.social?.messages) ? o.social.messages : []) {
    const seen = seenOfPost((message as { post?: unknown } | null)?.post, 'inbox');
    if (seen) out.push(seen);
  }
  return out;
}

/** The coin's turn as it is stored right now (both loops store it before an action leaves the process), or null. */
export async function storedTurn(ctx: Pick<SupervisorContext, 'db'>, agentId: string): Promise<Turn | null> {
  const row = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agentId), columns: { turn: true } });
  return (row?.turn as unknown as Turn | null) ?? null;
}

/** Everything this turn was shown, by post id: the observation, the inbox as the broker holds it, then the reads (the fullest record wins). */
export function turnSeen(turn: Pick<Turn, 'messages' | 'ownOpen' | 'seen'> | null, inbox: ReadonlyMap<string, SenderInboxItem>): Map<string, SeenPost> {
  const out = new Map<string, SeenPost>();
  for (const post of seenInObservation(turn)) out.set(post.postId, post);
  for (const item of inbox.values()) {
    const seen = seenOfPost(item.post, 'inbox');
    if (seen) out.set(seen.postId, { ...seen, authorId: seen.authorId ?? idOf(item.authorId) });
  }
  for (const post of turn?.seen ?? []) {
    const known = out.get(post.postId);
    // A watchlist post that a read then showed in full keeps its place on the watchlist: the author stays a followed one.
    out.set(post.postId, known?.via === 'watchlist' ? { ...post, via: 'watchlist' } : post);
  }
  return out;
}

/** The comments a day this coin may post: the deployment's limit, 0 when the creator switched comments off (`comments: false`). */
export function commentLimit(ctx: Pick<SupervisorContext, 'config'>, agent: Pick<AgentRow, 'config'>): number {
  if ((agent.config as Record<string, unknown>).comments === false) return 0;
  // A caller that holds only a part of the config (a test) gets a limit above 0: the piece is on unless it is switched off.
  return ctx.config.COMMENT_POSTS_PER_DAY ?? 1;
}

/** `PLATFORM_NEVER_COMMENT`: X author ids or handles, comma-separated. */
export function neverComment(spec: string | null | undefined): { ids: Set<string>; handles: Set<string> } {
  const ids = new Set<string>();
  const handles = new Set<string>();
  for (const raw of (spec ?? '').split(',')) {
    const v = raw.trim().replace(/^@/, '');
    if (!v) continue;
    if (X_ID.test(v)) ids.add(v);
    else if (HANDLE.test(v.toLowerCase())) handles.add(v.toLowerCase());
  }
  return { ids, handles };
}

/** Whether a text links the post `postId`, whatever the site in front of `/status/<id>` and however it is escaped. */
export function linksPost(text: string, postId: string): boolean {
  return new RegExp(`status(?:es)?/0*${postId}(?![0-9])`).test(normalizedCommunication(text));
}

interface CommentRow {
  at: number;
  postId: string | null;
  authorId: string | null;
}

/** The coin's comments of the last week that reached or may reach X, or wait for the creator: one row per comment. */
async function commentsInWindow(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, exceptActionId: string): Promise<CommentRow[]> {
  const rows = await ctx.db
    .select({ createdAt: actions.createdAt, action: actions.action, result: actions.result })
    .from(actions)
    .where(
      and(
        eq(actions.agentId, agentId),
        gt(actions.createdAt, new Date(ctx.now() - WEEK_MS)),
        inArray(actions.status, ['sending', 'sent', 'held', 'completed']),
        ne(actions.actionId, exceptActionId),
        sql`${actions.action}->>'tool' = 'publish_post'`,
        sql`jsonb_typeof(${actions.action}->'input'->'about') = 'object'`,
        // The row an approved post is recorded under repeats the action that queued it: one comment, counted once.
        isNull(sql`${actions.action}->'approval'`),
      ),
    );
  return rows.map((row) => {
    const about = (row.action as { input?: { about?: { postId?: unknown } } }).input?.about;
    const result = (row.result ?? {}) as { about?: { authorId?: unknown }; result?: { about?: { authorId?: unknown } } };
    return { at: row.createdAt.getTime(), postId: idOf(about?.postId), authorId: idOf(result.result?.about?.authorId ?? result.about?.authorId) };
  });
}

interface AuthorLookup {
  id: string | null;
  /** When the account last wrote to the agent (epoch ms), as the sender's inbox says; null when it never did. */
  addressedAt: number | null;
}

/** One account lookup through the sender: the stable id behind a handle, and when that account last wrote to the agent. Null when the sender or X did not answer. */
async function lookUpAuthor(ctx: Pick<SupervisorContext, 'sender' | 'log'>, agentId: string, handle: string): Promise<AuthorLookup | null> {
  try {
    const res = await ctx.sender.readAccount(agentId, handle);
    const at = typeof res.addressedAt === 'string' ? Date.parse(res.addressedAt) : Number.NaN;
    return { id: idOf((res.user as { id?: unknown } | null)?.id), addressedAt: Number.isFinite(at) ? at : null };
  } catch (err) {
    ctx.log.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, 'comment: the author could not be looked up at the sender');
    return null;
  }
}

export type CommentDecision = { refusal: string } | { about: CommentAbout };

/**
 * Whether this `publish_post` may go out as a comment on `input.about.postId`, and on whose post. `turn` is the coin's
 * stored turn (`storedTurn`), `inbox` the turn's inbox as the broker holds it. Never throws for a rule: every refusal
 * is a text the agent reads; a sender that cannot be reached for the one lookup a rule needs is a refusal too.
 */
export async function commentCheck(
  ctx: SupervisorContext,
  agent: AgentRow,
  config: { xUserId: string; xHandle: string; blockedAuthorIds: readonly string[] },
  actionId: string,
  input: Pick<ToolInput<'publish_post'>, 'text' | 'thread' | 'about'>,
  inbox: ReadonlyMap<string, SenderInboxItem>,
  turn: Pick<Turn, 'messages' | 'ownOpen' | 'seen'> | null,
): Promise<CommentDecision> {
  const postId = input.about?.postId ?? '';
  const now = ctx.now();
  const limit = commentLimit(ctx, agent);
  if (limit <= 0) return { refusal: commentDailyCap(0) };

  const seen = turnSeen(turn, inbox).get(postId);
  if (!seen) return { refusal: COMMENT_SOURCE_UNREAD };
  if (!ctx.config.COMMENT_LINK && [input.text, ...(input.thread ?? []).map((p) => p.text)].some((part) => linksPost(part, postId))) return { refusal: COMMENT_LINK_FORBIDDEN };
  const postedAt = postTimeMs(seen);
  if (postedAt === null || now - postedAt > ctx.config.COMMENT_SOURCE_MAX_AGE_MS) return { refusal: commentSourceTooOld(Math.round(ctx.config.COMMENT_SOURCE_MAX_AGE_MS / 3_600_000)) };

  const earlier = await commentsInWindow(ctx, agent.agentId, actionId);
  if (earlier.filter((c) => c.at > now - DAY_MS).length >= limit) return { refusal: commentDailyCap(limit) };

  // The accounts an agent follows are the platform account's alone; a coin's agent has no such list.
  const platform = (agent.config as Record<string, unknown>).platform === true;
  const notPublic = platform ? COMMENT_AUTHOR_NOT_PUBLIC : COMMENT_AUTHOR_NOT_PUBLIC_COIN;
  // Who wrote it: the read said so, or (a watchlist post names a handle only) one account lookup through the sender.
  const directory = await agentDirectory(ctx);
  let authorId = seen.authorId;
  let handle = seen.handle ?? (authorId ? (directory.byUserId.get(authorId)?.handle ?? null) : null);
  let account: AuthorLookup | null | undefined;
  if (!authorId) {
    if (!handle) return { refusal: notPublic };
    account = await lookUpAuthor(ctx, agent.agentId, handle);
    if (!account?.id) return { refusal: commentAuthorUnknown(handle) };
    authorId = account.id;
  }
  const peer = bootrAgentOf(directory, authorId, agent);
  handle = handle ?? peer?.handle ?? null;

  const never = neverComment(ctx.config.PLATFORM_NEVER_COMMENT);
  const self = authorId === config.xUserId || (handle !== null && handle === config.xHandle.toLowerCase());
  if (self || config.blockedAuthorIds.includes(authorId) || never.ids.has(authorId) || (handle !== null && never.handles.has(handle))) return { refusal: COMMENT_AUTHOR_BLOCKED };

  // Public: a followed account, another Bootr agent, a verified badge, or somebody who wrote to the agent lately.
  let isPublic = (platform && seen.via === 'watchlist') || peer !== null || eligibleBadge({ id: authorId, ...(seen.verified !== undefined ? { verified: seen.verified } : {}), ...(seen.verifiedType ? { verifiedType: seen.verifiedType as 'blue' | 'business' | 'government' | 'none' } : {}) });
  if (!isPublic) isPublic = [...inbox.values()].some((item) => item.authorId === authorId);
  if (!isPublic && handle) {
    // An id the read already gave is never replaced: a handle can change hands, the post's author cannot.
    account = account === undefined ? await lookUpAuthor(ctx, agent.agentId, handle) : account;
    isPublic = !!account && account.id === authorId && account.addressedAt !== null && now - account.addressedAt <= ctx.config.ENGAGED_WINDOW_MS;
  }
  if (!isPublic || !handle) return { refusal: notPublic };

  // One author is not followed around: a comment on a post of theirs counts, whichever post it was. A row whose
  // outcome is not known yet carries no author: it counts when it is about this very post.
  const onAuthor = earlier.filter((c) => (c.authorId ? c.authorId === authorId : c.postId === postId));
  const today = onAuthor.filter((c) => c.at > now - DAY_MS).length;
  if (today >= ctx.config.COMMENT_PER_AUTHOR_PER_DAY) return { refusal: commentAuthorCap(today, 'day') };
  if (onAuthor.length >= ctx.config.COMMENT_PER_AUTHOR_PER_WEEK) return { refusal: commentAuthorCap(onAuthor.length, 'week') };

  return { about: { postId, authorId, handle } };
}
