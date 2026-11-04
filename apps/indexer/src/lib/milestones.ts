/**
 * Once-only coin milestones (schema `milestone`): the first trade after the launch transaction, holder
 * counts reached and rolling 24 h volume reached. Each (token, kind, value) is written the first time it
 * happens and never again (`recordMilestones` in market.ts), so the platform feed can say "reached 100
 * holders" with a date, once. Pure helpers only here (no Ponder imports), so they are unit-testable.
 */
import type { Hex } from 'viem';

export const HOLDER_MILESTONES = [25, 100, 500, 1000] as const;
export const VOLUME_24H_MILESTONES_USD = [1_000, 10_000] as const;

export type MilestoneKind = 'first_swap' | 'holders' | 'volume24h';
export type MilestoneEvent = { kind: MilestoneKind; value: number };

export const milestoneId = (token: string, kind: MilestoneKind, value: number) => `${token}-${kind}-${value}`;

/** Thresholds passed when a figure moves from `prev` to `next` (strictly below before, at or above after). */
export function crossed(prev: number, next: number, thresholds: readonly number[]): number[] {
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return [];
  return thresholds.filter((t) => prev < t && next >= t);
}

/** Milestones of a swap: `first_swap` for any trade outside the launch tx (deduped by id), 24 h volume thresholds passed. */
export function swapMilestones(args: { txHash: Hex; launchTx: Hex; prevVolume24hUsd: number; nextVolume24hUsd: number }): MilestoneEvent[] {
  const out: MilestoneEvent[] = [];
  if (args.txHash.toLowerCase() !== args.launchTx.toLowerCase()) out.push({ kind: 'first_swap', value: 0 });
  for (const value of crossed(args.prevVolume24hUsd, args.nextVolume24hUsd, VOLUME_24H_MILESTONES_USD)) out.push({ kind: 'volume24h', value });
  return out;
}

export function holderMilestones(prevHolders: number, nextHolders: number): MilestoneEvent[] {
  return crossed(prevHolders, nextHolders, HOLDER_MILESTONES).map((value) => ({ kind: 'holders', value }));
}
