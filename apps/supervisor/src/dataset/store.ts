/**
 * The dataset's store: sources, sightings and records in the supervisor's Postgres (`sv_ds_*`, migration 0016). One
 * writer, the dataset process (main.ts); the supervisor's API only reads (view.ts). `ingestSighting` is the one way a
 * sighting becomes part of a record: it finds the record by the steps of matching.ts or starts one, under the day's cap.
 *
 * Kept and dropped:
 *  - a sighting is deleted SIGHTING_KEEP_MS (30 days) after it was seen; a record, with its `posted` list, RECORD_KEEP_MS
 *    (90 days) after it was last reinforced, so "already posted" outlives the story;
 *  - at most `recordsPerDay` new records a UTC day. Sources of the home clusters may fill it; near clusters stop at
 *    NEAR_SHARE of it and far ones at FAR_SHARE, so a loud news day cannot push Base's own incident out. A sighting
 *    that would start a record past the cap is not stored and is counted (`sv_cursors`, `dataset:capped:<day>`); a
 *    sighting of a record that exists always attaches.
 */
import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { cursors, dsRecords, dsSightings, dsSources } from '../db/schema.js';
import { clip, HEADLINE_MAX, linkKey, SUMMARY_MAX } from './clean.js';
import { ENTITIES_MAX } from './entities.js';
import { expiryOf, gradeOf } from './grades.js';
import { MATCH_MAX_SPAN_MS, MATCH_WINDOW_MS, matchByWords, type WordsCandidate } from './matching.js';
import { CHAIN_SOURCES, OPEN_SOURCES } from './sources.js';
import { clusterWeight, type EventPrecision, type RecordChange, type RecordKind, type RecordNumber, type RecordPosted, type RecordSource, type RecordStatus, type Sighting } from './types.js';

export const SIGHTING_KEEP_MS = 30 * 86_400_000;
export const RECORD_KEEP_MS = 90 * 86_400_000;
export const DEFAULT_RECORDS_PER_DAY = 400;
export const NEAR_SHARE = 0.85;
export const FAR_SHARE = 0.6;
export const SOURCES_MAX = 20;
export const RECORD_NUMBERS_MAX = 12;
export const CHANGES_MAX = 20;
export const REFS_MAX = 10;

export type RecordRow = typeof dsRecords.$inferSelect;
export type SightingRow = typeof dsSightings.$inferSelect;
export type SourceRow = typeof dsSources.$inferSelect;

/** What a source is to a record: who it is, which organisation, and what it may speak for. */
export interface SourceInfo {
  id: string;
  name: string;
  cluster: string;
  group: string;
  officialFor: readonly string[];
}

export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
export const sightingIdOf = (sourceId: string, externalId: string): string => sha(`${sourceId}\n${externalId}`).slice(0, 32);
const recordIdOf = (sightingId: string): string => `r_${sha(`record\n${sightingId}`).slice(0, 12)}`;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Brings `sv_ds_sources` in line with the checked-in list: a new source gets a row, a changed one its new name, URL,
 * group and cluster, and an open source that left the file becomes `retired` (its sightings stay). Fetch state and a
 * person's `suspended` are never touched. X sources (`layer = 'c'`) are not in the file and are left alone.
 */
