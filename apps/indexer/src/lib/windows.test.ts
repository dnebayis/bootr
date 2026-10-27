import { describe, expect, it } from 'vitest';

import { addTrade, change24hPct, DAY, HOUR, MAX_BUCKETS, sumWindow, type Bucket } from './windows';

const T0 = 1_800_000_000; // arbitrary unix time

describe('rolling windows', () => {
  it('aggregates trades into hourly buckets', () => {
    let b: Bucket[] = [];
    b = addTrade(b, T0, 100, 1, 0.5);
    b = addTrade(b, T0 + 10, 50, 0.5, 0.6);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ v: 150, f: 1.5, n: 2, p: 0.6 });
  });

  it('24h excludes trades older than 24 hours, 7d keeps them', () => {
    let b: Bucket[] = [];
    b = addTrade(b, T0, 100, 1, 1);
    b = addTrade(b, T0 + 2 * DAY, 10, 0.1, 2);
    const now = T0 + 2 * DAY + 60;
    expect(sumWindow(b, now, DAY)).toEqual({ volume: 10, fees: 0.1, trades: 1 });
    expect(sumWindow(b, now, 7 * DAY)).toEqual({ volume: 110, fees: 1.1, trades: 2 });
  });

  it('a trade 23h ago is inside 24h, 25h ago is not', () => {
    const now = T0 + 3 * DAY;
    const b = addTrade(addTrade([], now - 23 * HOUR, 5, 0, 1), now - 25 * HOUR, 7, 0, 1);
    expect(sumWindow(b, now, DAY).volume).toBe(5);
  });

  it('prunes buckets beyond 7 days', () => {
    let b: Bucket[] = [];
    for (let h = 0; h < 200; h++) b = addTrade(b, T0 + h * HOUR, 1, 0, 1);
    expect(b.length).toBe(MAX_BUCKETS);
    expect(sumWindow(b, T0 + 199 * HOUR, 7 * DAY).trades).toBe(168);
  });

  it('change24hPct uses the last price at or before now-24h', () => {
    const now = T0 + 2 * DAY;
    let b: Bucket[] = [];
    b = addTrade(b, now - 30 * HOUR, 1, 0, 2);
    b = addTrade(b, now - 2 * HOUR, 1, 0, 3);
    expect(change24hPct(b, now, 3)).toBe(50);
    expect(change24hPct(addTrade([], now - HOUR, 1, 0, 3), now, 3)).toBeNull();
  });
});
