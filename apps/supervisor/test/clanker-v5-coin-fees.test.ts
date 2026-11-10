/**
 * The fee split a Clanker v5 coin's agent states in posts and `read_coin` shows (coin-fees.ts), from the creator's token
 * settings (docs/design/clanker-v5-token-settings.md sections 1 and 2): the buy and the sell tax, Clanker's cut inside
 * them, the agent, platform and creator slots, extra reward rows as "other recipients" (never their addresses), the holder
 * dividends, the burn and the paired asset. The agent's own coin is described from the settings its launch receipt
 * carried; any coin from the indexer's settings-launcher row; a v5 row without those fields gets no split at all.
 */
import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { clankerV5CutPct, clankerV5SplitFromSettings, COIN_FEES_MEANING, COIN_FEES_V5_MEANING, coinFeesSection, coinFeeSplit, feeSplitLine } from '../src/coin-fees.js';
import { CLANKER_V5_DEFAULT_POLICY, type ClankerV5TokenSettings } from '../src/launch-source.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TOKEN = { token: { address: '0x0', symbol: 'GAS', name: 'Gas', chainId: 8453 } } as never;

/** Today's defaults on the settings launcher: 1.5% both sides, agent 5% / platform 30% / creator 65% of the post-Clanker pool, paired with ETH. */
const DEFAULTS: ClankerV5TokenSettings = {
  buyTaxBps: 15_000,
  sellTaxBps: 15_000,
  burnBps: 0,
  dividendBps: 0,
  slots: [
    { role: 'agent', weightBps: 500 },
    { role: 'platform', weightBps: 3_000 },
    { role: 'creator', weightBps: 6_500 },
  ],
  protocolPolicy: CLANKER_V5_DEFAULT_POLICY,
  minDividendHolding: null,
  metadataEditable: true,
};

/**
 * Everything on: buy 1.5%, sell 2%, burn 10% and dividends 15% of the post-Clanker pool, the rest (P = 7500) over the
 * slots agent 667 / platform 4000 / creator 3200 / two other rows 1333 + 800 (the launcher's ceil/floor weights).
 */
const FULL: ClankerV5TokenSettings = {
  ...DEFAULTS,
  sellTaxBps: 20_000,
  burnBps: 1_000,
  dividendBps: 1_500,
  slots: [
    { role: 'agent', weightBps: 667 },
    { role: 'platform', weightBps: 4_000 },
    { role: 'creator', weightBps: 3_200 },
    { role: 'other', weightBps: 1_333 },
    { role: 'other', weightBps: 800 },
  ],
  minDividendHolding: (10_000n * 10n ** 18n).toString(),
};

/** The indexer row of the default coin: kinds in bps of the tax after Clanker's 3333 (apps/indexer/src/lib/fees.ts). */
const ROW_DEFAULT = { source: 'clanker-v5', lpFeeBps: 15_000, buyTaxBps: 15_000, sellTaxBps: 15_000, agentBps: 333, creatorBps: 4_334, recipientBps: 0, dividendsBps: 0, burnBps: 0, platformBps: 2_000, protocolBps: 3_333, pairedToken: zeroAddress };

