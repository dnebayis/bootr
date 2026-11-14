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
 *    sighting of a record that exists always attaches;
 *  - one source's share of a day: at most `sourceRecordsPerDay` new records and `sourceSightingsPerDay` sightings from
 *    one source a UTC day, so one forum or one desk, flooded or compromised, cannot take its whole tier's share of the
 *    day. Past them a sighting of that source is not stored and is counted the same way. Bootr's own data (layer a)
 *    has no stranger behind it and passes 0 for both.
 */
import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { cursors, dsRecords, dsSightings, dsSources } from '../db/schema.js';
import { clip, HEADLINE_MAX, linkKey, SUMMARY_MAX } from './clean.js';
import { ENTITIES_MAX } from './entities.js';
import { expiryOf, gradeOf } from './grades.js';
import { kindsCompatible, MATCH_MAX_SPAN_MS, MATCH_WINDOW_MS, matchByWords, wordSet, type WordsCandidate } from './matching.js';
import { CHAIN_SOURCES, isOpenVenue, OPEN_SOURCES } from './sources.js';
import { clusterWeight, type EventPrecision, type RecordChange, type RecordKind, type RecordNumber, type RecordPosted, type RecordSource, type RecordStatus, type Sighting } from './types.js';

export const SIGHTING_KEEP_MS = 30 * 86_400_000;
export const RECORD_KEEP_MS = 90 * 86_400_000;
export const DEFAULT_RECORDS_PER_DAY = 400;
export const DEFAULT_SOURCE_RECORDS_PER_DAY = 40;
export const DEFAULT_SOURCE_SIGHTINGS_PER_DAY = 120;
export const NEAR_SHARE = 0.85;
export const FAR_SHARE = 0.6;
export const SOURCES_MAX = 20;
export const RECORD_NUMBERS_MAX = 12;
export const CHANGES_MAX = 20;
export const REFS_MAX = 10;
/** Records step 3 looks at for one sighting. */
export const CANDIDATES_MAX = 300;

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
  /** An open venue (sources.ts): its sightings are carried on a record and change nothing else of it. */
  open?: boolean;
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
  /** New records one source may start a UTC day; DEFAULT_SOURCE_RECORDS_PER_DAY when unset, 0 for no cap. */
  sourceRecordsPerDay?: number;
  /** Sightings one source may add a UTC day, new records or not; DEFAULT_SOURCE_SIGHTINGS_PER_DAY when unset, 0 for no cap. */
  sourceSightingsPerDay?: number;
  /**
   * Matching step 4 (a later stage): asked only about what step 3 left undecided, it answers with the id of one of the
   * `leftover` records or null. With no judge a leftover sighting starts a record of its own.
   */
  judgeLeftover?: (sighting: Sighting, leftover: { recordId: string; overlap: number; headline: string }[]) => Promise<string | null>;
}

export type IngestResult =
  | { outcome: 'duplicate'; recordId: string }
  | { outcome: 'updated'; recordId: string }
  | { outcome: 'attached'; recordId: string; matchedBy: MatchedBy; /** A second record of the same event, merged into this one. */ merged?: string }
  | { outcome: 'created'; recordId: string; matchedBy: 'new' }
  | { outcome: 'capped'; /** Which bound it met: the day's, or its own source's share of the day. */ by: 'day' | 'source' };

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

/**
 * Step 3's candidates: records that share an entity with the sighting and are inside the window, never metrics, chain
 * records or withdrawn ones, each with the titles its sources gave it (a withheld title gives no words).
 */
async function wordCandidates(db: Db, s: Sighting, at: Date): Promise<(WordsCandidate & { headline: string })[]> {
  if (!s.entities.length) return [];
  const names = sql.join(
    s.entities.map((e) => sql`${e}`),
    sql`, `,
  );
  const rows = await db
    .select({ id: dsRecords.id, kind: dsRecords.kind, entities: dsRecords.entities, sources: dsRecords.sources, firstSeenAt: dsRecords.firstSeenAt, lastReinforcedAt: dsRecords.lastReinforcedAt, headline: dsRecords.headline })
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
    .limit(CANDIDATES_MAX);
  if (!rows.length) return [];
  const titles = await db
    .select({ recordId: dsSightings.recordId, sourceId: dsSightings.sourceId, title: dsSightings.title })
    .from(dsSightings)
    .where(
      and(
        inArray(
          dsSightings.recordId,
          rows.map((r) => r.id),
        ),
        eq(dsSightings.withheld, false),
        sql`${dsSightings.key} is null`,
      ),
    )
    .limit(CANDIDATES_MAX * 8);
  // A title from an open venue speaks for a record only while nothing else carries it: on a record a desk or an
  // official source carries, a stranger's topic must not become the words later sightings are matched against.
  const closed = new Set(rows.filter((r) => (r.sources as unknown as RecordSource[]).some((x) => !x.open)).map((r) => r.id));
  const byRecord = new Map<string, { sourceId: string; words: string[] }[]>();
  for (const t of titles) {
    if (closed.has(t.recordId) && isOpenVenue(t.sourceId)) continue;
    byRecord.set(t.recordId, [...(byRecord.get(t.recordId) ?? []), { sourceId: t.sourceId, words: wordSet(t.title) }]);
  }
  return rows.map(({ sources: _sources, ...r }) => ({ ...r, kind: r.kind as RecordKind, sightings: byRecord.get(r.id) ?? [] }));
}

