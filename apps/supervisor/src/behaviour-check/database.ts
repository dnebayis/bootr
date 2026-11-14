/**
 * The behaviour check's database read (docs/dev/behaviour-check.md). Read only, by construction and by session:
 *
 *   - every statement is a `select` that answers one line of JSON, `{"q": <name>, "rows": [...]}`;
 *   - with a `DATABASE_URL` the statements run inside `begin transaction read only`, which Postgres itself enforces,
 *     and the transaction is rolled back;
 *   - either way no statement runs longer than `STATEMENT_TIMEOUT`: the limit is set for the read's own transaction;
 *   - or the same statements are printed as one psql script (`printScript`) for the read-only session of
 *     docs/STATUS.md section 2 (`PGOPTIONS=-c default_transaction_read_only=on`), and its output is read back
 *     (`parseAnswers`). That is how the owner runs it against production: no database address or password leaves the
 *     server, and what runs there is plain to read first.
 *
 * Both ways build the same statements and parse the same lines, so they cannot drift apart. The agent and the window
 * are written into the statements as literals (psql takes no parameters over a pipe), so both are held to a strict
 * shape first: an agent is an id or an X handle of letters, digits and underscores, a time is an ISO string this file
 * made itself.
 *
 * `sv_turns` (migration 0014) and `sv_gate_shadow` (the gates' shadow log) may not exist yet: each statement names the
 * table it needs, the first statement asks which are there, and a statement whose table is missing is not run.
 */
import type pg from 'pg';
import { DAY_MS, REPEAT_LOOKBACK_MS, type CheckInput, type PostRow } from './measures.js';

export const AGENT_RE = /^[A-Za-z0-9_]{1,80}$/;

export interface Window {
  /** An agent id, or its X handle without the @. */
  agent: string;
  from: number;
  to: number;
}

interface Statement {
  name: string;
  /** A table that must exist for the statement to run. */
  needs?: string;
  /** Context the table can do without: run after the read is complete, and a failure costs its own line only. */
  optional?: boolean;
  sql: string;
}

/**
 * How long one statement may run. The read goes against the live database, and a statement that outstays this is
 * stopped by Postgres itself (`canceling statement due to statement timeout`) rather than left to hold a backend.
 */
export const STATEMENT_TIMEOUT = '120s';
/** The answer that says every statement the table needs has answered: without it the output of a script is a read that stopped early. */
export const READ_COMPLETE = 'complete';

/** The tables the check reads that an older deployment, or a database without the sender, may not have. */
const OPTIONAL_TABLES = ['sv_turns', 'sv_gate_shadow', 'sender_actions', 'sender_inbox'] as const;

const stamp = (ms: number): string => `'${new Date(ms).toISOString()}'::timestamptz`;

/** Money a paid model call took, as inference.ts `CHARGED_MICRO_USDC` counts it: the receipt, or what a paid failure signed for. */
const CHARGED = `coalesce(receipt->'relay'->>'chargedMicroUsdc', case when status = 'failed' and (error in ('credit_exhausted', 'relay_failed_refund_due', 'direct_paid_no_response') or (error = 'upstream_rejected' and receipt->'payment'->'accepted'->>'scheme' = 'exact')) then receipt->'payment'->'accepted'->>'amount' end)::numeric`;
const PAID = `(status = 'succeeded' or (status = 'failed' and (error in ('credit_exhausted', 'relay_failed_refund_due', 'direct_paid_no_response') or (error = 'upstream_rejected' and receipt->'payment'->'accepted'->>'scheme' = 'exact'))))`;

