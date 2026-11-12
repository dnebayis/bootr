import { describe, expect, it } from 'vitest';
import { claimsByAsset, coinTerms } from './terms.js';
import type { UnsignedClaim } from './types.js';

const OWNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const WETH = '0x4200000000000000000000000000000000000006';
const ETH = '0x0000000000000000000000000000000000000000';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const claim = (path: UnsignedClaim['path'], asset: `0x${string}`, amountWei: string) =>
  ({
    path,
    target: OWNER,
    data: '0x12',
    value: '0',
    asset,
    amountWei,
    sendFrom: null,
    description: 'd',
  }) satisfies UnsignedClaim;

describe('coinTerms', () => {
  it('reads a Clanker v5 coin’s taxes in percent and its paired asset', () => {
    expect(
      coinTerms({
        source: 'clanker-v5',
        pairedToken: USDC,
        pairedSymbol: 'USDC',
        buyTaxBps: 20_000,
        sellTaxBps: 15_000,
        antiSnipe: true,
        metadataEditable: true,
      }),
    ).toEqual({
      source: 'clanker-v5',
      pairedAsset: 'USDC',
      buyTaxPct: 2,
      sellTaxPct: 1.5,
      sniperTax: true,
      metadataEditable: true,
    });
    expect(coinTerms({ source: 'clanker-v5', pairedToken: ETH }).pairedAsset).toBe('ETH');
  });

  it('has no tax on the older paths', () => {
    expect(
      coinTerms({
        source: 'clanker',
        pairedSymbol: 'WETH',
        buyTaxBps: null,
        sellTaxBps: null,
        antiSnipe: null,
      }),
    ).toEqual({
      source: 'clanker',
      pairedAsset: 'WETH',
      buyTaxPct: null,
      sellTaxPct: null,
      sniperTax: null,
      metadataEditable: null,
    });
  });
});

describe('claimsByAsset', () => {
  it('keeps each asset apart, USDC in its own units', () => {
    const groups = claimsByAsset({
      asset: WETH,
      claims: [
        claim('bootr', WETH, '1000000000000000000'),
        claim('clanker', WETH, '500000000000000000'),
        claim('clanker-v5', ETH, '20000000000000000'),
        claim('clanker-v5', USDC, '12345678'),
      ],
    });
    expect(
      groups.map(({ symbol, amount, amountText, claims }) => [
        symbol,
        amount,
        amountText,
        claims.length,
      ]),
    ).toEqual([
      ['WETH', '1500000000000000000', '1.5', 2],
      ['ETH', '20000000000000000', '0.02', 1],
      ['USDC', '12345678', '12.345678', 1],
    ]);
  });

  it('is empty when nothing is waiting', () => {
    expect(claimsByAsset({ asset: WETH, claims: [] })).toEqual([]);
  });
});
