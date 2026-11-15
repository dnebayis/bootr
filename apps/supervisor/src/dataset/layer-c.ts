/**
 * Layer c: the X accounts of x-sources.ts, read once by the platform and shared through the dataset
 * (docs/design/agent-behaviour.md section 6.4). This process holds no X credential: every read is asked of the sender
 * (sender-x.ts), which makes it with the platform account's token, meters it apart from every agent's own reads and
 * holds the day's cap (apps/sender/src/dataset-x.ts).
 *
 * OFF BY DEFAULT. With `DATASET_X_POSTS_PER_DAY` at 0 (or unset) no call that costs anything is made: the listed
 * accounts sit in `sv_ds_sources` as `pending`, and the only work is `sweepXText`, which lets go of words that can no
 * longer be confirmed. The layer also needs `DATASET_ENABLED`, like every other.
 *
 * One pass, in this order, each step inside what the day's budget has left (x-budget.ts):
 *
 *  1. `sweepXText` (x-text.ts): words that are too old, unconfirmed too long, or said by a listed page. No call to X.
 *  2. The day so far is asked of the sender (it costs nothing). The cap in force is the smaller of this process's
 *     setting and the sender's, and the units spent are the larger of the sender's count and this process's own: each
 *     side stops by itself.
 *  3. Confirmations: posts whose words are kept and are 20 hours old are checked against X; what X no longer shows is
 *     removed (x-text.ts rule 1).
 *  4. Lookups: a `pending` account gets its id (x-pin.ts, the first lookup), a `review` account its second look.
 *  5. The weekly look at pinned accounts, a few a day.
 *  6. Reads: the active accounts that are due (every X_READ_EVERY_MS, 20 minutes), least recently read first. A read
 *     asks for original posts above the newest id seen (`sinceId`, which never moves backwards), for no more posts
 *     than the account's share of the day and the day itself have left. An account whose share is used waits for the
 *     next UTC day; when the day has fewer than five units left, reading stops until then.
 *
 * A post becomes a sighting through x-build.ts and joins a record through store.ts `ingestSighting`, under the same
 * rules as a feed item, with the account's share of the day as its source cap. As in layer b, the back-off of a
 * failing account is written before its read, and one account's failure never stops the others.
 *
 * What the owner's panel shows comes from here: the day's note (`sv_cursors`, `dataset:x:<day>`: units, posts, user
 * reads, checks, why reading stopped, the last error; kept 30 days, store.ts `ageOut`) and the rows of `sv_ds_sources` with their status and reason.
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { cursors, dsSources } from '../db/schema.js';
import { rpcErrorText, type Logger } from '../log.js';
import { backoffMs } from './layer-b.js';
import { SenderXError, type SenderX, type XBudget } from './sender-x.js';
import { dayOf, ingestSighting, type IngestOptions } from './store.js';
import { clusterWeight } from './types.js';
import { askFor, capOf, postsLeft, rateOf, sharesOf, unitsLeft, X_PAGE_MIN, X_SHARE_MIN, X_USER_READ_UNITS } from './x-budget.js';
import { buildXSighting, sinceIdAt, xSourceInfo } from './x-build.js';
import { judgeFirstLook, judgeLook, listedOf, notedLook, pinX, stateOf, suspendX, X_FIRST_READ_BACK_MS, X_LOOK_EVERY_MS, type XState } from './x-pin.js';
import { applyXCheck, dueXChecks, purgeXSource, sweepXText, xChecksDueBy, type XTextSweep } from './x-text.js';

export const X_READ_EVERY_MIN = 20;
export const X_READ_EVERY_MS = X_READ_EVERY_MIN * 60_000;
export const X_READS_PER_PASS = 12;
export const X_LOOKUPS_PER_PASS = 8;
export const X_LOOKS_PER_PASS = 2;
export const X_CHECK_BATCH = 100;
export const X_CHECK_BATCHES_PER_PASS = 2;
/** Days of post counts an account's row keeps. */
export const X_DAYS_KEPT = 8;

