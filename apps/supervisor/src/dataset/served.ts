/**
 * Which records an agent was handed (`sv_records_served`, migration 0018; docs/design/agent-behaviour.md stage 5). The
 * supervisor writes a row when a turn's first observation carries a record (records-turn.ts); the dataset process
 * never touches the table. Four things read it:
 *
 *  - a post's citation. `publish_post {record}` names ids, and an id is only a citation when this agent was shown that
 *    record: otherwise any client could mark any record as posted, or point at numbers it never saw (`servedTo`);
 *  - the serving seam (serve.ts). A record this agent already used (`cited_at`: a post citing it went out, was scheduled
 *    or waits for review) is not served to it again, and neither is one it was offered `OFFERS_MAX` times with a due
 *    slot and passed over: an agent that was shown an event and chose not to post about it has passed on it;
 *  - the platform account's quiet slot (platform-quiet.ts): it is on only while the dataset really handed this agent
 *    a record in the last day (`servedLately`);
 *  - the weekly check, later: which records a turn had in front of it.
 *
 * Nothing here throws into a turn or a publish: a row that cannot be written is a warning. Rows are deleted
 * `SERVED_KEEP_MS` after they were last served and cited, at most once an hour per process, by the write itself.
 */
import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { recordsServed } from '../db/schema.js';

export const SERVED_KEEP_MS = 30 * 86_400_000;
export const SERVED_PRUNE_EVERY_MS = 3_600_000;
/** After this many turns that held a due slot and did not post about it, a record is not offered to that agent again. */
export const OFFERS_MAX = 3;

interface ServedCtx {
  db: Db;
  now(): number;
  log: { warn(obj: unknown, msg?: string): void };
}

const rowId = (agentId: string, recordId: string): string => `${agentId}:${recordId}`;

const lastPrune = new WeakMap<object, number>();

/**
 * Notes that `recordIds` were in the first observation of a turn of `agentId`. `slotDue`: the turn held a due
 * original-post slot, so the agent could have posted about them (counted as an offer). Never throws.
 */
export async function noteServed(ctx: ServedCtx, agentId: string, recordIds: readonly string[], opts: { slotDue: boolean }): Promise<void> {
  if (!recordIds.length) return;
  try {
    const now = new Date(ctx.now());
    const offered = opts.slotDue ? 1 : 0;
    await ctx.db
      .insert(recordsServed)
      .values([...new Set(recordIds)].map((recordId) => ({ id: rowId(agentId, recordId), agentId, recordId, firstServedAt: now, lastServedAt: now, times: 1, offered })))
      .onConflictDoUpdate({ target: recordsServed.id, set: { lastServedAt: now, times: sql`${recordsServed.times} + 1`, offered: sql`${recordsServed.offered} + ${offered}` } });
    const last = lastPrune.get(ctx.db);
    if (last === undefined || ctx.now() - last >= SERVED_PRUNE_EVERY_MS) {
      lastPrune.set(ctx.db, ctx.now());
      const cutoff = new Date(ctx.now() - SERVED_KEEP_MS);
      await ctx.db.delete(recordsServed).where(and(lt(recordsServed.lastServedAt, cutoff), or(isNull(recordsServed.citedAt), lt(recordsServed.citedAt, cutoff))));
    }
  } catch (err) {
    ctx.log.warn({ agentId, records: recordIds.length, err: err instanceof Error ? err.message : String(err) }, 'records served: the rows could not be written');
  }
}

/** The ids among `recordIds` that this agent was handed and that are still on record. One indexed read; none for an empty list. */
export async function servedTo(db: Db, agentId: string, recordIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(recordIds)].slice(0, 16);
  if (!ids.length) return new Set();
  const rows = await db.select({ recordId: recordsServed.recordId }).from(recordsServed).where(inArray(recordsServed.id, ids.map((id) => rowId(agentId, id))));
  return new Set(rows.map((r) => r.recordId));
}

/**
 * Notes that a post of `agentId` citing `recordIds` went out, was scheduled or was queued for review: from here on the
 * seam does not serve them to this agent. `by` is that post (the id of its publish action, of its scheduled row or of
 * its review item). Only rows that exist are marked (an id the agent was never handed is not a citation), and the
 * first citation stands. Never throws.
 */
export async function markCited(ctx: ServedCtx, agentId: string, recordIds: readonly string[], by: string | null = null): Promise<void> {
  const ids = [...new Set(recordIds)].slice(0, 16);
  if (!ids.length) return;
  try {
    await ctx.db.update(recordsServed).set({ citedAt: new Date(ctx.now()), citedBy: by }).where(and(inArray(recordsServed.id, ids.map((id) => rowId(agentId, id))), isNull(recordsServed.citedAt)));
  } catch (err) {
    ctx.log.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, 'records served: a citation could not be noted');
  }
}

/** Of `recordIds`, the ones a post of this agent already cited, each with when and by which post. One indexed read; none for an empty list. */
export async function citedBefore(db: Db, agentId: string, recordIds: readonly string[]): Promise<{ recordId: string; at: Date; by: string | null }[]> {
  const ids = [...new Set(recordIds)].slice(0, 16);
  if (!ids.length) return [];
  const rows = await db.select({ recordId: recordsServed.recordId, at: recordsServed.citedAt, by: recordsServed.citedBy }).from(recordsServed).where(inArray(recordsServed.id, ids.map((id) => rowId(agentId, id))));
  return rows.filter((r): r is { recordId: string; at: Date; by: string | null } => r.at !== null);
}

/** Whether the dataset handed this agent at least one record in a turn since `since` (epoch ms). One indexed read. */
export async function servedLately(db: Db, agentId: string, since: number): Promise<boolean> {
  const rows = await db.select({ id: recordsServed.id }).from(recordsServed).where(and(eq(recordsServed.agentId, agentId), gte(recordsServed.lastServedAt, new Date(since)))).limit(1);
  return rows.length > 0;
}
