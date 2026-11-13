/**
 * Originals that are not sent by the step that decided them (docs/design/agent-tools-2.md section 17): the seam
 * between the posting workstream (A), which knows how a post or a thread is sent, and the time workstream (B), which
 * sends a scheduled post from the tick and must be asked before a post is sent now. Nothing here talks to X or to the
 * database: it only holds what was registered.
 */
import type { ActionOutcome } from '@bootr/agent-core';
import type { AgentRow, SupervisorContext } from './context.js';

/** One original as it is sent: a single post, or a thread when `thread` has parts. */
export interface OriginalPost {
  /** The sender's action id of the first part; part n (from 2) is `${actionId}.t${n}`. */
  actionId: string;
  text: string;
  /** The parts after the first, in order. */
  thread?: { text: string }[];
  imageId?: string;
  attributions?: { username: string; sourceUrl: string }[];
}

/** `result` of a completed original. `parts`, `sent`, `of` and `cut` are present for a thread only. */
export interface OriginalResult {
  postId?: string;
  parts?: { n: number; postId: string }[];
  sent?: number;
  of?: number;
  cut?: { n: number; error: string };
}

export interface PostHooks {
  /**
   * Sends one original through the sender, all its parts in order (A). `completed` (its result an `OriginalResult`)
   * once the first part is known sent; `unknown` while the first part's outcome is not known; `failed` when nothing
   * was sent. Never throws. It runs the publish gate over every part first and sets no hold: the caller does.
   */
  sendOriginal(ctx: SupervisorContext, agent: AgentRow, post: OriginalPost): Promise<ActionOutcome>;
  /** Asked by the broker before an original is sent now (B): the refusal text while a scheduled post is due within one post interval, else null. */
  beforeOriginalNow(ctx: SupervisorContext, agent: AgentRow, now: number): Promise<string | null>;
}

/** Until a workstream's mount replaces them the hooks do nothing, so A and B compile and test alone. */
export const postHooks: PostHooks = {
  sendOriginal: async () => ({ kind: 'failed', error: 'original_sender_not_mounted: nothing was sent' }),
  beforeOriginalNow: async () => null,
};

export function setPostHooks(hooks: Partial<PostHooks>): void {
  Object.assign(postHooks, hooks);
}
