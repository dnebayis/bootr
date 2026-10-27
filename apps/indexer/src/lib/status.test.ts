import { describe, expect, it } from 'vitest';

import { allocateClaim, classifyRecipient } from './fees';
import { deriveStatus, dormantSince } from './status';

const now = 2_000_000_000;
const base = {
  now,
  lastActivityAt: now - 60,
  dormancyPeriod: 30 * 86_400,
  paused: false,
  claimed: false,
  treasuryUsdc: 5_000_000n,
};

describe('deriveStatus', () => {
  it('awake when recently active and funded', () => expect(deriveStatus(base)).toBe('awake'));
  it('sleeping when USDC < 1', () => expect(deriveStatus({ ...base, treasuryUsdc: 999_999n })).toBe('sleeping'));
  it('counts the spender float as fuel (kernel + spender >= 1 USDC)', () => {
    expect(deriveStatus({ ...base, treasuryUsdc: 0n, spenderUsdc: 1_000_000n })).toBe('awake');
    expect(deriveStatus({ ...base, treasuryUsdc: 600_000n, spenderUsdc: 400_000n })).toBe('awake');
    expect(deriveStatus({ ...base, treasuryUsdc: 600_000n, spenderUsdc: 399_999n })).toBe('sleeping');
  });
  it('sleeping when idle > 6h', () => expect(deriveStatus({ ...base, lastActivityAt: now - 7 * 3600 })).toBe('sleeping'));
  it('supervisor hints', () => {
    expect(deriveStatus({ ...base, supervisorHint: 'sleeping' })).toBe('sleeping');
    expect(deriveStatus({ ...base, lastActivityAt: now - 7 * 3600, supervisorHint: 'awake' })).toBe('awake');
  });
  it('paused beats funding/activity', () => expect(deriveStatus({ ...base, paused: true })).toBe('paused'));
  it('dormant once the period passed (even if paused)', () => {
    const s = { ...base, paused: true, lastActivityAt: now - 30 * 86_400 };
    expect(deriveStatus(s)).toBe('dormant');
    expect(dormantSince(now, s.lastActivityAt, s.dormancyPeriod)).toBe(now);
    expect(dormantSince(now, base.lastActivityAt, base.dormancyPeriod)).toBeNull();
  });
  it('claimed is terminal', () => expect(deriveStatus({ ...base, claimed: true })).toBe('claimed'));
});

describe('fee helpers', () => {
  const parties = {
    kernel: '0x00000000000000000000000000000000000000a1',
    creator: '0x00000000000000000000000000000000000000c1',
    burner: '0x00000000000000000000000000000000000000b1',
    platformRecipient: '0x00000000000000000000000000000000000000f1',
  } as const;

  it('classifies recipients (case-insensitive)', () => {
    expect(classifyRecipient('0x00000000000000000000000000000000000000A1', parties)).toBe('agent');
    expect(classifyRecipient(parties.creator, parties)).toBe('creator');
    expect(classifyRecipient(parties.burner, parties)).toBe('burn');
    expect(classifyRecipient(parties.platformRecipient, parties)).toBe('platform');
    expect(classifyRecipient('0x0000000000000000000000000000000000000001', parties)).toBeNull();
    expect(classifyRecipient(parties.creator, { ...parties, platformRecipient: parties.creator })).toBe('creator');
  });

  it('allocates a full claim to each outstanding balance and ignores excess', () => {
    expect(allocateClaim([100n, 50n], 150n)).toEqual([100n, 50n]);
    expect(allocateClaim([100n, 50n], 200n)).toEqual([100n, 50n]);
  });

  it('allocates a partial claim pro-rata without losing wei', () => {
    const out = allocateClaim([1n, 1n, 1n], 2n);
    expect(out.reduce((a, b) => a + b, 0n)).toBe(2n);
    expect(allocateClaim([300n, 100n], 200n)).toEqual([150n, 50n]);
    expect(allocateClaim([0n, 0n], 10n)).toEqual([0n, 0n]);
  });
});
