/**
 * The said-ledger (docs/design/agent-behaviour.md section 6.2): what each agent already said on X, as code compares
 * it. One row of `sv_said` per post that went out: a single post, each post of a thread, a reply. The row holds the
 * post's fact fingerprints and the numbers behind them as written (agent-core `postFacts`), its first three words
 * (`openerOf`), its words without the common ones (`wordSet`) and a place for the dataset records it cited. It never
 * holds the text: that stays in `sv_actions`.
 *
 * Written when a publish completes, by the code that records the completion (`recordSaid`): the hosted loop's and an
 * own agent's settle, the tick's reconciliation of a publish whose outcome was unknown, the review queue's approval
 * and the scheduler's send. A post queued for the creator's review is not said yet and gives no row; the row of the
 * approved post does. Every write is keyed by the action's id, so writing twice changes nothing.
 *
 * The history: publishes of the last `SAID_KEEP_DAYS` days that completed before this code ran are read from
 * `sv_actions` once, `SAID_BACKFILL_PER_TICK` a tick, one agent after the other and each agent's oldest first
 * (`sweepSaid`). Agent by agent because the one index of `sv_actions` is on (agent, creation time): each read is then
 * a range of that index from where the last one stopped, never a scan of the table. Where it stands is a row of
 * `sv_cursors`, written after every batch, so a restart goes on where the last tick stopped and never starts over.
 * Rows older than `SAID_KEEP_DAYS` are deleted by the same sweep, once an hour, and with them the rows of the gates'
 * shadow log (`sv_gate_shadow`) older than `GATE_SHADOW_KEEP_DAYS`.
 *
 * Nothing here throws into a publish: a ledger that cannot be written is a warning, and the post is out either way.
 */
import { factFingerprints, openerOf, postFacts, type PendingAction } from '@bootr/agent-core';
import { and, asc, desc, eq, gt, lt, ne, sql } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { actions, agents, cursors, gateShadow, said, type SaidKind } from './db/schema.js';

const DAY_MS = 24 * 3_600_000;
/** The row of `sv_cursors` that says how far the history has been read. */
export const SAID_BACKFILL_CURSOR = 'said:backfill';
/** The delete of old rows runs at most this often per process. */
export const SAID_PRUNE_EVERY_MS = 3_600_000;
/** Words of one post kept for the cross-agent check: a post of 280 characters has fewer, a long one is cut here. */
export const SAID_MAX_WORDS = 80;
/**
 * The most posts of other agents one cross-agent check reads. The check's window is a time (`CROSS_AGENT_WINDOW_MS`),
 * and this is only a ceiling on what one publish may cost: at 24 posts a day it is reached with about 40 agents
 * posting at their limit for two days. Past it the newest posts are compared and the oldest of the window are not, so
 * a copy of one of those passes; nothing is ever refused because of the ceiling, and a warning says it was reached.
 */
export const SAID_OTHERS_MAX_ROWS = 2000;
/** Agents the history moves on through in one tick, each for one indexed probe: a bound on the tick, not on the history. */
export const SAID_BACKFILL_AGENTS_PER_TICK = 50;

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'log' | 'config'>;

/** How many days the ledger keeps a post; 0 = the ledger is off. A caller that holds only a part of the config has it off. */
export function saidKeepDays(ctx: { config?: { SAID_KEEP_DAYS?: unknown } | null }): number {
  const n = ctx.config?.SAID_KEEP_DAYS;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const STOP_WORDS = new Set(
  'a an and are as at be been but by can for from had has have he her here his how i if in into is it its just more my no not now of on one or our out she so than that the their then there these they this those to up was we were what when who will with you your'.split(' '),
);

/**
 * The words of a post as two posts are compared (the design note's matching by word set: common words out, numbers
 * kept as words): lowercased, links and handles left out, each word once, sorted. A cashtag is the word of its symbol.
 */
export function wordSet(text: string): string[] {
  return wordsOf(text).slice(0, SAID_MAX_WORDS);
}

/** `wordSet` without its cut: every word of a text, for a text that is not a post (the strings code hands an agent). */
export function wordsOf(text: string): string[] {
  if (typeof text !== 'string' || !text) return [];
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@＠]\w+/g, ' ')
    .split(/[^\p{L}\p{N}.%]+/u)
    .map((w) => w.replace(/^[.%]+|[.]+$/g, ''))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return [...new Set(words)].sort();
}

