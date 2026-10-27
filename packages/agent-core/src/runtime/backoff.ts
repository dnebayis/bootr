export const PULSE_MS = 60 * 1000;
export const MIN_INTERRUPTION_MS = 60 * 1000;
export const MAX_INTERRUPTION_MS = 15 * 60 * 1000;
export const RECOVERY_BASE_MS = 15 * 1000;
export const RECOVERY_MAX_MS = 5 * 60 * 1000;
export const MAX_RECOVERY_ATTEMPTS = 3;

export interface InterruptionPlan {
  delayMs: number;
  nextAt: number;
  /** The failure count the plan was computed from. */
  failures: number;
  reason: 'idle' | 'pending' | 'backoff';
}

/**
 * When an external dependency (X, inference, RPC) interrupts the loop, wait
 * 1 min * 2^failures, capped at 15 min. With no failures and nothing pending
 * we simply sleep one pulse; with pending work and no failures we come back
 * after one pulse too, but the reason is reported so callers can log it.
 */
export function interruptionPlan(pendingCount: number, failures: number, now: number): InterruptionPlan {
  const count = Math.max(0, Math.floor(Number.isFinite(failures) ? failures : 0));
  const delayMs = Math.min(MAX_INTERRUPTION_MS, MIN_INTERRUPTION_MS * 2 ** count);
  const reason = count > 0 ? 'backoff' : pendingCount > 0 ? 'pending' : 'idle';
  return { delayMs, nextAt: now + delayMs, failures: count, reason };
}

/** Delay before re-sending the same original idempotent request: 15 s, 30 s, 1 min ... capped at 5 min. */
export function recoveryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(RECOVERY_MAX_MS, RECOVERY_BASE_MS * 2 ** n);
}