/**
 * Of the records a link relation points at, the ones the sighting can be about: a shared entity, inside the window the
 * word match uses, not withdrawn. A link in somebody's text is a claim that two things belong together; without a
 * shared name and a near time it is only a link.
 */
async function relatable(db: Db, ids: readonly string[], s: Sighting, at: Date): Promise<string[]> {
  if (!ids.length || !s.entities.length) return [];
  const rows = await db.select({ id: dsRecords.id, entities: dsRecords.entities, firstSeenAt: dsRecords.firstSeenAt, lastReinforcedAt: dsRecords.lastReinforcedAt }).from(dsRecords).where(inArray(dsRecords.id, [...ids]));
  const t = at.getTime();
  return rows
    .filter((r) => r.entities.some((e) => s.entities.includes(e)) && t >= r.firstSeenAt.getTime() - MATCH_WINDOW_MS && t <= r.lastReinforcedAt.getTime() + MATCH_WINDOW_MS && t <= r.firstSeenAt.getTime() + MATCH_MAX_SPAN_MS)
    .map((r) => r.id);
}

interface Found {
  recordId: string;
  matchedBy: MatchedBy;
  cited: boolean;
  /**
   * The sighting found the record by pointing at it (a link in its own text). Such a sighting is carried and counted,
   * and never gives the record its headline, its link or its time: whoever writes a link chooses where it lands.
   */
  cites?: boolean;
  /** Another record the sighting's words say it also is: one event that had two records. */
  also?: string;
}