/** Answers of the sender after which nothing more is asked in this pass: the layer cannot read at all right now. */
const CANNOT_READ: Record<string, string> = {
  dataset_x_off: "the sender has the X layer off (its DATASET_X_POSTS_PER_DAY is 0)",
  dataset_reader_unset: 'the sender has no account to read with (DATASET_X_READER_AGENT_ID)',
  not_connected: 'the account that reads for the dataset is not connected to X',
  revoked: 'the X authorisation of the account that reads for the dataset was revoked',
  refresh_failed: "the reading account's X token could not be refreshed",
  unauthorized: "the sender refused this process's key (DATASET_SENDER_KEY)",
  http_404: 'the sender has no dataset routes (its DATASET_SENDER_KEY is not set)',
  x_rate_limited: 'X is rate limiting the reading account',
};

export interface XLayerDeps {
  db: Db;
  log: Pick<Logger, 'info' | 'warn'>;
  /** The door to the sender; null when this process was not given one. */
  x: Pick<SenderX, 'budget' | 'resolve' | 'user' | 'posts' | 'check'> | null;
  /** `DATASET_X_POSTS_PER_DAY` as this process has it. */
  cap: number;
  recordsPerDay?: number;
  judgeLeftover?: IngestOptions['judgeLeftover'];
}

export interface XLayerReport {
  on: boolean;
  sweep: XTextSweep;
  confirmed: number;
  removed: number;
  pinned: number;
  suspended: number;
  looked: number;
  read: number;
  posts: number;
  created: number;
  attached: number;
  capped: number;
  dropped: number;
  failed: number;
  /** Why reading stopped in this pass: the day's cap, or the pace of the day. */
  stopped: 'cap' | 'pace' | null;
  error: string | null;
}

/** What the day's cursor holds: the sender's count of the day as last heard, this process's own, and how the last pass ended. */
export interface XDayNote {
  limit: number;
  units: number;
  posts: number;
  userReads: number;
  checks: number;
  /** This process's own count of what came back to it. */
  own: { posts: number; userReads: number; checks: number; looks: number };
  stopped: 'cap' | 'pace' | null;
  error: string | null;
  at: string;
}

export const xDayCursor = (day: string): string => `dataset:x:${day}`;

export async function readXDay(db: Db, day: string): Promise<XDayNote | null> {
  const [row] = await db.select({ value: cursors.value }).from(cursors).where(eq(cursors.name, xDayCursor(day))).limit(1);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<XDayNote>;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
    const own = (v.own ?? {}) as Partial<XDayNote['own']>;
    return { limit: n(v.limit), units: n(v.units), posts: n(v.posts), userReads: n(v.userReads), checks: n(v.checks), own: { posts: n(own.posts), userReads: n(own.userReads), checks: n(own.checks), looks: n(own.looks) }, stopped: v.stopped === 'cap' || v.stopped === 'pace' ? v.stopped : null, error: typeof v.error === 'string' ? v.error.slice(0, 300) : null, at: typeof v.at === 'string' ? v.at : '' };
  } catch {
    return null;
  }
}

async function writeXDay(db: Db, day: string, note: XDayNote, now: Date): Promise<void> {
  const value = JSON.stringify(note);
  await db.insert(cursors).values({ name: xDayCursor(day), value, updatedAt: now }).onConflictDoUpdate({ target: cursors.name, set: { value, updatedAt: now } });
}

const larger = (a: string, b: string): string => (BigInt(a) >= BigInt(b) ? a : b);
const nextMidnight = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/** The last X_DAYS_KEPT days of an account's counts, with `add` posts on `today`. */
function daysWith(days: Record<string, number> | undefined, today: string, add: number): Record<string, number> {
  const next = { ...(days ?? {}), [today]: (days?.[today] ?? 0) + add };
  return Object.fromEntries(
    Object.entries(next)
      .filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day))
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, X_DAYS_KEPT),
  );
}

