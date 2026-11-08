import { and, eq, sql } from 'drizzle-orm';
import type { SenderContext } from './context.js';
import { reads } from './db/schema.js';

/**
 * The X read budget: how many read units (posts returned, account lookups) one agent may spend per UTC day, across
 * every kind the metering records (`sender_reads`). X bills the app's owner per post read, and one agent's tools
 * (`read_x_thread` up to 8 posts, `read_x_account`, mention pages of up to 100) could run that bill up on their own,
 * so an agent past its budget is refused with a clear answer until the day rolls over. `SENDER_DEFAULT_READS_PER_DAY`
 * sets it; 0 turns it off.
 */

export const READ_BUDGET_EXHAUSTED = 'read_budget_exhausted';

export type ReadBudgetFail = { ok: false; status: 429; error: typeof READ_BUDGET_EXHAUSTED; message: string; retryAt: number };

export interface ReadBudget {
  /** Units per UTC day; 0 = no budget. */
  limit: number;
  used: number;
  /** Infinity when the budget is off. */
  remaining: number;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Start of the next UTC day: the metering day rolls over there, and with it the budget. */
export function nextUtcMidnight(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

/** Read units metered today (UTC) for the agent, every kind together. */
export async function readsToday(ctx: SenderContext, agentId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`coalesce(sum(${reads.count}), 0)::int` })
    .from(reads)
    .where(and(eq(reads.agentId, agentId), eq(reads.day, utcDay(ctx.now()))));
  return Number(row?.n ?? 0);
}

export async function readBudget(ctx: SenderContext, agentId: string): Promise<ReadBudget> {
  const limit = ctx.defaults.readsPerDay;
  if (limit <= 0) return { limit: 0, used: 0, remaining: Number.POSITIVE_INFINITY };
  const used = await readsToday(ctx, agentId);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

export function budgetExhausted(ctx: SenderContext, budget: ReadBudget): ReadBudgetFail {
  const retryAt = nextUtcMidnight(ctx.now());
  return {
    ok: false,
    status: 429,
    error: READ_BUDGET_EXHAUSTED,
    message: `This agent's X reads for today are used up (${budget.used} of ${budget.limit} posts and lookups). Reads open again at ${new Date(retryAt).toISOString()}.`,
    retryAt,
  };
}

/** Null when at least `units` reads are left today, else the refusal to answer with. */
export async function requireReads(ctx: SenderContext, agentId: string, units = 1): Promise<ReadBudgetFail | null> {
  const budget = await readBudget(ctx, agentId);
  return budget.remaining >= units ? null : budgetExhausted(ctx, budget);
}

/** X's `max_results` (5 to 100), fitted to `wanted` and to what is left of the budget. */
export function maxResultsWithin(remaining: number, wanted = 100): number {
  return Math.max(5, Math.min(100, wanted, Number.isFinite(remaining) ? remaining : 100));
}
