/**
 * The fee split a Clanker v5 coin's agent states in posts and `read_coin` shows (coin-fees.ts): a tax every buy and
 * every sell pays, Clanker's share inside it, the slots sharing the rest (docs/design/clanker-v5-migration.md section 4).
 */
import { describe, expect, it } from 'vitest';
import { coinFeeSplit, feeSplitLine } from '../src/coin-fees.js';

describe('coin fees of a Clanker v5 coin (the split an agent states in posts)', () => {
  // 1.5% tax: Clanker keeps 0.5% of the trade = 3333 bps of the tax; the slots share 6667 bps by their hook weights
  // (apps/indexer/src/lib/fees.ts clankerV5SlotBps: 500 / 6500 / 3000 -> 333 / 4334 / 2000; buyback 588 / 5883 / 3529
  // after a 15% burn -> 333 / 3335 / 1000 burn / 1999).
  const V5_STANDARD = { source: 'clanker-v5', lpFeeBps: 15_000, agentBps: 333, creatorBps: 4_334, burnBps: 0, platformBps: 2_000, protocolBps: 3_333 };
  const V5_BUYBACK = { source: 'clanker-v5', lpFeeBps: 15_000, agentBps: 333, creatorBps: 3_335, burnBps: 1_000, platformBps: 1_999, protocolBps: 3_333 };

  it('the tax is all a trader pays, buy or sell; Clanker takes 0.5% of the trade inside it; the slots share the rest', () => {
    expect(coinFeeSplit(V5_STANDARD)).toEqual({
      launchedThrough: 'Clanker v5',
      traderPaysPct: 1.5,
      launcherTakesPct: 0.5,
      recipientsPct: { agent: 4.995, creator: 65.007, burn: 0, platform: 29.999 },
      ofEachTradePct: { agent: 0.05, creator: 0.65, burn: 0, platform: 0.3 },
      hasBurn: false,
      taxPct: 1.5,
    });
    expect(coinFeeSplit(V5_BUYBACK)).toMatchObject({
      launchedThrough: 'Clanker v5',
      traderPaysPct: 1.5,
      launcherTakesPct: 0.5,
      recipientsPct: { agent: 4.995, creator: 50.022, burn: 14.999, platform: 29.984 },
      ofEachTradePct: { agent: 0.05, creator: 0.5, burn: 0.15, platform: 0.3 },
      hasBurn: true,
      taxPct: 1.5,
    });
    // the slots and Clanker's share add up to the tax: nothing comes on top as on Clanker v4
    const s = coinFeeSplit(V5_STANDARD)!;
    expect(s.launcherTakesPct + Object.values(s.ofEachTradePct).reduce((a, b) => a + b, 0)).toBeCloseTo(s.traderPaysPct, 2);
  });

  it('read_coin says it is a tax on every buy and sell, with Clanker inside it', () => {
    expect(feeSplitLine(coinFeeSplit(V5_STANDARD)!)).toBe(
      "Fee split (locked at launch, this coin's trades only): launched through Clanker v5, every buy and every sell pays a 1.5% tax, of which Clanker takes 0.5% of the trade. The rest goes to agent 4.995%, creator 65.007%, platform 29.999%. No burn on this coin.",
    );
    expect(feeSplitLine(coinFeeSplit(V5_BUYBACK)!)).toContain('burn 14.999%');
    // RWAGMI and Clanker v4 lines are unchanged
    expect(feeSplitLine(coinFeeSplit({ source: 'clanker', lpFeeBps: 10_000, agentBps: 500, creatorBps: 6_500, burnBps: 0, platformBps: 3_000, protocolBps: 2_000 })!)).toBe(
      "Fee split (locked at launch, this coin's trades only): a trade pays 1.2%, of which Clanker takes 0.2%. The rest goes to agent 5%, creator 65%, platform 30%. No burn on this coin.",
    );
    expect(coinFeeSplit({ source: 'bootr', lpFeeBps: 10_000, agentBps: 450, creatorBps: 5_850, burnBps: 0, platformBps: 2_700, protocolBps: 1_000 })).not.toHaveProperty('taxPct');
  });
});
