/**
 * Price math. Every Bootr coin has 18 decimals; the paired asset is WETH or native ETH (18 decimals, no adjustment) or,
 * for Clanker v5 coins launched with token settings, USDC (6 decimals: the raw pool price is scaled by 10^(18-6)).
 * Results are floats (USD values are display-grade, 6 dp).
 */
const Q96 = 2 ** 96;
/** Decimals of every Bootr coin (B20, Clanker v4 and v5 tokens alike). */
export const COIN_DECIMALS = 18;

/** Integer base units -> float. */
export function toUnits(amount: bigint, decimals: number): number {
  if (amount === 0n) return 0;
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const v = Number(whole) + Number(frac) / Number(base);
  return neg ? -v : v;
}

/** Round to 6 decimals (the contract's float precision for `*Usd`). */
export function usd(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Unit prices keep 12 significant digits instead of 6 dp: a fresh Bootr coin trades around
 * 1e-7 USD, which `usd()` would round to 0.
 */
export function unitPrice(v: number): number {
  if (!Number.isFinite(v) || v === 0) return 0;
  return Number(v.toPrecision(12));
}

/** price of currency0 denominated in currency1 = (sqrtPriceX96 / 2^96)^2. */
export function price0In1(sqrtPriceX96: bigint): number {
  const s = Number(sqrtPriceX96) / Q96;
  return s * s;
}

/** WETH per coin, from the pool's sqrtPriceX96. */
export function coinPriceInWeth(sqrtPriceX96: bigint, coinIsToken0: boolean): number {
  return coinPriceInQuote(sqrtPriceX96, coinIsToken0, 18);
}

/**
 * Whole units of the paired asset per whole coin, from the pool's sqrtPriceX96: the raw price (quote base units per
 * coin base unit) times 10^(coin decimals − quote decimals). 1e12 for USDC, 1 for WETH / ETH.
 */
export function coinPriceInQuote(sqrtPriceX96: bigint, coinIsToken0: boolean, quoteDecimals: number): number {
  if (sqrtPriceX96 === 0n) return 0;
  const p = price0In1(sqrtPriceX96);
  const raw = coinIsToken0 ? p : p === 0 ? 0 : 1 / p;
  return quoteDecimals === COIN_DECIMALS ? raw : raw * 10 ** (COIN_DECIMALS - quoteDecimals);
}

export function sqrtRatioAtTick(tick: number): number {
  return Math.sqrt(1.0001 ** tick);
}

/**
 * Token amounts (base units, float) held by a position with liquidity `liquidity` in
 * [tickLower, tickUpper] at the current sqrt price (standard v3/v4 LiquidityAmounts math).
 */
export function positionAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
): { amount0: number; amount1: number } {
  const L = Number(liquidity);
  if (L === 0 || sqrtPriceX96 === 0n) return { amount0: 0, amount1: 0 };
  const sp = Number(sqrtPriceX96) / Q96;
  const sa = sqrtRatioAtTick(tickLower);
  const sb = sqrtRatioAtTick(tickUpper);
  if (sp <= sa) return { amount0: (L * (sb - sa)) / (sa * sb), amount1: 0 };
  if (sp >= sb) return { amount0: 0, amount1: L * (sb - sa) };
  return { amount0: (L * (sb - sp)) / (sp * sb), amount1: L * (sp - sa) };
}

/**
 * Liquidity of the single launch LP position, from the coin amount deposited one-sided at launch
 * (`poolSupply`, base units). The locked position never changes, so this is computed once.
 * Coin = currency0: the range sits above the start price (all currency0). Coin = currency1: the
 * range sits below it (all currency1).
 */
export function oneSidedLiquidity(poolSupply: bigint, tickLower: number, tickUpper: number, coinIsToken0: boolean): bigint {
  const sa = sqrtRatioAtTick(tickLower);
  const sb = sqrtRatioAtTick(tickUpper);
  const amount = Number(poolSupply);
  const L = coinIsToken0 ? (amount * sa * sb) / (sb - sa) : amount / (sb - sa);
  return BigInt(Math.floor(L));
}

/**
 * USD value of the pool's liquidity (coin side valued at the pool price). `ethUsd` is the USD price of one whole unit
 * of the paired asset (ETH/USD for WETH / ETH, 1 for USDC) and `quoteDecimals` its decimals (18 unless given).
 */
export function liquidityUsd(args: {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  coinIsToken0: boolean;
  ethUsd: number;
  quoteDecimals?: number;
}): number {
  const quoteDecimals = args.quoteDecimals ?? 18;
  const { amount0, amount1 } = positionAmounts(args.liquidity, args.sqrtPriceX96, args.tickLower, args.tickUpper);
  const coinAmount = (args.coinIsToken0 ? amount0 : amount1) / 10 ** COIN_DECIMALS;
  const quoteAmount = (args.coinIsToken0 ? amount1 : amount0) / 10 ** quoteDecimals;
  const coinPriceUsd = coinPriceInQuote(args.sqrtPriceX96, args.coinIsToken0, quoteDecimals) * args.ethUsd;
  return usd(quoteAmount * args.ethUsd + coinAmount * coinPriceUsd);
}

/** Chainlink answer -> float USD. */
export function chainlinkToUsd(answer: bigint, decimals: number): number {
  return toUnits(answer, decimals);
}

export type SwapView = {
  side: 'buy' | 'sell';
  amountToken: bigint;
  amountPaired: bigint;
};

/**
 * Interpret v4 `Swap` deltas. They are from the swapper's point of view: negative = paid into
 * the pool, positive = received. A buy is the swapper receiving the coin.
 */
export function interpretSwap(amount0: bigint, amount1: bigint, coinIsToken0: boolean): SwapView {
  const coinDelta = coinIsToken0 ? amount0 : amount1;
  const pairedDelta = coinIsToken0 ? amount1 : amount0;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  return {
    side: coinDelta > 0n ? 'buy' : 'sell',
    amountToken: abs(coinDelta),
    amountPaired: abs(pairedDelta),
  };
}
