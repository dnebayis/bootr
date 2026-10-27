import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { memories } from './db/schema.js';

export interface MemoryRecord {
  id: string;
  text: string;
  sources: string[];
  tags: string[];
  createdAt: string;
}

const PAGE = 10;

function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9$_#-]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
}

/** `remember` / `recall` backed by `sv_memories`; keyword search ranks by matched token count. */
export class MemoryStore {
  constructor(private readonly db: Db) {}

  async remember(agentId: string, input: { text: string; sources?: string[]; tags?: string[] }): Promise<MemoryRecord> {
    const id = `mem_${randomUUID()}`;
    const createdAt = new Date();
    await this.db.insert(memories).values({ id, agentId, text: input.text, sources: input.sources ?? [], tags: input.tags ?? [], createdAt });
    return { id, text: input.text, sources: input.sources ?? [], tags: input.tags ?? [], createdAt: createdAt.toISOString() };
  }

  async recall(agentId: string, input: { query?: string; id?: string; offset?: number }): Promise<{ items: MemoryRecord[]; total: number; offset: number }> {
    if (input.id) {
      const row = await this.db.query.memories.findFirst({ where: and(eq(memories.agentId, agentId), eq(memories.id, input.id)) });
      return { items: row ? [toRecord(row)] : [], total: row ? 1 : 0, offset: 0 };
    }
    const offset = input.offset ?? 0;
    const terms = tokens(input.query ?? '');
    const rows = await this.db.select().from(memories).where(eq(memories.agentId, agentId)).orderBy(desc(memories.createdAt)).limit(500);
    const scored = rows
      .map((row) => {
        const hay = `${row.text} ${row.tags.join(' ')}`.toLowerCase();
        const score = terms.length ? terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) : 1;
        return { row, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.row.createdAt.getTime() - a.row.createdAt.getTime());
    return { items: scored.slice(offset, offset + PAGE).map((r) => toRecord(r.row)), total: scored.length, offset };
  }

  /** Most recent notes for the observation (bounded). */
  async recent(agentId: string, limit = 5): Promise<MemoryRecord[]> {
    const rows = await this.db.select().from(memories).where(eq(memories.agentId, agentId)).orderBy(desc(memories.createdAt)).limit(limit);
    return rows.map(toRecord);
  }

  async count(agentId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)` }).from(memories).where(eq(memories.agentId, agentId));
    return Number(row?.n ?? 0);
  }
}

function toRecord(row: typeof memories.$inferSelect): MemoryRecord {
  return { id: row.id, text: row.text, sources: row.sources, tags: row.tags, createdAt: row.createdAt.toISOString() };
}
