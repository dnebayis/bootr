/**
 * The trade panel in mock mode (no chain): figures shaped like the live ones, from the fixture's own price and liquidity.
 * A coin launched seconds ago behaves like a new Clanker coin on a Base fork at 200 ms blocks: no swaps for half a second,
 * then a fee from about 71% that falls with the clock to normal at 16 seconds.
 */
import { parseEther, parseUnits } from 'viem';
import { traderPaysPct, feeModelOf } from '../fee-split';
import { pairedAssetByAddress } from '../token-settings';
import type { Token } from '../types';
import type { SwapSide } from './core';
import { SwapFailure } from './errors';
import type { SwapQuote } from './quote';

export const MOCK_ETH_BALANCE = parseEther('1');
export const MOCK_COIN_BALANCE = parseEther('1000000');
/** A USDC-paired coin's buyer holds 1,000 USDC in mock mode. */
export const MOCK_PAIRED_BALANCE = parseUnits('1000', 6);
const ETH_USD = 3000;

export function mockQuote(token: Pick<Token, 'priceUsd' | 'liquidityUsd' | 'launchedAt' | 'source' | 'lpFeeBps' | 'pairedToken' | 'v5Settings'>, side: SwapSide, amountIn: bigint): SwapQuote {
  const now = Date.now() / 1000;
  const clanker = token.source === 'clanker';
  const age = now - token.launchedAt;
  const launchWindow = clanker ? { armed: age < 120, startedAt: token.launchedAt, endsAt: token.launchedAt + 120 } : null;
  if (clanker && age < 0.6) throw new SwapFailure('launch_window');

  // A v5 coin with settings may tax buys and sells differently.
  const v5 = token.v5Settings;
  const normalFee = v5 ? (side === 'buy' ? v5.buyTaxBps : v5.sellTaxBps) / 10_000 : traderPaysPct(feeModelOf(token));
  // The paired side: ETH (18 decimals, $3,000 here) or a USDC pool's dollar (6 decimals).
  const paired = pairedAssetByAddress(token.pairedToken);
  const pairedUsd = paired?.stableUsd ?? ETH_USD;
  const pairedDecimals = paired?.decimals ?? 18;
  const feePct = clanker && age < 16 ? Math.max(normalFee, 5 + 66 * ((15 - Math.floor(age)) / 15) ** 2) : normalFee;

  const priceEth = (token.priceUsd || 0.0001) / pairedUsd;
  const amount = Number(amountIn) / 10 ** (side === 'buy' ? pairedDecimals : 18);
  const valueUsd = side === 'buy' ? amount * pairedUsd : amount * (token.priceUsd || 0.0001);
  const impactPct = (valueUsd / Math.max(token.liquidityUsd || 1000, 1000)) * 100;
  if (impactPct >= 50) throw new SwapFailure('no_liquidity');

  const after = (1 - feePct / 100) * (1 - impactPct / 100);
  const out = side === 'buy' ? (amount / priceEth) * after : amount * priceEth * after;
  const feeEth = side === 'buy' ? amount * (feePct / 100) : amount * priceEth * (feePct / 100);
  return {
    side,
    amountIn,
    amountOut: side === 'buy' ? parseEther(out.toFixed(18)) : parseUnits(out.toFixed(pairedDecimals), pairedDecimals),
    feePct,
    feeEth: parseUnits(feeEth.toFixed(pairedDecimals), pairedDecimals),
    impactPct,
    launchWindow,
  };
}
