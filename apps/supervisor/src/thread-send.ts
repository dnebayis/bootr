/**
 * How an original post is sent (docs/design/agent-tools-2.md sections 3.3, 3.4 and 17.2): one post, or a thread of up
 * to four connected posts. Every part is its own publish at the sender with its own action id (the action's id for the
 * first, `<actionId>.t<n>` after it), so each passes the publish gate, the daily quota and the opt-outs by itself,
 * and none can ever be sent twice: the sender writes a part's row before it contacts X and answers a repeat from it.
 *
 * What makes a thread safe is what is NOT done:
 *   - all parts are checked before the first is sent (`validateThread`, the day's thread count, the quota's room for
 *     all parts at the sender), so a thread is refused whole or begun whole;
 *   - a later part names no reply target: the sender chains it under the part before it by its own lookup;
 *   - a thread that breaks stays cut. A part X refuses, or whose outcome is unknown, ends the thread there: the parts
 *     already out stay, that part is not sent again and the ones after it are never sent. The same holds when the
 *     first part's outcome was unknown and later proves sent, and when the process died between two parts: the action
 *     closes from the sender's receipt (`threadResultFromReceipt`), cut where it stopped;
 *   - a repeated send of a first part the sender already holds continues nothing: it closes from the receipt.
 *
 * `sendOriginal` is what the review queue (approvals.ts) and the scheduler's sweep call through `postHooks`; the
 * broker calls `sendParts` itself after its own checks. Neither sets a hold: the caller does (`afterSettledAction`).
 */
import { PolicyError, THREAD_MAX_PARTS, carriesLink, threadDailyCap, threadParts, threadRefusal, threadTooLong, validatePost, THREAD_NOT_HERE, type ActionOutcome, type AgentConfig, type ThreadLimits } from '@bootr/agent-core';
import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { mediaForAction, outcomeOfError, publicAddressesOf, publishOutcome } from './broker/index.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { actions } from './db/schema.js';
import { agentConfigOf } from './onboarding.js';
import { postsPerDayOf } from './post-budget.js';
import { postHooks, setPostHooks, type OriginalPost, type OriginalResult } from './post-send.js';
import { SenderError, type SenderReceipt } from './sender-client.js';

/** An original as this module sends it: the seam's `OriginalPost`, and for a comment the author of the post it is about. */
export interface CommentedOriginal extends OriginalPost {
  /** Sent to the sender as `aboutAuthorId`: an author who told this agent to stop is refused there (`policy:about_opted_out`). */
  aboutAuthorId?: string;
}

/** What the agent is told with a cut thread. */
export const THREAD_CUT_NOTE = 'A thread that is cut stays cut: do not post the rest.';
/** The window of the day's thread count. */
export const THREAD_WINDOW_MS = 24 * 3_600_000;
/** A part that was never handed to the sender: the thread stopped before it. */
export const PART_NOT_SENT = 'not_sent: the thread stopped before this part';
/** A part that was not sent because the first part's send was a repeat: a thread is sent in one go or cut. */
export const THREAD_NOT_CONTINUED = 'not_sent: the thread was not continued after an interrupted send';
/** A part that was not started because the tool's time was nearly used up. */
export const THREAD_OUT_OF_TIME = 'not_sent: the thread ran out of time';

export const linkQuota = (max: number): string => `link_quota: at most ${max} posts with a link per 24 hours; nothing was posted. Post it without the link.`;

/** The thread limits in force (config.ts): the deployment's, and never more parts than the coin may post in a day. */
export function threadLimits(ctx: Pick<SupervisorContext, 'config'>, agent?: Pick<AgentRow, 'config'> | null): ThreadLimits {
  const perDay = agent ? postsPerDayOf(agent.config as { postsPerDay?: unknown }) : Number.POSITIVE_INFINITY;
  return { maxParts: Math.min(ctx.config.THREAD_MAX_PARTS, perDay), partMaxChars: ctx.config.THREAD_PART_MAX_CHARS, maxLinkParts: ctx.config.THREAD_MAX_LINK_PARTS };
}

