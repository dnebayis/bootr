/**
 * The owner's view (src/dataset/view.ts): one day of records with grade, sources and counts, on the supervisor's
 * HMAC-signed internal API. Read-only; no agent path reads the dataset.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api.js';
import { dsRecords } from '../src/db/schema.js';
import { metricSighting } from '../src/dataset/build.js';
import { ingestSighting, markPosted, syncSources } from '../src/dataset/store.js';
import { dayParam, type DatasetDayView } from '../src/dataset/view.js';
import { signRequest } from '../src/hmac.js';
import { infoOf, sighting, source } from './dataset-helpers.js';
import { SUPERVISOR_KEY, makeWorld, type TestWorld } from './helpers.js';

let world: TestWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

async function setup(config: Record<string, string> = {}) {
  await world?.close();
  const w = (world = await makeWorld({ config }));
  const nowSec = () => Math.floor(w.ctx.now() / 1000);
  const app = createApp(w.ctx, nowSec);
  const get = (path: string, key = SUPERVISOR_KEY) => app.request(path, { headers: { authorization: signRequest(key, 'GET', path, '', nowSec()) } });
  return { app, get, db: w.ctx.db, now: new Date(w.ctx.now()) };
}

describe('GET /internal/dataset/day', () => {
  it('needs the service signature, like every internal route', async () => {
    const { app, get } = await setup();
    expect((await app.request('/internal/dataset/day')).status).toBe(401);
    expect((await get('/internal/dataset/day', 'another-key-of-thirty-two-characters-xx')).status).toBe(401);
    expect((await get('/internal/dataset/day')).status).toBe(200);
  });

  it('an empty day, with the flag as the supervisor reads it', async () => {
    const off = await setup();
    const body = (await (await off.get('/internal/dataset/day')).json()) as DatasetDayView;
    expect(body).toMatchObject({ enabled: false, day: '2026-10-24', totals: { records: 0, sightings: 0, byGrade: {}, byKind: {}, byMatch: {}, capped: 0 }, records: [], sources: [] });
    const on = await setup({ DATASET_ENABLED: 'true' });
    expect(((await (await on.get('/internal/dataset/day')).json()) as DatasetDayView).enabled).toBe(true);
  });

  it("a day's records, best sourced first, each with its grade in words, its sources by name, its sightings and its counts", async () => {
    const { get, db, now } = await setup();
    await syncSources(db, now);
    const put = (s: ReturnType<typeof sighting>, minutes: number) => ingestSighting(db, infoOf(s.sourceId), s, { now: new Date(now.getTime() + minutes * 60_000) });
    await put(sighting('b:coindesk', { id: 'cd', title: 'Kraken acquires tokenization startup Backed', link: 'https://www.coindesk.com/kraken' }, now), 0);
    await put(sighting('b:the-block', { id: 'tb', title: 'Kraken buys Backed in tokenization push', link: 'https://www.theblock.co/post/1/kraken' }, now), 10);
    const official = await put(sighting('b:base-status', { id: 'st', title: 'Delayed transaction inclusion on Base Mainnet', link: 'https://base-l2.statuspage.io/incidents/abc' }, now), 20);
    await put(sighting('b:llama-hacks', { id: 'hack:1', title: 'Acme Lend hack: oracle manipulation', kind: 'incident', eventTime: now, eventPrecision: 'day', numbers: [{ value: 12_000_000, unit: 'usd', what: 'reported loss', asOf: now.toISOString(), sourceId: 'b:llama-hacks' }] }, now), 30);
    await ingestSighting(db, infoOf('b:llama-chains'), metricSighting(source('b:llama-chains'), 'tvl:base', '2026-10-24', 'Base: 5.22B USD of value locked', [{ value: 5_220_000_000, unit: 'usd', what: 'value locked', asOf: now.toISOString(), sourceId: 'b:llama-chains' }], ['base']), { now });
    if (official.outcome !== 'created') throw new Error('expected a record');
    await markPosted(db, official.recordId, { agentId: '1153600', postId: '1', at: now.toISOString() });
    const view = (await (await get('/internal/dataset/day?day=2026-10-24')).json()) as DatasetDayView;
    expect(view.totals).toEqual({ records: 4, sightings: 5, byGrade: { 1: 2, 3: 1, 4: 1 }, byKind: { outage: 1, statement: 1, incident: 1, metric: 1 }, byMatch: { new: 4, words: 1 }, capped: 0 });
    expect(view.records.map((r) => [r.grade, r.headline])).toEqual([
      [4, 'Delayed transaction inclusion on Base Mainnet'],
      [3, 'Kraken acquires tokenization startup Backed'],
      [1, 'Acme Lend hack: oracle manipulation'],
      [1, 'Base: 5.22B USD of value locked'],
    ]);
    const [outage, kraken, hack, tvl] = view.records;
    expect(outage).toMatchObject({ gradeWords: 'an official source of one of its entities', groups: 1, status: 'open', posted: 1, incidentSourced: null, sources: [{ sourceId: 'b:base-status', name: 'Base status', group: 'coinbase', official: true, link: 'https://base-l2.statuspage.io/incidents/abc' }] });
    expect(kraken).toMatchObject({ gradeWords: 'an outside source is cited or two independent groups', groups: 2, status: 'corroborated', observationCount: 2 });
    expect(kraken!.sources.map((s) => s.name)).toEqual(['CoinDesk', 'The Block']);
    expect(kraken!.sightings.map((s) => [s.sourceId, s.matchedBy, s.title])).toEqual([
      ['b:coindesk', 'new', 'Kraken acquires tokenization startup Backed'],
      ['b:the-block', 'words', 'Kraken buys Backed in tokenization push'],
    ]);
    // an incident carried by one security source alone is a report, and the view says so
    expect(hack).toMatchObject({ kind: 'incident', incidentSourced: false, numbers: [{ value: 12_000_000, unit: 'usd', what: 'reported loss' }] });
    expect(tvl).toMatchObject({ kind: 'metric', eventPrecision: 'day', link: 'https://defillama.com/chains' });
    // every source with its state, so a source that fails is seen
    expect(view.sources.length).toBeGreaterThan(70);
    expect(view.sources.find((s) => s.id === 'b:base-status')).toMatchObject({ name: 'Base status', layer: 'b', kind: 'feed', group: 'coinbase', status: 'active', failures: 0 });
    // another day has none of it
    expect(((await (await get('/internal/dataset/day?day=2026-10-23')).json()) as DatasetDayView).records).toEqual([]);
    expect(await db.select().from(dsRecords)).toHaveLength(4);
  });

  it('reads a day only when it is one', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    expect(dayParam('2026-11-14', now)).toBe('2026-11-14');
    for (const bad of [undefined, '', 'yesterday', '2026-13-45', "2026-11-14' or 1=1", '20261114']) expect(dayParam(bad, now)).toBe('2026-11-15');
  });
});

describe('who reads the dataset', () => {
  it('nothing outside the dataset module, the API mount, the schema and the files of stage 5 (records for the platform account) names it', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'dataset' ? [] : files(`${dir}${e.name}/`)) : e.name.endsWith('.ts') ? [`${dir}${e.name}`] : []));
    const naming = files(src).filter((f) => /dataset\/|dsRecords|dsSightings|dsSources|sv_ds_/.test(readFileSync(f, 'utf8')));
    // stage 5: the turn's records (records-turn.ts, records-section.ts, runtime.ts), the citations and the number gate
    // (post-records.ts, number-gate.ts) and the platform account's quiet slot (platform-quiet.ts). The three send paths
    // (approvals.ts, broker/index.ts, thread-send.ts) ask dataset/execution-posts.ts whether a link is an execution
    // account's post (the security review of 2026-11-15, M4). A new reader is a decision, made here on purpose.
    expect(naming.map((f) => f.slice(src.length)).sort()).toEqual(['api.ts', 'approvals.ts', 'broker/index.ts', 'config.ts', 'db/schema.ts', 'number-gate.ts', 'platform-quiet.ts', 'post-records.ts', 'records-section.ts', 'records-turn.ts', 'runtime.ts', 'thread-send.ts', 'web-reader.ts']);
  });
});
