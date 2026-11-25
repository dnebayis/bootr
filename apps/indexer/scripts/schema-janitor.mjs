/* global process, console */
// Old Ponder index schemas, of both kinds:
//
//   automatic  `bootr_<7 hex>` (DATABASE_SCHEMA=auto, one per image). scripts/start.sh runs this before Ponder starts
//              and it drops them, keeping the current one and the newest one created before it (a rollback target).
//   named      `bootr_v<N>` (a fixed DATABASE_SCHEMA bumped by hand). Run by hand only, never from start.sh:
//                node scripts/schema-janitor.mjs bootr_v11          lists what it would drop (dry run)
//                node scripts/schema-janitor.mjs bootr_v11 --drop   drops them
//              It keeps the schema given (the one in DATABASE_SCHEMA) and the named one immediately before it.
//
// Never touched, whatever their name: `ponder_sync`, `ponder_rpc_cache_*`, `bootr_offchain`, `public`, `drizzle`, any
// schema that holds views into another schema (Ponder's views schema, DATABASE_VIEWS_SCHEMA, e.g. `bootr_live`), and
// any schema such a view reads from, which is the index the site is being served from right now.
//
// Ponder 0.18 keeps no record of a views schema's target: `ponder start --views-schema` and `ponder db create-views`
// run `CREATE VIEW "<views>"."<table>" AS SELECT * FROM "<schema>"."<table>"` and nothing else, so the target is read
// from the catalog (pg_depend through the views' rewrite rules, `VIEW_LINKS_SQL`).
//
// Reads INDEXER_DATABASE_URL.
import pg from 'pg';

export const AUTO_SCHEMA = /^bootr_[0-9a-f]{7}$/;
export const NAMED_SCHEMA = /^bootr_v(\d+)$/;

const PROTECTED = new Set(['ponder_sync', 'bootr_offchain', 'public', 'drizzle']);
/** A schema this script never drops by its name alone. */
export function isProtected(name) {
  return PROTECTED.has(name) || name.startsWith('ponder_rpc_cache_') || name.startsWith('pg_') || name === 'information_schema';
}

/** Every (schema holding a view, schema that view reads from) pair across two different schemas. */
export const VIEW_LINKS_SQL = `
  select distinct vn.nspname as "viewSchema", tn.nspname as "targetSchema"
  from pg_depend d
  join pg_rewrite r on r.oid = d.objid
  join pg_class v on v.oid = r.ev_class and v.relkind in ('v', 'm')
  join pg_namespace vn on vn.oid = v.relnamespace
  join pg_class t on t.oid = d.refobjid
  join pg_namespace tn on tn.oid = t.relnamespace
  where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass and vn.nspname <> tn.nspname`;

/** The schemas that views pin: every views schema and every schema one of its views reads from. */
function pinnedByViews(viewLinks) {
  const pinned = new Set();
  for (const l of viewLinks) {
    pinned.add(l.viewSchema);
    pinned.add(l.targetSchema);
  }
  return pinned;
}

/**
 * The automatic schemas to drop: every one except `current` and the one created most recently before it. `all` is
 * ordered oldest first (by pg_namespace oid). A schema pinned by a view is never among them.
 */
export function schemasToDrop(all, current, viewLinks = []) {
  const pinned = pinnedByViews(viewLinks);
  const auto = all.filter((name) => AUTO_SCHEMA.test(name) && name !== current);
  const keep = auto.length ? auto[auto.length - 1] : null;
  return auto.filter((name) => name !== keep && !pinned.has(name) && !isProtected(name));
}

/**
 * The named schemas (`bootr_v<N>`) to drop when `current` is the one in DATABASE_SCHEMA: all of them except `current`,
 * the existing one with the highest number below it, any with a higher number, and any a view pins. Nothing when `current` is not a named
 * schema. Returns the kept ones with the reason, for the listing.
 */
export function namedSchemasPlan(all, current, viewLinks = []) {
  const now = NAMED_SCHEMA.exec(current ?? '');
  if (!now) return { drop: [], keep: [] };
  const pinned = pinnedByViews(viewLinks);
  const number = (name) => Number(NAMED_SCHEMA.exec(name)[1]);
  const named = all.filter((name) => NAMED_SCHEMA.test(name)).sort((a, b) => number(a) - number(b));
  const below = named.filter((name) => number(name) < Number(now[1]));
  const previous = below.length ? below[below.length - 1] : null;
  const drop = [];
  const keep = [];
  for (const name of named) {
    if (name === current) keep.push({ name, why: 'current (DATABASE_SCHEMA)' });
    else if (name === previous) keep.push({ name, why: 'the one before the current' });
    else if (number(name) > Number(now[1])) keep.push({ name, why: 'newer than the current (a backfill for the next deploy?)' });
    else if (pinned.has(name)) {
      const by = viewLinks.filter((l) => l.targetSchema === name || l.viewSchema === name).map((l) => (l.viewSchema === name ? 'holds views' : `read by views in ${l.viewSchema}`));
      keep.push({ name, why: [...new Set(by)].join(', ') });
    } else if (isProtected(name)) keep.push({ name, why: 'protected' });
    else drop.push(name);
  }
  return { drop, keep };
}

async function main() {
  const current = process.argv[2];
  const really = process.argv.includes('--drop');
  const url = process.env.INDEXER_DATABASE_URL;
  const auto = !!current && AUTO_SCHEMA.test(current);
  const named = !!current && NAMED_SCHEMA.test(current);
  if ((!auto && !named) || !url) {
    console.error(`[janitor] nothing to do (current=${current ?? ''})`);
    return;
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query("select nspname from pg_namespace where nspname like 'bootr_%' order by oid");
    const all = rows.map((r) => r.nspname);
    const viewLinks = (await client.query(VIEW_LINKS_SQL)).rows;
    if (auto) {
      const victims = schemasToDrop(all, current, viewLinks);
      for (const name of victims) {
        await client.query(`drop schema "${name}" cascade`);
        console.log(`[janitor] dropped old index schema ${name}`);
      }
      if (!victims.length) console.log('[janitor] no old index schemas');
      return;
    }
    if (!all.includes(current)) {
      console.error(`[janitor] ${current} does not exist in this database; nothing listed`);
      return;
    }
    const plan = namedSchemasPlan(all, current, viewLinks);
    for (const k of plan.keep) console.log(`[janitor] keep ${k.name}: ${k.why}`);
    for (const name of plan.drop) {
      const size = await client.query(
        'select pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)), 0)) as size from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind in ($2, $3)',
        [name, 'r', 'm'],
      );
      if (really) {
        await client.query(`drop schema "${name}" cascade`);
        console.log(`[janitor] dropped ${name} (${size.rows[0].size})`);
      } else console.log(`[janitor] would drop ${name} (${size.rows[0].size})`);
    }
    if (!plan.drop.length) console.log('[janitor] no named schema to drop');
    else if (!really) console.log('[janitor] dry run: nothing was dropped; pass --drop to drop the schemas listed');
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
