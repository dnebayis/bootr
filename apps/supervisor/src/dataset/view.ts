/**
 * The owner's view of the dataset: one UTC day's records with their grade, sources and counts, and the state of every
 * source, so a day can be read by hand (the check of stage 4: under 5% duplicates, under 2% wrong merges, every
 * grade-4 record with an official link). Read-only, served on the supervisor's HMAC-signed internal API and shown in
 * the admin console (apps/web, `/api/admin/dataset`). No agent reads it.
 *
 * Layer c (the X accounts) has its own block: what the day's X reads cost so far as the dataset process last heard it
 * from the sender (`sv_cursors`, `dataset:x:<day>`), and every listed account with its status, so a suspended account
 * and its reason are in front of the owner. The one write here is the owner's "look again" on a suspended account
 * (`POST /internal/dataset/x/review`), which only marks the row: the dataset process makes the read.
 */
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { cursors, dsRecords, dsSightings, dsSources } from '../db/schema.js';
import type { AuthEnv } from '../hmac.js';
import { incidentSourced } from './grades.js';
import { readXDay } from './layer-c.js';
import { dayOf } from './store.js';
import { usdOf, worstDayUsd } from './x-budget.js';
import { askReview, listedOf, stateOf } from './x-pin.js';
import { GRADE_WORDS, type Grade, type RecordSource } from './types.js';

export const DAY_RECORDS_MAX = 500;
export const RECORD_SIGHTINGS_SHOWN = 6;
/** Sighting rows read for one day's view. The counts come from the database; these rows are only what is shown. */
export const DAY_SIGHTINGS_MAX = 2_000;

