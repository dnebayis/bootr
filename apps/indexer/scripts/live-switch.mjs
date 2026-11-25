// The live switch (docs/deploy/live-switch.md): the reader (`ponder serve`) reads a schema of views, `bootr_live`,
// and this script points those views at a writer's schema in one transaction, once that schema is ready and as far
// along the chain as the schema being served. Readers never see a half-filled index.
//
// Why not Ponder's own DATABASE_VIEWS_SCHEMA: measured on 2026-11-25 (docs/dev/indexer-live-switch-test.md), it
// repoints the views when the backfill ends, which is the finalized block (the head stepped back 216 s), and every
// start of any writer that carries the variable takes the views again, so an old writer that restarts takes them
// back from the new one.
//
// Usage (reads INDEXER_DATABASE_URL; the views schema is INDEXER_LIVE_SCHEMA, `bootr_live` when empty):
//   node scripts/live-switch.mjs status              what the views point at and how far along every index schema is
//   node scripts/live-switch.mjs preflight <schema>  exit 3 while another process is writing <schema> (fresh heartbeat)
//   node scripts/live-switch.mjs watch <schema>      wait until <schema> is ready and caught up, switch once, exit
//   node scripts/live-switch.mjs switch <schema>     switch now (the rollback command); refuses a schema that is not ready
//   node scripts/live-switch.mjs wait-live           wait until the views exist (the reader's start)
//
// Ponder's live-query trigger on the views schema (its SQL-over-HTTP client's change feed) is not created here: the
// indexer does not mount that client (src/api/index.ts).
import pg from 'pg';

export const DEFAULT_LIVE_SCHEMA = 'bootr_live';
/** A writer updates its heartbeat every 10 s and Ponder calls it gone after 25 s (ponder internal/options.js). */
export const HEARTBEAT_FRESH_MS = 30_000;
/** After a clean stop the lock flag is cleared and no heartbeat follows; one missed beat and a margin is enough to believe it. */
export const HEARTBEAT_UNLOCKED_FRESH_MS = 15_000;

/** Whether a process is still writing a schema. The lock flag alone is not trusted: a refused second writer clears it. */
export function writerAlive({ locked, heartbeatAt }, nowMs) {
  return nowMs - heartbeatAt < (locked ? HEARTBEAT_FRESH_MS : HEARTBEAT_UNLOCKED_FRESH_MS);
}
/** Seconds the new schema may trail the served one at the switch (INDEXER_SWITCH_SLACK_SEC). 0 = the head never steps back. */
export const DEFAULT_SLACK_SEC = 0;
/** When the served schema has no writer (its head stands still), how close to the wall clock counts as caught up. */
export const DEFAULT_MAX_LAG_SEC = 20;

const NAME = /^[a-z_][a-z0-9_]{0,44}$/;
export const validName = (s) => typeof s === 'string' && NAME.test(s);

/** The schema a view of the live schema selects from, read from its definition (`... FROM bootr_v10._ponder_meta;`). */
export function targetOfDefinition(definition) {
  const m = /\bFROM\s+"?([A-Za-z0-9_]+)"?\s*\.\s*"?_ponder_meta"?/i.exec(definition ?? '');
  return m ? m[1] : null;
}

/** Unix seconds of the block a Ponder checkpoint string stands at (its first ten digits). */
export function checkpointSeconds(checkpoint) {
  return typeof checkpoint === 'string' && /^\d{10}/.test(checkpoint) ? Number(checkpoint.slice(0, 10)) : null;
}

/**
 * What the watcher does on one look.
 *   mine    { ready: boolean, headSec: number | null }   the schema this writer fills
 *   target  { name: string | null, headSec: number | null, alive: boolean }   what the views point at now, and whether a
 *           writer is still filling it; while one is, the head it serves is the only measure, so the switch never steps back
 *   heldBefore  this schema has had the views before (the history table)
 * Returns { action: 'done' | 'superseded' | 'wait' | 'switch', why }.
 */
export function decide({ schema, mine, target, heldBefore, nowSec, slackSec = DEFAULT_SLACK_SEC, maxLagSec = DEFAULT_MAX_LAG_SEC }) {
  if (target.name === schema) return { action: 'done', why: 'the views already point at this schema' };
  if (heldBefore && target.name) {
    return { action: 'superseded', why: `the views moved on to ${target.name}; this schema had them before and does not take them back on its own` };
  }
  if (!mine.ready) return { action: 'wait', why: 'the backfill is not complete' };
  if (mine.headSec === null) return { action: 'wait', why: 'no checkpoint yet' };
  if (!target.name) return { action: 'switch', why: 'no views yet' };
  if (target.headSec !== null && mine.headSec >= target.headSec - slackSec) {
    return { action: 'switch', why: `caught up with ${target.name} (${mine.headSec - target.headSec} s apart)` };
  }
  if (target.alive && target.headSec !== null) return { action: 'wait', why: `${target.headSec - mine.headSec} s behind ${target.name}` };
  if (nowSec - mine.headSec <= maxLagSec) return { action: 'switch', why: `${target.name} has no writer and this schema is ${nowSec - mine.headSec} s behind the clock` };
  return { action: 'wait', why: `${nowSec - mine.headSec} s behind the clock` };
}

