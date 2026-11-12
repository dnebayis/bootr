/**
 * Own agents (docs/design/byo-agent.md section 7): the X read budget that goes with who runs the coin. A hosted coin
 * without fuel sleeps and reads nothing; an own coin thinks for free, so nothing but the sender's daily read budget
 * bounds what its reads cost Bootr. An own coin therefore starts on a smaller budget (`OWN_READS_PER_DAY`), written to
 * the sender's per-agent quota; a hosted coin is returned to the sender's default.
 */
import type { Runner } from '@bootr/shared/own-agent';
import type { SupervisorContext } from '../context.js';
import { ownSetting } from './registry.js';

/** What the sender's `readsPerDay` should be for a coin run this way: the own budget, or null for the sender's default. */
export function runnerReadsPerDay(ctx: Pick<SupervisorContext, 'config'>, runner: Runner): number | null {
  const own = Math.floor(ownSetting(ctx, 'OWN_READS_PER_DAY'));
  return runner === 'own' && own >= 1 ? own : null;
}

/**
 * Sets the sender's X read budget for the runner in force. A sender that does not answer is logged and not thrown: the
 * switch or the registration that called this stands, and `ownStatus` (own/turns.ts) applies the budget again the next
 * time a client asks for its status and the sender reports another value.
 */
export async function applyRunnerQuota(ctx: Pick<SupervisorContext, 'config' | 'sender' | 'log'>, agentId: string, runner: Runner): Promise<void> {
  const readsPerDay = runnerReadsPerDay(ctx, runner);
  try {
    await ctx.sender.setQuota(agentId, { readsPerDay });
    ctx.log.info({ agentId, runner, readsPerDay }, 'own agent: X read budget set at the sender');
  } catch (err) {
    ctx.log.warn({ agentId, runner, err: err instanceof Error ? err.message : String(err) }, 'own agent: the sender did not take the X read budget; it is applied again on the next status call');
  }
}
