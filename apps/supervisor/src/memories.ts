import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { memories, type MemoryKind } from './db/schema.js';

export interface MemoryRecord {
  id: string;
  text: string;
  sources: string[];
  tags: string[];
  /** When the note was first written. */
  createdAt: string;
  /** What a typed note is about; absent on a plain note. */
  kind?: MemoryKind;
  /** Who or what a note with a subject is the one note of (the `key` column; the tool's field is `subject`). */
  subject?: string;
  /** When a note with a subject was last written, and how many times in all. */
  updatedAt?: string;
  count?: number;
  /** A promise: when it is due, and when it was closed (absent while it is open). */
  dueAt?: string;
  closedAt?: string;
}

/** What `remember` stores for one note (the broker hands over agent-core's parsed note; code-written notes pass text, sources and tags). */
export interface MemoryInput {
  text: string;
  sources?: string[] | undefined;
  tags?: string[] | undefined;
  kind?: MemoryKind | undefined;
  subject?: string | undefined;
  /** A promise's due time (ISO); `PROMISE_DEFAULT_DUE_MS` from now when a promise names none. */
  dueAt?: string | undefined;
  /** Closes the promise with this subject. */
  done?: boolean | undefined;
}

const PAGE = 10;
/** When a promise that names no due time is due. */
export const PROMISE_DEFAULT_DUE_MS = 24 * 60 * 60 * 1000;
/** How long past its due time an open promise is still shown (`openPromises`); after that it is only found by `recall`. */
export const PROMISE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9$_#-]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
}

/** A unique-index violation (Postgres 23505), as node-postgres and PGlite both report it. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

/**
 * `remember` / `recall` backed by `sv_memories`; keyword search ranks by matched token count.
 *
 * A note with a subject is that subject's one note (docs/design/agent-behaviour.md section 6.2, where the field is
 * called `key`, as the column is): the same kind and subject again rewrites the row in place, keeps when it was first
 * noted, and counts how often it was written. Without a kind such a note is of kind `note`. A promise always has a
 * subject (one is made for it when it names none) and a due time, and is open until a later write with `done` closes
 * it; writing it again without `done` opens it again.
 */
export class MemoryStore {
  constructor(private readonly db: Db) {}

  async remember(agentId: string, input: MemoryInput, now: Date = new Date()): Promise<MemoryRecord & { updated: boolean }> {
    const id = `mem_${randomUUID()}`;
    const promise = input.kind === 'promise';
    const key = input.subject ?? (promise ? `p-${id.slice(4, 12)}` : undefined);
    if (!key) {
      const kind = input.kind ?? null;
      await this.db.insert(memories).values({ id, agentId, text: input.text, sources: input.sources ?? [], tags: input.tags ?? [], createdAt: now, kind });
      return { id, text: input.text, sources: input.sources ?? [], tags: input.tags ?? [], createdAt: now.toISOString(), ...(kind ? { kind } : {}), updated: false };
    }
    const kind: MemoryKind = input.kind ?? 'note';
    const due = promise ? new Date(input.dueAt && Number.isFinite(Date.parse(input.dueAt)) ? Date.parse(input.dueAt) : now.getTime() + PROMISE_DEFAULT_DUE_MS) : null;
    const closed = promise && input.done === true ? now : null;
    const subject = and(eq(memories.agentId, agentId), eq(memories.kind, kind), eq(memories.key, key));
    // Two attempts: a note of the same subject written between the read and the insert (the unique index says so) is updated on the second.
    for (let attempt = 0; ; attempt++) {
      const existing = await this.db.query.memories.findFirst({ where: subject });
      if (existing) {
        const [row] = await this.db
          .update(memories)
          .set({
            text: input.text,
            // What the new write does not name stays as it was: a later line about a person does not lose the first one's source.
            sources: input.sources ?? existing.sources,
            tags: input.tags ?? existing.tags,
            updatedAt: now,
            count: (existing.count ?? 1) + 1,
            ...(promise ? { dueAt: input.dueAt ? due : (existing.dueAt ?? due), closedAt: closed } : {}),
          })
          .where(eq(memories.id, existing.id))
          .returning();
        return { ...toRecord(row!), updated: true };
      }
      try {
        const [row] = await this.db.insert(memories).values({ id, agentId, text: input.text, sources: input.sources ?? [], tags: input.tags ?? [], createdAt: now, kind, key, updatedAt: now, count: 1, dueAt: due, closedAt: closed }).returning();
        return { ...toRecord(row!), updated: false };
      } catch (err) {
        if (attempt > 0 || !isUniqueViolation(err)) throw err;
      }
    }
  }

