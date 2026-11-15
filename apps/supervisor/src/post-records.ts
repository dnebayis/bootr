/**
 * A post that cites records (`publish_post {record}`, `schedule_post {record}`; docs/design/agent-behaviour.md sections
 * 6.2 and 6.3, rules R1 and R4). Three things follow from a citation, all of them here:
 *
 *  1. The ids are checked. A cited id counts only when this agent was really handed that record (dataset/served.ts):
 *     a model can make an id up, and an own agent's client can send any id it likes. An id that was never served is
 *     not a citation: it reaches neither the said-ledger nor the record, and no number is excused by it. The stored
 *     action keeps what the model sent, for the person who reads it later.
 *  2. Rule R1, one event, one post: an original post that cites a record this agent already posted about (the
 *     said-ledger's record ids, or a post of its own that cites it and still waits) is what the repeat gate (G1) finds
 *     as `repeat_record`, in the mode that gate has (`REPEAT_GATE`, shadow unless set otherwise). Until corrections
 *     exist (stage 8) a record that changed is no exception.
 *  3. When the post is out, the said-ledger row carries the record ids and the record's own `posted` list gets the
 *     agent, the post and the time, so the next agent that is handed the record sees that somebody posted it
 *     (`othersPosted`), and this agent is not handed it again.
 *
 * Nothing here calls a model, and nothing throws into a publish: a read or a write that fails is a warning, the post
 * goes out, and the citation is lost, not the post.
 */
import { recordIdsOf } from '@bootr/agent-core';
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { citedBefore, markCited, servedTo } from './dataset/served.js';
import { markPosted } from './dataset/store.js';
import type { RecordNumber } from './dataset/types.js';
import { dsRecords, said } from './db/schema.js';

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'log'>;

/** A record a post cites, as the gates read it. */
export interface CitedRecord {
  id: string;
  kind: string;
  headline: string;
  summary: string | null;
  link: string | null;
  numbers: RecordNumber[];
}

export interface Citation {
  /** The ids the input names, read the forgiving way (agent-core `recordIdsOf`). */
  asked: string[];
  /** Of those, the records this agent was handed and that still exist. */
  records: CitedRecord[];
}

const NO_CITATION: Citation = { asked: [], records: [] };

/**
 * The citation of a post input (`{ text, record? }`). No read for an input that names no record; two indexed reads
 * otherwise. A read that fails is "no citation".
 */
export async function citationOf(ctx: Ctx, agentId: string, input: unknown): Promise<Citation> {
  const asked = recordIdsOf(input);
  if (!asked.length) return NO_CITATION;
  try {
    const served = await servedTo(ctx.db, agentId, asked);
    const ids = asked.filter((id) => served.has(id));
    if (!ids.length) return { asked, records: [] };
    const rows = await ctx.db.select({ id: dsRecords.id, kind: dsRecords.kind, headline: dsRecords.headline, summary: dsRecords.summary, link: dsRecords.link, numbers: dsRecords.numbers }).from(dsRecords).where(inArray(dsRecords.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { asked, records: ids.flatMap((id) => (byId.has(id) ? [{ ...byId.get(id)!, numbers: byId.get(id)!.numbers as unknown as RecordNumber[] }] : [])) };
  } catch (err) {
    ctx.log.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, 'records: a citation could not be read; the post is treated as citing nothing');
    return { asked, records: [] };
  }
}

/**
 * The record ids of a post input that this agent was really handed, in the order it named them: what a scheduled row
 * keeps for its send. No read for an input that names no record; a read that fails keeps none. Never throws.
 */
export async function servedRecordIds(ctx: Ctx, agentId: string, input: unknown): Promise<string[]> {
  const asked = recordIdsOf(input);
  if (!asked.length) return [];
  try {
    const served = await servedTo(ctx.db, agentId, asked);
    return asked.filter((id) => served.has(id));
  } catch (err) {
    ctx.log.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, 'records: the citations of a scheduled post could not be checked; none is kept');
    return [];
  }
}

/** A record the agent already posted about, as the repeat gate reports it. */
export interface RecordRepeat {
  recordId: string;
  /** When the earlier post went out or was put in line (epoch ms). */
  at: number;
  /** Where the earlier citation is on record: a post that is out, or one that waits (scheduled, in review). */
  where: 'said' | 'waiting';
}

/**
 * Of the cited records, the ones this agent already posted about (rule R1). `actionId` is the post being decided: the
 * rows it left itself (a step asked twice, a scheduled post asked again at its send, an approved one) are not a
 * repeat. Two indexed reads; none for a post that cites nothing.
 */
