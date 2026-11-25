import { describe, expect, it } from 'vitest';

import { changedFields, sameValue } from './patch';
import { addTrade, windowFields, type Bucket } from './windows';

describe('sameValue', () => {
  it('compares numbers, big integers, text, booleans and null by value', () => {
    expect(sameValue(1.5, 1.5)).toBe(true);
    expect(sameValue(0.1 + 0.2, 0.3)).toBe(false);
    expect(sameValue(10n ** 29n, 10n ** 29n)).toBe(true);
    expect(sameValue(10n ** 29n, 10n ** 29n + 1n)).toBe(false);
    expect(sameValue('awake', 'awake')).toBe(true);
    expect(sameValue(true, false)).toBe(false);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue(null, '')).toBe(false);
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
  });

  it('never takes a number for a big integer or for its text', () => {
    expect(sameValue(1, 1n)).toBe(false);
    expect(sameValue(1, '1')).toBe(false);
    expect(sameValue(1n, '1')).toBe(false);
  });

  it('compares dates by their instant and JSON by content, whatever the key order', () => {
    expect(sameValue(new Date(1_795_000_000_000), new Date(1_795_000_000_000))).toBe(true);
    expect(sameValue(new Date(1_795_000_000_000), new Date(1_795_000_000_001))).toBe(false);
    expect(sameValue(new Date(0), 0)).toBe(false);
    expect(sameValue({ a: 1, b: [1, 2, { c: 3n }] }, { b: [1, 2, { c: 3n }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1, b: [1, 2] }, { a: 1, b: [2, 1] })).toBe(false);
    expect(sameValue({ c: 3n }, { c: '3' })).toBe(false);
    expect(sameValue([], {})).toBe(false);
  });
});

describe('changedFields', () => {
  const row = { id: '0xabc', priceUsd: 3.4e-7, totalSupply: 10n ** 29n, change24hPct: null as number | null, status: 'awake', balancesUpdatedAt: 100 as number | null };

  it('is empty when every field of the patch equals the stored row', () => {
    expect(changedFields(row, { priceUsd: 3.4e-7, totalSupply: 10n ** 29n, change24hPct: null, status: 'awake' })).toEqual({});
  });

  it('keeps only the fields that moved', () => {
    expect(changedFields(row, { priceUsd: 3.5e-7, totalSupply: 10n ** 29n, change24hPct: 2.94 })).toEqual({ priceUsd: 3.5e-7, change24hPct: 2.94 });
    expect(changedFields(row, { change24hPct: 0 })).toEqual({ change24hPct: 0 });
  });

  it('treats an undefined entry as no change', () => {
    expect(changedFields(row, { status: undefined, priceUsd: 3.4e-7 })).toEqual({});
  });

  it('does not write for a quiet field alone, and writes it along with a real change', () => {
    expect(changedFields(row, { balancesUpdatedAt: 160, status: 'awake' }, ['balancesUpdatedAt'])).toEqual({});
    expect(changedFields(row, { balancesUpdatedAt: 160, status: 'sleeping' }, ['balancesUpdatedAt'])).toEqual({ balancesUpdatedAt: 160, status: 'sleeping' });
  });
});

describe('a coin’s 24 h window between two snapshots with no trade', () => {
  // One $100 trade at t0. The stored row holds what the snapshot after it wrote.
  const HOUR = 3600;
  const t0 = 1_795_000_000 - (1_795_000_000 % HOUR);
  const buckets: Bucket[] = addTrade([], t0 + 60, 100, 2.4, 3.4e-7);
  const stored = windowFields(buckets, t0 + 120, 3.4e-7);

  it('needs no write a minute later', () => {
    expect(stored.volume24hUsd).toBe(100);
    expect(changedFields(stored, windowFields(buckets, t0 + 180, 3.4e-7))).toEqual({});
  });

  it('still rolls the trade out of the window when its hour leaves the last 24', () => {
    const later = windowFields(buckets, t0 + 25 * HOUR, 3.4e-7);
    expect(later.volume24hUsd).toBe(0);
    const diff = changedFields(stored, later);
    expect(diff).toMatchObject({ volume24hUsd: 0, trades24h: 0, fees24hUsd: 0 });
    // the 7 day volume has not moved, so it is not in the write
    expect(diff).not.toHaveProperty('volume7dUsd');
  });
});