export function statements(w: Window): Statement[] {
  if (!AGENT_RE.test(w.agent)) throw new Error('agent must be an agent id or an X handle (letters, digits, underscores)');
  if (!Number.isFinite(w.from) || !Number.isFinite(w.to) || w.to <= w.from) throw new Error('the window needs a start before its end');
  if (w.to - w.from > 92 * DAY_MS) throw new Error('the window is at most 92 days');
  const from = stamp(w.from);
  const to = stamp(w.to);
  const back = stamp(w.from - REPEAT_LOOKBACK_MS);
  // The one agent the window is about, by id or by handle; every statement reads through it.
  const who = `(select agent_id from sv_agents where agent_id = '${w.agent}' or lower(config->>'xHandle') = lower('${w.agent}') order by (agent_id = '${w.agent}') desc limit 1)`;
  const mine = `agent_id = ${who}`;
  return [
    {
      name: 'agent',
      sql: `select agent_id as id, config->>'xHandle' as handle, config->'token'->>'symbol' as symbol, coalesce((config->>'platform')::boolean, false) as platform from sv_agents where ${mine}`,
    },
    {
      // Publishes of the window and of the week before it (M1 looks back): text, outcome, refusal, and whether a source was named in a field.
      name: 'posts',
      sql: `select extract(epoch from created_at) * 1000 as at, action->>'tool' as tool, status, action->'input'->>'text' as text, action->'input'->'thread' as thread, result->>'error' as error,
        (jsonb_typeof(action->'input'->'attributions') = 'array' and jsonb_array_length(action->'input'->'attributions') > 0) or action->'input'->'record' is not null as attributed,
        coalesce(result->'result'->>'queued', 'false') = 'true' as queued
        from sv_actions where ${mine} and created_at >= ${back} and created_at < ${to} and action->>'tool' in ('publish_post', 'publish_reply') order by created_at`,
    },
    {
      // Every step of the window, without its content: the estimate of M5 while sv_turns has no rows for it.
      name: 'steps',
      sql: `select extract(epoch from created_at) * 1000 as at, action->>'tool' as tool, status, action->>'role' as role from sv_actions where ${mine} and created_at >= ${from} and created_at < ${to} order by created_at`,
    },
    {
      name: 'turns',
      needs: 'sv_turns',
      sql: `select role, thoughts, outcome, posted, replied, charged_micro_usdc as charged from sv_turns where ${mine} and started_at >= ${from} and started_at < ${to}`,
    },
    {
      // Thoughts and their cost: every paid model call but the creator's chat, pictures apart (a picture's key says so,
      // images.ts; the stored request is not opened here).
      name: 'fuel',
      sql: `select count(*) filter (where idempotency_key not like 'image:%')::int as thoughts, coalesce(sum(${CHARGED}) filter (where idempotency_key not like 'image:%'), 0)::text as charged, coalesce(sum(${CHARGED}) filter (where idempotency_key like 'image:%'), 0)::text as pictures
        from sv_inference where ${mine} and ${PAID} and created_at >= ${from} and created_at < ${to} and idempotency_key not like 'chat:%'`,
    },
    {
      name: 'approvals',
      sql: `select status, decided_by as "decidedBy", note from sv_approvals where ${mine} and kind in ('post', 'reply') and decided_at >= ${from} and decided_at < ${to}`,
    },
    {
      name: 'notes',
      sql: `select (select count(*)::int from sv_memories where ${mine} and created_at >= ${from} and created_at < ${to} and not (tags @> '["creator-request"]'::jsonb) and not (tags @> '["creator-request-answer"]'::jsonb)) as written,
        (select count(*)::int from sv_actions where ${mine} and created_at >= ${from} and created_at < ${to} and action->>'tool' = 'remember' and status = 'completed') as completed,
        (select count(*)::int from sv_actions where ${mine} and created_at >= ${from} and created_at < ${to} and action->>'tool' = 'remember' and status = 'failed') as failed`,
    },
    {
      name: 'checkpoint',
      sql: `select length(coalesce(state->>'memory', '')) as memory, length(coalesce(state->>'agenda', '')) as agenda, length(coalesce(state->>'summary', '')) as summary from sv_runtimes where ${mine}`,
    },
    {
      name: 'sender_rejected',
      needs: 'sender_actions',
      sql: `select coalesce(error, '') as error, count(*)::int as n from sender_actions where ${mine} and status = 'rejected' and created_at >= ${from} and created_at < ${to} group by 1 order by 2 desc`,
    },
    {
      // Mentions observed in the window, with the reply that answered each (the sender's own row for it), if any.
      name: 'mentions',
      needs: 'sender_inbox',
      sql: `select extract(epoch from i.observed_at) * 1000 as "observedAt", i.status, i.reason,
        (select extract(epoch from min(a.sent_at)) * 1000 from sender_actions a where a.agent_id = i.agent_id and a.kind = 'reply' and a.status = 'sent' and a.reply_to = i.post_id) as "sentAt"
        from sender_inbox i where i.${mine} and i.observed_at >= ${from} and i.observed_at < ${to}`,
    },
    {
      name: 'shadow',
      needs: 'sv_gate_shadow',
      sql: `select gate, code, enforced, count(*)::int as n from sv_gate_shadow where ${mine} and created_at >= ${from} and created_at < ${to} group by 1, 2, 3 order by 4 desc`,
    },
    {
      // How large the first observation was, per thought (the first user message of each request; a model call, not a
      // picture). The one statement that opens every stored request of the window, each tens of kilobytes: it runs
      // last and the read is whole without it, so if the time limit stops it, only its line of the table is lost.
      name: 'observation',
      optional: true,
      sql: `select count(*)::int as thoughts, coalesce(percentile_disc(0.5) within group (order by length(request->'messages'->1->>'content')), 0)::int as median, coalesce(max(length(request->'messages'->1->>'content')), 0)::int as max
        from sv_inference where ${mine} and created_at >= ${from} and created_at < ${to} and idempotency_key not like 'image:%' and idempotency_key not like 'chat:%' and request->'messages'->1->>'role' = 'user'`,
    },
  ];
}

