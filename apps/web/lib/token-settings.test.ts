import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  allocatedPct,
  clankerCutPct,
  creatorFundsPct,
  defaultTokenSettings,
  FALLBACK_V5_BOUNDS,
  MIN_DIVIDEND_HOLDING,
  openingCapInAsset,
  PAIRED_ASSETS,
  pairedAssetBySymbol,
  pairedAssetsFor,
  parseTokenSettings,
  perTradeLines,
  toContractSettings,
  tokenSettingsProblems,
  tradeSplit,
  poolSharesOf,
  rowsFromSlots,
  V5_ROW_TOLERANCE_BPS,
  v5SettingsOf,
} from './token-settings';
import { mockStore } from './mock';

const CREATOR = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;

describe('token settings bounds (the owner’s answers of 2026-11-10)', () => {
  it('taxes 1% to 5% per side, default 1.5%; floors agent 5% and platform 30%; four extra rows', () => {
    expect(FALLBACK_V5_BOUNDS).toEqual({ minTaxBps: 10_000, maxTaxBps: 50_000, agentShareBps: 500, platformShareBps: 3_000, maxRewardRows: 5 });
    const d = defaultTokenSettings(CREATOR);
    expect(d).toMatchObject({ pairedAsset: 'ETH', buyTaxPct: 1.5, sellTaxPct: 1.5, burnPct: 0, dividendsPct: 0, sniperTax: true, editableMetadata: true });
    expect(d.rewards).toEqual([{ recipient: CREATOR, admin: CREATOR, pct: 100 }]);
    expect(tokenSettingsProblems(d)).toEqual([]);
  });

  it('refuses a tax outside the bounds or with more than two decimals', () => {
    const d = defaultTokenSettings(CREATOR);
    for (const v of [0.99, 5.01, 1.005, -1, NaN]) {
      expect(tokenSettingsProblems({ ...d, buyTaxPct: v }).map((p) => p.field)).toContain('buyTaxPct');
    }
    for (const v of [1, 2.25, 5]) expect(tokenSettingsProblems({ ...d, sellTaxPct: v })).toEqual([]);
  });

  it('burn and dividends share the creator’s 65% with creator funds', () => {
    const d = defaultTokenSettings(CREATOR);
    expect(creatorFundsPct(d)).toBe(65);
    expect(creatorFundsPct({ burnPct: 30, dividendsPct: 35 })).toBe(0);
    expect(tokenSettingsProblems({ ...d, burnPct: 40, dividendsPct: 30 }).map((p) => p.field)).toContain('burnPct');
    // All of it to burn and dividends: no rows to pay.
    expect(tokenSettingsProblems({ ...d, burnPct: 30, dividendsPct: 35, rewards: [] })).toEqual([]);
  });

  it('dividends need a holding of at least 10,000 coins', () => {
    const d = { ...defaultTokenSettings(CREATOR), dividendsPct: 10 };
    expect(tokenSettingsProblems({ ...d, minDividendHolding: MIN_DIVIDEND_HOLDING })).toEqual([]);
    expect(tokenSettingsProblems({ ...d, minDividendHolding: 9_999 }).map((p) => p.field)).toEqual(['minDividendHolding']);
  });

  it('rows: one to five, each above 0%, adding up to exactly 100%', () => {
    const d = defaultTokenSettings(CREATOR);
    const row = (pct: number) => ({ recipient: OTHER, admin: OTHER, pct });
    expect(tokenSettingsProblems({ ...d, rewards: [{ ...d.rewards[0]!, pct: 60 }, row(40)] })).toEqual([]);
    expect(tokenSettingsProblems({ ...d, rewards: [{ ...d.rewards[0]!, pct: 60 }, row(30)] }).map((p) => p.message)).toContain('Allocated: 90/100%. The rows must add up to exactly 100%.');
    expect(tokenSettingsProblems({ ...d, rewards: [row(20), row(20), row(20), row(20), row(20)] })).toEqual([]);
    expect(tokenSettingsProblems({ ...d, rewards: [row(20), row(20), row(20), row(20), row(10), row(10)] }).map((p) => p.field)).toContain('rewards');
    expect(tokenSettingsProblems({ ...d, rewards: [] }).map((p) => p.field)).toContain('rewards');
    expect(tokenSettingsProblems({ ...d, rewards: [{ recipient: '0x0000000000000000000000000000000000000000', admin: CREATOR, pct: 100 }] }).map((p) => p.field)).toEqual(['rewards.0.recipient']);
    expect(allocatedPct([{ pct: 33.33 }, { pct: 33.33 }, { pct: 33.34 }])).toBe(100);
  });

  it('paired assets are a list: ETH and USDC for agent coins, nothing for plain tokens yet', () => {
    expect(pairedAssetsFor('agent').map((a) => a.symbol)).toEqual(['ETH', 'USDC']);
    expect(pairedAssetsFor('plain')).toEqual([]);
    expect(pairedAssetBySymbol('usdc')?.decimals).toBe(6);
    expect(tokenSettingsProblems({ ...defaultTokenSettings(CREATOR), pairedAsset: 'CBBTC' }).map((p) => p.field)).toEqual(['pairedAsset']);
    // Clanker's start ticks of 2026-11-10 put the opening cap at about 1.87 ETH and about 4,000 USDC.
    const [eth, usdc] = PAIRED_ASSETS;
    expect(openingCapInAsset(eth!.fallbackStartTick, 18)).toBeCloseTo(1.87, 2);
    expect(openingCapInAsset(usdc!.fallbackStartTick, 6)).toBeGreaterThan(3_900);
    expect(openingCapInAsset(usdc!.fallbackStartTick, 6)).toBeLessThan(4_100);
  });
});

