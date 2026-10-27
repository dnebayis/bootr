import { describe, expect, it } from 'vitest';
import { interruptionPlan, recoveryDelayMs } from './backoff.js';

const M = 60_000;

describe('interruptionPlan', () => {
  it('grows 1 -> 2 -> 4 -> 8 -> 15 minutes and caps there', () => {
    expect(interruptionPlan(0, 0, 0)).toEqual({ delayMs: M, nextAt: M, failures: 0, reason: 'idle' });
    expect(interruptionPlan(3, 0, 0).reason).toBe('pending');
    expect(interruptionPlan(0, 1, 0).delayMs).toBe(2 * M);
    expect(interruptionPlan(0, 2, 0).delayMs).toBe(4 * M);
    expect(interruptionPlan(0, 3, 0).delayMs).toBe(8 * M);
    expect(interruptionPlan(0, 4, 0).delayMs).toBe(15 * M);
    expect(interruptionPlan(0, 40, 1000)).toMatchObject({ delayMs: 15 * M, nextAt: 1000 + 15 * M, reason: 'backoff' });
    expect(interruptionPlan(0, -3, 0).delayMs).toBe(M);
    expect(interruptionPlan(0, Number.NaN, 0).delayMs).toBe(M);
  });
});

describe('recoveryDelayMs', () => {
  it('doubles from 15 s and caps at 5 min', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(recoveryDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });
});