export interface DatasetDayView {
  /** Whether the dataset process is switched on (`DATASET_ENABLED`), as this service's own environment says. */
  enabled: boolean;
  day: string;
  totals: {
    records: number;
    sightings: number;
    byGrade: Record<string, number>;
    byKind: Record<string, number>;
    /** How the day's sightings found their record: `new`, `key`, `link`, `relation`, `words`, `judge`. */
    byMatch: Record<string, number>;
    /** Sightings that would have started a record past the day's cap. */
    capped: number;
  };
  records: {
    id: string;
    kind: string;
    grade: number;
    gradeWords: string;
    groups: number;
    status: string;
    headline: string;
    summary: string | null;
    link: string | null;
    entities: string[];
    cluster: string;
    coin: string | null;
    firstSeenAt: string;
    lastReinforcedAt: string;
    observationCount: number;
    eventTime: string | null;
    eventPrecision: string;
    expiresAt: string;
    numbers: { value: number; unit: string; what: string; asOf: string | null; sourceId: string }[];
    sources: { sourceId: string; name: string; group: string; official: boolean; /** An open venue: carried, counted for nothing. */ open: boolean; link: string | null; seenAt: string }[];
    /** For an incident: whether it has the sourcing the note asks for before it is more than a report. */
    incidentSourced: boolean | null;
    posted: number;
    sightings: { sourceId: string; title: string; withheld: boolean; matchedBy: string; seenAt: string }[];
  }[];
  sources: { id: string; name: string; layer: string; kind: string; cluster: string; group: string; status: string; statusReason: string | null; lastOkAt: string | null; lastFetchAt: string | null; nextFetchAt: string | null; lastStatus: number | null; failures: number; lastError: string | null }[];
  /** Layer c: the day's X reads and the listed accounts. */
  x: {
    /** The day's note as the dataset process wrote it, or null when it read nothing on X that day (the layer was off). */
    day: { limit: number; units: number; posts: number; userReads: number; checks: number; usd: number; worstUsd: number; stopped: string | null; error: string | null; at: string | null } | null;
    accounts: { id: string; handle: string; listedAs: string | null; tier: number | null; cluster: string; status: string; statusReason: string | null; followers: number | null; postsToday: number; lastOkAt: string | null; lastError: string | null }[];
  };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** `YYYY-MM-DD` when `raw` is a real day, else today's. */
export function dayParam(raw: string | undefined, now: Date): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`)) ? raw : dayOf(now);
}

export async function datasetDayView(db: Db, day: string, enabled: boolean): Promise<DatasetDayView> {
  const [records, sources, [capped]] = await Promise.all([
    db.select().from(dsRecords).where(eq(dsRecords.day, day)).orderBy(desc(dsRecords.grade), desc(dsRecords.weight), asc(dsRecords.firstSeenAt)).limit(DAY_RECORDS_MAX),
    db.select().from(dsSources).orderBy(asc(dsSources.layer), asc(dsSources.id)),
    db.select({ value: cursors.value }).from(cursors).where(eq(cursors.name, `dataset:capped:${day}`)).limit(1),
  ]);
  const ids = records.map((r) => r.id);
  // This runs inside the supervisor, which serves agents: the rows are bounded in SQL and the totals are counted there.
  const sightings = ids.length
    ? await db.select({ recordId: dsSightings.recordId, sourceId: dsSightings.sourceId, title: dsSightings.title, withheld: dsSightings.withheld, matchedBy: dsSightings.matchedBy, seenAt: dsSightings.seenAt }).from(dsSightings).where(inArray(dsSightings.recordId, ids)).orderBy(asc(dsSightings.seenAt)).limit(DAY_SIGHTINGS_MAX)
    : [];
  const byMatch = ids.length ? await db.select({ matchedBy: dsSightings.matchedBy, n: sql<number>`count(*)::int` }).from(dsSightings).where(inArray(dsSightings.recordId, ids)).groupBy(dsSightings.matchedBy) : [];
  const [dayTotals] = await db.select({ records: sql<number>`count(*)::int` }).from(dsRecords).where(eq(dsRecords.day, day));
  const names = new Map(sources.map((s) => [s.id, s.name]));
  const xDay = await readXDay(db, day);
  const tally = (keys: string[]) => keys.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
  return {
    enabled,
    day,
    totals: {
      records: Number(dayTotals?.records ?? records.length),
      sightings: byMatch.reduce((n, m) => n + Number(m.n), 0),
      byGrade: tally(records.map((r) => String(r.grade))),
      byKind: tally(records.map((r) => r.kind)),
      byMatch: Object.fromEntries(byMatch.map((m) => [m.matchedBy, Number(m.n)])),
      capped: Number(capped?.value ?? 0) || 0,
    },
    records: records.map((r) => {
      const recordSources = r.sources as unknown as RecordSource[];
      return {
        id: r.id,
        kind: r.kind,
        grade: r.grade,
        gradeWords: GRADE_WORDS[r.grade as Grade] ?? '',
        groups: r.groups,
        status: r.status,
        headline: r.headline,
        summary: r.summary,
        link: r.link,
        entities: r.entities,
        cluster: r.cluster,
        coin: r.coin,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastReinforcedAt: r.lastReinforcedAt.toISOString(),
        observationCount: r.observationCount,
        eventTime: iso(r.eventTime),
        eventPrecision: r.eventPrecision,
        expiresAt: r.expiresAt.toISOString(),
        numbers: r.numbers as unknown as DatasetDayView['records'][number]['numbers'],
        sources: recordSources.map((s) => ({ sourceId: s.sourceId, name: names.get(s.sourceId) ?? s.sourceId, group: s.group, official: s.official, open: s.open === true, link: s.link, seenAt: s.seenAt })),
        incidentSourced: r.kind === 'incident' ? incidentSourced(recordSources) : null,
        posted: (r.posted as unknown[]).length,
        sightings: sightings
          .filter((s) => s.recordId === r.id)
          .slice(0, RECORD_SIGHTINGS_SHOWN)
          .map((s) => ({ sourceId: s.sourceId, title: s.title, withheld: s.withheld, matchedBy: s.matchedBy, seenAt: s.seenAt.toISOString() })),
      };
    }),
    sources: sources.map((s) => ({ id: s.id, name: s.name, layer: s.layer, kind: s.kind, cluster: s.cluster, group: s.groupId, status: s.status, statusReason: s.statusReason, lastOkAt: iso(s.lastOkAt), lastFetchAt: iso(s.lastFetchAt), nextFetchAt: iso(s.nextFetchAt), lastStatus: s.lastStatus, failures: s.failures, lastError: s.lastError })),
    x: {
      day: xDay ? { limit: xDay.limit, units: xDay.units, posts: xDay.posts, userReads: xDay.userReads, checks: xDay.checks, usd: usdOf(xDay.units), worstUsd: worstDayUsd(xDay.limit), stopped: xDay.stopped, error: xDay.error, at: xDay.at || null } : null,
      accounts: sources
        .filter((s) => s.layer === 'c')
        .map((s) => {
          const state = stateOf(s);
          return { id: s.id, handle: s.xHandle ?? listedOf(s)?.handle ?? state.listed, listedAs: listedOf(s)?.handle ?? null, tier: s.tier, cluster: s.cluster, status: s.status, statusReason: s.statusReason, followers: typeof state.followers === 'number' ? state.followers : null, postsToday: state.days?.[day] ?? 0, lastOkAt: iso(s.lastOkAt), lastError: s.lastError };
        }),
    },
  };
}

/**
 * `GET /internal/dataset/day?day=YYYY-MM-DD` (HMAC, like every internal route): the day's view; today's when no day is
 * given. `POST /internal/dataset/x/review` `{id}`: the owner's "look again" on a suspended X account (x-pin.ts
 * `askReview`); 404 when the id is not a suspended X account. A real change of an account is a commit, not this.
 */
export function mountDataset(app: Hono<AuthEnv>, ctx: { db: Db; now(): number; config: { DATASET_ENABLED: boolean } }): void {
  app.get('/internal/dataset/day', async (c) => c.json(await datasetDayView(ctx.db, dayParam(c.req.query('day'), new Date(ctx.now())), ctx.config.DATASET_ENABLED)));
  app.post('/internal/dataset/x/review', async (c) => {
    let id: unknown;
    try {
      id = (JSON.parse(c.get('rawBody') || '{}') as { id?: unknown }).id;
    } catch {
      id = null;
    }
    if (typeof id !== 'string' || !/^x:(?:@\w{1,15}|\d{1,25})$/.test(id)) return c.json({ error: 'invalid_request', message: 'id must be an X source id' }, 400);
    const asked = await askReview(ctx.db, id, new Date(ctx.now()));
    return asked ? c.json({ ok: true, id, status: 'review' }) : c.json({ error: 'not_found', message: 'No suspended X account has this id.' }, 404);
  });
}