export async function runXAccounts(deps: XLayerDeps, now: Date): Promise<XLayerReport> {
  const { db } = deps;
  const report: XLayerReport = { on: false, sweep: { expired: 0, unconfirmed: 0, superseded: 0 }, confirmed: 0, removed: 0, pinned: 0, suspended: 0, looked: 0, read: 0, posts: 0, created: 0, attached: 0, capped: 0, dropped: 0, failed: 0, stopped: null, error: null };
  // Letting go never waits for the budget, the sender or the switch.
  report.sweep = await sweepXText(db, now);
  const today = dayOf(now);
  const before = await readXDay(db, today);
  const own = before?.own ?? { posts: 0, userReads: 0, checks: 0, looks: 0 };
  const cap = capOf(deps.cap);
  const day = { limit: 0, units: before?.units ?? 0, posts: before?.posts ?? 0, userReads: before?.userReads ?? 0, checks: before?.checks ?? 0 };
  const note = async () => writeXDay(db, today, { ...day, own, stopped: report.stopped, error: report.error, at: now.toISOString() }, now);
  if (cap <= 0) {
    // Off: the note is written only where a day already has one, so an off layer leaves no trace of itself.
    if (before) await note();
    return report;
  }
  if (!deps.x) {
    report.error = 'DATASET_X_POSTS_PER_DAY is set, but SENDER_URL or DATASET_SENDER_KEY is not: the dataset process has no way to ask for X reads';
    await note();
    return report;
  }
  const x = deps.x;
  /** What the sender says of the day, held against this process's own count: the larger spend and the smaller cap. */
  const take = (b: XBudget) => {
    day.limit = Math.min(cap, b.limit);
    day.posts = Math.max(b.posts, own.posts);
    day.userReads = Math.max(b.userReads, own.userReads);
    day.checks = Math.max(b.checks, own.checks);
    day.units = Math.max(b.units, own.posts + own.checks + own.userReads * X_USER_READ_UNITS);
  };
  /** True when the failure means nothing more can be asked in this pass; the reason is then on the report. */
  const stops = (err: unknown): boolean => {
    if (!(err instanceof SenderXError)) return false;
    if (err.code === 'dataset_x_cap_reached') {
      report.stopped = 'cap';
      day.units = Math.max(day.units, day.limit);
      return true;
    }
    if (CANNOT_READ[err.code]) report.error = CANNOT_READ[err.code]!;
    return !!CANNOT_READ[err.code];
  };
  try {
    const budget = await x.budget();
    // Around midnight the two clocks can name different days for a moment: nothing is spent until they agree.
    if (budget.day !== today) return report;
    take(budget);
  } catch (err) {
    if (!stops(err)) report.error = `the sender did not answer: ${rpcErrorText(err, 120)}`;
    await note();
    return report;
  }
  if (day.limit <= 0) {
    report.error = CANNOT_READ.dataset_x_off!;
    await note();
    return report;
  }
  report.on = true;
  let stopped = false;

  // 3. Confirmations.
  for (let batch = 0; batch < X_CHECK_BATCHES_PER_PASS && !stopped; batch++) {
    const due = await dueXChecks(db, now, Math.min(X_CHECK_BATCH, unitsLeft(day)));
    if (!due.length) break;
    try {
      const res = await x.check(due.map((s) => s.externalId));
      own.checks += res.present.length;
      take(res.budget);
      const applied = await applyXCheck(db, due, res.present, res.gone, now);
      report.confirmed += applied.confirmed;
      report.removed += applied.removed;
    } catch (err) {
      stopped = stops(err);
      if (!stopped) deps.log.warn({ error: rpcErrorText(err, 200) }, 'dataset x: a confirmation failed');
      break;
    }
  }

  // 4. Lookups: the first one of a pending account, the second look the owner asked for.
  const waiting = stopped ? [] : await db.select().from(dsSources).where(and(eq(dsSources.layer, 'c'), inArray(dsSources.status, ['pending', 'review']), or(isNull(dsSources.nextFetchAt), lte(dsSources.nextFetchAt, now)))).orderBy(asc(dsSources.id)).limit(X_LOOKUPS_PER_PASS);
  for (const row of waiting) {
    const listed = listedOf(row);
    if (!listed) continue;
    if (unitsLeft(day) < X_USER_READ_UNITS) {
      report.stopped = 'cap';
      break;
    }
    try {
      const res = row.xUserId ? await x.user(row.xUserId) : await x.resolve(listed.handle);
      if (res.user) own.userReads++;
      take(res.budget);
      if (row.xUserId && res.user && res.user.id !== row.xUserId) throw new SenderXError(502, 'bad_answer');
      const verdict = judgeFirstLook(listed, res.user);
      if (verdict.ok && res.user) {
        if (await pinX(db, row, listed, { id: res.user.id, handle: verdict.handle, followers: verdict.followers }, now)) report.pinned++;
        else report.suspended++;
      } else if (!verdict.ok) {
        await suspendX(db, row.id, verdict.reason, now);
        if (verdict.gone && row.xUserId) report.removed += await purgeXSource(db, row.id, now);
        report.suspended++;
        deps.log.warn({ source: row.id, reason: verdict.reason }, 'dataset x: an account was not pinned');
      }
    } catch (err) {
      if (stops(err)) {
        stopped = true;
        break;
      }
      const failures = row.failures + 1;
      await db.update(dsSources).set({ failures, lastError: rpcErrorText(err, 200), nextFetchAt: new Date(now.getTime() + backoffMs(5, failures)), updatedAt: now }).where(eq(dsSources.id, row.id));
      report.failed++;
    }
  }

  const active = stopped ? [] : await db.select().from(dsSources).where(and(eq(dsSources.layer, 'c'), eq(dsSources.status, 'active'))).orderBy(sql`${dsSources.nextFetchAt} asc nulls first`, asc(dsSources.id));

  // 5. The weekly look: the accounts looked at longest ago, a few a day, so 41 looks are not one day's bill.
  const looksToday = Math.ceil(active.length / 7) + 1;
  const stale = active
    .filter((r) => r.xUserId && now.getTime() - (Date.parse(stateOf(r).lookedAt ?? '') || 0) >= X_LOOK_EVERY_MS)
    .sort((a, b) => (Date.parse(stateOf(a).lookedAt ?? '') || 0) - (Date.parse(stateOf(b).lookedAt ?? '') || 0))
    .slice(0, X_LOOKS_PER_PASS);
  const lost = new Set<string>();
  for (const row of stale) {
    if (stopped || own.looks >= looksToday || unitsLeft(day) < X_USER_READ_UNITS) break;
    try {
      own.looks++;
      const res = await x.user(row.xUserId!);
      if (res.user) own.userReads++;
      take(res.budget);
      if (res.user && res.user.id !== row.xUserId) throw new SenderXError(502, 'bad_answer');
      const verdict = judgeLook(stateOf(row), res.user);
      if (verdict.ok) {
        await notedLook(db, row, verdict, now);
        report.looked++;
      } else {
        await suspendX(db, row.id, verdict.reason, now);
        if (verdict.gone) report.removed += await purgeXSource(db, row.id, now);
        lost.add(row.id);
        report.suspended++;
        deps.log.warn({ source: row.id, reason: verdict.reason }, 'dataset x: an account was suspended');
      }
    } catch (err) {
      stopped = stops(err);
      if (stopped) break;
      deps.log.warn({ source: row.id, error: rpcErrorText(err, 200) }, 'dataset x: a look failed');
    }
  }

  // 6. Reads.
  const readable = active.filter((r) => !lost.has(r.id) && r.xUserId && listedOf(r));
  const shares = sharesOf(
    readable.map((r) => ({ id: r.id, weight: clusterWeight(listedOf(r)!.cluster), rate: rateOf(stateOf(r).days, today) })),
    day.limit,
  );
  const [{ n: unpinned } = { n: 0 }] = stopped ? [{ n: 0 }] : await db.select({ n: sql<number>`count(*)::int` }).from(dsSources).where(and(eq(dsSources.layer, 'c'), inArray(dsSources.status, ['pending', 'review'])));
  const reserve = stopped ? 0 : (await xChecksDueBy(db, nextMidnight(now))) + Number(unpinned) * X_USER_READ_UNITS;
  const msIntoDay = now.getTime() - Date.parse(`${today}T00:00:00.000Z`);
  const due = readable.filter((r) => !r.nextFetchAt || r.nextFetchAt.getTime() <= now.getTime()).slice(0, X_READS_PER_PASS);
  for (const row of due) {
    if (stopped) break;
    const listed = listedOf(row)!;
    const state = stateOf(row);
    const share = shares.get(row.id) ?? X_SHARE_MIN;
    const used = state.days?.[today] ?? 0;
    if (used >= share) {
      // Its share of the day is read: it waits for the next day, and the others go on.
      await db.update(dsSources).set({ nextFetchAt: nextMidnight(now), updatedAt: now }).where(eq(dsSources.id, row.id));
      continue;
    }
    const left = postsLeft({ limit: day.limit, units: day.units, posts: day.posts, reserve, msIntoDay });
    const ask = askFor(share - used, left);
    if (!ask) {
      report.stopped = day.limit - day.units - reserve < X_PAGE_MIN ? 'cap' : 'pace';
      break;
    }
    const failures = row.failures + 1;
    const retryAt = new Date(now.getTime() + backoffMs(X_READ_EVERY_MIN, failures));
    try {
      await db.update(dsSources).set({ lastFetchAt: now, failures, lastError: 'a read was started and did not finish', nextFetchAt: retryAt, updatedAt: now }).where(eq(dsSources.id, row.id));
      const since = state.sinceId && /^\d{1,25}$/.test(state.sinceId) ? state.sinceId : sinceIdAt(new Date(now.getTime() - X_FIRST_READ_BACK_MS));
      const res = await x.posts(row.xUserId!, since, ask);
      own.posts += res.posts.length;
      take(res.budget);
      const info = xSourceInfo(row.xUserId!, listed, row.xHandle ?? listed.handle);
      // Oldest first: the first sighting of an event is the earliest post about it.
      for (const post of [...res.posts].reverse()) {
        const built = buildXSighting(row.xUserId!, listed, post, now);
        if ('dropped' in built) {
          report.dropped++;
          continue;
        }
        // The account's share of the day is also the most it may add to the dataset (a read can pass the share by less than one page).
        const result = await ingestSighting(db, info, built.sighting, { now, recordsPerDay: deps.recordsPerDay, sourceRecordsPerDay: share + X_PAGE_MIN, sourceSightingsPerDay: share + X_PAGE_MIN, judgeLeftover: deps.judgeLeftover });
        if (result.outcome === 'created') report.created++;
        else if (result.outcome === 'attached') report.attached++;
        else if (result.outcome === 'capped') report.capped++;
      }
      const next: XState = { ...state, sinceId: res.posts.reduce((id, p) => larger(id, p.id), since), days: daysWith(state.days, today, res.posts.length), ...(res.more ? { truncated: (state.truncated ?? 0) + 1 } : {}) };
      await db
        .update(dsSources)
        .set({ state: next as unknown as Record<string, unknown>, lastFetchAt: now, lastOkAt: now, lastStatus: 200, failures: 0, lastError: null, nextFetchAt: new Date(now.getTime() + X_READ_EVERY_MS), updatedAt: now })
        .where(eq(dsSources.id, row.id));
      report.read++;
      report.posts += res.posts.length;
    } catch (err) {
      if (stops(err)) {
        // Not this account's failure: it is due again as it was.
        stopped = true;
        await db.update(dsSources).set({ failures: row.failures, lastError: row.lastError, nextFetchAt: row.nextFetchAt, updatedAt: now }).where(eq(dsSources.id, row.id)).catch(() => undefined);
        break;
      }
      report.failed++;
      const error = rpcErrorText(err, 200);
      deps.log.warn({ source: row.id, failures, error }, 'dataset x: a read failed');
      await db.update(dsSources).set({ lastFetchAt: now, lastStatus: err instanceof SenderXError ? err.status : null, failures, lastError: error, nextFetchAt: retryAt, updatedAt: now }).where(eq(dsSources.id, row.id)).catch(() => undefined);
    }
  }
  await note();
  return report;
}