/** A row without some of its fields (an indexer that does not send them). */
const without = (row: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

describe('coin fees of a Clanker v5 coin (the split an agent states in posts)', () => {
  it("Clanker's cut is 10% of the tax, at least 0.5% and at most 1% of the trade, never more than the tax", () => {
    expect(clankerV5CutPct(15_000)).toBe(0.5);
    expect(clankerV5CutPct(50_000)).toBe(0.5);
    expect(clankerV5CutPct(80_000)).toBeCloseTo(0.8);
    expect(clankerV5CutPct(200_000)).toBe(1);
    expect(clankerV5CutPct(3_000)).toBeCloseTo(0.3);
  });

  it('the default coin: a 1.5% tax both ways, Clanker 0.5% of the trade inside it, agent 5%, creator 65%, platform 30%, no burn, ETH', () => {
    const own = clankerV5SplitFromSettings(DEFAULTS, 'ETH');
    expect(own).toEqual({
      launchedThrough: 'Clanker v5',
      traderPaysPct: 1.5,
      launcherTakesPct: 0.5,
      recipientsPct: { agent: 5, creator: 65, burn: 0, platform: 30 },
      ofEachTradePct: { agent: 0.05, creator: 0.65, burn: 0, platform: 0.3 },
      hasBurn: false,
      taxPct: 1.5,
      sellTaxPct: 1.5,
      launcherTakesOnSellPct: 0.5,
      ofEachSellPct: { agent: 0.05, creator: 0.65, burn: 0, platform: 0.3 },
      pairedAsset: 'ETH',
      otherRecipientRows: 0,
    });
    // the slots and Clanker's share add up to the tax: nothing comes on top as on Clanker v4
    expect(own!.launcherTakesPct + Object.values(own!.ofEachTradePct).reduce((a, b) => a + b, 0)).toBeCloseTo(own!.traderPaysPct, 2);
    // the indexer's row of the same coin says the same, within its rounding
    expect(coinFeeSplit(ROW_DEFAULT)).toMatchObject({ traderPaysPct: 1.5, launcherTakesPct: 0.5, sellTaxPct: 1.5, pairedAsset: 'ETH', ofEachTradePct: { agent: 0.05, creator: 0.65, platform: 0.3, burn: 0 }, otherRecipientRows: null });
    expect(feeSplitLine(own!)).toBe(
      "Fee split (locked at launch, this coin's trades only): launched through Clanker v5 and paired with ETH, every buy and every sell pays a 1.5% tax, of which Clanker takes 0.5% of the trade. Fees are paid in ETH. The rest goes to agent 5%, creator 65%, platform 30%. No burn on this coin.",
    );
  });

  it('everything the creator can set: two taxes, other recipients without addresses, holder dividends with their minimum, a burn, USDC', () => {
    const split = clankerV5SplitFromSettings(FULL, 'USDC')!;
    expect(split).toEqual({
      launchedThrough: 'Clanker v5',
      traderPaysPct: 1.5,
      launcherTakesPct: 0.5,
      // P = 7500 of the pool: agent 7500 × 667 / 10000 = 500.25, creator 2400, others 1599.75, platform 3000
      recipientsPct: { agent: 5.003, creator: 24, otherRecipients: 15.998, holderDividends: 15, burn: 10, platform: 30 },
      ofEachTradePct: { agent: 0.05, creator: 0.24, otherRecipients: 0.16, holderDividends: 0.15, burn: 0.1, platform: 0.3 },
      hasBurn: true,
      taxPct: 1.5,
      sellTaxPct: 2,
      launcherTakesOnSellPct: 0.5,
      ofEachSellPct: { agent: 0.075, creator: 0.36, otherRecipients: 0.24, holderDividends: 0.225, burn: 0.15, platform: 0.45 },
      pairedAsset: 'USDC',
      otherRecipientRows: 2,
      holderMinimumCoins: 10_000,
    });
    // every share of a sell adds up to the sell tax
    expect(split.launcherTakesOnSellPct! + Object.values(split.ofEachSellPct!).reduce((a, b) => a + b, 0)).toBeCloseTo(2, 2);
    const line = feeSplitLine(split);
    expect(line).toBe(
      "Fee split (locked at launch, this coin's trades only): launched through Clanker v5 and paired with USDC, every buy pays a 1.5% tax and every sell a 2% tax, of which Clanker takes 0.5% of the trade. Fees are paid in USDC, the burn in the coin. The rest goes to agent 5.003%, creator 24%, other recipients 15.998%, holder dividends 15%, burn 10%, platform 30%. Holder dividends are paid in USDC to every holder of at least 10,000 coins, held by Clanker until they claim.",
    );
    expect(line).not.toMatch(/0x[0-9a-f]{6}/i);
  });

  it('never states what the coin does not have: no other recipients, no dividends, no burn words on a default coin', () => {
    const own = clankerV5SplitFromSettings(DEFAULTS, 'ETH')!;
    expect(own.recipientsPct).not.toHaveProperty('otherRecipients');
    expect(own.recipientsPct).not.toHaveProperty('holderDividends');
    expect(own).not.toHaveProperty('holderMinimumCoins');
    const line = feeSplitLine(own);
    expect(line).not.toMatch(/other recipients|dividend/i);
    // a burn-only coin: burn yes, dividends no
    const burnOnly = clankerV5SplitFromSettings({ ...DEFAULTS, burnBps: 2_000, slots: [{ role: 'agent', weightBps: 625 }, { role: 'platform', weightBps: 3_750 }, { role: 'creator', weightBps: 5_625 }] }, 'ETH')!;
    expect(burnOnly.recipientsPct).toEqual({ agent: 5, creator: 45, burn: 20, platform: 30 });
    expect(feeSplitLine(burnOnly)).not.toMatch(/dividend|other recipients/);
  });

  it('from the indexer: a v5 row needs the settings fields; without them there is no split, and USDC is told apart by address', () => {
    const withoutTaxes = without(ROW_DEFAULT, 'buyTaxBps', 'sellTaxBps');
    expect(coinFeeSplit(withoutTaxes)).toBeNull();
    const withoutDividends = without(ROW_DEFAULT, 'dividendsBps');
    expect(coinFeeSplit(withoutDividends)).toBeNull();
    const withoutRows = without(ROW_DEFAULT, 'recipientBps');
    expect(coinFeeSplit(withoutRows)).toBeNull();
    expect(coinFeeSplit({ ...ROW_DEFAULT, pairedToken: USDC_BASE })?.pairedAsset).toBe('USDC');
    expect(coinFeeSplit({ ...ROW_DEFAULT, pairedToken: USDC_BASE.toLowerCase() })?.pairedAsset).toBe('USDC');
    expect(coinFeeSplit({ ...ROW_DEFAULT, pairedToken: '0x1111111111111111111111111111111111111111' })?.pairedAsset).toBe('other');
    // a full row: dividends and other recipients appear, the minimum in coins
    const full = coinFeeSplit({ ...ROW_DEFAULT, sellTaxBps: 20_000, agentBps: 333, creatorBps: 1_600, recipientBps: 1_067, dividendsBps: 1_000, burnBps: 667, platformBps: 2_000, minDividendHolding: (10_000n * 10n ** 18n).toString() })!;
    expect(full).toMatchObject({ sellTaxPct: 2, launcherTakesOnSellPct: 0.5, holderMinimumCoins: 10_000, otherRecipientRows: null, hasBurn: true });
    expect(Object.keys(full.recipientsPct)).toEqual(['agent', 'creator', 'otherRecipients', 'holderDividends', 'burn', 'platform']);
    // RWAGMI and Clanker v4 lines are unchanged
    expect(feeSplitLine(coinFeeSplit({ source: 'clanker', lpFeeBps: 10_000, agentBps: 500, creatorBps: 6_500, burnBps: 0, platformBps: 3_000, protocolBps: 2_000 })!)).toBe(
      "Fee split (locked at launch, this coin's trades only): a trade pays 1.2%, of which Clanker takes 0.2%. The rest goes to agent 5%, creator 65%, platform 30%. No burn on this coin.",
    );
    expect(coinFeeSplit({ source: 'bootr', lpFeeBps: 10_000, agentBps: 450, creatorBps: 5_850, burnBps: 0, platformBps: 2_700, protocolBps: 1_000 })).not.toHaveProperty('taxPct');
  });

  it("the observation describes the agent's own v5 coin from its stored settings first, the indexer row second, and nothing when neither has them", () => {
    const details = { poolId: '0x01', hook: zeroAddress, feeEscrow: zeroAddress, quoteToken: USDC_BASE, tickSpacing: 200, taxBps: 15_000, antiSnipe: true } as const;
    const fromSettings = coinFeesSection(TOKEN, ROW_DEFAULT, { details: { ...details, settings: FULL }, pairedAsset: 'USDC' }).coinFees as Record<string, unknown>;
    expect(fromSettings).toMatchObject({ instructionAuthority: false, meaning: COIN_FEES_V5_MEANING, coin: 'GAS', pairedAsset: 'USDC', sellTaxPct: 2, otherRecipientRows: 2 });
    // stored details without settings (the v1 event): the indexer's row speaks
    expect(coinFeesSection(TOKEN, ROW_DEFAULT, { details, pairedAsset: 'USDC' }).coinFees).toMatchObject({ pairedAsset: 'ETH', sellTaxPct: 1.5 });
    // neither: no section
    const oldRow = without(ROW_DEFAULT, 'sellTaxBps');
    expect(coinFeesSection(TOKEN, oldRow, { details, pairedAsset: 'USDC' })).toEqual({});
    // the meaning tells the agent not to name other recipients nor to mention a recipient that is not there
    expect(COIN_FEES_V5_MEANING).toContain('never who they are');
    expect(COIN_FEES_V5_MEANING).toContain('never mention one that is not there');
    expect(Buffer.byteLength(JSON.stringify({ coinFees: fromSettings }))).toBeLessThan(2_000);
    // an RWAGMI coin's section keeps the short meaning
    expect(coinFeesSection(TOKEN, { source: 'bootr', lpFeeBps: 10_000, agentBps: 450, creatorBps: 5_850, burnBps: 0, platformBps: 2_700, protocolBps: 1_000 }).coinFees).toMatchObject({ meaning: COIN_FEES_MEANING });
  });
});
