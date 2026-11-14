/**
 * Layer b: the open sources of sources.ts, read without X. One source at a time, each a conditional GET (ETag or
 * If-Modified-Since, so an unchanged source costs a 304) through web-reader.ts `fetchPublic`, the same path as the
 * agents' `read_url`: public https hosts only, every redirect re-checked, a time limit, and the body cut at the
 * source's byte cap. A JSON body over its cap is a failed read (half a document parses to nothing); a feed or a page
 * over it is read as far as it came.
 *
 * A source that fails waits twice as long after every failure in a row (its interval, doubled, up to a day) and never
 * stops the others: each read has its own try, and what a pass does is bounded by `sourcesPerPass`. The wait is
 * written BEFORE the read, as if it had already failed: a body that kills the process (out of memory) leaves the
 * source backed off, so the restarted process does not walk into the same body first and die again. A read that ends
 * well puts the source back on its interval.
 *
 * An HTML page has no dates, so the first read of one only notes which links it has (`state.seen`); from then on a link
 * the page did not have before is a sighting, at most NEW_LINKS_MAX a read (a redesign must not become forty records).
 */
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { dsSources } from '../db/schema.js';
import { rpcErrorText, type Logger } from '../log.js';
import { fetchPublic } from '../web-reader.js';
import { buildSighting, metricSighting, sourceHosts } from './build.js';
import { canonicalLink, cleanText, linkKey, TITLE_MAX } from './clean.js';
import { parseFeed } from './readers/feed.js';
import { hashOf, pageLinks, visibleText, watchedValue } from './readers/html.js';
import { PARTIAL_BODY_READERS, readJson } from './readers/json.js';
import { SOURCE_BY_ID, type OpenSource } from './sources.js';
import { dayOf, ingestSighting, knownSightings, sightingIdOf, type IngestOptions, type SourceRow } from './store.js';
import type { Sighting } from './types.js';

export const NEW_LINKS_MAX = 10;
export const SEEN_MAX = 800;
export const BACKOFF_MAX_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 20_000;
/** The megabyte JSON APIs get longer to arrive. */
const BIG_FETCH_TIMEOUT_MS = 45_000;
const ACCEPT: Record<OpenSource['kind'], string> = {
  feed: 'application/atom+xml,application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5',
  json: 'application/json',
  html: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
};

export interface OpenSourceDeps {
  db: Db;
  log: Pick<Logger, 'info' | 'warn'>;
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<{ address: string }[]>;
  recordsPerDay?: number;
  /** One source's share of a day (store.ts): new records and sightings; unset = the store's defaults. */
  sourceRecordsPerDay?: number;
  sourceSightingsPerDay?: number;
  sourcesPerPass?: number;
  judgeLeftover?: IngestOptions['judgeLeftover'];
}

export interface SourceRead {
  notModified: boolean;
  sightings: Sighting[];
  dropped: number;
  /** What the source's row remembers for the next read. */
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  state: Record<string, unknown>;
  status: number;
}

/** How long a source waits after `failures` failed reads in a row. */
export function backoffMs(everyMin: number, failures: number): number {
  return Math.min(everyMin * 60_000 * 2 ** Math.min(failures, 10), BACKOFF_MAX_MS);
}

const short = (text: string): string => hashOf(text).slice(0, 16);

