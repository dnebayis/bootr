import { PULSE_MS } from './backoff.js';
import type { InboxEntry } from '../types.js';
import { SEEN_COOLDOWN_MS } from '../social/eligibility.js';

export type RuntimeStatus = 'waiting' | 'working' | 'paused' | 'blocked' | 'unknown';

export interface InboxCandidate extends Pick<InboxEntry, 'postId' | 'status' | 'seenAt' | 'deferredUntil'> {
  /** Result of replyEligibility for this entry, computed by the caller. */
  eligible: boolean;
}

export interface WakeInput {
  now: number;
  enabled: boolean;
  status: RuntimeStatus;
  /** Epoch ms of the scheduled wake chosen by the last checkpoint. */
  nextAt: number;
  /** Epoch ms until which another worker holds the runtime. */
  leaseUntil?: number | null;
  inbox?: readonly InboxCandidate[];
  /** A failed reply has a retry whose time has come. */
  replyRetryDue?: boolean;
  /** Original post schedule, or null when publishing is off. */
  schedule?: { due: boolean; nextAt: number; mayCompose: boolean } | null;
  /** The last turn ended mid-task and asked to continue. */
  continuation?: boolean;
  configRevision?: number;
  lastDecision?: { at: number; revision: number } | null;
  /** A money action with an unknown outcome blocks everything until reconciled. */
  heldAction?: boolean;
}

export interface WakeDecision {
  run: boolean;
  reasons: string[];
  /** Next pulse, or null when the runtime is not scheduled at all. */
  nextAt: number | null;
}

/** An eligible pending mention that was not shown to the model in the last 2 minutes. */
export function pendingReplyDue(inbox: readonly InboxCandidate[], now: number, cooldownMs = SEEN_COOLDOWN_MS): boolean {
  return inbox.some(
    (entry) =>
      entry.status === 'pending' &&
      entry.eligible &&
      (entry.deferredUntil == null || entry.deferredUntil <= now) &&
      (entry.seenAt == null || entry.seenAt <= now - cooldownMs),
  );
}

/** Reasons that justify buying a model response, independent of the scheduled wake. */
export function decisionDue(input: {
  continuation?: boolean;
  inbox?: boolean;
  postDue?: boolean;
  replyRetryDue?: boolean;
  configRevision?: number;
  lastDecision?: { at: number; revision: number } | null;
}): string[] {
  const reasons: string[] = [];
  if (input.continuation) reasons.push('continuation');
  if (input.inbox) reasons.push('pending_mention');
  if (input.replyRetryDue) reasons.push('reply_retry');
  if (input.postDue) reasons.push('original_post_due');
  const last = input.lastDecision;
  if (input.configRevision !== undefined && (!last || last.revision !== input.configRevision || !Number.isFinite(last.at)))
    reasons.push('config_changed');
  return reasons;
}

/**
 * The one-minute pulse keeps transports responsive but is not, by itself, a
 * reason to spend a model turn. Run when the scheduled wake arrived, or when
 * a concrete reason exists and the runtime is waiting.
 */
export function wakeDecision(input: WakeInput): WakeDecision {
  const { now } = input;
  if (!input.enabled) return { run: false, reasons: ['disabled'], nextAt: null };
  if (input.status === 'paused' || input.status === 'blocked' || input.status === 'unknown')
    return { run: false, reasons: [input.status], nextAt: null };
  if (input.heldAction) return { run: false, reasons: ['held_action'], nextAt: null };
  if (input.leaseUntil != null && input.leaseUntil > now) return { run: false, reasons: ['leased'], nextAt: now + 15_000 };

  let scheduled = input.nextAt;
  const schedule = input.schedule ?? null;
  if (schedule && input.status === 'waiting' && schedule.mayCompose && schedule.nextAt < scheduled) scheduled = schedule.nextAt;

  const reasons = decisionDue({
    continuation: input.continuation,
    inbox: pendingReplyDue(input.inbox ?? [], now),
    replyRetryDue: input.replyRetryDue,
    postDue: !!schedule && schedule.due && schedule.mayCompose,
    configRevision: input.configRevision,
    lastDecision: input.lastDecision,
  });
  const scheduledNow = scheduled <= now;
  if (scheduledNow) reasons.unshift('scheduled');
  const run = scheduledNow || (reasons.length > 0 && input.status === 'waiting');
  return { run, reasons: run ? reasons : [], nextAt: Math.min(scheduled, now + PULSE_MS) };
}
