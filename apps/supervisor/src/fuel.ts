/**
 * `fuel`: what the agent can still spend on thinking, for the first observation of a turn. The balances come from the
 * treasury snapshot the tick already read, the cost from the agent's latest paid thoughts (one database read, no RPC).
 * Omitted when there is no snapshot or the read fails: it never breaks a turn. Private, like the rest of the treasury.
 */
import { averageThoughtCost, fuelIsLow, thoughtsLeft } from '@bootr/shared/fuel';
import type { SupervisorContext } from './context.js';
import { recentThoughtCost } from './inference.js';
import type { TreasurySnapshot } from './treasury.js';

export interface FuelView {
  meaning: string;
  /** USDC that pays for thoughts now (the spender's float). */
  spendableUsdc: string;
  /** USDC in the treasury that tops the spendable amount up. */
  reserveUsdc: string;
  /** Absent while there are too few paid thoughts to tell. */
  avgThoughtUsdc?: string;
  thoughtsLeft?: number;
  low: boolean;
}

const MEANING = 'what you can still spend on thinking; thoughtsLeft is an estimate from what your recent thoughts cost. Private: never post about it.';

export function fuelView(usd: Pick<TreasurySnapshot['usd'], 'spenderUsdc' | 'usdc'>, cost: { thoughts: number; spentMicroUsdc: number }): FuelView {
  const spendable = Math.round(usd.spenderUsdc * 1e6);
  const average = averageThoughtCost(cost.spentMicroUsdc, cost.thoughts);
  const left = thoughtsLeft(spendable, average);
  return {
    meaning: MEANING,
    spendableUsdc: usd.spenderUsdc.toFixed(2),
    reserveUsdc: usd.usdc.toFixed(2),
    ...(average !== null && left !== null ? { avgThoughtUsdc: (average / 1e6).toFixed(4), thoughtsLeft: left } : {}),
    low: fuelIsLow(spendable, left),
  };
}

/** The observation section, or `{}` without a treasury snapshot or when the cost cannot be read. */
export async function fuelSection(ctx: Pick<SupervisorContext, 'db' | 'log'>, agentId: string, treasury: Pick<TreasurySnapshot, 'usd'> | null): Promise<Record<string, unknown>> {
  if (!treasury) return {};
  try {
    return { fuel: fuelView(treasury.usd, await recentThoughtCost(ctx, agentId)) };
  } catch (err) {
    ctx.log.warn({ agentId, err }, 'fuel read failed; turn goes on without the section');
    return {};
  }
}
