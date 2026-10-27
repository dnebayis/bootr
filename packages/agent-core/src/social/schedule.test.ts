import { describe, expect, it } from 'vitest';
import { originalPostSchedule } from './schedule.js';

const H = 60 * 60 * 1000;
const started = Date.parse('2026-01-01T00:00:00.000Z');

describe('originalPostSchedule', () => {
  it('anchors the first slot at startedAt + interval', () => {
    const s = originalPostSchedule(started, null, started + H, 2 * H);
    expect(s.due).toBe(false);
    expect(s.nextAt).toBe(started + 2 * H);
    expect(s.nextAtIso).toBe('2026-01-01T02:00:00.000Z');
    expect(s.lastPostAt).toBeNull();
  });
  it('becomes due exactly at the slot and anchors on the later of startedAt and lastPostAt', () => {
    expect(originalPostSchedule(started, null, started + 2 * H, 2 * H).due).toBe(true);
    const last = started + 5 * H;
    const s = originalPostSchedule(new Date(started).toISOString(), new Date(last).toISOString(), last + H, 2 * H);
    expect(s.due).toBe(false);
    expect(s.nextAt).toBe(last + 2 * H);
    expect(originalPostSchedule(started, started - 10 * H, started + 2 * H, 2 * H).nextAt).toBe(started + 2 * H);
  });
  it('never allows a catch-up burst after downtime', () => {
    const late = started + 30 * H;
    const before = originalPostSchedule(started, null, late, 2 * H);
    expect(before.due).toBe(true);
    expect(before.missedIntervals).toBe(14);
    const after = originalPostSchedule(started, late, late + 1000, 2 * H);
    expect(after.due).toBe(false);
    expect(after.nextAt).toBe(late + 2 * H);
    expect(after.missedIntervals).toBe(0);
  });
  it('uses the default two-hour interval and rejects invalid input', () => {
    expect(originalPostSchedule(started, null, started).intervalMs).toBe(2 * H);
    expect(() => originalPostSchedule('nope', null, started)).toThrow(/invalid_social_schedule/);
    expect(() => originalPostSchedule(started, 'nope', started)).toThrow(/invalid_social_schedule/);
    expect(() => originalPostSchedule(started, null, started, 0)).toThrow(/invalid_social_schedule/);
  });
});
