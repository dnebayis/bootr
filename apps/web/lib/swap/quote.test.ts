import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { poolKeyOf, SWAP_CONTRACTS } from './core';
import { quoteSwap, referenceAmount } from './quote';

const COIN: Address = '0xd769c4F731E088050e24E50275C655315Bf4CcCC';
const usdcKey = poolKeyOf(COIN, 'clanker-v5', SWAP_CONTRACTS.usdc)!;
const ethKey = poolKeyOf(COIN, 'clanker-v5')!;

describe('referenceAmount', () => {
  it('takes a tenth of a percent of a USDC buy from 10 USDC up', () => {
    expect(referenceAmount(25_000_000n, usdcKey, 'buy')).toBe(25_000n);
    expect(referenceAmount(10_000_000n, usdcKey, 'buy')).toBe(10_000n);
  });

  it('uses a USDC buy below 10 USDC as its own reference', () => {
    expect(referenceAmount(9_999_999n, usdcKey, 'buy')).toBe(9_999_999n);
  });

  it('keeps the 1 gwei floor for 18-decimal inputs: ETH buys and coin sells', () => {
    expect(referenceAmount(parseEther('0.01'), ethKey, 'buy')).toBe(parseEther('0.00001'));
    expect(referenceAmount(999_999_999_999n, ethKey, 'buy')).toBe(999_999_999_999n);
    expect(referenceAmount(parseEther('1000'), usdcKey, 'sell')).toBe(parseEther('1'));
    expect(referenceAmount(999_999_999_999n, usdcKey, 'sell')).toBe(999_999_999_999n);
  });
});

describe('quoteSwap on a USDC pool', () => {
  it('quotes a 25 USDC buy against a 0.025 USDC reference, so the fee is the tax and the impact is measured', async () => {
    const asked: bigint[] = [];
    // sqrtPriceX96 of 2^96: one coin per raw USDC unit before the fee.
    const sqrtPriceX96 = 1n << 96n;
    const client = {
      multicall: async ({ contracts }: { contracts: readonly { functionName: string; args?: readonly unknown[] }[] }) =>
        contracts.map((c) => {
          if (c.functionName === 'getSlot0') return { status: 'success', result: [sqrtPriceX96, 0, 0, 0] };
          const amount = (c.args![0] as { exactAmount: bigint }).exactAmount;
          asked.push(amount);
          // 1.5% tax, plus 0.6% price impact on the full amount only.
          const afterTax = (amount * 985n) / 1000n;
          return { status: 'success', result: [amount === 25_000_000n ? (afterTax * 994n) / 1000n : afterTax, 0n] };
        }),
    };
    const q = await quoteSwap(client as never, { key: usdcKey, side: 'buy', amountIn: 25_000_000n });
    expect(asked).toEqual([25_000_000n, 25_000n]);
    expect(q.feePct).toBeCloseTo(1.5, 2);
    expect(q.impactPct).toBeCloseTo(0.6, 2);
  });
});
