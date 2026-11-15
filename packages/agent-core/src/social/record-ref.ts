/**
 * The `record` field of `publish_post` and `schedule_post` (docs/design/agent-behaviour.md section 6.3): the dataset
 * records a post rests on, by id, two at most. It says nothing by itself: code looks the ids up, keeps the ones the
 * agent was really shown, writes them to the said-ledger and to the record's own list of who posted about it, and
 * reads the record's numbers for the number gate (apps/supervisor/src/post-records.ts, number-gate.ts).
 *
 * The field is forgiven, never refused, the way the labels of a note are (notes.ts): a refused call is a paid thought,
 * and a post must not be lost over how its evidence was pointed at. One record given alone becomes a list of one, a
 * bare id a record with that id, the same id twice is one, anything that is not a record id is dropped, and what is
 * past the limit is cut.
 */

/** A record's id as the dataset makes it: `r_` and 12 hex characters (apps/supervisor/src/dataset/store.ts). */
export const RECORD_ID_RE = /^r_[0-9a-f]{12}$/;
/** The most records one post may cite. */
export const MAX_RECORDS_PER_POST = 2;

export interface RecordRef {
  id: string;
}

/** `record` as a list of at most `MAX_RECORDS_PER_POST` distinct `{ id }`; undefined when nothing in it is a record id. */
export function forgivenRecords(value: unknown): RecordRef[] | undefined {
  if (value === null || value === undefined) return undefined;
  const list: unknown[] = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const item of list.slice(0, 16)) {
    const raw = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (RECORD_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.length ? ids.slice(0, MAX_RECORDS_PER_POST).map((id) => ({ id })) : undefined;
}

/** The record ids of a stored `publish_post` or `schedule_post` input, read the forgiving way; empty when it cites none. */
export function recordIdsOf(input: unknown): string[] {
  const record = input && typeof input === 'object' ? (input as { record?: unknown }).record : undefined;
  return (forgivenRecords(record) ?? []).map((r) => r.id);
}
