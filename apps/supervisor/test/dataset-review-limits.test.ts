/**
 * The security review's third finding (M3), as its own cases: one hostile or compromised listed source must not be
 * able to stop the dataset or take the day. (a) a body that would exhaust memory is refused before it is parsed, and
 * a source is backed off before it is read, so a read that kills the process is not the first thing the restarted
 * process does; (b) the feed reader is one forward pass; (c) one source has a bounded share of a day; (d) the owner's
 * view reads a bounded number of rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, not } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { cursors, dsRecords, dsSightings, dsSources } from '../src/db/schema.js';
import { readOpenSource, runOpenSources } from '../src/dataset/layer-b.js';
import { FEED_BLOCKS_MAX, FEED_ITEMS_MAX, parseFeed } from '../src/dataset/readers/feed.js';
import { flatRows, JSON_ELEMENTS_MAX, overviewTotals, readJson, SCAN_ROWS_MAX } from '../src/dataset/readers/json.js';
import { JSON_PARSED_MAX_BYTES, OPEN_SOURCES } from '../src/dataset/sources.js';
import { DEFAULT_SOURCE_RECORDS_PER_DAY, DEFAULT_SOURCE_SIGHTINGS_PER_DAY, ingestSighting, syncSources } from '../src/dataset/store.js';
import { datasetDayView, DAY_SIGHTINGS_MAX, RECORD_SIGHTINGS_SHOWN } from '../src/dataset/view.js';
import { H, infoOf, NOW, quietLog, sighting, source } from './dataset-helpers.js';
import { testDb } from './helpers.js';

const MB = 1024 * 1024;
const PUBLIC = async () => [{ address: '93.184.216.34' }];
const FAR = new Date(NOW.getTime() + 365 * 24 * H);
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const fresh = { etag: null, lastModified: null, contentHash: null, state: {} };
const timed = <T>(fn: () => T): { ms: number; value: T } => {
  const started = Date.now();
  const value = fn();
  return { ms: Date.now() - started, value };
};
const heapMb = () => {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed / MB;
};

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await testDb());
});
afterEach(async () => {
  await close();
});

describe('(a) a body that would exhaust memory', () => {
  it('no JSON body is parsed whole above 2 MB: the only larger caps belong to readers that never build the tree', () => {
    for (const s of OPEN_SOURCES.filter((x) => x.kind === 'json' && x.read)) {
      if (s.reader === 'growthepie') expect(s.maxBytes, s.id).toBe(5 * MB);
      else if (s.reader === 'llama-overview') expect(s.maxBytes, s.id).toBe(64 * 1024);
      else expect(s.maxBytes, s.id).toBeLessThanOrEqual(JSON_PARSED_MAX_BYTES);
    }
  });

  it("the reviewer's body: megabytes of `[{},{},...]` are refused by size or by count, and nothing is parsed", async () => {
    const chains = source('b:llama-chains');
    const eight = `[${'{},'.repeat((8 * MB) / 3)}{}]`;
    const before = heapMb();
    // 8 MB arrives: the read stops at the source's cap and the half document is a failed read
    const big: typeof fetch = async () => new Response(eight, { status: 200 });
    await expect(readOpenSource({ fetch: big, resolve: PUBLIC }, chains, fresh, NOW)).rejects.toThrow('body_over_cap');
    // under the byte cap, far over the element count: refused before JSON.parse sees it
    const under = `[${'{},'.repeat(150_000)}{}]`;
    expect(under.length).toBeLessThan(chains.maxBytes);
    const t = timed(() => {
      try {
        readJson(chains, under, NOW);
        return 'parsed';
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(t.value).toBe('body_too_many_elements');
    expect(t.ms).toBeLessThan(500);
    for (const id of ['b:llama-hacks', 'b:llama-stablecoins', 'b:l2beat-summary', 'b:x402-catalogue', 'b:federal-register']) expect(() => readJson(source(id), under, NOW), id).toThrow('body_too_many_elements');
    expect(heapMb() - before).toBeLessThan(64);
    expect(JSON_ELEMENTS_MAX).toBe(100_000);
  });

  it('the DefiLlama overviews are megabytes and are never parsed: the totals are read from the first 64 KB', async () => {
    const fees = source('b:llama-fees');
    const protocols = Array.from({ length: 30_000 }, (_, i) => `{"total24h":${i},"total7d":${i * 7},"name":"P${i}","breakdown24h":{"ethereum":{"x":1}}}`).join(',');
    const body = `{"totalDataChart":[],"breakdown24h":null,"allChains":["Ethereum","Base"],"total24h":73347978.47,"total48hto24h":1,"total7d":466522756.29,"total30d":2185902051.88,"change_1d":5.68,"protocols":[${protocols}]}`;
    expect(body.length).toBeGreaterThan(2 * MB);
    const before = heapMb();
    const read = await readOpenSource({ fetch: async () => new Response(body, { status: 200 }), resolve: PUBLIC }, fees, fresh, NOW);
    expect(read.sightings).toHaveLength(1);
    expect(read.sightings[0]!.numbers.map((n) => n.value)).toEqual([73347978, 466522756, 2185902052]);
    expect(heapMb() - before).toBeLessThan(48);
    // a response in another order gives nothing rather than a protocol's number
    expect(overviewTotals('{"protocols":[{"total24h":5,"total7d":6}],"total24h":73347978.47,"total7d":1}')).toEqual({});
    expect(readJson(fees, '{"protocols":[{"total24h":5,"total7d":6}],"total24h":9}', NOW).sightings).toEqual([]);
    expect(overviewTotals('<html>')).toEqual({});
  });

  it('growthepie is megabytes of flat rows and is scanned, a row at a time, to a bounded count', () => {
    const gtp = source('b:growthepie');
    const rows = Array.from({ length: 60_000 }, (_, i) => `{"metric_key": "fdv_usd", "origin_key": "chain${i}", "date": "2026-11-13", "value": ${i}.0}`);
    rows.push('{"metric_key": "txcount", "origin_key": "base", "date": "2026-11-13", "value": 9650367.0}', '{"metric_key": "daa", "origin_key": "base", "date": "2026-11-13", "value": 1250000.0}');
    const body = `[${rows.join(', ')}]`;
    expect(body.length).toBeGreaterThan(4 * MB);
    const before = heapMb();
    const t = timed(() => readJson(gtp, body, NOW));
    expect(t.ms).toBeLessThan(3000);
    expect(t.value.sightings.map((s) => s.title)).toEqual(["Base: 9.7M transactions on 2026-11-13, by growthepie's count"]);
    expect(heapMb() - before).toBeLessThan(48);
    // rows that are not rows, and a body of nothing but braces
    expect(flatRows('{"a":1} {not json} {"b":{"c":2}} {"d":3}', () => true)).toEqual([{ a: 1 }, { c: 2 }, { d: 3 }]);
    const braces = timed(() => flatRows('{'.repeat(4 * MB), () => true));
    expect(braces.value).toEqual([]);
    expect(braces.ms).toBeLessThan(3000);
    expect(SCAN_ROWS_MAX).toBe(200_000);
  });

  it('a source is backed off before it is read, so a read that kills the process is not first again after the restart', async () => {
    await syncSources(db, NOW);
    await db.update(dsSources).set({ nextFetchAt: FAR }).where(not(inArray(dsSources.id, ['b:llama-chains'])));
    // a second source that falls due a minute later
    await db.update(dsSources).set({ nextFetchAt: at(1) }).where(eq(dsSources.id, 'b:base-status'));
    const chains = source('b:llama-chains');
    const status = source('b:base-status');
    const row = async (id: string) => (await db.query.dsSources.findFirst({ where: eq(dsSources.id, id) }))!;
    // the first process: the read of one source never comes back (the process is about to die of it)
    const dying: typeof fetch = (input) => (String(input) === chains.url ? new Promise<Response>(() => undefined) : Promise.resolve(new Response('<rss><channel></channel></rss>', { status: 200 })));
    void runOpenSources({ db, log: quietLog, fetch: dying, resolve: PUBLIC, sourcesPerPass: 1 }, NOW);
    await new Promise((r) => setTimeout(r, 300));
    // what the database holds at the moment of death: the source already waits, as if the read had failed
    const during = await row('b:llama-chains');
    expect(during).toMatchObject({ failures: 1, lastError: 'a read was started and did not finish' });
    expect(during.nextFetchAt).toEqual(new Date(NOW.getTime() + 2 * chains.everyMin * 60_000));
    // the restarted process, a minute later: it reads the other source and leaves this one alone
    const asked: string[] = [];
    const healthy: typeof fetch = async (input) => (asked.push(String(input)), new Response('<rss><channel></channel></rss>', { status: 200 }));
    expect(await runOpenSources({ db, log: quietLog, fetch: healthy, resolve: PUBLIC, sourcesPerPass: 5 }, at(1))).toMatchObject({ read: 1, failed: 0 });
    expect(asked).toEqual([status.url]);
    // each death doubles the wait: a body that kills every time is tried once a day at most, never in a loop
    await db.update(dsSources).set({ nextFetchAt: at(2) }).where(eq(dsSources.id, 'b:llama-chains'));
    void runOpenSources({ db, log: quietLog, fetch: dying, resolve: PUBLIC, sourcesPerPass: 1 }, at(3));
    await new Promise((r) => setTimeout(r, 300));
    const again = await row('b:llama-chains');
    expect(again.failures).toBe(2);
    expect(again.nextFetchAt).toEqual(new Date(at(3).getTime() + 4 * chains.everyMin * 60_000));
    // and a read that ends well puts the source back on its own interval
    await db.update(dsSources).set({ nextFetchAt: at(4) }).where(eq(dsSources.id, 'b:llama-chains'));
    const good: typeof fetch = async () => new Response(JSON.stringify([{ name: 'Base', tvl: 5_000_000_000 }]), { status: 200 });
    expect(await runOpenSources({ db, log: quietLog, fetch: good, resolve: PUBLIC, sourcesPerPass: 1 }, at(5))).toMatchObject({ read: 1, created: 1 });
    expect(await row('b:llama-chains')).toMatchObject({ failures: 0, lastError: null });
    expect((await row('b:llama-chains')).nextFetchAt).toEqual(new Date(at(5).getTime() + chains.everyMin * 60_000));
  });
});

describe('(b) the feed reader is one forward pass', () => {
  it("the reviewer's body: 2 MB of tags that are not items is read in about the time it takes to scan it", () => {
    for (const filler of ['<itemx>', '<entryway>', '<items a="1">', '<itemx><entryx>', '<item-like><entry.x>']) {
      const body = `<rss><channel>${filler.repeat(Math.ceil((2 * MB) / filler.length))}<item><title>Coinbase ships agent payments</title><guid>real</guid></item></channel></rss>`;
      expect(body.length).toBeGreaterThanOrEqual(2 * MB);
      const t = timed(() => parseFeed(body));
      expect(t.ms, filler).toBeLessThan(1500);
      // the real item behind the noise is still found
      expect(t.value.map((i) => i.id), filler).toEqual(['real']);
    }
  });

  it('2 MB of empty items, of items with no end and of nested openings each cost a bounded read', () => {
    const cases = ['<item></item>'.repeat(170_000), '<entry><id></id></entry>'.repeat(90_000), '<item>'.repeat(350_000), `<item><title>${'<title>'.repeat(290_000)}`, '<item><link '.repeat(180_000)];
    for (const body of cases) {
      const t = timed(() => parseFeed(body));
      expect(t.ms, body.slice(0, 24)).toBeLessThan(1500);
      expect(t.value.length).toBeLessThanOrEqual(FEED_ITEMS_MAX);
    }
    expect(FEED_BLOCKS_MAX).toBe(600);
  });
});

describe('(c) one source has a bounded share of a day', () => {
  const item = (sourceId: string, i: number) => sighting(sourceId, { id: `${sourceId}-${i}`, title: `Arbitrum governance topic number ${i} about a different stablecoin vault`, link: `${new URL(source(sourceId).url).origin}/t/${i}` });
  const put = (s: ReturnType<typeof item>, minutes: number, opts: { sourceRecordsPerDay?: number; sourceSightingsPerDay?: number } = {}) => ingestSighting(db, infoOf(s.sourceId), s, { now: at(minutes), ...opts });

  it('new records: past its share a source starts no more, and the others are not touched', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) outcomes.push((await put(item('b:arbitrum-gov', i), i, { sourceRecordsPerDay: 3 })).outcome);
    expect(outcomes).toEqual(['created', 'created', 'created', 'capped', 'capped']);
    expect(await put(item('b:arbitrum-gov', 9), 9, { sourceRecordsPerDay: 3 })).toEqual({ outcome: 'capped', by: 'source' });
    const other = sighting('b:aave-gov', { id: 'aave-0', title: '[ARFC] Onboard GHO to the Base instance of Aave v3', link: 'https://governance.aave.com/t/arfc-gho/1' });
    expect((await put(other, 10, { sourceRecordsPerDay: 3 })).outcome).toBe('created');
    expect((await db.query.cursors.findFirst({ where: eq(cursors.name, 'dataset:capped:2026-11-15') }))!.value).toBe('3');
    // the next day it has its share again
    expect((await ingestSighting(db, infoOf('b:arbitrum-gov'), item('b:arbitrum-gov', 20), { now: at(24 * 60), sourceRecordsPerDay: 3 })).outcome).toBe('created');
  });

  it('sightings: a source that repeats itself onto records that exist is bounded too', async () => {
    const first = await put(item('b:the-defiant', 0), 0);
    const outcomes: string[] = [];
    for (let i = 1; i <= 6; i++) outcomes.push((await put({ ...item('b:the-defiant', 0), externalId: `again-${i}` }, i, { sourceSightingsPerDay: 4 })).outcome);
    expect(outcomes).toEqual(['attached', 'attached', 'attached', 'capped', 'capped', 'capped']);
    expect(first.outcome).toBe('created');
    expect(await db.select().from(dsSightings)).toHaveLength(4);
  });

  it('the defaults are a share of the day, not the day; 0 lifts the bound', async () => {
    expect([DEFAULT_SOURCE_RECORDS_PER_DAY, DEFAULT_SOURCE_SIGHTINGS_PER_DAY]).toEqual([40, 120]);
    const outcomes: string[] = [];
    for (let i = 0; i < 43; i++) outcomes.push((await put(item('b:coindesk', i), 0)).outcome);
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(40);
    expect(outcomes.slice(40)).toEqual(['capped', 'capped', 'capped']);
    expect((await put(item('b:coindesk', 100), 1, { sourceRecordsPerDay: 0, sourceSightingsPerDay: 0 })).outcome).toBe('created');
    expect(await db.select().from(dsRecords)).toHaveLength(41);
  });
});

describe("(d) the owner's view reads a bounded number of rows", () => {
  it('a record with thousands of sightings is counted in the database and shown by its first few', async () => {
    const r = await ingestSighting(db, infoOf('b:coindesk'), sighting('b:coindesk', { id: 'one', title: 'Kraken acquires tokenization startup Backed', link: 'https://www.coindesk.com/kraken' }), { now: NOW });
    if (r.outcome !== 'created') throw new Error('expected a record');
    const many = Array.from({ length: DAY_SIGHTINGS_MAX + 500 }, (_, i) => ({ id: `flood-${i}`, sourceId: 'b:coindesk', recordId: r.recordId, externalId: `flood-${i}`, kind: 'statement', title: 'Kraken acquires tokenization startup Backed', matchedBy: 'link', seenAt: at(1 + i / 100) }));
    for (let i = 0; i < many.length; i += 500) await db.insert(dsSightings).values(many.slice(i, i + 500));
    const view = await datasetDayView(db, '2026-11-15', true);
    expect(view.totals).toMatchObject({ records: 1, sightings: DAY_SIGHTINGS_MAX + 501, byMatch: { new: 1, link: DAY_SIGHTINGS_MAX + 500 } });
    expect(view.records).toHaveLength(1);
    expect(view.records[0]!.sightings).toHaveLength(RECORD_SIGHTINGS_SHOWN);
    expect(view.records[0]!.sightings[0]).toMatchObject({ matchedBy: 'new' });
  });
});