function readLinks(source: OpenSource, html: string, state: Record<string, unknown>, now: Date): { sightings: Sighting[]; dropped: number; state: Record<string, unknown> } {
  const hosts = sourceHosts(source);
  const page = canonicalLink(source.url, hosts);
  const found: { id: string; link: string; text: string }[] = [];
  for (const l of pageLinks(html, source.url)) {
    const link = canonicalLink(l.href, hosts);
    if (!link || link === page) continue;
    const path = new URL(link).pathname;
    if (source.paths && !source.paths.some((p) => path.startsWith(p) && path.length > p.length)) continue;
    const text = cleanText(l.text, TITLE_MAX);
    // A title, not a menu entry: a few words at least.
    if (text.length < 12 || text.split(' ').length < 3) continue;
    found.push({ id: short(linkKey(link)), link, text });
  }
  const before = Array.isArray(state.seen) ? (state.seen as unknown[]).filter((x): x is string => typeof x === 'string') : null;
  const seen = new Set(before ?? []);
  const fresh = before === null ? [] : found.filter((f) => !seen.has(f.id));
  const built = fresh.slice(0, NEW_LINKS_MAX).map((f) => buildSighting(source, { id: f.link, title: f.text, link: f.link, undated: true }, now));
  // Everything on the page is known from now on, shown or not; the oldest ids fall out first.
  const next = [...new Set([...(before ?? []), ...found.map((f) => f.id)])].slice(-SEEN_MAX);
  return { sightings: built.flatMap((b) => ('sighting' in b ? [b.sighting] : [])), dropped: built.filter((b) => 'dropped' in b).length, state: { ...state, seen: next } };
}

function readWatch(source: OpenSource, html: string, state: Record<string, unknown>, now: Date): { sightings: Sighting[]; state: Record<string, unknown> } {
  const text = visibleText(html);
  const base = { ...source, page: source.url };
  if (source.watch) {
    const value = watchedValue(text, source.watch.after, source.watch.values);
    if (!value || value === state.value) return { sightings: [], state };
    const sightings = typeof state.value === 'string' ? [{ ...metricSighting(base, `status:${value}`, dayOf(now), `${source.name}: its ${source.watch.after.toLowerCase()} is now ${value}`, [], []), kind: source.defaultKind }] : [];
    return { sightings, state: { ...state, value } };
  }
  const hash = hashOf(text);
  if (hash === state.hash) return { sightings: [], state };
  const sightings = typeof state.hash === 'string' ? [{ ...metricSighting(base, 'changed', dayOf(now), `${source.name}: the page changed`, [], []), kind: source.defaultKind }] : [];
  return { sightings, state: { ...state, hash } };
}

/** One read of one source: the request, and what its body says. Throws when the source cannot be read. */
export async function readOpenSource(deps: Pick<OpenSourceDeps, 'fetch' | 'resolve'>, source: OpenSource, row: Pick<SourceRow, 'etag' | 'lastModified' | 'contentHash' | 'state'>, now: Date): Promise<SourceRead> {
  const headers: Record<string, string> = { accept: ACCEPT[source.kind] };
  if (row.etag) headers['if-none-match'] = row.etag;
  if (row.lastModified) headers['if-modified-since'] = row.lastModified;
  const res = await fetchPublic(source.url, { headers, maxBytes: source.maxBytes, timeoutMs: source.maxBytes > 2 * 1024 * 1024 ? BIG_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS, fetch: deps.fetch, resolve: deps.resolve });
  const kept = { etag: row.etag, lastModified: row.lastModified, contentHash: row.contentHash, state: row.state ?? {} };
  if (res.status === 304) return { ...kept, notModified: true, sightings: [], dropped: 0, status: 304 };
  if (res.status !== 200) throw new Error(`http_${res.status}`);
  if (res.exceeded && source.kind === 'json' && !PARTIAL_BODY_READERS.has(source.reader ?? '')) throw new Error('body_over_cap');
  const body = new TextDecoder('utf-8').decode(res.bytes);
  const contentHash = hashOf(body);
  const fresh = { etag: res.headers.get('etag')?.slice(0, 200) ?? null, lastModified: res.headers.get('last-modified')?.slice(0, 64) ?? null, contentHash, status: 200 };
  // The same bytes as last time, from a server that keeps no ETag: nothing to do.
  if (contentHash === row.contentHash) return { ...fresh, notModified: true, sightings: [], dropped: 0, state: kept.state };
  if (source.kind === 'feed') {
    const built = parseFeed(body).map((item) => buildSighting(source, item, now));
    return { ...fresh, notModified: false, sightings: built.flatMap((b) => ('sighting' in b ? [b.sighting] : [])), dropped: built.filter((b) => 'dropped' in b).length, state: kept.state };
  }
  if (source.kind === 'json') return { ...fresh, notModified: false, ...readJson(source, body, now), state: kept.state };
  if (source.reader === 'watch') return { ...fresh, notModified: false, dropped: 0, ...readWatch(source, body, kept.state, now) };
  return { ...fresh, notModified: false, ...readLinks(source, body, kept.state, now) };
}