// jsonb, not json: `json_agg` breaks its output over several lines, and an answer is one line.
const wrap = (s: Statement): string => `select jsonb_build_object('q', '${s.name}', 'rows', coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb))::text from (${s.sql.replace(/\s+/g, ' ')}) t`;
const TABLES_SQL = `select jsonb_build_object('q', 'tables', 'rows', jsonb_build_array(jsonb_build_object(${OPTIONAL_TABLES.map((t) => `'${t}', to_regclass('public.${t}') is not null`).join(', ')})))::text`;

/** The time limit, for this transaction only, as a statement that answers one line like every other (`set_config(..., true)` is `set local`). */
const TIMEOUT_SQL = `select jsonb_build_object('q', 'timeout', 'rows', jsonb_build_array(jsonb_build_object('statement_timeout', set_config('statement_timeout', '${STATEMENT_TIMEOUT}', true))))::text`;
const COMPLETE_SQL = `select jsonb_build_object('q', '${READ_COMPLETE}', 'rows', jsonb_build_array(jsonb_build_object('complete', true)))::text`;

/**
 * The read as one psql script: unaligned, tuples only, one JSON line per statement; a statement whose table is missing
 * is skipped by psql itself (`\if`). Meant for `psql -X` on a session that refuses writes; it changes no setting but
 * the two output ones and, for its own transaction, the statement time limit, and holds nothing else but selects.
 * The line `complete` closes the read; the optional statements come after it.
 */
export function printScript(w: Window): string {
  const lines = ['-- behaviour check: read only (docs/dev/behaviour-check.md)', '\\set ON_ERROR_STOP on', '\\pset tuples_only on', '\\pset format unaligned', 'begin transaction read only;', `set local statement_timeout = '${STATEMENT_TIMEOUT}';`, `${TABLES_SQL};`];
  for (const t of OPTIONAL_TABLES) lines.push(`select to_regclass('public.${t}') is not null as has_${t} \\gset`);
  const all = statements(w);
  const put = (s: Statement) => (s.needs ? lines.push(`\\if :has_${s.needs}`, `${wrap(s)};`, '\\endif') : lines.push(`${wrap(s)};`));
  for (const s of all.filter((x) => !x.optional)) put(s);
  lines.push(`${COMPLETE_SQL};`);
  for (const s of all.filter((x) => x.optional)) put(s);
  lines.push('rollback;');
  return `${lines.join('\n')}\n`;
}

export type Answers = Record<string, Record<string, unknown>[]>;

/** The JSON lines of a run (psql's output, or what `runQueries` collected). Lines that are not an answer (psql's `BEGIN`, `ROLLBACK`, blanks) are passed over. */
export function parseAnswers(text: string): Answers {
  const out: Answers = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const answer = parsed as { q?: unknown; rows?: unknown };
    if (typeof answer.q === 'string' && Array.isArray(answer.rows)) out[answer.q] = answer.rows as Record<string, unknown>[];
  }
  return out;
}

/**
 * Runs the statements over one connection, inside a read-only transaction that is rolled back whatever happens, each
 * under `STATEMENT_TIMEOUT`. A statement the table needs that fails (the time limit included) fails the read; an
 * optional one that fails is left out, and `toInput` says so.
 */