/** The statements of one switch, in order; run inside one transaction. `stale` = views of the live schema the new index has no table for. */
export function switchStatements(live, schema, names, stale = []) {
  const out = [`CREATE SCHEMA IF NOT EXISTS "${live}"`];
  for (const n of stale) out.push(`DROP VIEW IF EXISTS "${live}"."${n}"`);
  for (const n of [...names, '_ponder_meta', '_ponder_checkpoint']) {
    // Drop and create: CREATE OR REPLACE VIEW cannot change a view's columns.
    out.push(`DROP VIEW IF EXISTS "${live}"."${n}"`);
    out.push(`CREATE VIEW "${live}"."${n}" AS SELECT * FROM "${schema}"."${n}"`);
  }
  return out;
}

// ------------------------------------------------------------------ database

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[live-switch] ${msg}`);

async function withClient(fn) {
  const url = process.env.INDEXER_DATABASE_URL;
  if (!url) throw new Error('INDEXER_DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: url, application_name: 'bootr_live_switch' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function ensureHistory(client) {
  await client.query(
    `CREATE SCHEMA IF NOT EXISTS bootr_offchain;
     CREATE TABLE IF NOT EXISTS bootr_offchain.live_switch (
       id bigserial PRIMARY KEY,
       at timestamptz NOT NULL DEFAULT now(),
       live_schema text NOT NULL,
       from_schema text,
       to_schema text NOT NULL,
       reason text NOT NULL
     )`,
  );
}

async function liveTarget(client, live) {
  const { rows } = await client.query("select definition from pg_views where schemaname = $1 and viewname = '_ponder_meta'", [live]);
  return rows.length ? targetOfDefinition(rows[0].definition) : null;
}

/** { ready, locked, heartbeatAt, buildId, tables, headSec } of an index schema, or null when it has no Ponder meta table. */
async function schemaState(client, schema) {
  const exists = await client.query("select 1 from pg_tables where schemaname = $1 and tablename = '_ponder_meta'", [schema]);
  if (!exists.rows.length) return null;
  const meta = await client.query(`select value from "${schema}"._ponder_meta where key = 'app'`);
  const app = meta.rows[0]?.value;
  if (!app) return null;
  const cp = await client.query(`select min(latest_checkpoint) as c from "${schema}"._ponder_checkpoint`);
  return {
    ready: app.is_ready === 1,
    locked: app.is_locked === 1,
    heartbeatAt: Number(app.heartbeat_at ?? 0),
    buildId: app.build_id ?? null,
    tables: [...(app.table_names ?? []), ...(app.view_names ?? [])],
    headSec: checkpointSeconds(cp.rows[0]?.c),
  };
}

async function doSwitch(client, live, schema, reason) {
  const state = await schemaState(client, schema);
  if (!state) throw new Error(`schema ${schema} is not a Ponder index (no _ponder_meta)`);
  if (!state.ready) throw new Error(`schema ${schema} is not ready (its backfill is not complete)`);
  for (const n of state.tables) if (!validName(n)) throw new Error(`unexpected table name ${n}`);
  const from = await liveTarget(client, live);
  await ensureHistory(client);
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query('BEGIN');
      // A long read on a view holds its lock; give up after 5 s and try again instead of queueing every new reader behind us.
      await client.query("SET LOCAL lock_timeout = '5s'");
      const existing = await client.query('select viewname from pg_views where schemaname = $1', [live]);
      const keep = new Set([...state.tables, '_ponder_meta', '_ponder_checkpoint']);
      const stale = existing.rows.map((r) => r.viewname).filter((n) => !keep.has(n) && validName(n));
      for (const sql of switchStatements(live, schema, state.tables, stale)) await client.query(sql);
      await client.query('insert into bootr_offchain.live_switch (live_schema, from_schema, to_schema, reason) values ($1, $2, $3, $4)', [live, from, schema, reason]);
      await client.query('COMMIT');
      break;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (attempt >= 5) throw err;
      log(`switch attempt ${attempt} failed (${err instanceof Error ? err.message : err}); trying again`);
      await sleep(1000);
    }
  }
  log(`${live} now points at ${schema} (was ${from ?? 'nothing'}): ${reason}`);
}

async function heldBefore(client, live, schema) {
  await ensureHistory(client);
  const { rows } = await client.query('select 1 from bootr_offchain.live_switch where live_schema = $1 and to_schema = $2 limit 1', [live, schema]);
  return rows.length > 0;
}

// ------------------------------------------------------------------ commands

async function status(live) {
  await withClient(async (client) => {
    const target = await liveTarget(client, live);
    console.log(`${live} -> ${target ?? '(no views)'}`);
    const { rows } = await client.query("select schemaname from pg_tables where tablename = '_ponder_meta' order by schemaname");
    const now = Date.now();
    for (const { schemaname } of rows) {
      const s = await schemaState(client, schemaname);
      if (!s) continue;
      const beat = Math.round((now - s.heartbeatAt) / 1000);
      const lag = s.headSec === null ? 'no checkpoint' : `${Math.floor(now / 1000) - s.headSec} s behind the clock`;
      console.log(
        `${schemaname === target ? '*' : ' '} ${schemaname}  build ${s.buildId}  ${s.ready ? 'ready' : 'backfilling'}  ${writerAlive(s, now) ? 'writer alive' : `no writer (heartbeat ${beat} s ago)`}  ${lag}`,
      );
    }
  });
}

async function preflight(schema) {
  const busy = await withClient(async (client) => {
    const s = await schemaState(client, schema);
    return !!s && writerAlive(s, Date.now());
  });
  if (busy) {
    console.error(`[live-switch] another process is writing ${schema} (its heartbeat is fresh); not starting a second writer on it`);
    process.exit(3);
  }
}

async function watch(live, schema) {
  const slackSec = Number(process.env.INDEXER_SWITCH_SLACK_SEC) || DEFAULT_SLACK_SEC;
  const maxLagSec = Number(process.env.INDEXER_SWITCH_MAX_LAG_SEC) || DEFAULT_MAX_LAG_SEC;
  let lastWhy = '';
  let lastLogAt = 0;
  for (;;) {
    try {
      const done = await withClient(async (client) => {
        const targetName = await liveTarget(client, live);
        const mineState = await schemaState(client, schema);
        const targetState = targetName && targetName !== schema ? await schemaState(client, targetName) : null;
        const d = decide({
          schema,
          mine: { ready: !!mineState?.ready, headSec: mineState?.headSec ?? null },
          target: { name: targetName, headSec: targetState?.headSec ?? null, alive: !!targetState && writerAlive(targetState, Date.now()) },
          heldBefore: targetName && targetName !== schema ? await heldBefore(client, live, schema) : false,
          nowSec: Math.floor(Date.now() / 1000),
          slackSec,
          maxLagSec,
        });
        if (d.action === 'switch') {
          await doSwitch(client, live, schema, d.why);
          return true;
        }
        if (d.action === 'done' || d.action === 'superseded') {
          log(`${schema}: ${d.why}`);
          return true;
        }
        // One line when the reason changes, and one a minute while only its number moves.
        const kind = d.why.replace(/-?\d+/g, '#');
        if (kind !== lastWhy || Date.now() - lastLogAt > 60_000) {
          log(`${schema}: waiting, ${d.why}`);
          lastLogAt = Date.now();
          lastWhy = kind;
        }
        return false;
      });
      if (done) return;
    } catch (err) {
      log(`watch: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(2000);
  }
}

