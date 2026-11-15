/**
 * What the dataset keeps of an X post's words and how it lets go of them (src/dataset/x-text.ts, X's developer policy
 * on content compliance): a post X no longer shows is removed with what it gave its record; words that cannot be
 * confirmed, are too old, or that a listed page now says itself are let go.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { dsRecords, dsSightings, dsSources } from '../src/db/schema.js';
import { runXAccounts } from '../src/dataset/layer-c.js';
import { ingestSighting, syncSources } from '../src/dataset/store.js';
import { syncXSources } from '../src/dataset/x-pin.js';
import { sweepXText, X_CHECK_AFTER_MS, X_TEXT_KEEP_MS, X_UNCONFIRMED_MAX_MS, X_WITHDRAWN_HEADLINE } from '../src/dataset/x-text.js';
import { H, infoOf, NOW, quietLog, sighting } from './dataset-helpers.js';
import { FakeSenderX } from './dataset-x-helpers.js';
import { testDb } from './helpers.js';

let db: Db;
let close: () => Promise<void>;
let clock: Date;
let x: FakeSenderX;
beforeEach(async () => {
  ({ db, close } = await testDb());
  clock = NOW;
  x = new FakeSenderX(250, () => clock);
  await syncSources(db, NOW);
  await syncXSources(db, NOW);
  for (let i = 0; i < 6; i++) await pass();
});
afterEach(async () => {
  await close();
});

const pass = (cap = 250) => runXAccounts({ db, log: quietLog, x, cap }, clock);
const sightingOf = async (postId: string) => (await db.select().from(dsSightings).where(eq(dsSightings.externalId, postId)))[0] ?? null;
const recordOf = async (id: string) => (await db.query.dsRecords.findFirst({ where: eq(dsRecords.id, id) }))!;
const later = (ms: number) => new Date(NOW.getTime() + ms);

/** `handle` posts `text` (or `given`) and is read at once; every other account waits a year. */
async function read(handle: string, text: string | null, given?: ReturnType<FakeSenderX['add']>) {
  const p = given ?? x.add(x.idOf(handle), text!);
  await db.update(dsSources).set({ nextFetchAt: new Date(NOW.getTime() + 365 * 24 * H) }).where(eq(dsSources.layer, 'c'));
  await db.update(dsSources).set({ nextFetchAt: null }).where(eq(dsSources.id, `x:${x.idOf(handle)}`));
  await pass();
  return { post: p, sighting: (await sightingOf(p.id))! };
}

describe('a post X no longer shows', () => {
  it('is noticed by the one check 20 hours on, and a record nothing else carries is withdrawn with its words gone', async () => {
    const { post, sighting: s } = await read('base', 'Base mainnet upgrade ships today with a new fee market');
    expect((await recordOf(s.recordId)).headline).toBe('Base mainnet upgrade ships today with a new fee market');
    x.gone.add(post.id);
    clock = later(X_CHECK_AFTER_MS + 60_000);
    const report = await pass();
    expect(report.removed).toBe(1);
    expect(await sightingOf(post.id)).toBeNull();
    const r = await recordOf(s.recordId);
    expect(r.status).toBe('withdrawn');
    expect(r.headline).toBe(X_WITHDRAWN_HEADLINE);
    expect(JSON.stringify(r)).not.toContain('fee market');
  });

  it('leaves a record another source carries, without the post: its source, headline and numbers go, the grade is counted again', async () => {
    const page = sighting('b:base-blog', { title: 'Base mainnet upgrade: a new fee market', link: 'https://blog.base.org/fee-market' });
    const stored = await ingestSighting(db, infoOf('b:base-blog'), page, { now: NOW });
    const p = x.add(x.idOf('Uniswap'), 'Uniswap pools on Base get cheaper with the fee market change https://t.co/a1', { urls: [{ url: 'https://t.co/a1', expandedUrl: 'https://blog.base.org/fee-market' }] });
    const { post, sighting: s } = await read('Uniswap', null, p);
    expect(s.recordId).toBe('recordId' in stored ? stored.recordId : '');
    expect((await recordOf(s.recordId)).groups).toBe(2);
    x.gone.add(post.id);
    clock = later(X_CHECK_AFTER_MS + 60_000);
    await pass();
    const r = await recordOf(s.recordId);
    expect(r.status).not.toBe('withdrawn');
    expect((r.sources as { sourceId: string }[]).some((src) => src.sourceId.startsWith('x:'))).toBe(false);
    expect(r.headline).toBe('Base mainnet upgrade: a new fee market');
    expect(r.groups).toBe(1);
  });

  it('confirms a post that is still there once, at one unit', async () => {
    const { post } = await read('base', 'Base mainnet upgrade ships today with a new fee market');
    const before = x.units;
    clock = later(X_CHECK_AFTER_MS + 60_000);
    await pass();
    expect((await sightingOf(post.id))?.checkedAt).not.toBeNull();
    expect(x.units - before).toBe(1);
    clock = later(X_CHECK_AFTER_MS + 2 * 60_000);
    await pass();
    expect(x.units - before).toBe(1);
  });
});

describe('letting go of words', () => {
  it('lets go of words it could not confirm within a day, even with the layer off', async () => {
    const { post, sighting: s } = await read('base', 'Base mainnet upgrade ships today with a new fee market');
    clock = later(X_UNCONFIRMED_MAX_MS + 60_000);
    await pass(0);
    const kept = (await sightingOf(post.id))!;
    expect(kept.title).toBe('');
    expect(kept.withheld).toBe(true);
    expect(kept.link).toBe(s.link);
    expect((await recordOf(s.recordId)).headline).toBe('an item from base on X');
  });

  it('lets go of confirmed words after 44 hours', async () => {
    const { post } = await read('base', 'Base mainnet upgrade ships today with a new fee market');
    clock = later(X_CHECK_AFTER_MS + 60_000);
    await pass();
    expect((await sightingOf(post.id))?.title).not.toBe('');
    const swept = await sweepXText(db, later(X_TEXT_KEEP_MS + 60_000));
    expect(swept.expired).toBe(1);
    expect((await sightingOf(post.id))?.title).toBe('');
  });

  it("lets go at once when a listed page carries the same record in its own words, and the page's title becomes the headline", async () => {
    const { post, sighting: s } = await read('base', 'Base mainnet upgrade ships today with a new fee market');
    const page = sighting('b:base-blog', { title: 'Base mainnet upgrade ships today with a new fee market', link: 'https://blog.base.org/fee-market' }, later(H));
    await ingestSighting(db, infoOf('b:base-blog'), page, { now: later(H) });
    const swept = await sweepXText(db, later(H));
    expect(swept.superseded).toBe(1);
    expect((await sightingOf(post.id))?.title).toBe('');
    expect((await recordOf(s.recordId)).headline).toBe('Base mainnet upgrade ships today with a new fee market');
  });
});
