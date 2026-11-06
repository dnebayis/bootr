/**
 * The trade panel in mock mode (no chain): figures shaped like the live ones, from the fixture's own price and liquidity.
 * A coin launched seconds ago behaves like a new Clanker coin on a Base fork at 200 ms blocks: no swaps for half a second,
 * then a fee from about 71% that falls with the clock to normal at 16 seconds.
 */
import { parseEther } from 'viem';
import { traderPaysPct, feeModelOf } from '../fee-split';
import type { Token } from '../types';
import type { SwapSide } from './core';
import { SwapFailure } from './errors';
import type { SwapQuote } from './quote';

export const MOCK_ETH_BALANCE = parseEther('1');
export const MOCK_COIN_BALANCE = parseEther('1000000');
const ETH_USD = 3000;

export function mockQuote(token: Pick<Token, 'priceUsd' | 'liquidityUsd' | 'launchedAt' | 'source' | 'lpFeeBps'>, side: SwapSide, amountIn: bigint): SwapQuote {
  const now = Date.now() / 1000;
  const clanker = token.source === 'clanker';
  const age = now - token.launchedAt;
  const launchWindow = clanker ? { armed: age < 120, startedAt: token.launchedAt, endsAt: token.launchedAt + 120 } : null;
  if (clanker && age < 0.6) throw new SwapFailure('launch_window');

  const normalFee = traderPaysPct(feeModelOf(token));
  const feePct = clanker && age < 16 ? Math.max(normalFee, 5 + 66 * ((15 - Math.floor(age)) / 15) ** 2) : normalFee;

  const priceEth = (token.priceUsd || 0.0001) / ETH_USD;
  const amount = Number(amountIn) / 1e18;
  const valueUsd = side === 'buy' ? amount * ETH_USD : amount * (token.priceUsd || 0.0001);
  const impactPct = (valueUsd / Math.max(token.liquidityUsd || 1000, 1000)) * 100;
  if (impactPct >= 50) throw new SwapFailure('no_liquidity');

  const after = (1 - feePct / 100) * (1 - impactPct / 100);
  const out = side === 'buy' ? (amount / priceEth) * after : amount * priceEth * after;
  const feeEth = side === 'buy' ? amount * (feePct / 100) : amount * priceEth * (feePct / 100);
  return {
    side,
    amountIn,
    amountOut: parseEther(out.toFixed(18)),
    feePct,
    feeEth: parseEther(feeEth.toFixed(18)),
    impactPct,
    launchWindow,
  };
}
