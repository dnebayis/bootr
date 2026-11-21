import { describe, expect, it } from 'vitest';

import { addPoolMove, addTrade, change24hPct, DAY, HOUR, MAX_BUCKETS, sumWindow, type Bucket } from './windows';

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

  it('a pool move (the fee conversion) adds its fee and price to the hour, no volume and no trade', () => {
    let b = addTrade([], T0, 100, 1, 0.5);
    b = addPoolMove(b, T0 + 10, 0.25, 0.4);
    expect(b).toEqual([{ h: Math.floor(T0 / HOUR), v: 100, f: 1.25, n: 1, p: 0.4 }]);
    b = addPoolMove(b, T0 + HOUR, 0.1, 0.45);
    expect(b[1]).toEqual({ h: Math.floor(T0 / HOUR) + 1, v: 0, f: 0.1, n: 0, p: 0.45 });
    expect(sumWindow(b, T0 + HOUR, DAY)).toEqual({ volume: 100, fees: 1.35, trades: 1 });
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
