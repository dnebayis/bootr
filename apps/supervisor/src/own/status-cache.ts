/**
 * Own agents: the two parts of `run/status` that cost a call elsewhere, kept for half a minute per agent. The X quota
 * is a request to the sender and the treasury several reads on the chain; a client may ask for its status 120 times a
 * minute, and each of those used to be passed on. What is left of today's posts and fuel is therefore up to
 * `STATUS_CACHE_MS` old in a status; every limit is still enforced where it always was, on the call that spends it.
 *
 * A part that could not be read is not kept, so the next status asks again. One table per context (a process has one;
 * a test world has its own).
 */
import type { AgentRow, SupervisorContext } from '../context.js';
import { readTreasuryOnChain } from '../treasury.js';

export const STATUS_CACHE_MS = 30_000;
const MAX_AGENTS = 2_000;

type Quota = Awaited<ReturnType<SupervisorContext['sender']['quota']>>;
type Treasury = Awaited<ReturnType<typeof readTreasuryOnChain>>;
type Kept<T> = { at: number; value: T };
type Entry = { quota?: Kept<Quota>; treasury?: Kept<Treasury> };

const tables = new WeakMap<object, Map<string, Entry>>();

function tableOf(ctx: SupervisorContext): Map<string, Entry> {
  let table = tables.get(ctx.db);
  if (!table) tables.set(ctx.db, (table = new Map()));
  return table;
}

/** The agent's X quota and treasury for a status: read at most once per `STATUS_CACHE_MS` each, null when unreadable. */
export async function statusReads(ctx: SupervisorContext, agent: AgentRow): Promise<{ quota: Quota | null; treasury: Treasury | null }> {
  const table = tableOf(ctx);
  const now = ctx.now();
  const fresh = <T>(kept: Kept<T> | undefined): kept is Kept<T> => !!kept && now - kept.at < STATUS_CACHE_MS && now >= kept.at;
  let entry = table.get(agent.agentId);
  if (!entry) {
    if (table.size >= MAX_AGENTS) for (const [id, e] of table) if (!fresh(e.quota) && !fresh(e.treasury)) table.delete(id);
    if (table.size >= MAX_AGENTS) table.clear();
    table.set(agent.agentId, (entry = {}));
  }
  if (!fresh(entry.quota)) {
    const quota = await ctx.sender.quota(agent.agentId).catch(() => null);
    if (quota) entry.quota = { at: now, value: quota };
    else delete entry.quota;
  }
  if (!fresh(entry.treasury)) {
    const treasury = await readTreasuryOnChain(ctx, agent).catch(() => null);
    if (treasury) entry.treasury = { at: now, value: treasury };
    else delete entry.treasury;
  }
  return { quota: entry.quota?.value ?? null, treasury: entry.treasury?.value ?? null };
}

/** Drops what is kept for an agent, after something changed it here (its X read budget was rewritten). */
export function forgetStatusReads(ctx: SupervisorContext, agentId: string): void {
  tables.get(ctx.db)?.delete(agentId);
}
