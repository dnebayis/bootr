/* global process, console, URL */
// Applies apps/inference/drizzle/*.sql to DATABASE_URL without drizzle-kit (a dev dependency), so the
// production image can run its own migrations (Railway pre-deploy command). Same journal as
// `pnpm --filter @bootr/inference db:migrate` (drizzle-kit migrate): drizzle.__drizzle_migrations.
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('inference migration failed: DATABASE_URL is required');
  process.exit(1);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(client), { migrationsFolder });
  console.log('inference migrations applied');
} catch (err) {
  console.error('inference migration failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
