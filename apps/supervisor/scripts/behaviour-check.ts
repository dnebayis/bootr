/**
 * The weekly behaviour check (docs/design/agent-behaviour.md section 5; how to run it: docs/dev/behaviour-check.md).
 * One agent, one window, one table of the measures M1 to M10. It writes nothing anywhere.
 *
 *   pnpm --filter supervisor behaviour:check public   --agent playclankfish --from 2026-11-08 --to 2026-11-15
 *   DATABASE_URL=... pnpm --filter supervisor behaviour:check database --agent 1171616 --from 2026-11-08 --to 2026-11-15
 *
 * `public` reads only what anyone can (the indexer's coin list, the coin page's tape, the sender's public posts, X's
 * public embed) and marks what it cannot see "needs the database". `database` reads Bootr's own tables, read only:
 * with `DATABASE_URL` over a connection whose session and transaction both refuse writes, or, for a database that is
 * reached through a shell only (production: docs/STATUS.md section 2), in two steps that never carry an address or a
 * password: `--print-sql` writes the read as a psql script, and `--answers <file>` (or `-` for stdin) turns that
 * script's output into the table.
 *
 * `--agent` is an agent id or an X handle (public mode also takes a symbol or an address); several, separated by
 * commas, give one table each. `--from` and `--to` are UTC days (`2026-11-08`) or ISO times; `--to` is not included.
 * Without them the window is the seven whole UTC days before today.
 *
 * It lives under apps/supervisor/scripts, not the repository's top-level scripts folder the design note names: that
 * folder holds shell scripts and belongs to no package, while this one needs the supervisor's `pg`, `tsx` and
 * agent-core (the fact fingerprints the measures share with the gates), as `seed-own-agent.ts` beside it does.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { parseAnswers, printScript, runQueries, toInput, type Window } from '../src/behaviour-check/database.js';
import { DAY_MS, renderTable } from '../src/behaviour-check/measures.js';
import { PUBLIC_SOURCES, readPublic, type PublicSources } from '../src/behaviour-check/public.js';

export interface Args {
  mode: 'public' | 'database';
  agents: string[];
  from: number;
  to: number;
  printSql: boolean;
  answers: string | null;
  sources: PublicSources;
}

export const USAGE = `usage: behaviour-check <public|database> --agent <id|handle>[,...] [--from <day>] [--to <day>]
  public    [--site <url>] [--indexer <url>] [--sender <url>]
  database  with DATABASE_URL set, or: --print-sql (write the read as a psql script), --answers <file|-> (read that script's output)
  days are UTC (2026-11-08) or ISO times; --to is not included; default: the seven whole UTC days before today`;

function time(value: string, name: string): number {
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(at)) throw new Error(`${name} must be a UTC day (2026-11-08) or an ISO time`);
  return at;
}

export function parseArgs(argv: readonly string[], now: number): Args {
  const [mode, ...rest] = argv;
  if (mode !== 'public' && mode !== 'database') throw new Error(USAGE);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!flag.startsWith('--')) throw new Error(`unexpected "${flag}"\n${USAGE}`);
    if (flag === '--print-sql') flags.set(flag, 'true');
    else {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
      flags.set(flag, value);
    }
  }
  const known = ['--agent', '--from', '--to', '--print-sql', '--answers', '--site', '--indexer', '--sender'];
  for (const flag of flags.keys()) if (!known.includes(flag)) throw new Error(`unknown ${flag}\n${USAGE}`);
  const agents = (flags.get('--agent') ?? '').split(',').map((a) => a.trim().replace(/^@/, '')).filter(Boolean);
  if (!agents.length) throw new Error(`--agent is required\n${USAGE}`);
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const to = flags.has('--to') ? time(flags.get('--to')!, '--to') : today;
  const from = flags.has('--from') ? time(flags.get('--from')!, '--from') : to - 7 * DAY_MS;
  if (to <= from) throw new Error('--from must be before --to');
  const printSql = flags.has('--print-sql');
  const answers = flags.get('--answers') ?? null;
  if (mode === 'public' && (printSql || answers)) throw new Error('--print-sql and --answers belong to the database mode');
  if ((printSql || answers) && agents.length !== 1) throw new Error('--print-sql and --answers take one agent at a time');
  const url = (flag: string, fallback: string) => (flags.get(flag) ?? fallback).replace(/\/+$/, '');
  return { mode, agents, from, to, printSql, answers, sources: { site: url('--site', PUBLIC_SOURCES.site), indexer: url('--indexer', PUBLIC_SOURCES.indexer), sender: url('--sender', PUBLIC_SOURCES.sender), embed: PUBLIC_SOURCES.embed } };
}

/** The tables of one run, in the order the agents were given. */
export async function run(args: Args, env: NodeJS.ProcessEnv, deps: { now: () => number; fetch: typeof fetch; readStdin: () => string; say: (line: string) => void }): Promise<string[]> {
  if (args.mode === 'public') {
    const out: string[] = [];
    for (const agent of args.agents) out.push(renderTable(await readPublic({ fetch: deps.fetch, now: deps.now, sources: args.sources, onStep: deps.say }, agent, args.from, args.to)));
    return out;
  }
  const windowOf = (agent: string): Window => ({ agent, from: args.from, to: args.to });
  if (args.printSql) return [printScript(windowOf(args.agents[0]!))];
  if (args.answers) {
    const text = args.answers === '-' ? deps.readStdin() : readFileSync(args.answers, 'utf8');
    return [renderTable(toInput(parseAnswers(text), windowOf(args.agents[0]!), deps.now()))];
  }
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for the database mode (or use --print-sql and --answers; see docs/dev/behaviour-check.md)');
  // The session refuses writes whatever role the address names; the read's own transaction is read only as well.
  const client = new pg.Client({ connectionString: url, options: '-c default_transaction_read_only=on -c statement_timeout=120000' });
  await client.connect();
  try {
    const out: string[] = [];
    for (const agent of args.agents) out.push(renderTable(toInput(await runQueries(client, windowOf(agent)), windowOf(agent), deps.now())));
    return out;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const args = parseArgs(process.argv.slice(2), Date.now());
    const tables = await run(args, process.env, { now: Date.now, fetch: globalThis.fetch, readStdin: () => readFileSync(0, 'utf8'), say: (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(`${tables.join('\n\n')}\n`);
  })().catch((err: unknown) => {
    // The message only: a connection error can carry the database address.
    process.stderr.write(`behaviour-check: ${err instanceof Error ? err.message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://…') : 'failed'}\n`);
    process.exit(1);
  });
}
