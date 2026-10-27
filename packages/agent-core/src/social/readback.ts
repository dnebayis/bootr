import { PolicyError } from '../errors.js';
import type { XPost } from '../types.js';

export interface ReadbackWindow {
  /** Inclusive start, whole seconds. */
  start: number;
  /** Exclusive end, whole seconds. */
  end: number;
}

export const READBACK_BEFORE_MS = 1000;
export const READBACK_AFTER_MS = 5 * 60 * 1000;

/**
 * Positive-evidence window around the time a post action was created
 * (-1 s .. +5 min). Nothing outside it is ever matched, so a similar post from
 * days later can never be mistaken for ours.
 */
export function postReadbackWindow(createdAt: number | string | Date): ReadbackWindow {
  const at = createdAt instanceof Date ? createdAt.getTime() : typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  if (!Number.isFinite(at)) throw new PolicyError('x_readback_invalid_time');
  return {
    start: Math.floor((at - READBACK_BEFORE_MS) / 1000) * 1000,
    end: Math.ceil((at + READBACK_AFTER_MS) / 1000) * 1000,
  };
}

export interface PublishedPostAction {
  createdAt: number | string | Date;
  input: {
    text: string;
    /** Post id we replied to, if any. */
    replyTo?: string | null;
    /** Stable author id of the post we replied to. */
    replyAuthorId?: string | null;
    hasMedia?: boolean;
    mediaKey?: string | null;
  };
}

function createdMs(value: number | string | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
}

/**
 * Does a post we read back from X correspond to the given publish action?
 * Compares expanded text (t.co links replaced by their targets, trailing media
 * link removed), the reply parent, media presence and creation time.
 * X may prepend the addressed handle to a reply; that one prefix is ignored
 * only when the stable recipient id also matches.
 */
export function matchesPublishedPost(post: XPost, action: PublishedPostAction): boolean {
  const parent = (post.referencedPosts ?? []).find((r) => r.type === 'replied_to')?.id;
  const hasMedia = action.input.hasMedia === true;
  const expanded = (post.urls ?? []).reduce((text, u) => {
    if (hasMedia && new RegExp('/status/' + post.id + '/(?:photo|video)/\\d+$').test(u.expandedUrl))
      return text.replaceAll(u.url, '').trimEnd();
    return text.replaceAll(u.url, u.expandedUrl);
  }, post.text);
  if (hasMedia) {
    const keys = post.mediaKeys ?? [];
    if (!keys.length) return false;
    if (action.input.mediaKey && !keys.includes(action.input.mediaKey)) return false;
  }
  const addressed =
    !!action.input.replyTo && typeof action.input.replyAuthorId === 'string' && action.input.replyAuthorId === post.inReplyToUserId;
  const body = addressed ? expanded.replace(/^@[a-z0-9_]+(?:\s+|$)/i, '') : expanded;
  const textMatches = expanded === action.input.text || body === action.input.text;
  const parentMatches = (parent ?? undefined) === (action.input.replyTo ?? undefined);
  const postAt = post.createdAt ? Date.parse(post.createdAt) : Number.NaN;
  const timeMatches = Number.isFinite(postAt) && postAt >= createdMs(action.createdAt) - READBACK_BEFORE_MS;
  return textMatches && parentMatches && timeMatches;
}

/** Full readback match: ours, inside the window, right recipient, and the same post. */
export function readbackMatch(post: XPost, action: PublishedPostAction, ownUserId: string): boolean {
  const { start, end } = postReadbackWindow(action.createdAt);
  const at = post.createdAt ? Date.parse(post.createdAt) : Number.NaN;
  if (post.authorId !== ownUserId || !(at >= start && at < end)) return false;
  if (action.input.replyTo && !(typeof action.input.replyAuthorId === 'string' && post.inReplyToUserId === action.input.replyAuthorId))
    return false;
  return matchesPublishedPost(post, action);
}
