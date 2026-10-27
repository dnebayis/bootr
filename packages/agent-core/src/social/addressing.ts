import type { XPost } from '../types.js';

export type AddressingKind = 'reply_to_self' | 'explicit_mention' | 'carried_mention' | 'not_addressed';

export interface Addressing {
  kind: AddressingKind;
  /** Post text with the leading run of @handles removed. */
  body: string;
  replyToUserId: string | null;
}

export interface SelfIdentity {
  ownUserId: string;
  ownHandle: string;
}

const LEADING_MENTIONS = /^(?:\s*@[a-z0-9_]+\b[\s,]*)+/i;

function handleRegex(handle: string): RegExp {
  return new RegExp('@' + handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
}

/**
 * Classify how a post addresses us.
 * - reply_to_self: X says the post replies directly to our account.
 * - explicit_mention: our handle appears in the body (after the leading
 *   @-prefix), or the post is not a reply and names us, or the only leading
 *   handle is ours.
 * - carried_mention: our handle only rides along in the reply prefix (X copies
 *   every participant into replies further down a thread).
 * - not_addressed: we are not named at all.
 */
export function classifyAddressing(post: XPost, self: SelfIdentity): Addressing {
  const text = post.text ?? '';
  const prefix = text.match(LEADING_MENTIONS)?.[0] ?? '';
  const body = text.slice(prefix.length);
  const leading = prefix.match(/@[a-z0-9_]+/gi) ?? [];
  const own = handleRegex(self.ownHandle);
  const ownLower = '@' + self.ownHandle.toLowerCase();
  const isReply = !!post.inReplyToUserId || (post.referencedPosts ?? []).some((r) => r.type === 'replied_to');
  const named =
    own.test(text) || (post.mentions ?? []).some((m) => m.username.toLowerCase() === self.ownHandle.toLowerCase());
  const replyToUserId = post.inReplyToUserId ?? null;

  let kind: AddressingKind;
  if (replyToUserId === self.ownUserId) kind = 'reply_to_self';
  else if (own.test(body) || (!isReply && named) || (leading.length === 1 && leading[0]!.toLowerCase() === ownLower))
    kind = 'explicit_mention';
  else if (named) kind = 'carried_mention';
  else kind = 'not_addressed';

  return { kind, body, replyToUserId };
}

const X_ID = /^[1-9][0-9]{0,18}$/;

/** A post we may treat as a received interaction: real ids, not ours, not a retweet, and addressed to us somehow. */
export function isReceivedInteraction(post: XPost, self: SelfIdentity): boolean {
  if (!X_ID.test(post.id ?? '') || !X_ID.test(post.authorId ?? '')) return false;
  if (post.authorId === self.ownUserId) return false;
  if ((post.referencedPosts ?? []).some((r) => r.type === 'retweeted')) return false;
  return classifyAddressing(post, self).kind !== 'not_addressed';
}

/** Received and not merely a carried mention. */
export function directlyAddresses(post: XPost, self: SelfIdentity): boolean {
  return isReceivedInteraction(post, self) && classifyAddressing(post, self).kind !== 'carried_mention';
}
