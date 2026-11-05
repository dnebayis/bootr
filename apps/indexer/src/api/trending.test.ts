import {
  TRENDING_MAX_TRADERS,
  TRENDING_WALLET_TRADES_CAP,
  TRENDING_WALLET_VOLUME_CAP_USD,
  trendingScore,
  type TrendingWallet,
} from '@bootr/shared/trending';
import { describe, expect, it } from 'vitest';

const wallets = (n: number, w: TrendingWallet): TrendingWallet[] => Array.from({ length: n }, () => w);

describe('trendingScore', () => {
  it('is 0 without trades', () => {
    expect(trendingScore([])).toBe(0);
    expect(trendingScore([{ volumeUsd: 100, trades: 0 }])).toBe(0);
  });

  it('matches the documented figures', () => {
    expect(trendingScore([{ volumeUsd: 1_000_000, trades: 100_000 }])).toBe(3.48);
    expect(trendingScore(wallets(10, { volumeUsd: 200, trades: 2 }))).toBe(46.23);
  });

  it('gives one wash wallet nothing for trading more', () => {
    const atCap = trendingScore([{ volumeUsd: TRENDING_WALLET_VOLUME_CAP_USD, trades: TRENDING_WALLET_TRADES_CAP }]);
    expect(trendingScore([{ volumeUsd: 50_000_000, trades: 1_000_000 }])).toBe(atCap);
  });

  it('ranks a few small real traders over one huge wallet', () => {
    const wash = trendingScore([{ volumeUsd: 10_000_000, trades: 50_000 }]);
    const small = trendingScore(wallets(3, { volumeUsd: 20, trades: 1 }));
    expect(small).toBeGreaterThan(wash);
  });

  it('caps a wash wallet inside a real crowd too', () => {
    const crowd = wallets(9, { volumeUsd: 100, trades: 1 });
    const honest = trendingScore([...crowd, { volumeUsd: TRENDING_WALLET_VOLUME_CAP_USD, trades: TRENDING_WALLET_TRADES_CAP }]);
    expect(trendingScore([...crowd, { volumeUsd: 9_000_000, trades: 9_000 }])).toBe(honest);
  });

  it('stops counting wallets at the cap, while volume and trades still count', () => {
    const atCap = wallets(TRENDING_MAX_TRADERS, { volumeUsd: 10, trades: 1 });
    const over = wallets(TRENDING_MAX_TRADERS * 4, { volumeUsd: 10, trades: 1 });
    expect(trendingScore(over)).toBeGreaterThan(trendingScore(atCap));
    expect(trendingScore(over) / trendingScore(atCap)).toBeLessThan(2);
  });

  it('never rises when a wallet is removed', () => {
    const list = [
      { volumeUsd: 40, trades: 2 },
      { volumeUsd: 900, trades: 7 },
      { volumeUsd: 5, trades: 1 },
    ];
    expect(trendingScore(list.slice(0, 2))).toBeLessThan(trendingScore(list));
  });

  it('ignores volumes that are not real numbers', () => {
    expect(trendingScore([{ volumeUsd: Number.NaN, trades: 1 }])).toBe(trendingScore([{ volumeUsd: 0, trades: 1 }]));
    expect(trendingScore([{ volumeUsd: -50, trades: 1 }])).toBe(trendingScore([{ volumeUsd: 0, trades: 1 }]));
  });
});
