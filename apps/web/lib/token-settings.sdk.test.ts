import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkTokenSettings,
  DEV_BUY_SLIPPAGE,
  launchProblem,
  TOKEN_SETTINGS_BOUNDS,
  TOKEN_SETTINGS_DEFAULTS,
} from '../../../packages/sdk/src/token-settings';
import {
  DEFAULT_DEV_BUY_SLIPPAGE_PCT,
  DEFAULT_PAIRED_ASSET,
  DEFAULT_TAX_PCT,
  defaultTokenSettings,
  FALLBACK_V5_BOUNDS,
  MAX_DEV_BUY_SLIPPAGE_PCT,
  MIN_DIVIDEND_HOLDING,
  pairedAssetsFor,
  parseTokenSettings,
  V5_SUPPLY,
} from './token-settings';

/**
 * `@bootrfun/sdk` checks a launch's Clanker v5 settings before it sends anything, so a mistake does not spend the signed
 * message's nonce. It cannot import this file (it is published on its own), so it holds a copy of the bounds and the
 * messages: this fails when the copy and the site's own drift apart.
 */

const ME = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const FRIEND = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('the SDK’s copy of the launch checks', () => {
  it('has the site’s bounds and defaults', () => {
    const B = TOKEN_SETTINGS_BOUNDS;
    expect([...B.pairedAssets]).toEqual(pairedAssetsFor('agent').map((a) => a.symbol));
    expect(B.minTaxPct * 10_000).toBe(FALLBACK_V5_BOUNDS.minTaxBps);
    expect(B.maxTaxPct * 10_000).toBe(FALLBACK_V5_BOUNDS.maxTaxBps);
    expect(B.agentSharePct * 100).toBe(FALLBACK_V5_BOUNDS.agentShareBps);
    expect(B.platformSharePct * 100).toBe(FALLBACK_V5_BOUNDS.platformShareBps);
    expect(B.maxRewardRows).toBe(FALLBACK_V5_BOUNDS.maxRewardRows);
    expect(B.minDividendHolding).toBe(MIN_DIVIDEND_HOLDING);
    expect(B.supply).toBe(V5_SUPPLY);
    expect({ ...TOKEN_SETTINGS_DEFAULTS, rewards: [{ recipient: ME, admin: ME, pct: 100 }] }).toEqual(defaultTokenSettings(ME));
    expect(TOKEN_SETTINGS_DEFAULTS.pairedAsset).toBe(DEFAULT_PAIRED_ASSET);
    expect(TOKEN_SETTINGS_DEFAULTS.buyTaxPct).toBe(DEFAULT_TAX_PCT);
    expect(DEV_BUY_SLIPPAGE).toEqual({ defaultPct: DEFAULT_DEV_BUY_SLIPPAGE_PCT, minPct: 0.1, maxPct: MAX_DEV_BUY_SLIPPAGE_PCT });
  });

  it.each([
    undefined,
    {},
    { pairedAsset: 'usdc', buyTaxPct: 2, sellTaxPct: '3', burnPct: 10, dividendsPct: 5, rewards: [{ recipient: ME, pct: 80 }, { recipient: FRIEND, admin: ME, pct: 20 }], sniperTax: false },
    { burnPct: 65 },
    'nope',
    [],
    { pairedAsset: 'DAI' },
    { pairedAsset: 5 },
    { buyTaxPct: 0.5 },
    { buyTaxPct: 6 },
    { sellTaxPct: 1.005 },
    { sellTaxPct: 'two' },
    { burnPct: 70 },
    { burnPct: 40, dividendsPct: 30 },
    { dividendsPct: -1 },
    { dividendsPct: 5, minDividendHolding: 10 },
    { dividendsPct: 5, minDividendHolding: 10_000.5 },
    { sniperTax: 'yes' },
    { editableMetadata: 1 },
    { rewards: 'me' },
    { rewards: [null] },
    { rewards: [{ recipient: 'me', pct: 100 }] },
    { rewards: [{ recipient: ME, admin: 'x', pct: 100 }] },
    { rewards: [{ recipient: ME, pct: 'all' }] },
    { rewards: [{ recipient: ME, pct: 60 }] },
    { rewards: [{ recipient: ME, pct: 0 }, { recipient: FRIEND, pct: 100 }] },
    { rewards: [{ recipient: '0x0000000000000000000000000000000000000000', pct: 100 }] },
    { rewards: Array.from({ length: 6 }, () => ({ recipient: ME, pct: 100 / 6 })) },
    { rewards: Array.from({ length: 17 }, () => ({ recipient: ME, pct: 1 })) },
  ])('reads %j as the site does', (raw) => {
    const site = parseTokenSettings(raw, ME, FALLBACK_V5_BOUNDS);
    expect(checkTokenSettings(raw as never, ME)).toEqual(site);
  });

  it('refuses the Clanker v5 fields off v5 and a bad slippage in the route’s words', () => {
    const route = readFileSync(path.join(import.meta.dirname, '../app/api/agent/launch/route.ts'), 'utf8');
    const asRoute = (message: string) => message.replace('this launch goes through bootr.', 'this launch goes through ${launchThrough}.');
    expect(route).toContain(asRoute(launchProblem({ token: {} }, ME)!.message));
    expect(route).toContain(asRoute(launchProblem({ devBuySlippagePct: 3 }, ME)!.message));
    expect(route).toContain(
      launchProblem({ launchThrough: 'pump' as never }, ME)!.message.replace('"pump"', '${quoted(l.launchThrough)}'),
    );
    expect(route).toContain(
      launchProblem({ launchThrough: 'clanker', devBuySlippagePct: 60 }, ME)!
        .message.replace('0.1 to 50 (default 3), got "60"', '0.1 to ${MAX_DEV_BUY_SLIPPAGE_PCT} (default ${DEFAULT_DEV_BUY_SLIPPAGE_PCT}), got ${quoted(l.devBuySlippagePct)}'),
    );
  });
});
