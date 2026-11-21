/**
 * The paired asset (quote) of a coin's pool and how the indexer prices it. WETH (bootr and clanker v4 pools) and native
 * ETH (`address(0)`, Clanker v5) are valued at ETH/USD with 18 decimals; USDC (Clanker v5 coins launched with token
 * settings, docs/design/clanker-v5-token-settings.md section 3) at one dollar with 6 decimals. Anything else gets
 * symbol `?` and no USD value: the agent launch kind only allows ETH and USDC, and a plain-token path with other quotes
 * is not built.
 */
import { coinPriceInQuote, liquidityUsd, toUnits, unitPrice, usd } from './price';

export type QuoteSymbol = 'WETH' | 'ETH' | 'USDC' | '?';
export type QuoteAsset = { symbol: QuoteSymbol; decimals: number };

const NATIVE = '0x0000000000000000000000000000000000000000';

export function quoteAsset(paired: string, a: { weth: string; usdc: string }): QuoteAsset {
  const p = paired.toLowerCase();
  if (p === NATIVE) return { symbol: 'ETH', decimals: 18 };
  if (p === a.weth.toLowerCase()) return { symbol: 'WETH', decimals: 18 };
  if (p === a.usdc.toLowerCase()) return { symbol: 'USDC', decimals: 6 };
  return { symbol: '?', decimals: 18 };
}

/** USD per whole unit of a coin's paired asset: ETH/USD for WETH and ETH, 1 for USDC, 0 when unknown. */
export function quoteUsd(pairedSymbol: string, ethUsd: number): number {
  if (pairedSymbol === 'WETH' || pairedSymbol === 'ETH') return ethUsd;
  if (pairedSymbol === 'USDC') return 1;
  return 0;
}

/** USD value of `amount` base units of a coin's paired asset (a trade's paired side). */
export function quoteValueUsd(t: { pairedSymbol: string; pairedDecimals: number }, amount: bigint, ethUsd: number): number {
  return usd(toUnits(amount, t.pairedDecimals) * quoteUsd(t.pairedSymbol, ethUsd));
}

export type MarketInput = {
  sqrtPriceX96: bigint;
  coinIsToken0: boolean;
  totalSupply: bigint;
  /** Coins at 0x…dEaD (`token.deadBalance`): out of circulation, so not in the market cap. */
  deadBalance: bigint;
  positionLiquidity: bigint;
  poolLiquidity: bigint;
  tickLower: number;
  tickUpper: number;
  pairedSymbol: string;
  pairedDecimals: number;
};

/**
 * Market cap: price × the supply less the coins at 0x…dEaD, as DEX Screener and the other aggregators count it
 * ($BOOTR: 3.29B of its 100B sit there). Every launched coin has a fixed supply and every burn path (BuybackBurner,
 * Clanker's burn slot and v5 burn share, anyone's own transfer) sends coins there rather than burning them.
 */
export function marketCapUsd(priceUsd: number, t: Pick<MarketInput, 'totalSupply' | 'deadBalance'>): number {
  const circulating = t.totalSupply > t.deadBalance ? t.totalSupply - t.deadBalance : 0n;
  return usd(priceUsd * toUnits(circulating, 18));
}

/**
 * Price-derived fields of a coin from its pool state, in its paired asset: `priceQuote` (whole quote units per coin),
 * `priceUsd` (at ETH/USD or $1), `priceWeth` (the price in ETH for every coin: equal to `priceQuote` on WETH / ETH
 * pools, `priceUsd / ethUsd` on USDC pools), market cap (`marketCapUsd`) and the locked position's liquidity in USD.
 */
export function marketFields(t: MarketInput, ethUsd: number) {
  const priceQuote = coinPriceInQuote(t.sqrtPriceX96, t.coinIsToken0, t.pairedDecimals);
  const perQuote = quoteUsd(t.pairedSymbol, ethUsd);
  const priceUsd = unitPrice(priceQuote * perQuote);
  const isEth = t.pairedSymbol === 'WETH' || t.pairedSymbol === 'ETH';
  const priceWeth = isEth ? priceQuote : ethUsd > 0 ? unitPrice(priceUsd / ethUsd) : 0;
  return {
    priceWeth,
    priceQuote,
    priceUsd,
    marketCapUsd: marketCapUsd(priceUsd, t),
    liquidityUsd: liquidityUsd({
      // The locked position; active liquidity is 0 while the price sits on the range edge.
      liquidity: t.positionLiquidity > t.poolLiquidity ? t.positionLiquidity : t.poolLiquidity,
      sqrtPriceX96: t.sqrtPriceX96,
      // The token's own position range (Clanker pools are not the RWAGMI launch range).
      tickLower: t.tickLower,
      tickUpper: t.tickUpper,
      coinIsToken0: t.coinIsToken0,
      ethUsd: perQuote,
      quoteDecimals: t.pairedDecimals,
    }),
  };
}