/** Whether `publish_post` offers `thread` at all: a thread needs two parts and a count of the day above 0. */
export function threadsOffered(ctx: Pick<SupervisorContext, 'config'>): boolean {
  // A caller that holds only a part of the config (a test) gets the defaults.
  return (ctx.config.THREAD_MAX_PARTS ?? THREAD_MAX_PARTS) >= 2 && (ctx.config.THREADS_PER_DAY ?? 1) > 0;
}

/**
 * The coin's threads of the last 24 hours that reached or may reach X, or wait for the creator's review. The row an
 * approved post is recorded under repeats the action that queued it and is left out; a scheduled thread counts when
 * the sweep sends it (its row is a `publish_post` like any other).
 */
export async function threadsInWindow(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, exceptActionId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .where(
      and(
        eq(actions.agentId, agentId),
        gt(actions.createdAt, new Date(ctx.now() - THREAD_WINDOW_MS)),
        inArray(actions.status, ['sending', 'sent', 'held', 'completed']),
        ne(actions.actionId, exceptActionId),
        sql`${actions.action}->>'tool' = 'publish_post'`,
        sql`jsonb_typeof(${actions.action}->'input'->'thread') = 'array'`,
        isNull(sql`${actions.action}->'approval'`),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * The count of posts with a link, asked before a thread whose LATER part carries the link is begun: the sender checks
 * it at the part that carries the link, which for the first part refuses the whole thread and for a later one would
 * cut it. Null when the thread may go, when no later part has a link, or when the sender does not say (it stays the
 * authority either way).
 */
export async function threadLinkRefusal(ctx: Pick<SupervisorContext, 'sender'>, agentId: string, platform: boolean, parts: readonly string[]): Promise<string | null> {
  if (!parts.slice(1).some((part) => carriesLink(part))) return null;
  const quota = await ctx.sender.quota(agentId).catch(() => null);
  if (!quota) return null;
  const limit = quota.linkPostsPerDay ?? (platform ? quota.linkPostsDefaultPlatform : quota.linkPostsDefault) ?? 0;
  return limit > 0 && (quota.linkPostsUsed24h ?? 0) >= limit ? linkQuota(limit) : null;
}

/**
 * The rules of a thread that the broker and the review queue apply before anything is sent or queued: not in a turn
 * that carries the digest or the numbers post, the day's count, and the gate over every part (`validateThread`: how
 * many parts, their length, repeats, links, and the common publish gate with the mentions in the first part only).
 * The refusal text, or null when the thread may go.
 */
export async function threadRulesRefusal(
  ctx: Pick<SupervisorContext, 'db' | 'now' | 'config' | 'sender'>,
  agent: Pick<AgentRow, 'agentId' | 'config'>,
  config: AgentConfig,
  actionId: string,
  parts: readonly string[],
  attributions: readonly { username: string; sourceUrl: string }[],
  opts: { hasMedia: boolean; singlePostTurn: boolean },
): Promise<string | null> {
  if (opts.singlePostTurn) return THREAD_NOT_HERE;
  const limits = threadLimits(ctx, agent);
  // The size first: a thread longer than the deployment or the coin's day takes is told so before the day's count is.
  if (parts.length > limits.maxParts) return threadTooLong(Math.max(1, limits.maxParts));
  const perDay = ctx.config.THREADS_PER_DAY;
  if (perDay <= 0 || (await threadsInWindow(ctx, agent.agentId, actionId)) >= perDay) return threadDailyCap(Math.max(0, perDay));
  const refused = threadRefusal(parts, attributions, { limits, hasMedia: opts.hasMedia, platform: config.platform === true, publicAddresses: publicAddressesOf(config) });
  if (refused) return refused;
  return threadLinkRefusal(ctx, agent.agentId, config.platform === true, parts);
}

const failed = (error: string): ActionOutcome => ({ kind: 'failed', error });

function completed(result: OriginalResult & Record<string, unknown>): ActionOutcome {
  return { kind: 'completed', result, ...(result.postId ? { receipt: { postId: result.postId } } : {}) };
}

/** Why a later part did not go out, from what the sender answered or threw; never the post's text. */
function partError(err: unknown): string {
  if (err instanceof SenderError) return `sender:${err.code}`;
  return err instanceof Error ? `${err.name}: ${err.message.split('\n')[0]}`.slice(0, 200) : String(err).slice(0, 200);
}

/**
 * The result of a thread from the sender's receipt of its first part, for an action that is closed without sending
 * anything more: the parts that are on X in order, then `cut` at the first part that is not (a part the sender never
 * saw, refused, or still does not know the outcome of). `of` is the length the thread was meant to have.
 */
export function threadResultFromReceipt(receipt: Pick<SenderReceipt, 'providerPostId' | 'thread'>, of: number, notSent: string = PART_NOT_SENT): OriginalResult {
  const postId = receipt.providerPostId ?? undefined;
  const known = new Map((receipt.thread?.parts ?? []).map((p) => [p.n, p]));
  const parts: { n: number; postId: string }[] = postId ? [{ n: 1, postId }] : [];
  let cut: OriginalResult['cut'];
  for (let n = 2; n <= of; n++) {
    const part = known.get(n);
    if (part?.status === 'sent' && part.providerPostId) {
      parts.push({ n, postId: part.providerPostId });
      continue;
    }
    cut = { n, error: !part ? notSent : part.status === 'rejected' ? `sender_rejected:${part.error ?? 'rejected'}` : `sender_${part.status}` };
    break;
  }
  return { ...(postId ? { postId } : {}), parts, sent: parts.length, of, ...(cut ? { cut } : {}) };
}

/** A thread's result as the agent reads it: a cut one says that it stays cut. */
function threadOutcome(result: OriginalResult): ActionOutcome {
  return completed({ ...result, ...(result.cut ? { note: THREAD_CUT_NOTE } : {}) });
}

/**
 * Sends one original through the sender: the single post as it always went, or a thread part by part. Throws what the
 * sender client throws for the FIRST part (the caller maps it as it maps a single post: nothing is known sent then);
 * a later part never throws, it cuts the thread. `media` rides on the first part only.
 */
export async function sendParts(ctx: Pick<SupervisorContext, 'sender' | 'config' | 'log'>, agent: Pick<AgentRow, 'agentId'>, config: AgentConfig, post: CommentedOriginal, media?: { data: string; mime: string; alt: string }): Promise<ActionOutcome> {
  const parts = threadParts(post);
  const of = parts.length;
  const head = post.actionId;
  const common = { agentId: agent.agentId, ...(config.platform ? { platform: true } : {}), publicAddresses: publicAddressesOf(config), xUserId: config.xUserId, ...(post.aboutAuthorId ? { aboutAuthorId: post.aboutAuthorId } : {}) };
  const startedAt = Date.now();
  const first = await ctx.sender.publish({
    ...common,
    actionId: head,
    text: parts[0]!,
    ...(post.attributions?.length ? { attributions: post.attributions } : {}),
    ...(media ? { media } : {}),
    ...(of > 1 ? { thread: { head, n: 1, of } } : {}),
  });
  if (of === 1) return publishOutcome(first);
  if (first.status !== 'sent' || !first.providerPostId) return publishOutcome(first);
  // The sender already held this first part: this is a repeat of an interrupted send, and a thread is never continued.
  if (first.duplicate) {
    const receipt = await ctx.sender.receipt(head).catch(() => null);
    return threadOutcome(threadResultFromReceipt({ providerPostId: first.providerPostId, ...(receipt?.thread ? { thread: receipt.thread } : {}) }, of, THREAD_NOT_CONTINUED));
  }

  const sent: { n: number; postId: string }[] = [{ n: 1, postId: first.providerPostId }];
  let cut: OriginalResult['cut'];
  for (let n = 2; n <= of; n++) {
    // The tool has a ceiling (`TOOL_TIMEOUT_MS`), past which the action is closed from the receipt while this loop
    // would still run: a part is not started once half of it is gone.
    if (Date.now() - startedAt > ctx.config.TOOL_TIMEOUT_MS / 2) {
      cut = { n, error: THREAD_OUT_OF_TIME };
      break;
    }
    try {
      const res = await ctx.sender.publish({ ...common, actionId: `${head}.t${n}`, text: parts[n - 1]!, thread: { head, n, of } });
      if (res.status === 'sent' && res.providerPostId) {
        sent.push({ n, postId: res.providerPostId });
        continue;
      }
      cut = { n, error: res.status === 'rejected' ? `sender_rejected:${res.receipt.error ?? 'rejected'}` : `sender_${res.status}` };
    } catch (err) {
      cut = { n, error: partError(err) };
    }
    break;
  }
  if (cut) ctx.log.warn({ agentId: agent.agentId, actionId: head, sent: sent.length, of, cutAt: cut.n, code: cut.error.split(/\s/)[0] }, 'thread cut: the rest is not sent');
  return threadOutcome({ postId: first.providerPostId, parts: sent, sent: sent.length, of, ...(cut ? { cut } : {}) });
}

/**
 * The seam's `sendOriginal` (post-send.ts): gate, then send. `completed` once the first part is known sent (a thread's
 * result carries `parts`, `sent`, `of` and `cut`), `unknown` while the first part's outcome is not known, `failed`
 * when nothing was sent. Never throws and sets no hold. A failure the caller may try again later with the same id
 * (the sender recorded nothing: its quota, a consent lookup, an account that is not connected) is marked `retryable`.
 */
export async function sendOriginal(ctx: SupervisorContext, agent: AgentRow, post: OriginalPost): Promise<ActionOutcome> {
  try {
    const config = agentConfigOf(agent);
    if (!config) return failed('agent_not_ready: the agent has no X account yet; nothing was posted');
    const media = await mediaForAction(ctx, agent.agentId, post.imageId, config);
    if (media.error) return failed(media.error);
    const parts = threadParts(post);
    const attributions = post.attributions ?? [];
    const risk = { platform: config.platform === true, publicAddresses: publicAddressesOf(config) };
    if (parts.length > 1) {
      const refused = threadRefusal(parts, attributions, { ...risk, hasMedia: !!media.media, limits: threadLimits(ctx, agent) }) ?? (await threadLinkRefusal(ctx, agent.agentId, config.platform === true, parts));
      if (refused) return failed(refused);
    } else {
      try {
        validatePost(parts[0], attributions, 'original', !!media.media, risk);
      } catch (err) {
        if (err instanceof PolicyError) return failed(`${err.code}: the post does not pass the publish gate; rewrite it`);
        throw err;
      }
    }
    return await sendParts(ctx, agent, config, post, media.media);
  } catch (err) {
    const outcome = outcomeOfError(ctx, agent, post.actionId, 'publish_post', err);
    return outcome.kind === 'failed' && (err as { retryable?: unknown }).retryable === true ? ({ ...outcome, retryable: true } as ActionOutcome) : outcome;
  }
}

/** Whether a failed `sendOriginal` left nothing at the sender, so the same original may be sent again later. */
export function retryableSend(outcome: ActionOutcome): boolean {
  return outcome.kind === 'failed' && (outcome as { retryable?: unknown }).retryable === true;
}

/** The hook as it stood before this module registered: the placeholder of post-send.ts, or whatever a test put there first. */
const before = postHooks.sendOriginal;
setPostHooks({ sendOriginal });

/**
 * Registers the real send as `postHooks.sendOriginal` (api.ts calls this when it mounts the routes). Loading this
 * module registers it too, so a caller that never builds the app (a test of the review queue) sends for real; a hook
 * somebody else put there since (a test's fake) is left alone.
 */
export function mountPosting(): void {
  if (postHooks.sendOriginal === before || postHooks.sendOriginal === sendOriginal) setPostHooks({ sendOriginal });
}
