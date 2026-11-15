/**
 * The words the dataset keeps of an X post, and how it lets go of them (X's developer policy, "Content compliance":
 * stored content is kept up to date with X; what is deleted, protected, suspended or withheld there is deleted here).
 *
 * What is kept of a post's words is one cleaned sentence of at most 120 characters (x-build.ts): the sighting's
 * `title`, which may stand as its record's headline, and the numbers found in it. The rules for those words:
 *
 *  1. Every X sighting, words kept or not, is confirmed against X once, X_CHECK_AFTER_MS (20 hours) after the post
 *     was read: the sender asks X which of the posts it still shows (one unit of the day's budget for each that is
 *     still there, so a post costs two units over its life). A sighting whose words were already let go still counts
 *     as a source on its record, which is why it is checked too. A post X no longer shows is REMOVED: its
 *     sighting row is deleted, its source no longer counts on the record, the record's headline, link and numbers
 *     that came from it are replaced or dropped, the record is graded again, and a record nothing else carries is
 *     withdrawn (it is offered to nobody again; its skeleton stays so that "already posted" and a later correction
 *     still have something to point at).
 *  2. Words that could not be confirmed within X_UNCONFIRMED_MAX_MS (24 hours) are let go unconfirmed: when the
 *     budget is spent, the sender is down or the layer was switched off, the words do not stay because nobody could
 *     ask. Compliance never depends on the budget.
 *  3. Words are let go after X_TEXT_KEEP_MS (44 hours) whatever happened, so no word is ever held more than 24 hours
 *     after X last showed the post.
 *  4. Words are let go at once when a listed page (a source that is not an X account and not an open venue) carries
 *     the same record with words of its own: the headline then comes from that page. An X post's words stand in a
 *     headline only while nothing else can.
 *  5. An account that turns protected or disappears has every sighting of it removed as in rule 1 (x-pin.ts).
 *
 * "Let go" means: the sighting's `title` is emptied and it is marked `withheld`, its numbers leave the record, and a
 * headline that was those words becomes another source's title or code's own "an item from <source>"; the words are
 * also taken out of the record's change list. What stays of a post that is still on X is its id, its link, its time,
 * the entity ids and the kind: nothing of its text.
 *
 * `sweepXText` (rules 2 to 4) needs no call to X and runs on every pass, with the layer on or off.
 */