export async function runQueries(client: Pick<pg.ClientBase, 'query'>, w: Window): Promise<Answers> {
  const all = statements(w);
  const answers: Answers = {};
  const one = async (sql: string) => {
    const res = await client.query(sql);
    const line = Object.values((res.rows[0] ?? {}) as Record<string, unknown>)[0];
    Object.assign(answers, parseAnswers(typeof line === 'string' ? line : JSON.stringify(line ?? '')));
  };
  await client.query('begin transaction read only');
  try {
    await one(TABLES_SQL);
    await one(TIMEOUT_SQL);
    const present = (answers.tables?.[0] ?? {}) as Record<string, unknown>;
    const runs = (s: Statement) => !s.needs || present[s.needs] === true;
    for (const s of all.filter((x) => !x.optional && runs(x))) await one(wrap(s));
    answers[READ_COMPLETE] = [{ complete: true }];
    // Last, since an error ends the transaction: nothing after an optional statement depends on it.
    for (const s of all.filter((x) => x.optional && runs(x))) {
      try {
        await one(wrap(s));
      } catch {
        break;
      }
    }
  } finally {
    await client.query('rollback');
  }
  return answers;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Every part of a publish as one text: the first post and the posts of its thread. */
function wholeText(text: unknown, thread: unknown): string {
  const later = Array.isArray(thread) ? thread.map((p) => (p as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === 'string') : [];
  return [str(text), ...later].filter(Boolean).join('\n');
}

/** The answers as the measures take them. Throws when the agent is not in the database: a table of zeros for a typo would read as a quiet week. */
export function toInput(answers: Answers, w: Window, readAt: number): CheckInput {
  const agent = answers.agent?.[0];
  if (!agent) throw new Error(`no agent "${w.agent}" in sv_agents (give its agent id, or its X handle without the @)`);
  const tables = (answers.tables?.[0] ?? {}) as Record<string, unknown>;
  const posts: PostRow[] = (answers.posts ?? []).map((r) => ({
    at: num(r.at),
    kind: r.tool === 'publish_reply' ? 'reply' : 'post',
    status: r.status === 'completed' ? 'completed' : r.status === 'failed' ? 'failed' : 'open',
    text: wholeText(r.text, r.thread),
    error: strOrNull(r.error),
    attributed: r.attributed === true,
    queued: r.queued === true,
  }));
  const fuel = answers.fuel?.[0];
  const observation = answers.observation?.[0];
  const checkpoint = answers.checkpoint?.[0];
  const notes = answers.notes?.[0];
  const caveats: string[] = [];
  if (tables.sv_turns !== true) caveats.push('sv_turns is not in this database yet (migration 0014): M5 is an estimate.');
  else if (!(answers.turns ?? []).length) caveats.push('sv_turns has no row for this window (it is written from the deploy of migration 0014 on): M5 is an estimate.');
  if (tables.sv_gate_shadow !== true) caveats.push('sv_gate_shadow is not in this database yet: M10 has nothing to read.');
  if (tables.sender_actions !== true || tables.sender_inbox !== true) caveats.push('The sender\'s tables are not in this database: M7 and the sender\'s own refusals are missing.');
  if (!observation) caveats.push(`The size of the first observation was not read: its statement did not answer (it opens every stored request of the window and is stopped after ${STATEMENT_TIMEOUT}), or the read ended before it.`);
  if (fuel && num(fuel.pictures) > 0) caveats.push(`Pictures cost ${(num(fuel.pictures) / 1_000_000).toFixed(2)} USDC in the window; M6 counts thoughts only.`);
  return {
    mode: 'database',
    agent: { id: str(agent.id), handle: strOrNull(agent.handle), symbol: strOrNull(agent.symbol), platform: agent.platform === true },
    from: w.from,
    to: w.to,
    readAt,
    posts,
    fuel: fuel ? { thoughts: num(fuel.thoughts) || 0, chargedMicroUsdc: num(fuel.charged) || 0 } : null,
    turns: tables.sv_turns === true ? (answers.turns ?? []).map((r) => ({ role: str(r.role), thoughts: num(r.thoughts) || 0, outcome: str(r.outcome), posted: num(r.posted) || 0, replied: num(r.replied) || 0, chargedMicroUsdc: num(r.charged) || 0 })) : null,
    steps: (answers.steps ?? []).map((r) => ({ at: num(r.at), tool: str(r.tool), status: str(r.status), role: strOrNull(r.role) })),
    approvals: (answers.approvals ?? []).map((r) => ({ status: str(r.status), decidedBy: strOrNull(r.decidedBy), note: strOrNull(r.note) })),
    senderRejected: tables.sender_actions === true ? (answers.sender_rejected ?? []).map((r) => ({ error: str(r.error), n: num(r.n) || 0 })) : null,
    mentions: tables.sender_inbox === true && tables.sender_actions === true ? (answers.mentions ?? []).map((r) => ({ observedAt: num(r.observedAt), status: str(r.status), reason: strOrNull(r.reason), sentAt: r.sentAt === null || r.sentAt === undefined ? null : num(r.sentAt) })) : null,
    shadow: tables.sv_gate_shadow === true ? (answers.shadow ?? []).map((r) => ({ gate: str(r.gate), code: str(r.code), enforced: r.enforced === true, n: num(r.n) || 0 })) : null,
    notes: notes ? { written: num(notes.written) || 0, rememberCompleted: num(notes.completed) || 0, rememberFailed: num(notes.failed) || 0 } : null,
    checkpoint: checkpoint ? { memory: num(checkpoint.memory) || 0, agenda: num(checkpoint.agenda) || 0, summary: num(checkpoint.summary) || 0 } : null,
    observation: observation && num(observation.thoughts) > 0 ? { thoughts: num(observation.thoughts), medianChars: num(observation.median) || 0, maxChars: num(observation.max) || 0 } : null,
    caveats,
  };
}
