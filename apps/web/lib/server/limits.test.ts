import { describe, expect, it } from 'vitest';
import { evictOldest, RateLimiter } from './ipfs';
import { rememberDue } from './own-agent';

/**
 * What a limiter does when its table is full (security review L7). It used to forget every count at once, so a flood
 * of distinct keys lifted the limit for everybody each time it filled the table, the callers over theirs included.
 */

describe('RateLimiter with a full table', () => {
  it('keeps refusing a caller who is over the limit while distinct keys flood in', () => {
    const limiter = new RateLimiter(3, 60_000, 100);
    const t0 = 1_000_000;
    // Ninety quiet callers, then one who goes over.
    for (let i = 0; i < 90; i++) expect(limiter.hit(`quiet-${i}`, t0)).toBe(0);
    for (let i = 0; i < 3; i++) expect(limiter.hit('greedy', t0 + 1)).toBe(0);
    expect(limiter.hit('greedy', t0 + 2)).toBeGreaterThan(0);
    // A flood of keys nobody will use again, far more than the table holds.
    for (let i = 0; i < 250; i++) {
      expect(limiter.hit(`flood-${i}`, t0 + 3)).toBe(0);
      // The table never grows past its room, and never empties.
      expect(limiter.size).toBeLessThanOrEqual(100);
      expect(limiter.size).toBeGreaterThanOrEqual(90);
      // Every nine keys of the flood, the caller over the limit asks again: still refused, every time.
      if (i % 9 === 0) expect([i, limiter.hit('greedy', t0 + 3) > 0]).toEqual([i, true]);
    }
  });

  it('lets the counts of the callers quiet longest go first, a tenth of the table at a time, and expired ones before any of them', () => {
    const limiter = new RateLimiter(1, 60_000, 10);
    const t0 = 5_000_000;
    for (let i = 0; i < 10; i++) limiter.hit(`k${i}`, t0 + i);
    // Full, nothing expired: one more key costs the oldest one its count, and nobody else.
    expect(limiter.hit('new', t0 + 20)).toBe(0);
    expect(limiter.size).toBe(10);
    expect(limiter.hit('k0', t0 + 21)).toBe(0);
    for (let i = 2; i < 10; i++) expect([i, limiter.hit(`k${i}`, t0 + 22) > 0]).toEqual([i, true]);
    // Once windows have run out, those are what is dropped: a key still inside its window keeps its count.
    const later = t0 + 60_000 + 5;
    expect(limiter.hit('late', later - 1000)).toBe(0);
    for (let i = 0; i < 9; i++) limiter.hit(`fresh-${i}`, later + i);
    expect(limiter.hit('late', later + 50)).toBeGreaterThan(0);
  });

  it('counts as before while the table has room', () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.hit('a', 0)).toBe(0);
    expect(limiter.hit('a', 1)).toBe(0);
    expect(limiter.hit('a', 2)).toBe(1);
    expect(limiter.hit('b', 2)).toBe(0);
    // A new window starts the count again.
    expect(limiter.hit('a', 1000)).toBe(0);
    expect(limiter.size).toBe(2);
  });
});

describe('the moments clients may look again', () => {
  it('are not all forgotten when the table is full: the client that just looked is still held to its interval', () => {
    const next = new Map<string, number>();
    const now = 9_000_000;
    for (let i = 0; i < 20; i++) rememberDue(next, `client-${i}`, now + 20_000, now + i, 20);
    rememberDue(next, 'just-looked', now + 20_030, now + 30, 20);
    for (let i = 0; i < 40; i++) {
      rememberDue(next, `junk-${i}`, now + 20_040 + i, now + 40 + i, 20);
      expect(next.size).toBeLessThanOrEqual(20);
      expect(next.size).toBeGreaterThan(10);
      // It looks again in between: its entry moves to the end, so it is among the last to go.
      if (i % 5 === 0) {
        expect([i, (next.get('just-looked') ?? 0) > now + 40 + i]).toEqual([i, true]);
        rememberDue(next, 'just-looked', now + 20_040 + i, now + 40 + i, 20);
      }
    }
    // Entries whose moment has passed go before any that still hold.
    const later = now + 30_000;
    const table = new Map<string, number>([['past-1', now], ['past-2', now + 1]]);
    for (let i = 0; i < 8; i++) table.set(`holding-${i}`, later + 60_000);
    rememberDue(table, 'new', later + 20_000, later, 10);
    expect([...table.keys()]).toEqual([...Array.from({ length: 8 }, (_, i) => `holding-${i}`), 'new']);
  });

  it('evictOldest leaves a map with room alone and drops only from the front of a full one', () => {
    const map = new Map<string, number>(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    evictOldest(map, 31);
    expect(map.size).toBe(30);
    evictOldest(map, 30);
    expect([...map.keys()]).toEqual(Array.from({ length: 27 }, (_, i) => `k${i + 3}`));
  });
});