describe('per-trade arithmetic', () => {
  it('Clanker keeps 10% of the tax, at least 0.5% and at most 1% of the trade', () => {
    expect(clankerCutPct(1)).toBe(0.5);
    expect(clankerCutPct(1.5)).toBe(0.5);
    expect(clankerCutPct(5)).toBe(0.5);
    expect(clankerCutPct(8)).toBeCloseTo(0.8);
    expect(clankerCutPct(10)).toBe(1);
  });

  it('writes the footer the way Clanker’s form does', () => {
    const d = defaultTokenSettings(CREATOR);
    expect(perTradeLines({ ...d, buyTaxPct: 1, sellTaxPct: 1 })).toEqual(['Per trade: 0.5% Clanker · 0.025% agent · 0.15% Bootr · 0.325% creator funds']);
    expect(perTradeLines(d)).toEqual(['Per trade: 0.5% Clanker · 0.05% agent · 0.3% Bootr · 0.65% creator funds']);
    expect(perTradeLines({ ...d, sellTaxPct: 3, burnPct: 15, dividendsPct: 10 })).toEqual([
      'Per buy: 0.5% Clanker · 0.05% agent · 0.3% Bootr · 0.4% creator funds · 0.1% holder dividends · 0.15% burn',
      'Per sell: 0.5% Clanker · 0.125% agent · 0.75% Bootr · 1% creator funds · 0.25% holder dividends · 0.375% burn',
    ]);
  });

  it('the parts add up to the tax', () => {
    const t = tradeSplit(2.5, poolSharesOf({ burnPct: 12.5, dividendsPct: 20 }));
    expect(t.clanker + t.agent + t.platform + t.creatorFunds + t.dividends + t.burn).toBeCloseTo(2.5, 10);
  });
});

