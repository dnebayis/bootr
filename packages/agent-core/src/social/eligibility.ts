import { classifyAddressing, isReceivedInteraction } from './addressing.js';
import { consentCommand } from './consent.js';
import type { XAuthor, XPost } from '../types.js';

export const REPLY_VERIFICATION_TYPES: readonly string[] = ['blue', 'business'];
export const SEEN_COOLDOWN_MS = 2 * 60 * 1000;

const X_ID = /^[1-9][0-9]{0,18}$/;

/** A verified blue or business badge is the default audience for replies. */
export function eligibleBadge(author: XAuthor | null | undefined): boolean {
  return author?.verified === true && REPLY_VERIFICATION_TYPES.includes(author.verifiedType ?? '');
}

/**
 * Owner allowlist exception: bound to the stable author id that X returned
 * alongside the post, never to a handle or display name.
 */
export function replyExclusion(post: XPost, replyAuthorIds: readonly string[] = []): string | null {
  const authorId = post.authorId;
  const excepted = X_ID.test(authorId ?? '') && post.author?.id === authorId && replyAuthorIds.includes(authorId);
  return !eligibleBadge(post.author) && !excepted ? 'verified_audience_required' : null;
}

export interface EligibilityConfig {
  ownUserId: string;
  ownHandle: string;
  replyAuthorIds?: readonly string[];
  blockedAuthorIds?: readonly string[];
  /** Author ids that asked us to stop. */
  optedOutAuthorIds?: ReadonlySet<string> | readonly string[];
  /** Carried mentions are only answered when the model was explicitly invited in context. */
  allowCarriedMention?: boolean;
  /**
   * The reply audience `own_threads`: ids of the agent's own posts. A direct reply to one of them is answered whatever
   * its author's badge (`openReply`); opt-outs, the owner's block list and every other exclusion still apply. Absent
   * or empty = the verified audience alone, as before.
   */
  openReplyTo?: ReadonlySet<string> | readonly string[];
  /**
   * Questions from anyone: an author outside the verified audience who addressed the agent directly (a mention, or a
   * reply to its account) and whose own text asks something (`mentionAsksQuestion`) is answered. Opt-outs, the owner's
   * block list and every other exclusion still apply. Absent or false = no such way in, as before.
   */
  openQuestions?: boolean;
  /** Epoch ms the post was last shown to the model, if ever. */
  seenAt?: number | null;
  deferredUntil?: number | null;
  now?: number;
  seenCooldownMs?: number;
}

export interface Eligibility {
  eligible: boolean;
  reason?: string;
  /**
   * Eligible although its author is outside the verified audience: a direct reply to one of the agent's own posts
   * (`openReplyTo`) or a question (`openQuestions`). Counted per day by the caller.
   */
  open?: boolean;
  /** Which of the two ways in it was; present exactly when `open` is. */
  openAs?: OpenReplyKind;
}

/** Why a post from outside the verified audience is answered: it sits directly under the agent's own post, or it asks the agent a question. */
export type OpenReplyKind = 'own_thread' | 'question';

/** Characters that take no room on the screen but count as letters or symbols: the fillers people hide text behind. */
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}]|(?![\t\n\v\f\r])\p{Cc}|\u115F|\u1160|\u3164|\uFFA0|\u2800|\u17B4|\u17B5/gu;
/** A link with its scheme, and a bare host that carries a path or a query (`site.io/a?b=1`, `site.io?b=1`). A bare host that merely ends a sentence (`is it on base.org?`) is not one. */
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*|\?\S+)/gi;
/** The letters and digits a question needs around its mark so that the mark alone, or a mark behind filler, is not one. */
export const QUESTION_MIN_WORD_CHARS = 2;

