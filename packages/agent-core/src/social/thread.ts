/**
 * Threads (docs/design/agent-tools-2.md section 3): an original post with up to three more posts connected under it.
 * A thread is one original in every rule that counts posts; what is new is checked here, over all parts and before
 * the first one is sent, because the sender only ever sees one part at a time. Pure: no clock, no network.
 */
import { PolicyError } from '../errors.js';
import { linkedHosts, postLength, validatePost, type PostValidationContext } from './post-validation.js';

/** Posts in a thread, the first included. */
export const THREAD_MAX_PARTS = 4;
/** Every part of a thread, for every account: a Premium account that wants length writes one long post. */
export const THREAD_PART_MAX_CHARS = 280;
/** Parts of one thread that may carry a link (X charges a post with a link many times a plain one). */
export const THREAD_MAX_LINK_PARTS = 1;

export interface ThreadLimits {
  maxParts: number;
  partMaxChars: number;
  maxLinkParts: number;
}

export const THREAD_LIMITS: ThreadLimits = { maxParts: THREAD_MAX_PARTS, partMaxChars: THREAD_PART_MAX_CHARS, maxLinkParts: THREAD_MAX_LINK_PARTS };

/** The refusals of a thread, in the words the agent reads (docs/design/agent-tools-2.md section 17.6). */
export const threadTooLong = (max: number): string => `thread_too_long: a thread has at most ${max} posts; nothing was posted. Say it in fewer.`;
export const threadPartTooLong = (n: number, length: number, max: number = THREAD_PART_MAX_CHARS): string => `thread_part_too_long: part ${n} has ${length} characters; every part of a thread is ${max} at most. Nothing was posted.`;
export const threadDailyCap = (max: number): string => `thread_daily_cap: at most ${max} threads per 24 hours; nothing was posted. Publish it as one post.`;
export const THREAD_LINKS = 'thread_links: only one part of a thread may carry a link; nothing was posted.';
export const THREAD_NOT_HERE = 'thread_not_here: the digest and the numbers post are one post each; nothing was posted. Publish it without thread.';
/** Two parts that say the same: X answers a repeat with a bare 403, so it is refused before anything is sent. */
export const THREAD_REPEAT = 'thread_repeat: two parts of the thread say the same; nothing was posted. Say each thing once.';
/** A part the common publish gate refuses: the gate's own code first, as every other refused post carries it. */
export const threadPartRefused = (code: string, n: number): string => `${code}: part ${n} of the thread does not pass the publish gate; nothing was posted. Rewrite it.`;

/** What `validateThread` is told beside the gate's own context: a picture rides on the first part, and the limits in force. */
export interface ThreadContext extends PostValidationContext {
  hasMedia?: boolean;
  limits?: Partial<ThreadLimits>;
}

/** The parts of an original as they are sent, in order: `text` first, then `thread`. One part when there is no thread. */
export function threadParts(post: { text: string; thread?: readonly { text: string }[] | null }): string[] {
  return [post.text, ...(post.thread ?? []).map((p) => p.text)];
}

/** How a part is compared with the others: X treats a repeat as a duplicate whatever its spacing or case. */
const sameText = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Whether a text carries a link as X would make one (explicit or bare; `linkedHosts`). */
export function carriesLink(text: string): boolean {
  return linkedHosts(text).length > 0;
}

/**
 * The gate of a thread, over all of its parts. Throws `PolicyError` whose message is the refusal the agent reads:
 *  - `thread_too_long`: more parts than the limit (a limit under 2 means threads are off);
 *  - `thread_part_too_long`: a part, the first included, over the part limit;
 *  - `thread_repeat`: two parts with the same text;
 *  - `thread_links`: more parts with a link than allowed;
 *  - any `validatePost` code, with the number of the part: every part is checked in the short format, the first with
 *    the credits and the picture, the rest with none, so an `@` in a later part fails (`mentions_require_source_credit`).
 */
export function validateThread(parts: readonly string[], attributions: unknown = [], context: ThreadContext = {}): void {
  const { hasMedia = false, limits, ...risk } = context;
  const max = { ...THREAD_LIMITS, ...limits };
  if (parts.length < 2 || parts.length > max.maxParts) throw new PolicyError('thread_too_long', { message: threadTooLong(Math.max(1, max.maxParts)) });
  parts.forEach((part, i) => {
    const length = typeof part === 'string' ? postLength(part) : 0;
    if (length > max.partMaxChars) throw new PolicyError('thread_part_too_long', { message: threadPartTooLong(i + 1, length, max.partMaxChars) });
  });
  const seen = new Set<string>();
  for (const part of parts) {
    const key = sameText(String(part));
    if (seen.has(key)) throw new PolicyError('thread_repeat', { message: THREAD_REPEAT });
    seen.add(key);
  }
  if (parts.filter((part) => carriesLink(String(part))).length > max.maxLinkParts) throw new PolicyError('thread_links', { message: THREAD_LINKS });
  parts.forEach((part, i) => {
    try {
      validatePost(part, i === 0 ? attributions : [], 'short', i === 0 && hasMedia, risk);
    } catch (err) {
      if (err instanceof PolicyError) throw new PolicyError(err.code, { message: threadPartRefused(err.code, i + 1) });
      throw err;
    }
  });
}

/** Non-throwing variant: the refusal text, or null when the thread may go. */
export function threadRefusal(parts: readonly string[], attributions: unknown = [], context: ThreadContext = {}): string | null {
  try {
    validateThread(parts, attributions, context);
    return null;
  } catch (err) {
    if (err instanceof PolicyError) return err.message;
    throw err;
  }
}
