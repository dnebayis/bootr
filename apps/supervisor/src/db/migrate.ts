import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './client.js';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder, migrationsTable: MIGRATIONS_TABLE, migrationsSchema: MIGRATIONS_SCHEMA });
    console.log('supervisor migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('supervisor migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
