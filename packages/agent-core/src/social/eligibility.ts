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
  /** Epoch ms the post was last shown to the model, if ever. */
  seenAt?: number | null;
  deferredUntil?: number | null;
  now?: number;
  seenCooldownMs?: number;
}

export interface Eligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Deterministic reply eligibility, in order of cheapest definitive exclusion:
 * not_addressed_to_agent, consent_stop, recipient_opted_out, owner_blocked,
 * verified_audience_required, deferred, recently_presented.
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
  if (exclusion) return { eligible: false, reason: exclusion };
  const now = cfg.now ?? Date.now();
  if (typeof cfg.deferredUntil === 'number' && cfg.deferredUntil > now) return { eligible: false, reason: 'deferred' };
  const cooldown = cfg.seenCooldownMs ?? SEEN_COOLDOWN_MS;
  if (typeof cfg.seenAt === 'number' && now - cfg.seenAt < cooldown) return { eligible: false, reason: 'recently_presented' };
  return { eligible: true };
}