describe('parseTokenSettings (the agent API and the draft store)', () => {
  it('fills the defaults with the creator’s row', () => {
    const r = parseTokenSettings(undefined, CREATOR);
    expect(r).toEqual({ ok: true, settings: defaultTokenSettings(CREATOR) });
    const partial = parseTokenSettings({ pairedAsset: 'usdc', sellTaxPct: '2' }, CREATOR);
    expect(partial.ok && partial.settings).toMatchObject({ pairedAsset: 'USDC', buyTaxPct: 1.5, sellTaxPct: 2 });
  });

  it('refuses what it cannot read rather than taking the default', () => {
    expect(parseTokenSettings({ sniperTax: 'yes' }, CREATOR)).toMatchObject({ ok: false, field: 'sniperTax' });
    expect(parseTokenSettings({ buyTaxPct: 'one' }, CREATOR)).toMatchObject({ ok: false, field: 'buyTaxPct' });
    expect(parseTokenSettings({ rewards: [{ recipient: 'me', pct: 100 }] }, CREATOR)).toMatchObject({ ok: false, field: 'rewards.0.recipient' });
    expect(parseTokenSettings({ buyTaxPct: 6 }, CREATOR)).toMatchObject({ ok: false, field: 'buyTaxPct' });
  });

  it('an admin left out is the recipient; rows are dropped when creator funds are 0%', () => {
    const r = parseTokenSettings({ rewards: [{ recipient: OTHER, pct: 100 }] }, CREATOR);
    expect(r.ok && r.settings.rewards).toEqual([{ recipient: OTHER, admin: OTHER, pct: 100 }]);
    const none = parseTokenSettings({ burnPct: 65 }, CREATOR);
    expect(none.ok && none.settings.rewards).toEqual([]);
  });
});

describe('toContractSettings', () => {
  it('turns percents into the launcher’s units', () => {
    const s = { ...defaultTokenSettings(CREATOR), pairedAsset: 'USDC', buyTaxPct: 1.25, sellTaxPct: 4, burnPct: 10, dividendsPct: 5.5, minDividendHolding: 20_000, rewards: [{ recipient: CREATOR, admin: CREATOR, pct: 70 }, { recipient: OTHER, admin: CREATOR, pct: 30 }] };
    const pins = { minDevBuyOut: 970n, expectedConfigVersion: 3n, maxLaunchFeeWei: 500_000_000_000_000n, expectedAgentShareBps: 500, expectedPlatformShareBps: 3_000 };
    expect(toContractSettings(s, 'https://bootr.fun/tokens/x.json', FALLBACK_V5_BOUNDS, pins)).toEqual({
      quoteToken: PAIRED_ASSETS[1]!.address,
      buyTaxBps: 12_500,
      sellTaxBps: 40_000,
      burnBps: 1_000,
      dividendBps: 550,
      minDividendHolding: 20_000n * 10n ** 18n,
      rewards: [
        { recipient: CREATOR, admin: CREATOR, bps: 7_000 },
        { recipient: OTHER, admin: CREATOR, bps: 3_000 },
      ],
      antiSnipe: true,
      metadataEditable: true,
      contractURI: 'https://bootr.fun/tokens/x.json',
      // the creator's pins, in the struct's order after contractURI
      minDevBuyOut: 970n,
      expectedConfigVersion: 3n,
      maxLaunchFeeWei: 500_000_000_000_000n,
      expectedAgentShareBps: 500,
      expectedPlatformShareBps: 3_000,
    });
    expect(toContractSettings(defaultTokenSettings(CREATOR), '').minDividendHolding).toBe(0n);
  });
});