/** The share of words two posts have in common: the words in both over the words in either (0 to 1). */
export function wordOverlap(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const inA = new Set(a);
  let both = 0;
  for (const w of new Set(b)) if (inA.has(w)) both += 1;
  return both / (inA.size + new Set(b).size - both);
}

/** A completed publish as `sv_actions` holds it. */
export interface SaidSource {
  agentId: string;
  /** The `sv_actions` row the publish is recorded under. */
  actionId: string;
  /** The stored action: `{ tool, input: { text, thread?, record? } }`. */
  action: unknown;
  /** The stored result: the runtime's envelope (`{ status, result }`) or the result itself (the row of an approved or a scheduled post). */
  result: unknown;
  /** When it went out: the action row's `created_at`. */
  at: Date | number;
}

export type SaidInsert = typeof said.$inferInsert;

/** What one text gives a row: its fingerprints, the numbers behind them, its opener and its words. */
export function saidFieldsOf(text: string): Pick<SaidInsert, 'fingerprints' | 'facts' | 'opener' | 'words'> {
  return { fingerprints: factFingerprints(text), facts: postFacts(text).map((f) => ({ s: f.subject, u: f.unit, v: f.value })), opener: openerOf(text), words: wordSet(text) };
}

function recordIdsOf(record: unknown): string[] {
  const list = Array.isArray(record) ? record : record ? [record] : [];
  return list.map((r) => (r as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64).slice(0, 4);
}

/**
 * The ledger rows of one completed publish, or none: for anything that is not a `publish_post` or a `publish_reply`,
 * and for the turn's own row of a post that was queued for review (`queued`: it is not on X; the row of its approval
 * is). A thread gives one row per post that went out: the result says which (`parts`, `sent`), and a thread that was
 * cut gives rows for the posts before the cut only. Pure.
 */
export function saidRowsOf(src: SaidSource): SaidInsert[] {
  const action = src.action as { tool?: unknown; input?: { text?: unknown; thread?: unknown; record?: unknown } | null } | null;
  if (action?.tool !== 'publish_post' && action?.tool !== 'publish_reply') return [];
  const input = action.input ?? {};
  if (typeof input.text !== 'string' || !input.text.trim()) return [];
  const outer = (src.result ?? {}) as Record<string, unknown>;
  const inner = (outer.result !== null && typeof outer.result === 'object' ? outer.result : outer) as { queued?: unknown; postId?: unknown; parts?: unknown; sent?: unknown };
  if (inner.queued === true) return [];
  const postedAt = src.at instanceof Date ? src.at : new Date(src.at);
  const recordIds = recordIdsOf(input.record);
  const row = (id: string, kind: SaidKind, text: string, postId: unknown): SaidInsert => ({ id, agentId: src.agentId, actionId: src.actionId, postId: typeof postId === 'string' && postId ? postId : null, kind, postedAt, ...saidFieldsOf(text), recordIds });
  if (action.tool === 'publish_reply') return [row(src.actionId, 'reply', input.text, inner.postId)];
  const later = Array.isArray(input.thread) ? input.thread.map((p) => (p as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : [];
  const texts = [input.text, ...later];
  const ids = new Map<number, string>();
  if (Array.isArray(inner.parts)) for (const p of inner.parts as { n?: unknown; postId?: unknown }[]) if (typeof p?.n === 'number' && typeof p.postId === 'string') ids.set(p.n, p.postId);
  if (typeof inner.postId === 'string' && inner.postId && !ids.has(1)) ids.set(1, inner.postId);
  // A thread that settled says how many of its posts went out; a single post, or a result that does not say, is taken whole.
  const out = typeof inner.sent === 'number' && Number.isInteger(inner.sent) && inner.sent >= 0 ? Math.min(inner.sent, texts.length) : texts.length;
  return texts.slice(0, out).map((text, i) => row(i === 0 ? src.actionId : `${src.actionId}.t${i + 1}`, i === 0 ? 'original' : 'thread_part', text, ids.get(i + 1)));
}

/** Writes the ledger rows of a completed publish; the number of rows it gave. Never throws, and writing the same publish again changes nothing. */
export async function recordSaid(ctx: Ctx, src: SaidSource): Promise<number> {
  try {
    if (saidKeepDays(ctx) <= 0) return 0;
    const rows = saidRowsOf(src);
    if (!rows.length) return 0;
    await ctx.db.insert(said).values(rows).onConflictDoNothing();
    return rows.length;
  } catch (err) {
    ctx.log.warn({ agentId: src.agentId, actionId: src.actionId, err: err instanceof Error ? err.message : String(err) }, 'said-ledger: the rows of a publish could not be written');
    return 0;
  }
}

/** `recordSaid` for an action as the runtime settles it: nothing unless it is a publish that completed. */
export async function recordSaidOfPending(ctx: Ctx, agentId: string, pending: Pick<PendingAction, 'id' | 'action' | 'status' | 'result' | 'createdAt'> | null | undefined): Promise<void> {
  if (!pending || pending.status !== 'completed' || (pending.action.tool !== 'publish_post' && pending.action.tool !== 'publish_reply')) return;
  await recordSaid(ctx, { agentId, actionId: pending.id, action: pending.action, result: pending.result ?? null, at: pending.createdAt || ctx.now() });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** One original post of an agent as the repeat gate reads it: a single post, or a thread with the facts of all its posts. */
export interface SaidOriginal {
  actionId: string;
  postId: string | null;
  postedAt: number;
  /** The first three words of its first post. */
  opener: string;
  facts: { s: string; u: string; v: number }[];
}

/**
 * The agent's last `limit` original posts, newest first; a thread is one. One indexed read. `exceptActionId` leaves
 * out the rows of the action being decided (a repeated call of a step that already went out).
 */
export async function lastOriginals(ctx: Pick<SupervisorContext, 'db'>, agentId: string, limit: number, exceptActionId?: string | null): Promise<SaidOriginal[]> {
  const rows = await ctx.db
    .select({ actionId: said.actionId, postId: said.postId, kind: said.kind, postedAt: said.postedAt, opener: said.opener, facts: said.facts })
    .from(said)
    .where(and(eq(said.agentId, agentId), ne(said.kind, 'reply'), ...(exceptActionId ? [ne(said.actionId, exceptActionId)] : [])))
    .orderBy(desc(said.postedAt))
    // A thread has four posts at most (the tool takes no more).
    .limit(limit * 4);
  const out = new Map<string, SaidOriginal>();
  for (const r of rows) {
    let original = out.get(r.actionId);
    if (!original) {
      if (out.size >= limit) continue;
      original = { actionId: r.actionId, postId: null, postedAt: r.postedAt.getTime(), opener: '', facts: [] };
      out.set(r.actionId, original);
    }
    if (r.kind === 'original') {
      original.opener = r.opener;
      original.postId = r.postId;
    }
    original.facts.push(...(Array.isArray(r.facts) ? r.facts : []));
  }
  return [...out.values()];
}

/** An original post of another agent, as the cross-agent gate reads it. */
export interface SaidByOther {
  agentId: string;
  postId: string | null;
  postedAt: number;
  words: string[];
}

export interface SaidByOthers {
  posts: SaidByOther[];
  /** The window held more than `SAID_OTHERS_MAX_ROWS` posts: the oldest of them are not in `posts`. */
  truncated: boolean;
}

/**
 * The original posts (single posts and the posts of threads; no replies) the other agents made since `since` (epoch
 * ms), newest first. The bound is the time; `maxRows` is the ceiling on what one read may bring back
 * (`SAID_OTHERS_MAX_ROWS`). One indexed read.
 */
export async function saidByOthers(ctx: Pick<SupervisorContext, 'db'>, agentId: string, since: number, maxRows: number = SAID_OTHERS_MAX_ROWS): Promise<SaidByOthers> {
  const rows = await ctx.db
    .select({ agentId: said.agentId, postId: said.postId, postedAt: said.postedAt, words: said.words })
    .from(said)
    .where(and(gt(said.postedAt, new Date(since)), ne(said.agentId, agentId), ne(said.kind, 'reply')))
    .orderBy(desc(said.postedAt))
    .limit(maxRows + 1);
  return { posts: rows.slice(0, maxRows).map((r) => ({ agentId: r.agentId, postId: r.postId, postedAt: r.postedAt.getTime(), words: Array.isArray(r.words) ? r.words : [] })), truncated: rows.length > maxRows };
}

// ---------------------------------------------------------------------------
// The history and the retention (the tick's sweep)
// ---------------------------------------------------------------------------

export interface BackfillCursor {
  /** Publishes created from here (ISO) up to `until` belong to the history; later ones are written as they complete. */
  from: string;
  until: string;
  /** The agent whose history is being read; '' before the first. */
  agentId: string;
  /** The last publish of that agent that was read: its `created_at` to the microsecond (as Postgres wrote it) and its id. */
  after: string;
  afterId: string;
  done: boolean;
}

function cursorOf(value: string | undefined): BackfillCursor | null {
  if (!value) return null;
  try {
    const c = JSON.parse(value) as Partial<BackfillCursor>;
    if (c.done === true && typeof c.until === 'string') return { from: c.from ?? c.until, until: c.until, agentId: c.agentId ?? '', after: c.after ?? c.until, afterId: c.afterId ?? '', done: true };
    // A cursor that names no agent is one from before the history was read agent by agent: it is begun again (a row written twice changes nothing).
    if (typeof c.from !== 'string' || typeof c.until !== 'string' || typeof c.agentId !== 'string' || typeof c.after !== 'string' || typeof c.afterId !== 'string') return null;
    return { from: c.from, until: c.until, agentId: c.agentId, after: c.after, afterId: c.afterId, done: false };
  } catch {
    return null;
  }
}

/**
 * One agent's completed publishes from where the last read stopped up to `until`, oldest first, at most `limit`: a
 * range of the (agent, created_at) index of `sv_actions`, read in its order. The lower bound is said twice: plainly
 * (`created_at >= after`), which is what makes it an index range, and as the pair the cursor keeps, which leaves out
 * the publish it stopped at. `at` is the creation time to the microsecond, as the next cursor needs it.
 */
export function historyBatch(db: SupervisorContext['db'], cursor: Pick<BackfillCursor, 'agentId' | 'after' | 'afterId' | 'until'>, limit: number) {
  return db
    .select({ actionId: actions.actionId, agentId: actions.agentId, action: actions.action, result: actions.result, createdAt: actions.createdAt, at: sql<string>`to_char(${actions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(actions)
    .where(
      and(
        eq(actions.agentId, cursor.agentId),
        sql`${actions.createdAt} >= ${cursor.after}::timestamptz`,
        sql`(${actions.createdAt}, ${actions.actionId}) > (${cursor.after}::timestamptz, ${cursor.afterId})`,
        sql`${actions.createdAt} <= ${cursor.until}::timestamptz`,
        eq(actions.status, 'completed'),
        sql`${actions.action}->>'tool' in ('publish_post', 'publish_reply')`,
      ),
    )
    .orderBy(asc(actions.createdAt), asc(actions.actionId))
    .limit(limit);
}

export interface SaidSweepReport {
  /** Publishes of the history read this tick, and the ledger rows they gave. */
  read: number;
  written: number;
  /** The history is in: nothing more is read. */
  done: boolean;
  /** Ledger rows deleted for their age. */
  pruned: number;
  /** Rows of the gates' shadow log deleted for their age. */
  shadowPruned: number;
}

/** Per supervisor config (one per process; tests get their own): the history is in, and when old rows were last deleted. */
const backfilled = new WeakSet<object>();
const lastPrune = new WeakMap<object, number>();

/** For tests: forget what this process knows of the sweep (the cursor row stays). */
export function resetSaidSweep(config: object): void {
  backfilled.delete(config);
  lastPrune.delete(config);
}

/**
 * The tick's sweep: one bounded batch of the history, and once an hour the delete of ledger rows past their age and of
 * shadow-log rows past theirs (`GATE_SHADOW_KEEP_DAYS`; 0 keeps them all). With the ledger off (`SAID_KEEP_DAYS` at 0)
 * only the shadow log is trimmed. One read of the cursor per tick while the history is not in, none after that.
 */
export async function sweepSaid(ctx: Ctx, opts: { forcePrune?: boolean } = {}): Promise<SaidSweepReport> {
  const report: SaidSweepReport = { read: 0, written: 0, done: backfilled.has(ctx.config), pruned: 0, shadowPruned: 0 };
  const keepDays = saidKeepDays(ctx);
  const now = ctx.now();

  const last = lastPrune.get(ctx.config);
  if (opts.forcePrune || last === undefined || now - last >= SAID_PRUNE_EVERY_MS) {
    lastPrune.set(ctx.config, now);
    if (keepDays > 0) report.pruned = (await ctx.db.delete(said).where(lt(said.postedAt, new Date(now - keepDays * DAY_MS))).returning({ id: said.id })).length;
    const shadowDays = ctx.config.GATE_SHADOW_KEEP_DAYS;
    if (shadowDays > 0) report.shadowPruned = (await ctx.db.delete(gateShadow).where(lt(gateShadow.createdAt, new Date(now - shadowDays * DAY_MS))).returning({ id: gateShadow.id })).length;
    if (report.shadowPruned) ctx.log.info({ shadowPruned: report.shadowPruned }, 'gate shadow log: old rows deleted');
  }
  if (keepDays <= 0) return report;

  const perTick = ctx.config.SAID_BACKFILL_PER_TICK;
  if (report.done || !(perTick > 0)) return report;
  const stored = await ctx.db.query.cursors.findFirst({ where: eq(cursors.name, SAID_BACKFILL_CURSOR) });
  const fresh = (): BackfillCursor => ({ from: new Date(now - keepDays * DAY_MS).toISOString(), until: new Date(now).toISOString(), agentId: '', after: '', afterId: '', done: false });
  const cursor: BackfillCursor = cursorOf(stored?.value) ?? fresh();
  if (cursor.done) {
    backfilled.add(ctx.config);
    report.done = true;
    return report;
  }
  let left = perTick;
  // Whether the agent the cursor names may still have publishes to read: not before the first agent, and not once a read of its came back short.
  let more = cursor.agentId !== '';
  for (let hops = 0; left > 0 && !cursor.done; ) {
    if (!more) {
      if (hops >= SAID_BACKFILL_AGENTS_PER_TICK) break;
      hops += 1;
      const [next] = await ctx.db.select({ agentId: agents.agentId }).from(agents).where(gt(agents.agentId, cursor.agentId)).orderBy(asc(agents.agentId)).limit(1);
      if (!next) {
        cursor.done = true;
        break;
      }
      Object.assign(cursor, { agentId: next.agentId, after: cursor.from, afterId: '' });
    }
    const rows = await historyBatch(ctx.db, cursor, left);
    for (const r of rows) report.written += await recordSaid(ctx, { agentId: r.agentId, actionId: r.actionId, action: r.action, result: r.result, at: r.createdAt });
    report.read += rows.length;
    const tail = rows.at(-1);
    if (tail) Object.assign(cursor, { after: tail.at, afterId: tail.actionId });
    more = rows.length >= left;
    left -= rows.length;
  }
  await ctx.db
    .insert(cursors)
    .values({ name: SAID_BACKFILL_CURSOR, value: JSON.stringify(cursor), updatedAt: new Date(now) })
    .onConflictDoUpdate({ target: cursors.name, set: { value: JSON.stringify(cursor), updatedAt: new Date(now) } });
  if (cursor.done) {
    backfilled.add(ctx.config);
    report.done = true;
    ctx.log.info({ until: cursor.until }, 'said-ledger: the stored history is in');
  }
  if (report.read || report.pruned) ctx.log.info({ read: report.read, written: report.written, pruned: report.pruned, done: report.done }, 'said-ledger sweep');
  return report;
}
