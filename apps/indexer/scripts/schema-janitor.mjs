// Drops the automatic Ponder schemas (`bootr_<7 hex>`, from DATABASE_SCHEMA=auto) of older images, keeping the
// current one and the newest previous one. Never touches fixed names (bootr_v1, bootr_v3, ...) or bootr_offchain.
// Usage: node scripts/schema-janitor.mjs <current schema>   (reads INDEXER_DATABASE_URL)
import pg from 'pg';

export const AUTO_SCHEMA = /^bootr_[0-9a-f]{7}$/;

/** The schemas to drop: every automatic one except `current` and the one created most recently before it. `all` is ordered oldest first (by pg_namespace oid). */
export function schemasToDrop(all, current) {
  const auto = all.filter((name) => AUTO_SCHEMA.test(name) && name !== current);
  const keep = auto.length ? auto[auto.length - 1] : null;
  return auto.filter((name) => name !== keep);
}

async function main() {
  const current = process.argv[2];
  const url = process.env.INDEXER_DATABASE_URL;
  if (!current || !AUTO_SCHEMA.test(current) || !url) {
    console.error(`[janitor] nothing to do (current=${current ?? ''})`);
    return;
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query("select nspname from pg_namespace where nspname like 'bootr_%' order by oid");
    const victims = schemasToDrop(rows.map((r) => r.nspname), current);
    for (const name of victims) {
      await client.query(`drop schema "${name}" cascade`);
      console.log(`[janitor] dropped old index schema ${name}`);
    }
    if (!victims.length) console.log('[janitor] no old index schemas');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('schema-janitor.mjs')) {
  main().catch((err) => {
    console.error('[janitor] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