  async recall(agentId: string, input: { query?: string | undefined; id?: string | undefined; offset?: number | undefined }): Promise<{ items: MemoryRecord[]; total: number; offset: number }> {
    if (input.id) {
      const row = await this.db.query.memories.findFirst({ where: and(eq(memories.agentId, agentId), eq(memories.id, input.id)) });
      return { items: row ? [toRecord(row)] : [], total: row ? 1 : 0, offset: 0 };
    }
    const offset = input.offset ?? 0;
    const terms = tokens(input.query ?? '');
    const rows = await this.db.select().from(memories).where(eq(memories.agentId, agentId)).orderBy(desc(memories.createdAt)).limit(500);
    const scored = rows
      .map((row) => {
        const hay = `${row.text} ${row.tags.join(' ')} ${row.kind ?? ''} ${row.key ?? ''}`.toLowerCase();
        const score = terms.length ? terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) : 1;
        return { row, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || lastWritten(b.row) - lastWritten(a.row));
    return { items: scored.slice(offset, offset + PAGE).map((r) => toRecord(r.row)), total: scored.length, offset };
  }

  /**
   * The notes written last, for the observation (bounded); `excludeTags` leaves out rows carrying any of them (creator
   * requests have their own section). A note with a subject counts by its last write. With `withoutOpenPromises`, promises that
   * are still open are left out: the observation shows them under their own heading (`openPromises`).
   */
  async recent(agentId: string, limit = 5, excludeTags: readonly string[] = [], opts: { withoutOpenPromises?: boolean } = {}): Promise<MemoryRecord[]> {
    const rows = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.agentId, agentId),
          ...excludeTags.map((tag) => sql`not (${memories.tags} @> ${JSON.stringify([tag])}::jsonb)`),
          ...(opts.withoutOpenPromises ? [sql`not (${memories.kind} is not distinct from 'promise' and ${memories.closedAt} is null)`] : []),
        ),
      )
      .orderBy(desc(sql`coalesce(${memories.updatedAt}, ${memories.createdAt})`))
      .limit(limit);
    return rows.map(toRecord);
  }

  /** Promises the agent has not closed, soonest due first; one more than `PROMISE_STALE_MS` past its due time is no longer listed. */
  async openPromises(agentId: string, now: Date, limit = 5): Promise<MemoryRecord[]> {
    const rows = await this.db
      .select()
      .from(memories)
      .where(and(eq(memories.agentId, agentId), eq(memories.kind, 'promise'), isNull(memories.closedAt), gt(memories.dueAt, new Date(now.getTime() - PROMISE_STALE_MS))))
      .orderBy(asc(memories.dueAt))
      .limit(limit);
    return rows.map(toRecord);
  }

  async count(agentId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)` }).from(memories).where(eq(memories.agentId, agentId));
    return Number(row?.n ?? 0);
  }
}

const lastWritten = (row: typeof memories.$inferSelect): number => (row.updatedAt ?? row.createdAt).getTime();

function toRecord(row: typeof memories.$inferSelect): MemoryRecord {
  return {
    id: row.id,
    text: row.text,
    sources: row.sources,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.key ? { subject: row.key } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
    ...(row.count ? { count: row.count } : {}),
    ...(row.dueAt ? { dueAt: row.dueAt.toISOString() } : {}),
    ...(row.closedAt ? { closedAt: row.closedAt.toISOString() } : {}),
  };
}
