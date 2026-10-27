/**
 * Policy gate for outgoing X publications, backed by `@bootr/agent-core`.
 *
 * The sender enforces the same deterministic rules the agent sees at decision time:
 * `validatePost` (length per format, one cashtag, mention/source-credit symmetry) which also
 * runs `outgoingActionRisk` (no execution commands, wallet payloads or intent links).
 */
export {
  PolicyError,
  consentCommand,
  normalizedCommunication,
  executionAccount,
  outgoingActionRisk,
  validatePost,
  countCashtags,
  mentionedHandles,
} from '@bootr/agent-core';
export type { Attribution, ConsentCommand, RiskCode, RiskContext } from '@bootr/agent-core';

import { PolicyError, validatePost } from '@bootr/agent-core';
import type { Attribution } from '@bootr/agent-core';

export interface OutgoingAction {
  kind: 'post' | 'reply';
  text: string;
  attributions?: Attribution[];
  /** Username of the author being replied to, if known. */
  recipient?: string | null;
  /** The agent's own handle; never treated as an execution account. */
  ownHandle?: string | null;
}

export type OutgoingDecision = { allowed: true } | { allowed: false; code: string };

/**
 * The publish gate. Replies use the 280-char `short` format, original posts the 4000-char
 * `original` format, matching agent-core's publish_reply / publish_post tool schemas.
 */
export function checkOutgoing(action: OutgoingAction): OutgoingDecision {
  try {
    validatePost(
      action.text,
      action.attributions ?? [],
      action.kind === 'reply' ? 'short' : 'original',
      false,
      {
        reply: action.kind === 'reply',
        recipient: action.recipient ?? null,
        exemptAccounts: action.ownHandle ? [action.ownHandle] : [],
      },
    );
    return { allowed: true };
  } catch (err) {
    if (err instanceof PolicyError || (err instanceof Error && 'code' in err)) {
      return { allowed: false, code: String((err as { code: unknown }).code) };
    }
    throw err;
  }
}
