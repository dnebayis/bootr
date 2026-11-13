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
  /** Epoch ms the post was last shown to the model, if ever. */
  seenAt?: number | null;
  deferredUntil?: number | null;
  now?: number;
  seenCooldownMs?: number;
}

export interface Eligibility {
  eligible: boolean;
  reason?: string;
  /** Eligible only because the post is a direct reply to one of the agent's own posts (`openReplyTo`): counted per day by the caller. */
  open?: boolean;
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
 * verified_audience_required (unless the post is a direct reply to one of `openReplyTo`), deferred, recently_presented.
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
  // The one way past the verified audience: a direct reply under the agent's own post, when the coin answers those.
  const open = exclusion !== null && openReply(post, cfg.ownUserId, cfg.openReplyTo);
  if (exclusion && !open) return { eligible: false, reason: exclusion };
  const now = cfg.now ?? Date.now();
  if (typeof cfg.deferredUntil === 'number' && cfg.deferredUntil > now) return { eligible: false, reason: 'deferred' };
  const cooldown = cfg.seenCooldownMs ?? SEEN_COOLDOWN_MS;
  if (typeof cfg.seenAt === 'number' && now - cfg.seenAt < cooldown) return { eligible: false, reason: 'recently_presented' };
  return open ? { eligible: true, open: true } : { eligible: true };
}