export interface OpenSourcesReport {
  read: number;
  notModified: number;
  failed: number;
  created: number;
  attached: number;
  updated: number;
  capped: number;
  dropped: number;
}

/**
 * One pass over the open sources that are due, least recently read first, at most `sourcesPerPass`. Never throws: a
 * source's failure is written on its row with the time of its next try.
 */
export async function runOpenSources(deps: OpenSourceDeps, now: Date): Promise<OpenSourcesReport> {
  const report: OpenSourcesReport = { read: 0, notModified: 0, failed: 0, created: 0, attached: 0, updated: 0, capped: 0, dropped: 0 };
  const due = await deps.db
    .select()
    .from(dsSources)
    .where(and(eq(dsSources.layer, 'b'), eq(dsSources.status, 'active'), or(isNull(dsSources.nextFetchAt), lte(dsSources.nextFetchAt, now))))
    // A source never read yet comes before one that is merely late.
    .orderBy(sql`${dsSources.nextFetchAt} asc nulls first`, asc(dsSources.id))
    .limit(deps.sourcesPerPass ?? 12);
  for (const row of due) {
    const source = SOURCE_BY_ID.get(row.id);
    if (!source || !source.read) continue;
    const failures = row.failures + 1;
    const retryAt = new Date(now.getTime() + backoffMs(source.everyMin, failures));
    try {
      await deps.db.update(dsSources).set({ lastFetchAt: now, failures, lastError: 'a read was started and did not finish', nextFetchAt: retryAt, updatedAt: now }).where(eq(dsSources.id, row.id));
      const read = await readOpenSource(deps, source, row, now);
      const info = { id: source.id, name: source.name, cluster: source.cluster, group: source.group, officialFor: source.officialFor, open: source.open === true };
      const known = await knownSightings(deps.db, read.sightings.filter((s) => !s.key).map((s) => sightingIdOf(s.sourceId, s.externalId)));
      for (const sighting of read.sightings) {
        if (known.has(sightingIdOf(sighting.sourceId, sighting.externalId))) continue;
        const result = await ingestSighting(deps.db, info, sighting, { now, recordsPerDay: deps.recordsPerDay, sourceRecordsPerDay: deps.sourceRecordsPerDay, sourceSightingsPerDay: deps.sourceSightingsPerDay, judgeLeftover: deps.judgeLeftover });
        if (result.outcome === 'created') report.created++;
        else if (result.outcome === 'attached') report.attached++;
        else if (result.outcome === 'updated') report.updated++;
        else if (result.outcome === 'capped') report.capped++;
      }
      report.read++;
      report.dropped += read.dropped;
      if (read.notModified) report.notModified++;
      await deps.db
        .update(dsSources)
        .set({ etag: read.etag, lastModified: read.lastModified, contentHash: read.contentHash, state: read.state, lastFetchAt: now, lastOkAt: now, lastStatus: read.status, failures: 0, lastError: null, nextFetchAt: new Date(now.getTime() + source.everyMin * 60_000), updatedAt: now })
        .where(eq(dsSources.id, row.id));
    } catch (err) {
      report.failed++;
      const error = rpcErrorText(err, 200);
      const status = /^http_(\d{3})$/.exec(error)?.[1];
      deps.log.warn({ source: row.id, failures, error }, 'dataset: source read failed');
      await deps.db
        .update(dsSources)
        .set({ lastFetchAt: now, lastStatus: status ? Number(status) : null, failures, lastError: error, nextFetchAt: retryAt, updatedAt: now })
        .where(eq(dsSources.id, row.id))
        .catch(() => undefined);
    }
  }
  return report;
}
