import { describe, expect, it } from 'vitest';

import { composePlatformFees, type SourceStatsRow } from './platform-fees';
import type { WalletClaimSplit } from './wallet-slots';

const row = (over: Partial<SourceStatsRow> & { id: string }): SourceStatsRow => ({
  tokens: 0,
  volumeTotalUsd: 0,
  feesTotalUsd: 0,
  feesAgentUsd: 0,
  feesCreatorUsd: 0,
  feesBurnUsd: 0,
  feesPlatformUsd: 0,
  feesClaimedUsd: 0,
  feesPlatformClaimedUsd: 0,
  updatedAt: 0,
  ...over,
});

describe('GET /platform/fees', () => {
  const split = (exact: boolean, usd: number): WalletClaimSplit => ({ exact, bookedUsd: usd * 2, byKind: { creator: { amount: 1n, usd }, platform: { amount: 1n, usd } } });

  it('adds the platform share of a wallet holding two slots, which the stored rollup books as the creator', () => {
    const body = composePlatformFees([row({ id: 'clanker', feesPlatformClaimedUsd: 43.84 })], [{ source: 'clanker', split: split(true, 5670.5) }]);
    expect(body.bySource.clanker.feesPlatformClaimedUsd).toBeCloseTo(5714.34, 6);
    expect(body.bySource.clanker.feesPlatformClaimedExact).toBe(true);
    expect(body.total.feesPlatformClaimedUsd).toBeCloseTo(5714.34, 6);
  });

  it('adds nothing it cannot state, and says so', () => {
    const body = composePlatformFees([row({ id: 'clanker', feesPlatformClaimedUsd: 43.84 })], [{ source: 'clanker', split: split(false, 5670.5) }]);
    expect(body.bySource.clanker.feesPlatformClaimedUsd).toBe(43.84);
    expect(body.bySource.clanker.feesPlatformClaimedExact).toBe(false);
    expect(body.bySource.bootr.feesPlatformClaimedExact).toBe(true);
    expect(body.total.feesPlatformClaimedExact).toBe(false);
  });

  it('reports both launch paths and their sum, zeros for a path with no row yet', () => {
    const body = composePlatformFees([
      row({ id: 'bootr', tokens: 3, volumeTotalUsd: 10_000, feesTotalUsd: 100, feesAgentUsd: 4.5, feesCreatorUsd: 58.5, feesPlatformUsd: 27, feesClaimedUsd: 20, feesPlatformClaimedUsd: 10, updatedAt: 1_800_000_000 }),
    ]);
    expect(Object.keys(body.bySource).sort()).toEqual(['bootr', 'clanker', 'clanker-v5']);
    expect(body.bySource.bootr).toEqual({
      tokens: 3,
      volumeTotalUsd: 10_000,
      feesTotalUsd: 100,
      byKind: { agent: 4.5, creator: 58.5, burn: 0, platform: 27 },
      feesClaimedUsd: 20,
      feesPlatformClaimedUsd: 10,
      feesPlatformClaimedExact: true,
      updatedAt: 1_800_000_000,
    });
    expect(body.bySource.clanker).toEqual({ tokens: 0, volumeTotalUsd: 0, feesTotalUsd: 0, byKind: { agent: 0, creator: 0, burn: 0, platform: 0 }, feesClaimedUsd: 0, feesPlatformClaimedUsd: 0, feesPlatformClaimedExact: true, updatedAt: null });
    expect(body.bySource['clanker-v5']).toEqual(body.bySource.clanker);
    expect(body.total).toEqual(body.bySource.bootr);
  });

  it('sums the three paths, rounds to 6 dp and ignores unknown ids', () => {
    const body = composePlatformFees([
      row({ id: 'bootr', tokens: 1, feesTotalUsd: 1.0000004, feesPlatformUsd: 0.27, updatedAt: 10 }),
      row({ id: 'clanker', tokens: 2, feesTotalUsd: 2.4, feesPlatformUsd: 0.6, feesBurnUsd: 0.3, feesPlatformClaimedUsd: 0.5, updatedAt: 20 }),
      row({ id: 'clanker-v5', tokens: 1, feesTotalUsd: 1.5, feesPlatformUsd: 0.3, updatedAt: 30 }),
      row({ id: 'other', tokens: 99, feesTotalUsd: 99 }),
    ]);
    expect(body.bySource['clanker-v5'].tokens).toBe(1);
    expect(body.total.tokens).toBe(4);
    expect(body.total.feesTotalUsd).toBe(4.9);
    expect(body.total.byKind).toEqual({ agent: 0, creator: 0, burn: 0.3, platform: 1.17 });
    expect(body.total.feesPlatformClaimedUsd).toBe(0.5);
    expect(body.total.updatedAt).toBe(30);
    expect((body.bySource as Record<string, unknown>).other).toBeUndefined();
  });
});
