/** What the trade panel shows and accepts, as plain functions. */
import { formatUnits, parseUnits } from 'viem';
import { MAX_SLIPPAGE_BPS } from './core';

/** Every Bootr coin has 18 decimals on both launch paths, like ETH. */
export const COIN_DECIMALS = 18;
/** "Max" on a buy leaves this much ETH for the network fee. */
export const GAS_RESERVE_WEI = 500_000_000_000_000n;
/** A fee this far above the coin's normal one is Clanker's launch fee. Measured fees sit within 0.02 of normal. */
export const LAUNCH_FEE_MARGIN_PCT = 0.5;

/** Text the user typed as base units; null for anything that is not a positive amount a swap can carry. */
export function parseAmount(text: string): bigint | null {
  const s = text.trim();
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const fraction = s.split('.')[1] ?? '';
  if (fraction.length > COIN_DECIMALS) return null;
  const value = parseUnits(s, COIN_DECIMALS);
  return value > 0n && value < 1n << 128n ? value : null;
}

/** An amount for reading, not for arithmetic: 28.64M, 1,234.5, 0.0071479. */
export function formatAmount(raw: bigint): string {
  const n = Number(formatUnits(raw, COIN_DECIMALS));
  if (n === 0) return '0';
  if (n >= 1_000_000) return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumSignificantDigits: 5, maximumFractionDigits: COIN_DECIMALS });
}

/** A user's own amount as an input value, in full: no rounding, no separators. */
export function amountInput(raw: bigint): string {
  return formatUnits(raw, COIN_DECIMALS);
}

/** Basis points from a percent the user typed; null outside 0.01% to the maximum. */
export function parseSlippage(text: string): number | null {
  const s = text.trim();
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps >= 1 && bps <= MAX_SLIPPAGE_BPS ? bps : null;
}

/**
 * The fee to show: the coin's normal one unless the fee measured on the pool is clearly above it, which is Clanker's
 * launch fee. The measured figure sits a hair under the normal one when a tiny swap rounds (1.1977% for 1.2%), and that
 * would only confuse.
 */
export function feeFigure(measured: number | null, normal: number): { pct: number; raised: boolean } {
  if (measured === null || measured <= normal + LAUNCH_FEE_MARGIN_PCT) return { pct: normal, raised: false };
  return { pct: measured, raised: true };
}

export function percent(value: number): string {
  return `${value < 0.01 && value > 0 ? '<0.01' : value.toFixed(2)}%`;
}
