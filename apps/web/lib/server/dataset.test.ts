import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATASET_RECORDS_MAX, datasetDay, getDatasetDay, httpsLink, sanitizeDatasetDay } from './dataset';
import { SupervisorError, SupervisorUnavailable } from './supervisor';

const RECORD = {
  id: 'r_8f3a11223344',
  kind: 'outage',
  grade: 4,
  gradeWords: 'an official source of one of its entities',
  groups: 2,
  status: 'corroborated',
  headline: 'Delayed transaction inclusion on Base Mainnet',
  summary: null,
  link: 'https://base-l2.statuspage.io/incidents/9jdt5jc1ylry',
  entities: ['base', 'coinbase'],
  cluster: 'base',
  coin: null,
  firstSeenAt: '2026-11-15T09:00:00.000Z',
  lastReinforcedAt: '2026-11-15T10:00:00.000Z',
  observationCount: 3,
  eventTime: '2026-11-15T08:55:00.000Z',
  eventPrecision: 'second',
  expiresAt: '2026-11-18T10:00:00.000Z',
  numbers: [{ value: 12_000_000, unit: 'usd', what: 'reported loss', asOf: null, sourceId: 'b:llama-hacks' }],
  sources: [
    { sourceId: 'b:base-status', name: 'Base status', group: 'coinbase', official: true, link: 'https://base-l2.statuspage.io/incidents/9jdt5jc1ylry', seenAt: '2026-11-15T09:00:00.000Z' },
    { sourceId: 'b:coindesk', name: 'CoinDesk', group: 'coindesk', official: false, link: 'https://www.coindesk.com/x', seenAt: '2026-11-15T09:30:00.000Z' },
  ],
  incidentSourced: null,
  posted: 1,
  sightings: [{ sourceId: 'b:base-status', title: 'Delayed transaction inclusion on Base Mainnet', withheld: false, matchedBy: 'new', seenAt: '2026-11-15T09:00:00.000Z' }],
};
const DAY = {
  enabled: true,
  day: '2026-11-15',
  totals: { records: 1, sightings: 3, byGrade: { 4: 1 }, byKind: { outage: 1 }, byMatch: { new: 1, words: 2 }, capped: 0 },
  records: [RECORD],
  sources: [{ id: 'b:base-status', name: 'Base status', layer: 'b', kind: 'feed', cluster: 'base', group: 'coinbase', status: 'active', statusReason: null, lastOkAt: '2026-11-15T10:00:00.000Z', lastFetchAt: '2026-11-15T10:00:00.000Z', nextFetchAt: '2026-11-15T10:15:00.000Z', lastStatus: 200, failures: 0, lastError: null }],
};

