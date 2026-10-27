import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.js';

export type Schema = typeof schema;
/** Driver-agnostic drizzle handle (node-postgres in production, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export const MIGRATIONS_TABLE = 'sender_migrations';
export const MIGRATIONS_SCHEMA = 'public';

export function createDb(databaseUrl: string): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, close: () => pool.end() };
}
