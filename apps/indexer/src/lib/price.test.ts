import { describe, expect, it } from 'vitest';

import { unitPrice, coinPriceInWeth, interpretSwap, liquidityUsd, oneSidedLiquidity, positionAmounts, price0In1, sqrtRatioAtTick, toUnits, usd } from './price';

const Q96 = 2n ** 96n;

describe('sqrtPriceX96 math', () => {
  it('price of currency0 in currency1', () => {
    expect(price0In1(Q96)).toBe(1);
    expect(price0In1(Q96 * 2n)).toBe(4);
    expect(price0In1(Q96 / 2n)).toBe(0.25);
  });

  it('coin price in WETH for both orderings', () => {
    expect(coinPriceInWeth(Q96 * 2n, true)).toBe(4);
    expect(coinPriceInWeth(Q96 * 2n, false)).toBe(0.25);
    expect(coinPriceInWeth(0n, true)).toBe(0);
  });

  it('matches the launch starting tick (tickIfToken0IsB20 -230400) (~1e-10 WETH per coin, ~10 ETH FDV for 100B)', () => {
    const sqrt = BigInt(Math.floor(Math.sqrt(1.0001 ** -230400) * 2 ** 96));
    const p = coinPriceInWeth(sqrt, true);
    expect(p).toBeGreaterThan(9e-11);
    expect(p).toBeLessThan(1.1e-10);
    expect(p * 100e9).toBeCloseTo(9.87, 1);
  });

  it('position amounts are one-sided outside the range', () => {
    const L = 10n ** 24n;
    const below = positionAmounts(L, BigInt(Math.floor(Math.sqrt(1.0001 ** -240000) * 2 ** 96)), -230400, -120000);
    expect(below.amount1).toBe(0);
    expect(below.amount0).toBeGreaterThan(0);
    const above = positionAmounts(L, BigInt(Math.floor(Math.sqrt(1.0001 ** -100000) * 2 ** 96)), -230400, -120000);
    expect(above.amount0).toBe(0);
    expect(above.amount1).toBeGreaterThan(0);
  });

  it('liquidity USD is positive in range and zero without liquidity', () => {
    const sqrt = BigInt(Math.floor(Math.sqrt(1.0001 ** -200000) * 2 ** 96));
    const args = { sqrtPriceX96: sqrt, tickLower: -230400, tickUpper: -120000, coinIsToken0: true, ethUsd: 3000 };
    expect(liquidityUsd({ ...args, liquidity: 0n })).toBe(0);
    expect(liquidityUsd({ ...args, liquidity: 10n ** 24n })).toBeGreaterThan(0);
  });
});

describe('oneSidedLiquidity', () => {
  const supply = 100_000_000_000n * 10n ** 18n;
  const sqrtAt = (t: number) => BigInt(Math.floor(sqrtRatioAtTick(t) * 2 ** 96));
  it('round-trips the launch deposit when the coin is currency0', () => {
    const L = oneSidedLiquidity(supply, -230400, -120000, true);
    const { amount0, amount1 } = positionAmounts(L, sqrtAt(-230400), -230400, -120000);
    expect(amount0 / 1e18).toBeCloseTo(100e9, -3);
    expect(amount1).toBe(0);
  });
  it('round-trips the launch deposit when the coin is currency1', () => {
    const L = oneSidedLiquidity(supply, 120000, 230400, false);
    const { amount0, amount1 } = positionAmounts(L, sqrtAt(230400), 120000, 230400);
    expect(amount1 / 1e18).toBeCloseTo(100e9, -3);
    expect(amount0).toBe(0);
  });
});

describe('interpretSwap (v4 deltas are swapper-signed)', () => {
  it('coin is currency0: receiving coin = buy', () => {
    expect(interpretSwap(1000n, -5n, true)).toEqual({ side: 'buy', amountToken: 1000n, amountPaired: 5n });
    expect(interpretSwap(-1000n, 5n, true)).toEqual({ side: 'sell', amountToken: 1000n, amountPaired: 5n });
  });
  it('coin is currency1', () => {
    expect(interpretSwap(-5n, 1000n, false)).toEqual({ side: 'buy', amountToken: 1000n, amountPaired: 5n });
    expect(interpretSwap(5n, -1000n, false)).toEqual({ side: 'sell', amountToken: 1000n, amountPaired: 5n });
  });
});

describe('units', () => {
  it('converts base units and rounds USD to 6 dp', () => {
    expect(toUnits(1_500_000n, 6)).toBe(1.5);
    expect(toUnits(-(10n ** 18n), 18)).toBe(-1);
    expect(toUnits(123456789012345678901234n, 18)).toBeCloseTo(123456.78901234567, 9);
    expect(usd(1.23456789)).toBe(1.234568);
    expect(usd(Number.NaN)).toBe(0);
    expect(unitPrice(2.349720907123e-7)).toBe(2.34972090712e-7);
    expect(usd(2.35e-7)).toBe(0);
  });
});

describe('a Clanker pool with the coin as currency1 ($BOOTR, 2026-11-04)', () => {
  // Pool state read from the indexer on 2026-11-04 (`PoolManager.Swap` liquidity 1.007e24, price tick 211449).
  const sqrtPriceX96 = 3091769184186775186558952405292365n;
  const poolLiquidity = 1007143810120425777431872n;
  const supply = 10n ** 29n;
  const ethUsd = 2411;

  it('derives the launch liquidity from the mirrored range, matching the pool', () => {
    const L = oneSidedLiquidity(supply, 120000, 230400, false);
    expect(Number(L) / Number(poolLiquidity)).toBeCloseTo(1, 1);
    // The unmirrored (Clanker-frame) range had given 4e31.
    expect(Number(oneSidedLiquidity(supply, -230400, -120000, false))).toBeGreaterThan(1e31);
  });

  it('values the liquidity near the deposited WETH plus the remaining coins, not in the trillions', () => {
    const value = liquidityUsd({ liquidity: poolLiquidity, sqrtPriceX96, tickLower: 120000, tickUpper: 230400, coinIsToken0: false, ethUsd });
    expect(value).toBeGreaterThan(50_000);
    expect(value).toBeLessThan(200_000);
  });
});