describe('the dataset day, as the console renders it', () => {
  it('keeps the named fields of a well-formed day', () => {
    const view = sanitizeDatasetDay(DAY, '2026-11-15');
    expect(view).toMatchObject({ enabled: true, day: '2026-11-15', totals: { records: 1, sightings: 3, byGrade: { 4: 1 }, byMatch: { new: 1, words: 2 }, capped: 0 } });
    expect(view.records).toHaveLength(1);
    expect(view.records[0]).toEqual({
      id: 'r_8f3a11223344',
      kind: 'outage',
      grade: 4,
      gradeWords: 'an official source of one of its entities',
      groups: 2,
      status: 'corroborated',
      headline: 'Delayed transaction inclusion on Base Mainnet',
      summary: null,
      link: 'https://base-l2.statuspage.io/incidents/9jdt5jc1ylry',
      entities: ['base', 'coinbase'],
      cluster: 'base',
      coin: null,
      firstSeenAt: '2026-11-15T09:00:00.000Z',
      lastReinforcedAt: '2026-11-15T10:00:00.000Z',
      observationCount: 3,
      eventTime: '2026-11-15T08:55:00.000Z',
      eventPrecision: 'second',
      numbers: [{ value: 12_000_000, unit: 'usd', what: 'reported loss' }],
      sources: [
        { name: 'Base status', group: 'coinbase', official: true, link: 'https://base-l2.statuspage.io/incidents/9jdt5jc1ylry' },
        { name: 'CoinDesk', group: 'coindesk', official: false, link: 'https://www.coindesk.com/x' },
      ],
      incidentSourced: null,
      posted: 1,
      sightings: [{ source: 'b:base-status', title: 'Delayed transaction inclusion on Base Mainnet', withheld: false, matchedBy: 'new' }],
    });
    expect(view.sources).toEqual([{ id: 'b:base-status', name: 'Base status', layer: 'b', kind: 'feed', status: 'active', lastOkAt: '2026-11-15T10:00:00.000Z', nextFetchAt: '2026-11-15T10:15:00.000Z', failures: 0, lastError: null }]);
  });

  it('never passes a link that is not plain https, an extra field, or a string past its limit', () => {
    const hostile = {
      ...RECORD,
      link: 'javascript:alert(document.cookie)',
      headline: 'x'.repeat(5000),
      summary: 'y'.repeat(5000),
      kind: '<script>alert(1)</script>',
      status: 'open" onmouseover="x',
      entities: ['base', '<img src=x onerror=alert(1)>', 7, null],
      coin: 'not-an-address',
      grade: 99,
      numbers: [{ value: 'NaN', unit: 'usd', what: 'x' }, { value: 5, unit: 'u'.repeat(100), what: 'w'.repeat(500) }],
      sources: [{ name: 'Evil', group: 'e', official: 'yes', link: 'https://user:pw@evil.example/x' }, { name: '', link: 'data:text/html,x' }],
      sightings: Array.from({ length: 50 }, () => ({ sourceId: 's', title: 't'.repeat(999), withheld: 'no', matchedBy: 'new' })),
      secret: 'must not pass',
      __proto__: { polluted: true },
    };
    const [r] = sanitizeDatasetDay({ ...DAY, records: [hostile] }, '2026-11-15').records;
    expect(r).toMatchObject({ link: null, kind: '', status: '', entities: ['base'], coin: null, grade: 5, numbers: [{ value: 5 }], sources: [{ name: 'Evil', official: false, link: null }] });
    expect(r!.headline).toHaveLength(200);
    expect(r!.summary).toHaveLength(400);
    expect(r!.numbers[0]!.unit).toHaveLength(12);
    expect(r!.sightings).toHaveLength(8);
    expect(r!.sightings[0]!.title).toHaveLength(200);
    expect(r).not.toHaveProperty('secret');
    expect(r).not.toHaveProperty('polluted');
    expect(httpsLink('http://blog.base.org/x')).toBeNull();
    expect(httpsLink('https://blog.base.org/x')).toBe('https://blog.base.org/x');
    expect(httpsLink(`https://blog.base.org/${'a'.repeat(600)}`)).toBeNull();
  });

  it('drops what is not a record, bounds the lists, and survives any shape', () => {
    const many = Array.from({ length: DATASET_RECORDS_MAX + 50 }, (_, i) => ({ ...RECORD, id: `r_${i}` }));
    expect(sanitizeDatasetDay({ ...DAY, records: [...many] }, '2026-11-15').records).toHaveLength(DATASET_RECORDS_MAX);
    expect(sanitizeDatasetDay({ ...DAY, records: [{ ...RECORD, id: 'bad id!' }, { ...RECORD, firstSeenAt: 'yesterday' }, { ...RECORD, headline: '' }, null, 'x', 7] }, '2026-11-15').records).toEqual([]);
    for (const raw of [null, undefined, 'text', 42, [], { records: 'x', sources: 7, totals: [] }]) {
      expect(sanitizeDatasetDay(raw, '2026-11-14')).toEqual({ enabled: false, day: '2026-11-14', totals: { records: 0, sightings: 0, byGrade: {}, byKind: {}, byMatch: {}, capped: 0 }, records: [], sources: [] });
    }
    expect(sanitizeDatasetDay({ ...DAY, day: "2026-11-15' or 1=1" }, '2026-11-14').day).toBe('2026-11-14');
  });

  it('reads a day only when it is one', () => {
    expect(datasetDay('2026-11-15')).toBe('2026-11-15');
    for (const bad of [null, undefined, '', 'today', '2026-13-45', '2026-11-15T00:00:00Z', '20261115', '../../etc']) expect(datasetDay(bad)).toBeNull();
  });
});

describe('getDatasetDay', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const configured = () => {
    vi.stubEnv('SUPERVISOR_URL', 'http://supervisor:3004');
    vi.stubEnv('SUPERVISOR_SERVICE_KEY', 'test-supervisor-key-fedcba9876543210fedcba');
  };

  it('asks the signed internal route for the day and returns the sanitised view', async () => {
    configured();
    const calls: { url: string; auth: string | null; method: string | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization'), method: init?.method });
      return Response.json({ ...DAY, extra: 'dropped' });
    });
    const view = await getDatasetDay('2026-11-15');
    expect(view.records).toHaveLength(1);
    expect(view).not.toHaveProperty('extra');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'http://supervisor:3004/internal/dataset/day?day=2026-11-15', method: 'GET' });
    expect(calls[0]!.auth).toMatch(/^HMAC \d+:[0-9a-f]{64}$/);
  });

  it('says so when the service is not configured, does not answer, or has no dataset yet', async () => {
    await expect(getDatasetDay('2026-11-15')).rejects.toBeInstanceOf(SupervisorUnavailable);
    configured();
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(getDatasetDay('2026-11-15')).rejects.toBeInstanceOf(SupervisorUnavailable);
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    await expect(getDatasetDay('2026-11-15')).rejects.toBeInstanceOf(SupervisorUnavailable);
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    await expect(getDatasetDay('2026-11-15')).rejects.toMatchObject({ status: 404, code: 'dataset_not_deployed' });
    await expect(getDatasetDay('2026-11-15')).rejects.toBeInstanceOf(SupervisorError);
  });
});