import { and, asc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { dsRecords, dsSightings, dsSources } from '../db/schema.js';
import { clip, HEADLINE_MAX } from './clean.js';
import { gradeOf } from './grades.js';
import { isOpenVenue } from './sources.js';
import { CHANGES_MAX, type RecordRow } from './store.js';
import type { RecordChange, RecordNumber, RecordSource, RecordStatus } from './types.js';

const HOUR = 3_600_000;
export const X_CHECK_AFTER_MS = 20 * HOUR;
export const X_UNCONFIRMED_MAX_MS = 24 * HOUR;
export const X_TEXT_KEEP_MS = 44 * HOUR;
/** Kept X texts looked at in one pass. A day of the largest cap is 700 posts. */
export const X_KEPT_MAX = 2_000;
export const X_WITHDRAWN_HEADLINE = 'withdrawn: the post this came from is no longer on X';

const isX = sql`${dsSightings.sourceId} like 'x:%'`;
export const isXSourceId = (sourceId: string): boolean => sourceId.startsWith('x:');

/** A sighting of an X post, as far as letting go of it needs. */
export interface XSightingRef {
  id: string;
  sourceId: string;
  recordId: string;
  /** The post id. */
  externalId: string;
  title: string;
  link: string | null;
  publishedAt: Date | null;
  seenAt: Date;
  checkedAt: Date | null;
}

const REF = { id: dsSightings.id, sourceId: dsSightings.sourceId, recordId: dsSightings.recordId, externalId: dsSightings.externalId, title: dsSightings.title, link: dsSightings.link, publishedAt: dsSightings.publishedAt, seenAt: dsSightings.seenAt, checkedAt: dsSightings.checkedAt };
const json = <T>(value: T) => value as unknown as Record<string, unknown>[];
const asSources = (r: RecordRow) => r.sources as unknown as RecordSource[];
const asNumbers = (r: RecordRow) => r.numbers as unknown as RecordNumber[];
const asChanges = (r: RecordRow) => r.changes as unknown as RecordChange[];

/** The record's change list without `words` in it: what changed stays, what it said does not. */
function scrub(changes: RecordChange[], words: string): RecordChange[] {
  if (!words) return changes;
  return changes.map((c) => {
    if (c.from !== words && c.to !== words) return c;
    const { from, to, ...rest } = c;
    return { ...rest, ...(from !== undefined && from !== words ? { from } : {}), ...(to !== undefined && to !== words ? { to } : {}) };
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The headline a record takes when the words of sighting `leaving` go: the title of another source on the record (an
 * official one first, then the first listed page or account; never an open venue's while a closed source carries the
 * record), else "an item from <source>".
 */
async function headlineWithout(tx: Tx, record: RecordRow, sources: readonly RecordSource[], leaving: string): Promise<string> {
  const others = await tx
    .select({ sourceId: dsSightings.sourceId, title: dsSightings.title })
    .from(dsSightings)
    .where(and(eq(dsSightings.recordId, record.id), ne(dsSightings.id, leaving), ne(dsSightings.title, ''), eq(dsSightings.withheld, false), isNull(dsSightings.key)))
    .orderBy(asc(dsSightings.seenAt))
    .limit(50);
  const entry = (id: string) => sources.find((s) => s.sourceId === id);
  const closed = sources.some((s) => !s.open);
  const usable = others.filter((o) => entry(o.sourceId) && (!closed || !entry(o.sourceId)!.open));
  // A listed page before an X account: a post's words stand in a headline only while nothing else can.
  const rank = (o: { sourceId: string }) => (entry(o.sourceId)!.official ? 0 : 2) + (isXSourceId(o.sourceId) ? 1 : 0);
  const best = usable.sort((a, b) => rank(a) - rank(b))[0];
  if (best) return clip(best.title, HEADLINE_MAX);
  const first = sources.find((s) => !s.open) ?? sources[0];
  if (!first) return X_WITHDRAWN_HEADLINE;
  const [row] = await tx.select({ name: dsSources.name }).from(dsSources).where(eq(dsSources.id, first.sourceId)).limit(1);
  return `an item from ${row?.name ?? 'a listed source'}`;
}

/**
 * Lets go of the words of one X sighting (rules 2 to 4): the sighting stays as a counted sighting with its id, link
 * and time; its words and its numbers leave it and its record.
 */
export async function releaseXText(db: Db, s: XSightingRef, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(dsSightings).set({ title: '', excerpt: null, withheld: true }).where(eq(dsSightings.id, s.id));
    const record = await tx.query.dsRecords.findFirst({ where: eq(dsRecords.id, s.recordId) });
    if (!record) return;
    const words = clip(s.title, HEADLINE_MAX);
    const numbers = asNumbers(record).filter((n) => n.sourceId !== s.sourceId);
    const wasHeadline = !!s.title && (record.headline === words || record.headline === s.title);
    if (!wasHeadline && numbers.length === asNumbers(record).length) return;
    const headline = wasHeadline ? await headlineWithout(tx, record, asSources(record), s.id) : record.headline;
    const changes = [...scrub(asChanges(record), words), ...(wasHeadline ? [{ at: now.toISOString(), what: 'headline', to: headline }] : [])].slice(-CHANGES_MAX);
    await tx
      .update(dsRecords)
      .set({ headline, numbers: json(numbers), changes: json(changes), changedAt: now })
      .where(eq(dsRecords.id, record.id));
  });
}

/**
 * Removes one X sighting altogether (rule 1 and rule 5): the post is no longer on X, so nothing of it stays. The
 * record loses the source when this was its only sighting of it, is graded again, and is withdrawn when nothing else
 * carries it.
 */
export async function removeXSighting(db: Db, s: XSightingRef, now: Date): Promise<'removed' | 'withdrawn'> {
  return db.transaction(async (tx) => {
    await tx.delete(dsSightings).where(eq(dsSightings.id, s.id));
    const record = await tx.query.dsRecords.findFirst({ where: eq(dsRecords.id, s.recordId) });
    if (!record) return 'removed';
    const left = await tx.select({ sourceId: dsSightings.sourceId, link: dsSightings.link }).from(dsSightings).where(eq(dsSightings.recordId, record.id)).limit(500);
    const words = clip(s.title, HEADLINE_MAX);
    const at = now.toISOString();
    if (!left.length) {
      const changes = [...scrub(asChanges(record), words), ...(record.status === 'withdrawn' ? [] : [{ at, what: 'status', from: record.status, to: 'withdrawn' }])].slice(-CHANGES_MAX);
      await tx
        .update(dsRecords)
        .set({ headline: X_WITHDRAWN_HEADLINE, summary: null, link: null, numbers: [], sources: [], groups: 1, grade: 1, cited: false, eventTime: null, eventEnd: null, eventPrecision: 'unknown', status: 'withdrawn', changedAt: now, changes: json(changes) })
        .where(eq(dsRecords.id, record.id));
      return 'withdrawn';
    }
    const before = asSources(record);
    const again = left.find((l) => l.sourceId === s.sourceId);
    // The source stays on the record only through another post of it that is still there, and then with that post's link.
    const sources = again ? before.map((x) => (x.sourceId === s.sourceId && x.link === s.link ? { ...x, link: again.link } : x)) : before.filter((x) => x.sourceId !== s.sourceId);
    const { grade, groups } = gradeOf(sources, record.cited);
    const wasHeadline = !!s.title && (record.headline === words || record.headline === s.title);
    const headline = wasHeadline ? await headlineWithout(tx, record, sources, s.id) : record.headline;
    const link = record.link !== s.link ? record.link : ((sources.find((x) => x.official && x.link) ?? sources.find((x) => !x.open && x.link))?.link ?? null);
    // The time of the event was this post's own time only where the post was the official word.
    const timed = record.eventTime && s.publishedAt && record.eventTime.getTime() === s.publishedAt.getTime() && !sources.some((x) => x.official);
    const status: RecordStatus = record.status === 'corroborated' && groups < 2 ? 'open' : (record.status as RecordStatus);
    const changes = [
      ...scrub(asChanges(record), words),
      { at, what: 'source-removed', from: s.sourceId },
      ...(wasHeadline ? [{ at, what: 'headline', to: headline }] : []),
      ...(status !== record.status ? [{ at, what: 'status', from: record.status, to: status }] : []),
    ].slice(-CHANGES_MAX);
    await tx
      .update(dsRecords)
      .set({
        sources: json(sources),
        groups,
        grade,
        headline,
        link,
        numbers: json(asNumbers(record).filter((n) => n.sourceId !== s.sourceId)),
        observationCount: Math.max(1, record.observationCount - 1),
        ...(timed ? { eventTime: null, eventEnd: null, eventPrecision: 'unknown' } : {}),
        status,
        changedAt: now,
        changes: json(changes),
      })
      .where(eq(dsRecords.id, record.id));
    return 'removed';
  });
}

/** Removes every sighting of one X account (rule 5). Returns how many went. */
export async function purgeXSource(db: Db, sourceId: string, now: Date): Promise<number> {
  if (!isXSourceId(sourceId)) return 0;
  const rows = await db.select(REF).from(dsSightings).where(eq(dsSightings.sourceId, sourceId)).limit(10_000);
  for (const s of rows) await removeXSighting(db, s, now);
  return rows.length;
}

export interface XTextSweep {
  expired: number;
  unconfirmed: number;
  superseded: number;
}

/** Rules 2 to 4, with no call to X: what is too old, what could not be confirmed in time, what a listed page now says itself. */
export async function sweepXText(db: Db, now: Date): Promise<XTextSweep> {
  const report: XTextSweep = { expired: 0, unconfirmed: 0, superseded: 0 };
  const kept = await db.select(REF).from(dsSightings).where(and(isX, ne(dsSightings.title, ''))).orderBy(asc(dsSightings.seenAt)).limit(X_KEPT_MAX);
  if (!kept.length) return report;
  const pages = await db
    .selectDistinct({ recordId: dsSightings.recordId, sourceId: dsSightings.sourceId })
    .from(dsSightings)
    .where(and(inArray(dsSightings.recordId, [...new Set(kept.map((k) => k.recordId))]), ne(dsSightings.title, ''), eq(dsSightings.withheld, false), isNull(dsSightings.key), sql`${dsSightings.sourceId} not like 'x:%'`));
  const carried = new Set(pages.filter((p) => !isOpenVenue(p.sourceId)).map((p) => p.recordId));
  for (const s of kept) {
    const age = now.getTime() - s.seenAt.getTime();
    const why = age >= X_TEXT_KEEP_MS ? 'expired' : !s.checkedAt && age >= X_UNCONFIRMED_MAX_MS ? 'unconfirmed' : carried.has(s.recordId) ? 'superseded' : null;
    if (!why) continue;
    await releaseXText(db, s, now);
    report[why]++;
  }
  return report;
}

/** X sightings due for their one confirmation, oldest first: every one, words kept or not, since each counts on its record. */
export async function dueXChecks(db: Db, now: Date, limit: number): Promise<XSightingRef[]> {
  if (limit <= 0) return [];
  return db
    .select(REF)
    .from(dsSightings)
    .where(and(isX, isNull(dsSightings.checkedAt), lte(dsSightings.seenAt, new Date(now.getTime() - X_CHECK_AFTER_MS))))
    .orderBy(asc(dsSightings.seenAt))
    .limit(limit);
}

/** How many confirmations fall due before `until`: what the day's budget sets aside for them. */
export async function xChecksDueBy(db: Db, until: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dsSightings)
    .where(and(isX, isNull(dsSightings.checkedAt), lte(dsSightings.seenAt, new Date(until.getTime() - X_CHECK_AFTER_MS))));
  return Number(row?.n ?? 0);
}

/**
 * What X answered about `asked`: a post it still shows is confirmed, a post it no longer shows is removed. A post the
 * answer says nothing about stays unconfirmed, and rule 2 lets go of it in time.
 */
export async function applyXCheck(db: Db, asked: readonly XSightingRef[], present: readonly string[], gone: readonly string[], now: Date): Promise<{ confirmed: number; removed: number; withdrawn: number }> {
  const out = { confirmed: 0, removed: 0, withdrawn: 0 };
  const there = new Set(present);
  const away = new Set(gone);
  const confirmed = asked.filter((s) => there.has(s.externalId)).map((s) => s.id);
  if (confirmed.length) {
    await db.update(dsSightings).set({ checkedAt: now }).where(inArray(dsSightings.id, confirmed));
    out.confirmed = confirmed.length;
  }
  for (const s of asked) {
    if (there.has(s.externalId) || !away.has(s.externalId)) continue;
    out.removed++;
    if ((await removeXSighting(db, s, now)) === 'withdrawn') out.withdrawn++;
  }
  return out;
}