describe('the indexer’s token row (v5SettingsOf)', () => {
  // Rows in the indexer's shape (apps/indexer README, "Clanker v5 token settings"): every share in bps of the buy tax
  // with Clanker's inside it, agent + creator + rewards + burn + dividend + platform = 10000 - protocolBps.
  const base = { source: 'clanker-v5' as const, minDividendHolding: null, antiSnipe: true, metadataEditable: true, metadataLocked: false };
  /** The defaults: 1.5% each side, no burn or dividends, one row. Clanker keeps 3333 bps of the tax. */
  const defaults = { ...base, buyTaxBps: 15_000, sellTaxBps: 15_000, protocolBps: 3333, agentBps: 333, creatorBps: 4334, rewardsBps: 0, burnBps: 0, dividendBps: 0, platformBps: 2000 };
  /** The mock $SIGMA: 2% / 3%, 10% burn, 5% dividends, the creator's row 80% and one extra row 20%. Clanker keeps 2500. */
  const sigma = { ...base, buyTaxBps: 20_000, sellTaxBps: 30_000, protocolBps: 2500, agentBps: 375, creatorBps: 3000, rewardsBps: 750, burnBps: 750, dividendBps: 375, platformBps: 2250, minDividendHolding: '10000000000000000000000' };

  it('turns the default row into the pool shares: agent 5%, platform 30%, creator funds 65%', () => {
    const v = v5SettingsOf(defaults)!;
    expect(v.splitKnown).toBe(true);
    expect(Math.abs(v.agentShareBps - 500)).toBeLessThanOrEqual(2);
    expect(Math.abs(v.platformShareBps - 3000)).toBeLessThanOrEqual(2);
    expect(Math.abs(v.creatorFundsBps - 6500)).toBeLessThanOrEqual(2);
    expect(v).toMatchObject({ buyTaxBps: 15_000, sellTaxBps: 15_000, burnBps: 0, dividendBps: 0, rewards: [] });
  });

  it('turns $SIGMA’s row into its settings, creator funds being the creator’s row and the extra rows together', () => {
    expect(v5SettingsOf(sigma)).toMatchObject({ splitKnown: true, agentShareBps: 500, platformShareBps: 3000, burnBps: 1000, dividendBps: 500, creatorFundsBps: 5000, minDividendHolding: '10000000000000000000000' });
    // The mock store reports $SIGMA in exactly this shape, so mock and live read the same.
    const t = mockStore().tokens.find((x) => x.symbol === 'SIGMA')!;
    for (const k of ['buyTaxBps', 'sellTaxBps', 'protocolBps', 'agentBps', 'creatorBps', 'rewardsBps', 'burnBps', 'dividendBps', 'platformBps'] as const) expect(t[k], k).toBe(sigma[k]);
  });

  it('never invents a split: a row that does not add up is unknown, a few bps of rounding are not', () => {
    expect(v5SettingsOf({ ...sigma, platformBps: 2250 + V5_ROW_TOLERANCE_BPS })!.splitKnown).toBe(true);
    const off = v5SettingsOf({ ...sigma, platformBps: 2300 })!;
    expect(off).toMatchObject({ splitKnown: false, agentShareBps: 0, platformShareBps: 0, creatorFundsBps: 0, buyTaxBps: 20_000 });
    // Without protocolBps, Clanker's share comes from the policy.
    expect(v5SettingsOf({ ...defaults, protocolBps: null })!.splitKnown).toBe(true);
  });

  it('is null for every coin not launched with settings', () => {
    expect(v5SettingsOf({ ...sigma, source: 'clanker' })).toBeNull();
    expect(v5SettingsOf({ ...sigma, buyTaxBps: null })).toBeNull();
    expect(v5SettingsOf(null)).toBeNull();
  });

  it('reads the creator rows from the hook’s slots, after the agent’s and the platform’s', () => {
    const a = '0x1111111111111111111111111111111111111111' as Address;
    expect(rowsFromSlots([
      { recipient: a, admin: a, weightBps: 500 },
      { recipient: a, admin: a, weightBps: 3000 },
      { recipient: CREATOR, admin: CREATOR, weightBps: 4875 },
      { recipient: OTHER, admin: CREATOR, weightBps: 1625 },
    ])).toEqual([
      { recipient: CREATOR, admin: CREATOR, bps: 7500 },
      { recipient: OTHER, admin: CREATOR, bps: 2500 },
    ]);
  });
});
