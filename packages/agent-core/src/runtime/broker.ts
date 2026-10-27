import { PolicyError } from '../errors.js';
import { digest } from '../hash.js';
import { MAX_RECOVERY_ATTEMPTS, recoveryDelayMs } from './backoff.js';
import { TOOLS } from '../tools.js';
import type { Action, ActionOutcome, ActionReceipt, ActionResult, PendingAction } from '../types.js';

export interface BrokerRuntime {
  runtimeId: string;
  cycle: number;
  pending: PendingAction | null;
}

/** Deterministic key for one cycle of one runtime: the idempotency anchor for everything the cycle sends. */
export function cycleKey(runtimeId: string, cycle: number): string {
  return 'cycle:' + digest({ runtimeId, cycle }).slice(0, 32);
}

/** Deterministic action id: the same cycle and the same action always produce the same id. */
export function actionId(key: string, action: Action): string {
  return 'act_' + digest({ cycleKey: key, action }).slice(0, 32);
}

/** Reads and writes keyed by our cycle key may be re-sent; money never is. */
export function isRetryable(action: Action): boolean {
  const tool = TOOLS[action.tool];
  return tool.effect !== 'money' && tool.idempotent;
}

export function isMoney(action: Action): boolean {
  return TOOLS[action.tool].effect === 'money';
}

/**
 * Bind a worker's requested action to the runtime's current cycle. The runtime
 * must be free (no pending action) and the cycle must match.
 */
export function beginAction(runtime: BrokerRuntime, action: Action, cycle: number, now: number = Date.now(), completeAfter = false): PendingAction {
  if (runtime.pending && runtime.pending.status !== 'completed' && runtime.pending.status !== 'failed') throw new PolicyError('runtime_busy');
  if (cycle !== runtime.cycle) throw new PolicyError('runtime_cycle_mismatch');
  if (!Object.prototype.hasOwnProperty.call(TOOLS, action.tool)) throw new PolicyError('runtime_action_denied');
  const key = cycleKey(runtime.runtimeId, cycle);
  return {
    id: actionId(key, action),
    cycleKey: key,
    action,
    status: 'sending',
    createdAt: now,
    attempts: 1,
    ...(completeAfter ? { completeAfter: true } : {}),
  };
}

/** The request has left the process; from here on an unknown outcome is possible. */
export function markSent(pending: PendingAction): PendingAction {
  if (pending.status !== 'sending') throw new PolicyError('action_not_sending');
  return { ...pending, status: 'sent' };
}

/**
 * Can the identical original request be sent again after an unknown outcome?
 * Only reads and writes the receiving service keys by our cycle key, and only
 * a bounded number of times.
 */
export function canResume(pending: PendingAction): boolean {
  if (pending.status !== 'sent' && pending.status !== 'held') return false;
  if (!isRetryable(pending.action)) return false;
  return pending.attempts < MAX_RECOVERY_ATTEMPTS + 1;
}

function resultFor(pending: PendingAction, outcome: ActionOutcome): ActionResult {
  const base = { actionId: pending.id, tool: pending.action.tool };
  if (outcome.kind === 'completed') return { ...base, status: 'completed', result: outcome.result, ...(outcome.receipt ? { receipt: outcome.receipt } : {}) };
  if (outcome.kind === 'failed') return { ...base, status: 'failed', error: outcome.error };
  return { ...base, status: 'unknown', error: outcome.error };
}

/**
 * Record what happened to a sent action.
 * - completed / definite failure settle the action.
 * - unknown: resumable actions go back to `sent` with a backoff; everything
 *   else (money, non-idempotent writes, exhausted retries) becomes `held`.
 */
export function recordOutcome(pending: PendingAction, outcome: ActionOutcome, now: number = Date.now()): PendingAction {
  if (pending.status === 'completed' || pending.status === 'failed') throw new PolicyError('action_already_settled');
  if (pending.status === 'sending' && outcome.kind !== 'failed') throw new PolicyError('action_not_sent');
  const result = resultFor(pending, outcome);
  if (outcome.kind === 'completed') return { ...pending, status: 'completed', result, reason: undefined, nextAt: undefined };
  if (outcome.kind === 'failed') return { ...pending, status: 'failed', result, reason: outcome.error, nextAt: outcome.retryAt };
  const unknown = { ...pending, result, reason: outcome.error };
  if (canResume(unknown)) return { ...unknown, status: 'sent', nextAt: now + recoveryDelayMs(pending.attempts - 1) };
  return { ...unknown, status: 'held', nextAt: undefined };
}

/** Re-send the same original request. Only valid when canResume() is true and the backoff elapsed. */
export function resumeAction(pending: PendingAction, now: number = Date.now()): PendingAction {
  if (!canResume(pending)) throw new PolicyError('runtime_original_not_resolved');
  if (pending.nextAt !== undefined && pending.nextAt > now) throw new PolicyError('action_backoff_pending');
  return { ...pending, status: 'sending', attempts: pending.attempts + 1, nextAt: undefined };
}

export interface ReconcileReceipt {
  actionId: string;
  cycleKey: string;
  outcome: Exclude<ActionOutcome, { kind: 'unknown' }>;
  receipt?: ActionReceipt;
}

/**
 * Resolve a held action with the original receipt recovered from the
 * executing service. The receipt must name this exact action and cycle; a
 * receipt for anything else leaves the action held.
 */
export function reconcile(pending: PendingAction, receipt: ReconcileReceipt): PendingAction {
  if (pending.status !== 'held' && pending.status !== 'sent') throw new PolicyError('action_not_held');
  if (receipt.actionId !== pending.id || receipt.cycleKey !== pending.cycleKey) throw new PolicyError('runtime_original_not_resolved');
  const outcome = receipt.outcome.kind === 'completed' && receipt.receipt ? { ...receipt.outcome, receipt: receipt.receipt } : receipt.outcome;
  return recordOutcome({ ...pending, status: 'sent' }, outcome);
}

/** A runtime with a held action cannot start another cycle. */
export function runtimeBlocked(runtime: BrokerRuntime): boolean {
  return runtime.pending?.status === 'held';
}

/** Advance the runtime once its pending action settled; the result becomes the next observation. */
export function settleCycle(runtime: BrokerRuntime): { runtime: BrokerRuntime; observation: ActionResult | null } {
  const pending = runtime.pending;
  if (pending && pending.status !== 'completed' && pending.status !== 'failed') throw new PolicyError('runtime_busy');
  return {
    runtime: { ...runtime, cycle: runtime.cycle + 1, pending: null },
    observation: pending?.result ?? null,
  };
}
