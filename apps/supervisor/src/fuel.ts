/**
 * `fuel`: what the agent can still spend on thinking, for the first observation of a turn. The balances come from the
 * treasury snapshot the tick already read, the cost from the agent's latest paid thoughts (one database read, no RPC).
 * Omitted when there is no snapshot or the read fails: it never breaks a turn. Private, like the rest of the treasury.
 *
 * A picture costs more than a thought, so it is held to the fuel too: `pictureFits` says whether one leaves the
 * agent at least `LOW_FUEL_THOUGHTS` thoughts behind (the observation's `picture.affordable`, images.ts before the
 * paid call), and `pictureFuelCheck` reads the spender for that decision at the moment of the call.
 */
import { averageThoughtCost, fuelIsLow, LOW_FUEL_THOUGHTS, thoughtsLeft } from '@bootr/shared/fuel';
import { erc20Abi, type Address } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
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

/** Below this much fuel in all (treasury USDC plus the spendable float) the agent sleeps: no thoughts until it is refuelled. */
export const SLEEP_USDC = 1;

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

/**
 * Whether a picture at `pictureMicroUsdc` fits the fuel: what is left after it must still pay for `LOW_FUEL_THOUGHTS`
 * thoughts at the average cost, so a picture never starves the agent of thinking. Without a cost estimate (too few
 * paid thoughts) the picture must leave at least SLEEP_USDC behind, the amount under which the agent sleeps.
 */
export function pictureFits(spendableMicroUsdc: number, averageThoughtMicroUsdc: number | null, pictureMicroUsdc: number): boolean {
  const after = spendableMicroUsdc - pictureMicroUsdc;
  if (after < 0) return false;
  const floor = averageThoughtMicroUsdc !== null && averageThoughtMicroUsdc > 0 ? LOW_FUEL_THOUGHTS * averageThoughtMicroUsdc : SLEEP_USDC * 1e6;
  return after >= floor;
}

export type PictureFuelCheck = { ok: true; spendableMicroUsdc: number | null } | { ok: false; error: string };

/**
 * The fuel check images.ts runs before paying for a picture: the spender's USDC now (one balance read; when the chain
 * does not answer the picture is allowed, the relay's own payment check still stands) against the price and the
 * agent's average thought. The refusal names the amounts in USDC so the model can tell its creator what is missing.
 */
export async function pictureFuelCheck(ctx: Pick<SupervisorContext, 'db' | 'chain' | 'spenderFor' | 'log'>, agent: AgentRow, pictureMicroUsdc: number): Promise<PictureFuelCheck> {
  let spendable: number;
  try {
    const spender = ctx.spenderFor(agent).address as Address;
    const balance = await ctx.chain.publicClient.readContract({ address: ctx.chain.addresses.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [spender] });
    spendable = Number(balance);
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err }, 'spender balance read failed; the picture goes to the relay, whose payment check stands');
    return { ok: true, spendableMicroUsdc: null };
  }
  const cost = await recentThoughtCost(ctx, agent.agentId);
  const average = averageThoughtCost(cost.spentMicroUsdc, cost.thoughts);
  if (pictureFits(spendable, average, pictureMicroUsdc)) return { ok: true, spendableMicroUsdc: spendable };
  const left = average !== null ? `${LOW_FUEL_THOUGHTS} thoughts at about ${(average / 1e6).toFixed(3)} USDC each` : `${SLEEP_USDC} USDC`;
  return { ok: false, error: `image_fuel_low: a picture costs about ${(pictureMicroUsdc / 1e6).toFixed(3)} USDC and your spendable fuel is ${(spendable / 1e6).toFixed(2)} USDC; a picture must leave ${left} behind. Post without a picture.` };
}