/**
 * Whether a post somebody wrote to the agent asks it something: a question mark that a reader sees, outside links,
 * handles and tags, next to at least `QUESTION_MIN_WORD_CHARS` visible letters or digits. It reads the post's own text
 * and nothing else (not the post it replies to, not a quoted one), and needs no model.
 *
 * It is the question test of the original-post quota (a `?` outside links) made hard to fake, because here a question
 * opens a door: invisible characters are dropped and look-alike forms are folded first (so a link broken up by
 * zero-width characters is still a link, and a full-width `？` is a question mark), a `?` inside a link's query or
 * glued to a handle does not count, and neither does a bare mark with nothing said.
 */
export function mentionAsksQuestion(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || !text) return false;
  const seen = text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(LINK, ' ')
    .replace(/[@#$][\p{L}\p{N}_]+/gu, ' ');
  if (!/[?\u061F\u2E2E]/u.test(seen)) return false;
  return (seen.match(/[\p{L}\p{N}]/gu) ?? []).length >= QUESTION_MIN_WORD_CHARS;
}

/**
 * Whether `post` is a direct reply to one of the agent's own posts: X says it replies to the agent's account, and the
 * post it replies to is one of `ownPostIds`. A mention, a quote or a reply further down somebody else's thread is not.
 */
export function openReply(post: XPost, ownUserId: string, ownPostIds: ReadonlySet<string> | readonly string[] | undefined): boolean {
  if (!ownPostIds || post.inReplyToUserId !== ownUserId) return false;
  const own = ownPostIds instanceof Set ? (ownPostIds as ReadonlySet<string>) : new Set(ownPostIds as readonly string[]);
  if (own.size === 0) return false;
  return (post.referencedPosts ?? []).some((r) => r.type === 'replied_to' && own.has(r.id));
}

/**
 * Deterministic reply eligibility, in order of cheapest definitive exclusion:
 * not_addressed_to_agent, consent_stop, recipient_opted_out, owner_blocked,
 * verified_audience_required (unless the post is a direct reply to one of `openReplyTo`, or a question while
 * `openQuestions` is on), deferred, recently_presented.
 */
export function replyEligibility(post: XPost, cfg: EligibilityConfig): Eligibility {
  const self = { ownUserId: cfg.ownUserId, ownHandle: cfg.ownHandle };
  if (!isReceivedInteraction(post, self)) return { eligible: false, reason: 'not_addressed_to_agent' };
  if (classifyAddressing(post, self).kind === 'carried_mention' && !cfg.allowCarriedMention)
    return { eligible: false, reason: 'not_addressed_to_agent' };
  if (consentCommand(post.text) === 'stop') return { eligible: false, reason: 'consent_stop' };
  const optedOut = cfg.optedOutAuthorIds instanceof Set ? cfg.optedOutAuthorIds : new Set(cfg.optedOutAuthorIds ?? []);
  if (optedOut.has(post.authorId)) return { eligible: false, reason: 'recipient_opted_out' };
  if ((cfg.blockedAuthorIds ?? []).includes(post.authorId)) return { eligible: false, reason: 'owner_blocked' };
  const exclusion = replyExclusion(post, cfg.replyAuthorIds ?? []);
  // The two ways past the verified audience: a direct reply under the agent's own post, when the coin answers those,
  // and a question, when questions from anyone are answered. The addressing checks above already hold for both.
  const openAs: OpenReplyKind | null =
    exclusion === null ? null : openReply(post, cfg.ownUserId, cfg.openReplyTo) ? 'own_thread' : cfg.openQuestions === true && mentionAsksQuestion(post.text) ? 'question' : null;
  if (exclusion && !openAs) return { eligible: false, reason: exclusion };
  const now = cfg.now ?? Date.now();
  if (typeof cfg.deferredUntil === 'number' && cfg.deferredUntil > now) return { eligible: false, reason: 'deferred' };
  const cooldown = cfg.seenCooldownMs ?? SEEN_COOLDOWN_MS;
  if (typeof cfg.seenAt === 'number' && now - cfg.seenAt < cooldown) return { eligible: false, reason: 'recently_presented' };
  return openAs ? { eligible: true, open: true, openAs } : { eligible: true };
}
