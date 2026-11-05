/**
 * Fuel arithmetic, shared by the supervisor (the `fuel` section of a turn's observation) and the web (the creator
 * console's runway line). Amounts are micro-USDC as plain numbers. Every estimate answers `null` when the data is too
 * thin to say anything: callers then say nothing rather than guess.
 */

/** Fewer paid thoughts than this is too little to estimate a cost per thought or a rate from. */
export const MIN_FUEL_SAMPLE = 10;
/** A rate needs at least this much history behind it; one busy first turn says nothing about a day. */
export const MIN_RUNWAY_HISTORY_MS = 6 * 60 * 60 * 1000;
/** Below this many thoughts fuel counts as low: three full turns at the default cap of eight steps. */
export const LOW_FUEL_THOUGHTS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Average micro-USDC per paid thought, or null with too few thoughts or no recorded charges. */
export function averageThoughtCost(spentMicroUsdc: number, thoughts: number): number | null {
  if (!Number.isFinite(spentMicroUsdc) || spentMicroUsdc <= 0 || !Number.isFinite(thoughts) || thoughts < MIN_FUEL_SAMPLE) return null;
  return spentMicroUsdc / thoughts;
}

/** Whole thoughts `spendableMicroUsdc` still pays for at `averageCost`; null when the cost is unknown, 0 for an empty wallet. */
export function thoughtsLeft(spendableMicroUsdc: number, averageCost: number | null): number | null {
  if (averageCost === null || !Number.isFinite(averageCost) || averageCost <= 0) return null;
  return Math.max(0, Math.floor(Math.max(0, spendableMicroUsdc) / averageCost));
}

/** Low when the estimate is under `LOW_FUEL_THOUGHTS`; without an estimate, only an empty wallet is known to be low. */
export function fuelIsLow(spendableMicroUsdc: number, left: number | null): boolean {
  return left === null ? spendableMicroUsdc <= 0 : left < LOW_FUEL_THOUGHTS;
}

/**
 * Days `fuelMicroUsdc` lasts at the rate of `spentMicroUsdc` over `historyMs`. Null with too few thoughts, too little
 * history or nothing spent (no rate); 0 for an empty wallet with a known rate.
 */
export function runwayDays(fuelMicroUsdc: number, spentMicroUsdc: number, thoughts: number, historyMs: number): number | null {
  if (averageThoughtCost(spentMicroUsdc, thoughts) === null) return null;
  if (!Number.isFinite(historyMs) || historyMs < MIN_RUNWAY_HISTORY_MS) return null;
  const perDay = spentMicroUsdc / (historyMs / DAY_MS);
  return Math.max(0, fuelMicroUsdc) / perDay;
}
