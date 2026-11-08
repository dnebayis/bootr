import { describe, expect, it } from 'vitest';
import { boundedState, checkpoint, stateFits } from './checkpoint.js';

const now = Date.parse('2026-05-05T10:00:00.000Z');
const valid = { memory: 'm', agenda: 'a', summary: 's', nextAt: '2026-05-05T12:00:00.000Z' };

describe('checkpoint', () => {
  it('returns the fields with the requested wake time when inside bounds', () => {
    expect(checkpoint(valid, now)).toEqual({ ...valid, nextAtMs: Date.parse(valid.nextAt), requestedMs: Date.parse(valid.nextAt) });
  });
  it('clamps nextAt into [now + 1 min, now + 24 h]', () => {
    expect(checkpoint({ ...valid, nextAt: '2020-01-01T00:00:00.000Z' }, now).nextAt).toBe('2026-05-05T10:01:00.000Z');
    expect(checkpoint({ ...valid, nextAt: '2030-01-01T00:00:00.000Z' }, now).nextAt).toBe('2026-05-06T10:00:00.000Z');
  });
  it('a caller\'s floor lifts an early wake to it, leaves a later one alone, and never passes 24 h', () => {
    const soon = { ...valid, nextAt: '2026-05-05T10:05:00.000Z' };
    const lifted = checkpoint(soon, now, { floorMs: 2 * 3_600_000 });
    expect(lifted.nextAt).toBe('2026-05-05T12:00:00.000Z');
    expect(lifted.requestedMs).toBe(Date.parse(soon.nextAt));
    expect(checkpoint(valid, now, { floorMs: 30 * 60_000 }).nextAt).toBe(valid.nextAt);
    // a floor under the minute, or not a number, is the minute
    expect(checkpoint(soon, now, { floorMs: 10_000 }).nextAt).toBe(soon.nextAt);
    expect(checkpoint({ ...valid, nextAt: '2020-01-01T00:00:00.000Z' }, now, { floorMs: Number.NaN }).nextAt).toBe('2026-05-05T10:01:00.000Z');
    // a seven-day cadence still wakes within the day
    expect(checkpoint(soon, now, { floorMs: 7 * 24 * 3_600_000 }).nextAt).toBe('2026-05-06T10:00:00.000Z');
  });
  it('rejects missing fields, oversized fields and invalid times', () => {
    expect(() => checkpoint({ ...valid, memory: undefined }, now)).toThrow(/invalid_checkpoint/);
    expect(() => checkpoint({ ...valid, memory: 'x'.repeat(16001) }, now)).toThrow(/checkpoint_too_large/);
    expect(() => checkpoint({ ...valid, agenda: 'x'.repeat(12001) }, now)).toThrow(/checkpoint_too_large/);
    expect(() => checkpoint({ ...valid, summary: 'x'.repeat(4001) }, now)).toThrow(/checkpoint_too_large/);
    expect(checkpoint({ ...valid, memory: 'x'.repeat(16000), agenda: 'y'.repeat(12000), summary: 'z'.repeat(4000) }, now).memory).toHaveLength(16000);
    expect(() => checkpoint({ ...valid, nextAt: 'soon' }, now)).toThrow(/invalid_next_time/);
  });
});

describe('boundedState', () => {
  it('deep-copies small state and rejects state over 12 KB', () => {
    const state = { a: [1, 2, { b: 'c' }] };
    const copy = boundedState(state);
    expect(copy).toEqual(state);
    expect(copy).not.toBe(state);
    expect(stateFits({ big: 'x'.repeat(11_990) })).toBe(true);
    expect(() => boundedState({ big: 'x'.repeat(12_000) })).toThrow(/runtime_state_too_large/);
    expect(() => boundedState({ big: 'é'.repeat(6_000) })).toThrow(/runtime_state_too_large/);
    expect(() => boundedState(undefined)).toThrow(/runtime_state_too_large/);
  });
});
