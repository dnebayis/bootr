/**
 * Policy gate for outgoing X publications, backed by `@bootr/agent-core`.
 *
 * The sender enforces the same deterministic rules the agent sees at decision time:
 * `validatePost` (length per format, one cashtag, mention/source-credit symmetry) which also
 * runs `outgoingActionRisk` (no execution commands, wallet payloads or intent links) and
 * `outgoingDisclosureRisk` (no secrets, internal references, runtime jargon or foreign addresses).
 */
export {
  PolicyError,
  consentCommand,
  normalizedCommunication,
  executionAccount,
  outgoingActionRisk,
  outgoingDisclosureRisk,
  validatePost,
  countCashtags,
  mentionedHandles,
} from '@bootr/agent-core';
export type { Attribution, ConsentCommand, DisclosureCode, DisclosureContext, RiskCode, RiskContext } from '@bootr/agent-core';

import { gateWords, postFinding } from '@bootr/agent-core';
import type { Attribution } from '@bootr/agent-core';

export interface OutgoingAction {
  kind: 'post' | 'reply';
  text: string;
  attributions?: Attribution[];
  /** Username of the author being replied to, if known. */
  recipient?: string | null;
  /** The agent's own handle; never treated as an execution account. */
  ownHandle?: string | null;
  /** Addresses the text may name (own token, own treasury); undefined skips the address check. */
  publicAddresses?: readonly string[];
  /** The platform's own agent: agent-core's platform post rules apply on top of the common ones. */
  platform?: boolean;
}

/**
 * A refusal carries the gate's code and, in `words`, what tripped and how to say it (agent-core `gateWords`): an
 * excerpt of the agent's own text at most, never the recipient's handle or a credit. The supervisor hands both to
 * the model, which before had the bare code and rewrote blind.
 */
export type OutgoingDecision = { allowed: true } | { allowed: false; code: string; words: string | null };

/**
 * The publish gate. Replies use the 280-char `short` format, original posts the 4000-char
 * `original` format, matching agent-core's publish_reply / publish_post tool schemas.
 */
export function checkOutgoing(action: OutgoingAction): OutgoingDecision {
  const finding = postFinding(
    action.text,
    action.attributions ?? [],
    action.kind === 'reply' ? 'short' : 'original',
    false,
    {
      reply: action.kind === 'reply',
      recipient: action.recipient ?? null,
      exemptAccounts: action.ownHandle ? [action.ownHandle] : [],
      ...(action.publicAddresses ? { publicAddresses: action.publicAddresses } : {}),
      ...(action.platform ? { platform: true } : {}),
    },
  );
  return finding ? { allowed: false, code: finding.code, words: gateWords(finding) } : { allowed: true };
}