async function findRecord(db: Db, s: Sighting, at: Date, opts: IngestOptions): Promise<Found | null> {
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
  let tied: Found | null = null;
  if (ownKey) {
    const [byLink] = await recordOfSighting(db, and(eq(dsSightings.linkKey, ownKey), unkeyed)!);
    if (byLink) tied = { recordId: byLink, matchedBy: 'link', cited: false };
  }
  // Step 2: a stated relation, in either direction, only when it names one record, and only a record the sighting
  // shares a name and a time with (`relatable`).
  if (!tied) {
    const cites = s.refs.length ? await recordOfSighting(db, and(inArray(dsSightings.linkKey, s.refs), unkeyed)!) : [];
    const citedBy = ownKey ? await recordOfSighting(db, sql`${dsSightings.refs} @> ${JSON.stringify([ownKey])}::jsonb`) : [];
    const pointed = [...new Set([...cites, ...citedBy])];
    const related = pointed.length === 1 ? await relatable(db, pointed, s, at) : [];
    if (related.length === 1) tied = { recordId: related[0]!, matchedBy: 'relation', cited: true, cites: !citedBy.includes(related[0]!) };
  }
  // Step 3: entities and words. Also asked of a sighting its link already placed: when its words name another record,
  // the two were one event.
  const candidates = await wordCandidates(db, s, at);
  const byWords = matchByWords({ sourceId: s.sourceId, kind: s.kind, entities: s.entities, words: s.words, at }, candidates);
  if (tied) return byWords.recordId && byWords.recordId !== tied.recordId ? { ...tied, also: byWords.recordId } : tied;
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

/** What `sourceId` added on `day` so far: its sightings, and how many of them started a record. */
async function sourceDay(db: Db, sourceId: string, day: string): Promise<{ sightings: number; records: number }> {
  const [row] = await db
    .select({ sightings: sql<number>`count(*)::int`, records: sql<number>`count(*) filter (where ${dsSightings.matchedBy} = 'new')::int` })
    .from(dsSightings)
    .where(and(eq(dsSightings.sourceId, sourceId), gte(dsSightings.seenAt, new Date(`${day}T00:00:00.000Z`))));
  return { sightings: Number(row?.sightings ?? 0), records: Number(row?.records ?? 0) };
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

/**
 * A sighting joins a record that exists. What it may change depends on who carries it and how it got there:
 *
 *  - it is official only for an entity the record ALREADY had and the item itself is about (`named`). The sighting's
 *    own entities are merged in afterwards, so a source cannot make itself official by bringing its own name along;
 *  - the record's headline, link and event time change hands only to such an official source, the first one, or to
 *    the first closed source of a record only open venues carried, or over a withheld placeholder;
 *  - a sighting that got here by pointing at the record (`cites`) and a sighting of an open venue on a record a closed
 *    source carries give it no text, no link, no time, no entity and no number. They are counted, nothing more.
 */
async function attach(db: Db, record: RecordRow, source: SourceInfo, s: Sighting, id: string, found: Found, now: Date): Promise<void> {
  const { matchedBy, cited } = found;
  const sources = asSources(record);
  const open = source.open === true;
  const hadOfficial = sources.some((x) => x.official);
  const hadClosed = sources.some((x) => !x.open);
  // Carried only: it adds itself to the record's sources and its count.
  const passenger = found.cites === true || (open && hadClosed);
  const official = !open && !passenger && source.officialFor.some((e) => record.entities.includes(e) && s.named.includes(e));
  const entities = passenger ? record.entities : [...new Set([...record.entities, ...s.entities])].slice(0, ENTITIES_MAX);
  const known = sources.some((x) => x.sourceId === source.id);
  const entry: RecordSource = { sourceId: source.id, cluster: source.cluster, group: source.group, official, ...(open ? { open: true } : {}), link: s.link, seenAt: now.toISOString() };
  const nextSources = known || sources.length >= SOURCES_MAX ? sources : [...sources, entry];
  const isCited = record.cited || cited;
  const { grade, groups } = gradeOf(nextSources, isCited);
  const numbers = passenger ? asNumbers(record) : [...asNumbers(record), ...s.numbers.filter((n) => !asNumbers(record).some((b) => sameNumber(b, n)))].slice(0, RECORD_NUMBERS_MAX);
  const changes = [...asChanges(record)];
  const takesOver = !passenger && ((official && !hadOfficial) || (!open && !hadClosed));
  const takeText = !passenger && !s.withheld && !!s.title && (takesOver || record.headline.startsWith('an item from '));
  let headline = record.headline;
  if (takeText && clip(s.title, HEADLINE_MAX) !== record.headline) {
    headline = clip(s.title, HEADLINE_MAX);
    changes.push({ at: now.toISOString(), what: 'headline', from: record.headline, to: headline });
  }
  const link = (takesOver && s.link) || record.link || (passenger ? null : s.link);
  const eventTime = (takesOver && official && s.eventTime) || record.eventTime || (passenger ? null : s.eventTime);
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
 * Two records that turned out to be one event become one: the older stays (its id, its first sighting), takes the
 * other's sightings, sources, entities, numbers and posted list, and is graded again; the other is deleted. The
 * official source's title, page and time win. A withdrawn record and a metric are never merged, in either direction,
 * and neither are two records that share no entity or whose kinds cannot be one event. Returns the id that stays, or
 * null when nothing was merged.
 */
export async function mergeRecords(db: Db, aId: string, bId: string, now: Date): Promise<string | null> {
  if (aId === bId) return null;
  const [a, b] = await Promise.all([db.query.dsRecords.findFirst({ where: eq(dsRecords.id, aId) }), db.query.dsRecords.findFirst({ where: eq(dsRecords.id, bId) })]);
  if (!a || !b || a.status === 'withdrawn' || b.status === 'withdrawn' || a.kind === 'metric' || b.kind === 'metric') return null;
  // One sighting's link and words are not enough to fold two stories into one: the two must already share a name and
  // be of kinds that can be one event.
  if (!a.entities.some((e) => b.entities.includes(e)) || kindsCompatible(a.kind as RecordKind, b.kind as RecordKind) === 'no') return null;
  const [keep, drop] = a.firstSeenAt.getTime() <= b.firstSeenAt.getTime() ? [a, b] : [b, a];
  const sources = [...asSources(keep), ...asSources(drop).filter((x) => !asSources(keep).some((k) => k.sourceId === x.sourceId))].slice(0, SOURCES_MAX);
  const cited = keep.cited || drop.cited;
  const { grade, groups } = gradeOf(sources, cited);
  // Whose words the merged record keeps: an official source's over a desk's, a desk's over an open venue's.
  const standing = (r: RecordRow) => (asSources(r).some((x) => x.official) ? 2 : asSources(r).some((x) => !x.open) ? 1 : 0);
  const text = standing(drop) > standing(keep) ? drop : keep;
  const lastReinforcedAt = new Date(Math.max(keep.lastReinforcedAt.getTime(), drop.lastReinforcedAt.getTime()));
  const status: RecordStatus = keep.status === 'open' && groups >= 2 ? 'corroborated' : (keep.status as RecordStatus);
  const timed = text.eventTime ? text : keep.eventTime ? keep : drop;
  const weight = Math.max(keep.weight, drop.weight);
  await db.transaction(async (tx) => {
    await tx.update(dsSightings).set({ recordId: keep.id }).where(eq(dsSightings.recordId, drop.id));
    await tx.delete(dsRecords).where(eq(dsRecords.id, drop.id));
    await tx
      .update(dsRecords)
      .set({
        entities: [...new Set([...keep.entities, ...drop.entities])].slice(0, ENTITIES_MAX),
        sources: json(sources),
        groups,
        grade,
        cited,
        numbers: json([...asNumbers(keep), ...asNumbers(drop).filter((n) => !asNumbers(keep).some((k) => sameNumber(k, n)))].slice(0, RECORD_NUMBERS_MAX)),
        headline: text.headline.startsWith('an item from ') ? (text === keep ? drop : keep).headline : text.headline,
        summary: text.summary ?? keep.summary,
        link: text.link ?? keep.link ?? drop.link,
        eventTime: timed.eventTime,
        eventEnd: timed.eventEnd,
        eventPrecision: timed.eventPrecision,
        observationCount: keep.observationCount + drop.observationCount,
        lastReinforcedAt,
        weight,
        cluster: drop.weight > keep.weight ? drop.cluster : keep.cluster,
        status,
        posted: json([...(keep.posted as unknown[]), ...(drop.posted as unknown[])]),
        changedAt: now,
        changes: json([...asChanges(keep), { at: now.toISOString(), what: 'merged', from: drop.id, to: keep.id }, ...(status !== keep.status ? [{ at: now.toISOString(), what: 'status', from: keep.status, to: status }] : [])].slice(-CHANGES_MAX)),
        expiresAt: expiryOf(keep.kind as RecordKind, keep.firstSeenAt, lastReinforcedAt, timed.eventTime, timed.eventPrecision as EventPrecision),
      })
      .where(eq(dsRecords.id, keep.id));
  });
  return keep.id;
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
  const day = dayOf(now);
  const sourceSightings = opts.sourceSightingsPerDay ?? DEFAULT_SOURCE_SIGHTINGS_PER_DAY;
  const sourceRecords = opts.sourceRecordsPerDay ?? DEFAULT_SOURCE_RECORDS_PER_DAY;
  const soFar = sourceSightings > 0 || sourceRecords > 0 ? await sourceDay(db, s.sourceId, day) : { sightings: 0, records: 0 };
  if (sourceSightings > 0 && soFar.sightings >= sourceSightings) {
    await countCapped(db, day, now);
    return { outcome: 'capped', by: 'source' };
  }
  const at = s.publishedAt && s.publishedAt.getTime() < now.getTime() ? s.publishedAt : now;
  const found = await findRecord(db, s, at, opts);
  if (found) {
    const kept = found.also ? await mergeRecords(db, found.recordId, found.also, now) : null;
    const record = await db.query.dsRecords.findFirst({ where: eq(dsRecords.id, kept ?? found.recordId) });
    if (record) {
      await attach(db, record, source, s, id, found, now);
      return { outcome: 'attached', recordId: record.id, matchedBy: found.matchedBy, ...(kept && found.also ? { merged: kept === found.recordId ? found.also : found.recordId } : {}) };
    }
  }
  const weight = clusterWeight(source.cluster);
  if (sourceRecords > 0 && soFar.records >= sourceRecords) {
    await countCapped(db, day, now);
    return { outcome: 'capped', by: 'source' };
  }
  if (!(await underCap(db, day, weight, opts.recordsPerDay ?? DEFAULT_RECORDS_PER_DAY))) {
    await countCapped(db, day, now);
    return { outcome: 'capped', by: 'day' };
  }
  const recordId = recordIdOf(id);
  const entities = s.entities.slice(0, ENTITIES_MAX);
  // Official for what the item itself is about (its text names it, or its source is about nothing else), never for an
  // entity the source merely carries on everything it publishes.
  const open = source.open === true;
  const official = !open && source.officialFor.some((e) => s.named.includes(e));
  const sources: RecordSource[] = [{ sourceId: source.id, cluster: source.cluster, group: source.group, official, ...(open ? { open: true } : {}), link: s.link, seenAt: now.toISOString() }];
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