export async function syncSources(db: Db, now: Date): Promise<{ added: number; retired: number }> {
  const listed = [
    ...OPEN_SOURCES.map((s) => ({ id: s.id, layer: 'b', kind: s.kind as string, name: s.name, url: s.url as string | null, cluster: s.cluster as string, groupId: s.group, officialFor: [...s.officialFor], read: s.read })),
    ...CHAIN_SOURCES.map((s) => ({ id: s.id, layer: 'a', kind: 'chain', name: s.name, url: null as string | null, cluster: s.cluster as string, groupId: s.group, officialFor: [...s.officialFor], read: true })),
  ];
  const existing = new Map((await db.select({ id: dsSources.id, status: dsSources.status }).from(dsSources)).map((r) => [r.id, r.status]));
  let added = 0;
  for (const s of listed) {
    const { read, ...columns } = s;
    const before = existing.get(s.id);
    if (before === undefined) {
      await db.insert(dsSources).values({ ...columns, status: read ? 'active' : 'retired', statusReason: read ? null : 'listed, not read', createdAt: now, updatedAt: now });
      added++;
    } else {
      // A row a person suspended stays suspended; a listed source that came back into the list is active again.
      const status = !read ? 'retired' : before === 'retired' ? 'active' : before;
      await db.update(dsSources).set({ ...columns, status, updatedAt: now }).where(eq(dsSources.id, s.id));
    }
  }
  const ids = new Set(listed.map((s) => s.id));
  const gone = [...existing.entries()].filter(([id, status]) => !ids.has(id) && !id.startsWith('x:') && status !== 'retired').map(([id]) => id);
  if (gone.length) await db.update(dsSources).set({ status: 'retired', statusReason: 'left the source list', updatedAt: now }).where(inArray(dsSources.id, gone));
  return { added, retired: gone.length };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export type MatchedBy = 'new' | 'key' | 'link' | 'relation' | 'words' | 'judge';

export interface IngestOptions {
  /** When Bootr saw it. */
  now: Date;
  /** New records a UTC day; DEFAULT_RECORDS_PER_DAY when unset, 0 for no cap. */
  recordsPerDay?: number;
  /**
   * Matching step 4 (a later stage): asked only about what step 3 left undecided, it answers with the id of one of the
   * `leftover` records or null. With no judge a leftover sighting starts a record of its own.
   */
  judgeLeftover?: (sighting: Sighting, leftover: { recordId: string; overlap: number; headline: string }[]) => Promise<string | null>;
}

export type IngestResult =
  | { outcome: 'duplicate'; recordId: string }
  | { outcome: 'updated'; recordId: string }
  | { outcome: 'attached'; recordId: string; matchedBy: MatchedBy }
  | { outcome: 'created'; recordId: string; matchedBy: 'new' }
  | { outcome: 'capped' };

/** The ids among `ids` that are already stored: one read for a whole feed, so a re-read of known items costs nothing more. */
export async function knownSightings(db: Db, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.select({ id: dsSightings.id }).from(dsSightings).where(inArray(dsSightings.id, [...ids]));
  return new Set(rows.map((r) => r.id));
}

const sameNumber = (a: RecordNumber, b: RecordNumber) => a.what === b.what && a.unit === b.unit && a.sourceId === b.sourceId;
const asSources = (row: RecordRow) => row.sources as unknown as RecordSource[];
const asNumbers = (row: RecordRow) => row.numbers as unknown as RecordNumber[];
const asChanges = (row: RecordRow) => row.changes as unknown as RecordChange[];
const json = <T>(value: T) => value as unknown as Record<string, unknown>[];

function headlineOf(source: SourceInfo, s: Sighting): string {
  return s.withheld || !s.title ? `an item from ${source.name}` : clip(s.title, HEADLINE_MAX);
}

async function recordOfSighting(db: Db, where: SQL): Promise<string[]> {
  const rows = await db.selectDistinct({ recordId: dsSightings.recordId }).from(dsSightings).where(where).limit(5);
  return rows.map((r) => r.recordId);
}

/** Step 3's candidates: records that share an entity with the sighting and are inside the window, never metrics, chain records or withdrawn ones. */
async function wordCandidates(db: Db, s: Sighting, at: Date): Promise<(WordsCandidate & { headline: string })[]> {
  if (!s.entities.length) return [];
  const names = sql.join(
    s.entities.map((e) => sql`${e}`),
    sql`, `,
  );
  const rows = await db
    .select({ id: dsRecords.id, kind: dsRecords.kind, entities: dsRecords.entities, words: dsRecords.words, sources: dsRecords.sources, firstSeenAt: dsRecords.firstSeenAt, lastReinforcedAt: dsRecords.lastReinforcedAt, headline: dsRecords.headline })
    .from(dsRecords)
    .where(
      and(
        gte(dsRecords.lastReinforcedAt, new Date(at.getTime() - MATCH_WINDOW_MS)),
        gte(dsRecords.firstSeenAt, new Date(at.getTime() - MATCH_MAX_SPAN_MS)),
        ne(dsRecords.kind, 'metric'),
        ne(dsRecords.status, 'withdrawn'),
        sql`${dsRecords.coin} is null`,
        sql`${dsRecords.entities} ?| array[${names}]::text[]`,
      ),
    )
    .limit(500);
  return rows.map((r) => ({ ...r, kind: r.kind as RecordKind, sourceIds: (r.sources as unknown as RecordSource[]).map((x) => x.sourceId) }));
}

async function findRecord(db: Db, s: Sighting, at: Date, opts: IngestOptions): Promise<{ recordId: string; matchedBy: MatchedBy; cited: boolean } | null> {
  // Step 1: the same identity.
  if (s.key) {
    const [byKey] = await recordOfSighting(db, eq(dsSightings.key, s.key));
    if (byKey) return { recordId: byKey, matchedBy: 'key', cited: false };
    // A keyed sighting is a thing code named itself: it is that thing or a new one, never matched by its words.
    return null;
  }
  // A keyed sighting's link is the page of a whole measure (a chart, a list), not of one event: links never lead to it.
  const unkeyed = sql`${dsSightings.key} is null`;
  const ownKey = s.link ? linkKey(s.link) : null;
  if (ownKey) {
    const [byLink] = await recordOfSighting(db, and(eq(dsSightings.linkKey, ownKey), unkeyed)!);
    if (byLink) return { recordId: byLink, matchedBy: 'link', cited: false };
  }
  // Step 2: a stated relation, in either direction, and only when it names one record.
  const related = new Set<string>();
  if (s.refs.length) for (const id of await recordOfSighting(db, and(inArray(dsSightings.linkKey, s.refs), unkeyed)!)) related.add(id);
  if (ownKey) for (const id of await recordOfSighting(db, sql`${dsSightings.refs} @> ${JSON.stringify([ownKey])}::jsonb`)) related.add(id);
  if (related.size === 1) return { recordId: [...related][0]!, matchedBy: 'relation', cited: true };
  // Step 3: entities and words.
  const candidates = await wordCandidates(db, s, at);
  const byWords = matchByWords({ sourceId: s.sourceId, kind: s.kind, entities: s.entities, words: s.words, at }, candidates);
  if (byWords.recordId) return { recordId: byWords.recordId, matchedBy: 'words', cited: false };
  // Step 4's seam.
  if (byWords.leftover.length && opts.judgeLeftover) {
    const leftover = byWords.leftover.map((l) => ({ ...l, headline: candidates.find((c) => c.id === l.recordId)?.headline ?? '' }));
    const chosen = await opts.judgeLeftover(s, leftover).catch(() => null);
    if (chosen && leftover.some((l) => l.recordId === chosen)) return { recordId: chosen, matchedBy: 'judge', cited: false };
  }
  return null;
}

/** New records of `day` so far, and whether a source of `weight` may still start one. */
async function underCap(db: Db, day: string, weight: number, recordsPerDay: number): Promise<boolean> {
  if (recordsPerDay <= 0) return true;
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(dsRecords).where(eq(dsRecords.day, day));
  const share = weight >= 3 ? 1 : weight === 2 ? NEAR_SHARE : FAR_SHARE;
  return Number(row?.n ?? 0) < Math.floor(recordsPerDay * share);
}

async function countCapped(db: Db, day: string, now: Date): Promise<void> {
  const name = `dataset:capped:${day}`;
  await db
    .insert(cursors)
    .values({ name, value: '1', updatedAt: now })
    .onConflictDoUpdate({ target: cursors.name, set: { value: sql`(${cursors.value}::int + 1)::text`, updatedAt: now } });
}

function sightingValues(s: Sighting, id: string, recordId: string, matchedBy: MatchedBy, now: Date) {
  return {
    id,
    sourceId: s.sourceId,
    recordId,
    externalId: s.externalId,
    kind: s.kind,
    title: s.withheld ? '' : s.title,
    excerpt: s.withheld ? null : s.excerpt,
    withheld: s.withheld,
    link: s.link,
    linkKey: s.link ? linkKey(s.link) : null,
    key: s.key,
    refs: s.refs.slice(0, REFS_MAX),
    matchedBy,
    publishedAt: s.publishedAt,
    seenAt: now,
  };
}

/** A keyed reading read again (a day's metric, a week's count): its numbers and summary replace the old ones, with what changed noted. */
async function refreshKeyed(db: Db, record: RecordRow, s: Sighting, now: Date): Promise<boolean> {
  const before = asNumbers(record);
  const changes: RecordChange[] = [];
  for (const n of s.numbers) {
    const old = before.find((b) => sameNumber(b, n));
    if (!old || old.value !== n.value) changes.push({ at: now.toISOString(), what: `number:${n.what}`, ...(old ? { from: String(old.value) } : {}), to: String(n.value) });
  }
  if (!changes.length) return false;
  const numbers = [...s.numbers, ...before.filter((b) => !s.numbers.some((n) => sameNumber(b, n)))].slice(0, RECORD_NUMBERS_MAX);
  await db
    .update(dsRecords)
    .set({
      numbers: json(numbers),
      summary: s.summary ? clip(s.summary, SUMMARY_MAX) : record.summary,
      headline: record.status === 'withdrawn' || s.withheld || !s.title ? record.headline : clip(s.title, HEADLINE_MAX),
      lastReinforcedAt: now,
      changedAt: now,
      changes: json([...asChanges(record), ...changes].slice(-CHANGES_MAX)),
    })
    .where(eq(dsRecords.id, record.id));
  return true;
}

async function attach(db: Db, record: RecordRow, source: SourceInfo, s: Sighting, id: string, matchedBy: MatchedBy, cited: boolean, now: Date): Promise<void> {
  const sources = asSources(record);
  const entities = [...new Set([...record.entities, ...s.entities])].slice(0, ENTITIES_MAX);
  const official = source.officialFor.some((e) => entities.includes(e));
  const known = sources.some((x) => x.sourceId === source.id);
  const nextSources = known || sources.length >= SOURCES_MAX ? sources : [...sources, { sourceId: source.id, cluster: source.cluster, group: source.group, official, link: s.link, seenAt: now.toISOString() }];
  const isCited = record.cited || cited;
  const { grade, groups } = gradeOf(nextSources, isCited);
  const numbers = [...asNumbers(record), ...s.numbers.filter((n) => !asNumbers(record).some((b) => sameNumber(b, n)))].slice(0, RECORD_NUMBERS_MAX);
  const changes = [...asChanges(record)];
  // The official source's own title and page are the record's, once it is there; so is a readable title over a withheld one.
  const hadOfficial = sources.some((x) => x.official);
  const takeText = !s.withheld && !!s.title && ((official && !hadOfficial) || record.headline.startsWith('an item from '));
  let headline = record.headline;
  let words = record.words;
  if (takeText && clip(s.title, HEADLINE_MAX) !== record.headline) {
    headline = clip(s.title, HEADLINE_MAX);
    words = [...new Set([...record.words, ...s.words])].slice(0, 60);
    changes.push({ at: now.toISOString(), what: 'headline', from: record.headline, to: headline });
  }
  const link = (official && !hadOfficial && s.link) || record.link || s.link;
  const eventTime = (official && !hadOfficial && s.eventTime) || record.eventTime || s.eventTime;
  const eventPrecision = eventTime === record.eventTime ? record.eventPrecision : s.eventPrecision;
  const lastReinforcedAt = new Date(Math.max(record.lastReinforcedAt.getTime(), now.getTime()));
  const weight = Math.max(record.weight, clusterWeight(source.cluster));
  const status: RecordStatus = record.status === 'open' && groups >= 2 ? 'corroborated' : (record.status as RecordStatus);
  if (status !== record.status) changes.push({ at: now.toISOString(), what: 'status', from: record.status, to: status });
  await db.transaction(async (tx) => {
    await tx.insert(dsSightings).values(sightingValues(s, id, record.id, matchedBy, now));
    await tx
      .update(dsRecords)
      .set({
        entities,
        sources: json(nextSources),
        groups,
        grade,
        cited: isCited,
        numbers: json(numbers),
        headline,
        words,
        link,
        eventTime,
        eventEnd: record.eventEnd ?? s.eventEnd,
        eventPrecision,
        observationCount: record.observationCount + 1,
        lastReinforcedAt,
        weight,
        cluster: weight > record.weight ? source.cluster : record.cluster,
        status,
        changedAt: changes.length > asChanges(record).length ? now : record.changedAt,
        changes: json(changes.slice(-CHANGES_MAX)),
        expiresAt: expiryOf(record.kind as RecordKind, record.firstSeenAt, lastReinforcedAt, eventTime, eventPrecision as EventPrecision),
      })
      .where(eq(dsRecords.id, record.id));
  });
}

/**
 * One sighting into the store. A sighting already stored is a duplicate (a keyed one refreshes its record's numbers);
 * one that matches a record attaches to it; one that matches nothing starts a record, unless the day is full.
 */
export async function ingestSighting(db: Db, source: SourceInfo, s: Sighting, opts: IngestOptions): Promise<IngestResult> {
  const now = opts.now;
  const id = sightingIdOf(s.sourceId, s.externalId);
  const [stored] = await db.select({ recordId: dsSightings.recordId }).from(dsSightings).where(eq(dsSightings.id, id)).limit(1);
  if (stored) {
    if (!s.key) return { outcome: 'duplicate', recordId: stored.recordId };
    const record = await db.query.dsRecords.findFirst({ where: eq(dsRecords.id, stored.recordId) });
    return record && (await refreshKeyed(db, record, s, now)) ? { outcome: 'updated', recordId: record.id } : { outcome: 'duplicate', recordId: stored.recordId };
  }
  const at = s.publishedAt && s.publishedAt.getTime() < now.getTime() ? s.publishedAt : now;
  const found = await findRecord(db, s, at, opts);
  if (found) {
    const record = await db.query.dsRecords.findFirst({ where: eq(dsRecords.id, found.recordId) });
    if (record) {
      await attach(db, record, source, s, id, found.matchedBy, found.cited, now);
      return { outcome: 'attached', recordId: record.id, matchedBy: found.matchedBy };
    }
  }
  const weight = clusterWeight(source.cluster);
  const day = dayOf(now);
  if (!(await underCap(db, day, weight, opts.recordsPerDay ?? DEFAULT_RECORDS_PER_DAY))) {
    await countCapped(db, day, now);
    return { outcome: 'capped' };
  }
  const recordId = recordIdOf(id);
  const entities = s.entities.slice(0, ENTITIES_MAX);
  const official = source.officialFor.some((e) => entities.includes(e));
  const sources: RecordSource[] = [{ sourceId: source.id, cluster: source.cluster, group: source.group, official, link: s.link, seenAt: now.toISOString() }];
  const { grade, groups } = gradeOf(sources, false);
  await db.transaction(async (tx) => {
    await tx.insert(dsRecords).values({
      id: recordId,
      kind: s.kind,
      entities,
      cluster: source.cluster,
      weight,
      coin: s.coin ?? null,
      headline: headlineOf(source, s),
      summary: s.summary ? clip(s.summary, SUMMARY_MAX) : null,
      link: s.link,
      words: s.withheld ? [] : s.words,
      firstSeenAt: now,
      lastReinforcedAt: now,
      observationCount: 1,
      eventTime: s.eventTime,
      eventEnd: s.eventEnd,
      eventPrecision: s.eventPrecision,
      sources: json(sources),
      groups,
      grade,
      cited: false,
      numbers: json(s.numbers.slice(0, RECORD_NUMBERS_MAX)),
      status: 'open',
      expiresAt: expiryOf(s.kind, now, now, s.eventTime, s.eventPrecision),
      day,
    });
    await tx.insert(dsSightings).values(sightingValues(s, id, recordId, 'new', now));
  });
  return { outcome: 'created', recordId, matchedBy: 'new' };
}

// ---------------------------------------------------------------------------
// Ageing, the posted list, withdrawal
// ---------------------------------------------------------------------------

/** Deletes what is past its keeping time: sightings after 30 days, records 90 days after their last sighting, old cap counters. */
export async function ageOut(db: Db, now: Date): Promise<{ sightings: number; records: number }> {
  const sightings = await db.delete(dsSightings).where(lt(dsSightings.seenAt, new Date(now.getTime() - SIGHTING_KEEP_MS))).returning({ id: dsSightings.id });
  const records = await db.delete(dsRecords).where(lt(dsRecords.lastReinforcedAt, new Date(now.getTime() - RECORD_KEEP_MS))).returning({ id: dsRecords.id });
  await db.delete(cursors).where(and(sql`${cursors.name} like 'dataset:capped:%'`, lt(cursors.updatedAt, new Date(now.getTime() - SIGHTING_KEEP_MS))));
  return { sightings: sightings.length, records: records.length };
}

/**
 * Notes that an agent posted about a record: one atomic append, so the publish path (a later stage) and the dataset
 * process never overwrite each other. Nothing calls it yet.
 */
export async function markPosted(db: Db, recordId: string, entry: RecordPosted): Promise<boolean> {
  const rows = await db
    .update(dsRecords)
    .set({ posted: sql`${dsRecords.posted} || ${JSON.stringify([entry])}::jsonb` })
    .where(eq(dsRecords.id, recordId))
    .returning({ id: dsRecords.id });
  return rows.length > 0;
}

/** Takes one record out of every turn for good: later sightings still attach to it and it stays withdrawn. */
export async function withdrawRecord(db: Db, recordId: string, now: Date): Promise<boolean> {
  const record = await db.query.dsRecords.findFirst({ where: eq(dsRecords.id, recordId) });
  if (!record || record.status === 'withdrawn') return false;
  const changes = [...asChanges(record), { at: now.toISOString(), what: 'status', from: record.status, to: 'withdrawn' }].slice(-CHANGES_MAX);
  await db.update(dsRecords).set({ status: 'withdrawn', changedAt: now, changes: json(changes) }).where(eq(dsRecords.id, recordId));
  return true;
}
