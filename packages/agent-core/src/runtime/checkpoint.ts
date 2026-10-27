import { PolicyError } from '../errors.js';
import { byteLength } from '../hash.js';

export const CHECKPOINT_LIMITS = { memory: 16000, agenda: 12000, summary: 4000 } as const;
export const CHECKPOINT_MIN_DELAY_MS = 60 * 1000;
export const CHECKPOINT_MAX_DELAY_MS = 24 * 60 * 60 * 1000;
export const MAX_STATE_BYTES = 12000;

export interface Checkpoint {
  memory: string;
  agenda: string;
  summary: string;
  /** ISO time, clamped to [now + 1 min, now + 24 h]. */
  nextAt: string;
  nextAtMs: number;
}

/**
 * Validate a `finish` call. Oversized fields are rejected (the model should
 * archive details with `remember`); the requested wake time is clamped.
 */
export function checkpoint(args: Record<string, unknown>, now: number = Date.now()): Checkpoint {
  const { memory, agenda, summary, nextAt } = args;
  if (typeof memory !== 'string' || typeof agenda !== 'string' || typeof summary !== 'string' || typeof nextAt !== 'string')
    throw new PolicyError('invalid_checkpoint');
  if (memory.length > CHECKPOINT_LIMITS.memory || agenda.length > CHECKPOINT_LIMITS.agenda || summary.length > CHECKPOINT_LIMITS.summary)
    throw new PolicyError('checkpoint_too_large', { message: 'checkpoint_too_large: keep concise notes and archive details with remember' });
  const requested = Date.parse(nextAt);
  if (!Number.isFinite(requested)) throw new PolicyError('invalid_next_time');
  const nextAtMs = Math.max(now + CHECKPOINT_MIN_DELAY_MS, Math.min(now + CHECKPOINT_MAX_DELAY_MS, requested));
  return { memory, agenda, summary, nextAt: new Date(nextAtMs).toISOString(), nextAtMs };
}

/** Deep-copies a worker state and refuses anything over 12 KB of JSON. */
export function boundedState<T>(value: T, maxBytes: number = MAX_STATE_BYTES): T {
  const raw = JSON.stringify(value);
  if (raw === undefined || byteLength(raw) > maxBytes) throw new PolicyError('runtime_state_too_large');
  return JSON.parse(raw) as T;
}

export function stateFits(value: unknown, maxBytes: number = MAX_STATE_BYTES): boolean {
  const raw = JSON.stringify(value);
  return raw !== undefined && byteLength(raw) <= maxBytes;
}
