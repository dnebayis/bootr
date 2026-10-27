import { PolicyError } from '../errors.js';
import { DEFAULT_POST_INTERVAL_MS } from '../types.js';

export interface PostSchedule {
  due: boolean;
  /** Epoch ms of the current slot. */
  nextAt: number;
  nextAtIso: string;
  intervalMs: number;
  lastPostAt: number | null;
  /** How many whole intervals have elapsed since the slot opened; informational only, never a burst allowance. */
  missedIntervals: number;
}

type Instant = number | string | Date;

function toMs(value: Instant | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Fixed-interval original-post schedule anchored at max(startedAt, lastPostAt).
 * Being late by many intervals makes exactly one post due; after it publishes
 * the next slot is lastPostAt + interval, so there is never a catch-up burst.
 */
export function originalPostSchedule(
  startedAt: Instant,
  lastPostAt: Instant | null | undefined,
  now: number = Date.now(),
  intervalMs: number = DEFAULT_POST_INTERVAL_MS,
): PostSchedule {
  const started = toMs(startedAt);
  const last = toMs(lastPostAt);
  if (started === null || Number.isNaN(started) || Number.isNaN(last)) throw new PolicyError('invalid_social_schedule');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new PolicyError('invalid_social_schedule');
  const anchor = Math.max(started, last ?? 0);
  const nextAt = anchor + intervalMs;
  const due = now >= nextAt;
  return {
    due,
    nextAt,
    nextAtIso: new Date(nextAt).toISOString(),
    intervalMs,
    lastPostAt: last,
    missedIntervals: due ? Math.floor((now - nextAt) / intervalMs) : 0,
  };
}
