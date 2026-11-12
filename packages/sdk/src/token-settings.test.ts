import { describe, expect, it } from 'vitest';
import { checkTokenSettings, launchProblem, parseSlippagePct } from './token-settings.js';

const ME = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const FRIEND = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('checkTokenSettings', () => {
  it('fills in the site’s defaults, the signing wallet as the one reward row', () => {
    expect(checkTokenSettings(undefined, ME.toLowerCase())).toEqual({
      ok: true,
      settings: {
        pairedAsset: 'ETH',
        buyTaxPct: 1.5,
        sellTaxPct: 1.5,
        burnPct: 0,
        dividendsPct: 0,
        minDividendHolding: 10_000,
        rewards: [{ recipient: ME, admin: ME, pct: 100 }],
        sniperTax: true,
        editableMetadata: true,
      },
    });
  });

  it('reads the worked example of the docs, numbers given as text included', () => {
    const r = checkTokenSettings(
      {
        pairedAsset: 'usdc',
        buyTaxPct: 2,
        sellTaxPct: '3',
        burnPct: 10,
        dividendsPct: 5,
        rewards: [
          { recipient: ME, pct: 80 },
          { recipient: FRIEND, admin: ME, pct: 20 },
        ],
        sniperTax: false,
      },
      ME,
    );
    expect(r).toMatchObject({
      ok: true,
      settings: {
        pairedAsset: 'USDC',
        sellTaxPct: 3,
        rewards: [
          { recipient: ME, admin: ME, pct: 80 },
          { recipient: FRIEND, admin: ME, pct: 20 },
        ],
      },
    });
  });

  it.each([
    [{ pairedAsset: 'DAI' }, 'pairedAsset', 'pairedAsset must be one of ETH, USDC.'],
    [{ buyTaxPct: 6 }, 'buyTaxPct', 'Buy tax must be 1% to 5%, in steps of 0.01%.'],
    [{ sellTaxPct: 1.005 }, 'sellTaxPct', 'Sell tax must be 1% to 5%, in steps of 0.01%.'],
    [{ buyTaxPct: 'two' }, 'buyTaxPct', 'buyTaxPct must be a number such as 1.5, got "two".'],
    [
      { burnPct: 70 },
      'burnPct',
      'Burn allocation must be 0% to 65% of the tax pool, in steps of 0.01%.',
    ],
    [
      { burnPct: 40, dividendsPct: 30 },
      'burnPct',
      'Burn allocation and holder dividends add up to 70%: together they can take at most 65%, what the agent’s 5% and the platform’s 30% leave.',
    ],
    [
      { dividendsPct: 5, minDividendHolding: 10 },
      'minDividendHolding',
      'minDividendHolding must be a whole number of coins from 10,000 to 1,000,000,000.',
    ],
    [{ sniperTax: 'yes' }, 'sniperTax', 'sniperTax must be true or false.'],
    [
      { rewards: [{ recipient: ME, pct: 60 }] },
      'rewards',
      'Allocated: 60/100%. The rows must add up to exactly 100%.',
    ],
    [
      { rewards: [{ recipient: 'me', pct: 100 }] },
      'rewards.0.recipient',
      'Row 1: recipient must be a 0x address.',
    ],
    [
      { rewards: Array.from({ length: 6 }, () => ({ recipient: ME, pct: 100 / 6 })) },
      'rewards',
      'rewards must have 1 to 5 rows: yours first, then up to 4 more.',
    ],
  ])('refuses %j as the site does', (token, field, message) => {
    expect(checkTokenSettings(token as never, ME)).toEqual({ ok: false, field, message });
  });

  it('drops the reward rows when burn and dividends take all of the creator funds', () => {
    expect(checkTokenSettings({ burnPct: 65 }, ME)).toMatchObject({
      ok: true,
      settings: { rewards: [] },
    });
  });
});

describe('launchProblem', () => {
  it('names the field as the site does, inside token', () => {
    expect(launchProblem({ launchThrough: 'clanker', token: { buyTaxPct: 6 } }, ME)).toEqual({
      field: 'token.buyTaxPct',
      message: 'Buy tax must be 1% to 5%, in steps of 0.01%.',
    });
    expect(launchProblem({ launchThrough: 'clanker-v5', token: { sellTaxPct: 2 } }, ME)).toBeNull();
  });

  it('refuses v5 fields on the Bootr path', () => {
    expect(launchProblem({ token: {} }, ME)).toMatchObject({ field: 'token' });
    expect(launchProblem({ launchThrough: 'bootr', devBuySlippagePct: 3 }, ME)).toMatchObject({
      field: 'devBuySlippagePct',
    });
  });

  it('checks the path and the dev buy’s slippage', () => {
    expect(launchProblem({ launchThrough: 'pump' as never }, ME)).toEqual({
      field: 'launchThrough',
      message: 'launchThrough must be bootr (default), clanker or clanker-v5, got "pump".',
    });
    expect(launchProblem({ launchThrough: 'clanker', devBuySlippagePct: 60 }, ME)).toEqual({
      field: 'devBuySlippagePct',
      message: 'devBuySlippagePct must be a percent from 0.1 to 50 (default 3), got "60".',
    });
    expect(parseSlippagePct('2.5')).toBe(2.5);
    expect(parseSlippagePct(0.05)).toBeNull();
  });
});
