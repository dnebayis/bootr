/**
 * Server-side client for the owner's view of Bootr's own dataset (docs/design/agent-behaviour.md section 6.4): the
 * agent service's `GET /internal/dataset/day`, called by the admin route `/api/admin/dataset`. Same HMAC scheme as
 * `lib/server/supervisor.ts`, and that file's errors.
 *
 * The answer is rebuilt field by field before it reaches a page. The dataset's text was cleaned where it was stored;
 * this is the second look: only the fields named here pass, every string is cut to its limit, every list is bounded,
 * and a link is kept only when it is a plain https address (the console renders it as a link).
 */
import { supervisorEnv } from './env';
import { signSenderRequest } from './sender';
import { SupervisorError, SupervisorUnavailable } from './supervisor';

if (typeof window !== 'undefined') throw new Error('lib/server/dataset must not be imported in the browser');

export interface DatasetNumber {
  value: number;
  unit: string;
  what: string;
}

export interface DatasetRecordView {
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
  /** The coin a chain record is about (an address), or null. */
  coin: string | null;
  firstSeenAt: string;
  lastReinforcedAt: string;
  observationCount: number;
  eventTime: string | null;
  eventPrecision: string;
  numbers: DatasetNumber[];
  sources: { name: string; group: string; official: boolean; link: string | null }[];
  incidentSourced: boolean | null;
  posted: number;
  sightings: { source: string; title: string; withheld: boolean; matchedBy: string }[];
}

export interface DatasetSourceView {
  id: string;
  name: string;
  layer: string;
  kind: string;
  status: string;
  lastOkAt: string | null;
  nextFetchAt: string | null;
  failures: number;
  lastError: string | null;
}

export interface DatasetDay {
  enabled: boolean;
  day: string;
  totals: { records: number; sightings: number; byGrade: Record<string, number>; byKind: Record<string, number>; byMatch: Record<string, number>; capped: number };
  records: DatasetRecordView[];
  sources: DatasetSourceView[];
}

export const DATASET_RECORDS_MAX = 500;
export const DATASET_SOURCES_MAX = 400;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9:_.-]{1,80}$/i;

/** `YYYY-MM-DD` when `raw` is a real day, else null. */
export function datasetDay(raw: string | null | undefined): string | null {
  return raw && DAY_RE.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`)) ? raw : null;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const word = (v: unknown, max = 40): string => (typeof v === 'string' && /^[a-z0-9 ,_-]*$/i.test(v) ? v.slice(0, max) : '');
const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const whole = (v: unknown, max = 1_000_000): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : 0);
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A link the console may render: a plain https address without credentials, or null. */
export function httpsLink(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function tally(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(v)).slice(0, 20)) if (/^[a-z0-9_-]{1,20}$/i.test(k)) out[k] = whole(n);
  return out;
}

function record(raw: unknown): DatasetRecordView | null {
  const r = obj(raw);
  const firstSeenAt = iso(r.firstSeenAt);
  const lastReinforcedAt = iso(r.lastReinforcedAt);
  const headline = str(r.headline, 200);
  if (typeof r.id !== 'string' || !ID_RE.test(r.id) || !firstSeenAt || !lastReinforcedAt || !headline) return null;
  return {
    id: r.id,
    kind: word(r.kind, 20),
    grade: Math.min(5, Math.max(1, whole(r.grade) || 1)),
    gradeWords: str(r.gradeWords, 80),
    groups: whole(r.groups, 100),
    status: word(r.status, 20),
    headline,
    summary: str(r.summary, 400) || null,
    link: httpsLink(r.link),
    entities: list(r.entities, 12).map((e) => word(e, 40)).filter(Boolean),
    cluster: word(r.cluster, 30),
    coin: typeof r.coin === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r.coin) ? r.coin : null,
    firstSeenAt,
    lastReinforcedAt,
    observationCount: whole(r.observationCount),
    eventTime: iso(r.eventTime),
    eventPrecision: word(r.eventPrecision, 12),
    numbers: list(r.numbers, 12)
      .map(obj)
      .filter((n) => typeof n.value === 'number' && Number.isFinite(n.value))
      .map((n) => ({ value: n.value as number, unit: str(n.unit, 12), what: str(n.what, 60) })),
    sources: list(r.sources, 20)
      .map(obj)
      .map((s) => ({ name: str(s.name, 60), group: word(s.group, 40), official: s.official === true, link: httpsLink(s.link) }))
      .filter((s) => s.name),
    incidentSourced: typeof r.incidentSourced === 'boolean' ? r.incidentSourced : null,
    posted: whole(r.posted),
    sightings: list(r.sightings, 8)
      .map(obj)
      .map((s) => ({ source: str(s.sourceId, 60), title: str(s.title, 200), withheld: s.withheld === true, matchedBy: word(s.matchedBy, 12) })),
  };
}

function source(raw: unknown): DatasetSourceView | null {
  const s = obj(raw);
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return null;
  return { id: s.id, name: str(s.name, 60), layer: word(s.layer, 2), kind: word(s.kind, 10), status: word(s.status, 12), lastOkAt: iso(s.lastOkAt), nextFetchAt: iso(s.nextFetchAt), failures: whole(s.failures, 10_000), lastError: str(s.lastError, 200) || null };
}

/** The day as the console renders it. `day` falls back to the day that was asked for. */
export function sanitizeDatasetDay(raw: unknown, asked: string): DatasetDay {
  const o = obj(raw);
  const t = obj(o.totals);
  return {
    enabled: o.enabled === true,
    day: datasetDay(typeof o.day === 'string' ? o.day : null) ?? asked,
    totals: { records: whole(t.records), sightings: whole(t.sightings), byGrade: tally(t.byGrade), byKind: tally(t.byKind), byMatch: tally(t.byMatch), capped: whole(t.capped) },
    records: list(o.records, DATASET_RECORDS_MAX).map(record).filter((r): r is DatasetRecordView => !!r),
    sources: list(o.sources, DATASET_SOURCES_MAX).map(source).filter((s): s is DatasetSourceView => !!s),
  };
}

/** `GET /internal/dataset/day?day=`: one UTC day of the dataset. Throws the supervisor client's errors. */
export async function getDatasetDay(day: string): Promise<DatasetDay> {
  const { serviceKey, url } = supervisorEnv();
  if (!serviceKey || !url) throw new SupervisorUnavailable('supervisor is not configured');
  const path = `/internal/dataset/day?day=${encodeURIComponent(day)}`;
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, { method: 'GET', headers: { authorization: await signSenderRequest(serviceKey, 'GET', path, '') }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new SupervisorUnavailable(`supervisor unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 500) throw new SupervisorUnavailable(`supervisor responded ${res.status}`);
  // An agent service from before the dataset has no such route.
  if (!res.ok) throw new SupervisorError(res.status, res.status === 404 ? 'dataset_not_deployed' : `http_${res.status}`, res.status === 404 ? 'The agent service does not have the dataset yet.' : `The agent service answered ${res.status}.`);
  return sanitizeDatasetDay(await res.json(), day);
}