export async function recordRepeats(ctx: Pick<SupervisorContext, 'db'>, agentId: string, recordIds: readonly string[], actionId: string): Promise<RecordRepeat[]> {
  if (!recordIds.length) return [];
  const own = [actionId, `${actionId}-sent`, `${actionId}-approved`];
  const names = sql.join(
    recordIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const [ledger, waiting] = await Promise.all([
    ctx.db
      .select({ recordIds: said.recordIds, postedAt: said.postedAt })
      .from(said)
      .where(and(eq(said.agentId, agentId), ne(said.kind, 'reply'), notInArray(said.actionId, own), sql`${said.recordIds} ?| array[${names}]::text[]`))
      .limit(20),
    citedBefore(ctx.db, agentId, recordIds),
  ]);
  const out = new Map<string, RecordRepeat>();
  for (const row of ledger) for (const id of Array.isArray(row.recordIds) ? row.recordIds : []) if (recordIds.includes(id) && !out.has(id)) out.set(id, { recordId: id, at: row.postedAt.getTime(), where: 'said' });
  for (const row of waiting) if (!out.has(row.recordId) && !(row.by !== null && own.includes(row.by))) out.set(row.recordId, { recordId: row.recordId, at: row.at.getTime(), where: 'waiting' });
  return [...out.values()];
}

/** What the repeat gate (G1) finds in a post that cites a record this agent already posted about: the refusal and its shadow row. Pure. */
export function recordRepeatProblem(repeats: readonly RecordRepeat[], parts: readonly string[], done: 'posted' | 'scheduled' = 'posted'): { code: 'repeat_record'; message: string; text: string; detail: Record<string, unknown> } | null {
  if (!repeats.length) return null;
  const named = repeats.map((r) => `${r.recordId} (${r.where === 'said' ? 'posted' : 'scheduled or sent for review'} on ${new Date(r.at).toISOString().slice(0, 10)})`);
  return {
    code: 'repeat_record',
    message: `repeat_record: you already posted about ${named.join(' and ')}. One event is one post, however it is worded: write about another record or about something else. Nothing was ${done}.`,
    text: parts.join('\n'),
    detail: { records: repeats.map((r) => ({ recordId: r.recordId, at: new Date(r.at).toISOString(), where: r.where })) },
  };
}

/**
 * Notes that a post citing `input.record` was put in line under `by` (scheduled, or queued for the creator's review):
 * the seam stops handing those records to this agent, and a second post about them is a repeat. A post that is sent
 * at once needs no call: its ledger row does the same (`tellRecords`). Never throws.
 */
export async function noteCitationInLine(ctx: Ctx, agentId: string, input: unknown, by: string): Promise<void> {
  const asked = recordIdsOf(input);
  if (asked.length) await markCited(ctx, agentId, asked, by);
}

/** A said-ledger row as `recordSaid` is about to write it. */
interface SaidRow {
  id: string;
  agentId: string;
  actionId: string;
  postId?: string | null;
  kind: string;
  postedAt: Date;
  recordIds?: string[];
}

/**
 * The rows of a publish with their record ids cut to the ones the agent was handed. Rows that cite nothing come back
 * as they are, the same objects, with no read: a post without `record` costs what it did. Never throws.
 */
export async function servedCitations<T extends SaidRow>(ctx: Ctx, rows: T[]): Promise<T[]> {
  const asked = [...new Set(rows.flatMap((r) => r.recordIds ?? []))];
  if (!asked.length) return rows;
  try {
    const served = await servedTo(ctx.db, rows[0]!.agentId, asked);
    return rows.map((r) => ({ ...r, recordIds: (r.recordIds ?? []).filter((id) => served.has(id)) }));
  } catch (err) {
    ctx.log.warn({ agentId: rows[0]!.agentId, err: err instanceof Error ? err.message : String(err) }, 'records: the citations of a publish could not be checked; none is kept');
    return rows.map((r) => ({ ...r, recordIds: [] }));
  }
}

/**
 * Tells the records that a post about them went out: once per publish (its first post; a thread is one), and only for
 * rows the ledger really wrote now (`written`: the ids the insert returned), so a publish recorded twice tells nothing
 * twice. Appends to each record's `posted` list and marks the served row cited. Never throws.
 */
export async function tellRecords(ctx: Ctx, rows: readonly SaidRow[], written: ReadonlySet<string>): Promise<void> {
  for (const row of rows) {
    if (row.kind !== 'original' || !written.has(row.id) || !row.recordIds?.length) continue;
    try {
      const entry = { agentId: row.agentId, postId: row.postId ?? row.actionId, at: row.postedAt.toISOString() };
      for (const recordId of row.recordIds) await markPosted(ctx.db, recordId, entry);
      await markCited(ctx, row.agentId, row.recordIds, row.actionId);
    } catch (err) {
      ctx.log.warn({ agentId: row.agentId, actionId: row.actionId, err: err instanceof Error ? err.message : String(err) }, 'records: a record could not be told that a post about it went out');
    }
  }
}