async function waitLive(live) {
  let said = false;
  for (;;) {
    try {
      const target = await withClient((client) => liveTarget(client, live));
      if (target) {
        log(`${live} points at ${target}`);
        return;
      }
    } catch (err) {
      log(`wait-live: ${err instanceof Error ? err.message : err}`);
    }
    if (!said) log(`${live} has no views yet; waiting for a writer to switch (or run: node scripts/live-switch.mjs switch <schema>)`);
    said = true;
    await sleep(3000);
  }
}

async function main() {
  const [cmd, schema] = process.argv.slice(2);
  const live = (process.env.INDEXER_LIVE_SCHEMA ?? '').trim() || DEFAULT_LIVE_SCHEMA;
  if (!validName(live)) throw new Error(`INDEXER_LIVE_SCHEMA="${live}" is not a schema name`);
  if (['preflight', 'watch', 'switch'].includes(cmd) && !validName(schema)) throw new Error(`${cmd} needs a schema name`);
  if (schema === live) throw new Error('the index schema and the views schema must differ');
  if (cmd === 'status') return status(live);
  if (cmd === 'preflight') return preflight(schema);
  if (cmd === 'watch') return watch(live, schema);
  if (cmd === 'switch') return withClient((client) => doSwitch(client, live, schema, 'switched by hand'));
  if (cmd === 'wait-live') return waitLive(live);
  throw new Error('usage: live-switch.mjs status | preflight <schema> | watch <schema> | switch <schema> | wait-live');
}

if (process.argv[1] && process.argv[1].endsWith('live-switch.mjs')) {
  main().catch((err) => {
    console.error('[live-switch] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
