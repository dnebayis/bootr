/**
 * The security review's first finding (H1), as its own cases: a stranger with a free forum account must not be able
 * to write an "official" record, take over somebody else's record, or lift one alone. A forum is a venue, not the
 * entity's voice; a source is official only for what its item is about and the record already was about; a link in
 * somebody's text places a sighting and gives the record nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { dsRecords } from '../src/db/schema.js';
import { gradeOf, incidentSourced } from '../src/dataset/grades.js';
import { OPEN_SOURCES } from '../src/dataset/sources.js';
import { ingestSighting, mergeRecords, type IngestResult } from '../src/dataset/store.js';
import type { RecordSource, Sighting } from '../src/dataset/types.js';
import { D, infoOf, NOW, sighting } from './dataset-helpers.js';
import { testDb } from './helpers.js';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await testDb());
});
afterEach(async () => {
  await close();
});

const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const put = (s: Sighting, minutes = 0) => ingestSighting(db, infoOf(s.sourceId), s, { now: at(minutes) });
const record = async (id: string) => (await db.query.dsRecords.findFirst({ where: eq(dsRecords.id, id) }))!;
const idOf = (r: IngestResult): string => {
  if (r.outcome === 'capped') throw new Error('capped');
  return r.recordId;
};
const sourcesOf = async (id: string) => (await record(id)).sources as unknown as RecordSource[];

const DESK_LINK = 'https://www.coindesk.com/tech/2026/11/15/acme-lend-exploit';
/** Three desks carry a real incident: grade 3, the first desk's headline and link. */
async function incident(where = 'Arbitrum') {
  const title = `Lender Acme Lend on ${where} exploited for $12 million in oracle attack`;
  const a = await put(sighting('b:coindesk', { id: 'cd', title, link: DESK_LINK }));
  await put(sighting('b:the-block', { id: 'tb', title: `Acme Lend on ${where} exploited for $12 million in oracle attack`, link: 'https://www.theblock.co/post/1/acme-lend' }), 10);
  await put(sighting('b:decrypt', { id: 'dc', title: `Acme Lend on ${where} loses $12 million in oracle attack exploit`, link: 'https://decrypt.co/1/acme-lend' }), 20);
  const id = idOf(a);
  expect(await record(id)).toMatchObject({ grade: 3, groups: 3, kind: 'incident', headline: title, link: DESK_LINK, observationCount: 3 });
  return id;
}

describe('a forum is a venue, not the entity', () => {
  it('no open venue is official for anything, and the six governance forums are open venues', () => {
    const open = OPEN_SOURCES.filter((s) => s.open);
    expect(open.map((s) => s.id).sort()).toEqual(['b:aave-gov', 'b:arbitrum-gov', 'b:arxiv-cs-ai', 'b:clanker-site', 'b:eth-magicians', 'b:ethresearch', 'b:lido-research', 'b:morpho-forum', 'b:optimism-gov', 'b:uniswap-gov', 'b:x-dev-forum', 'b:x402-site']);
    for (const s of open) expect(s.officialFor, s.id).toEqual([]);
    // every source that is official is the entity's own publication: no forum, no news desk, no aggregator
    for (const s of OPEN_SOURCES.filter((x) => x.officialFor.length)) {
      expect(s.url, s.id).not.toMatch(/forum|gov\.|governance|research\.lido|latest\.rss|magicians|devcommunity/);
      expect(s.cluster, s.id).not.toBe('news');
    }
    // a feed that carries guests is nobody's voice either
    expect(OPEN_SOURCES.find((s) => s.id === 'b:hugging-face')!.officialFor).toEqual([]);
  });

  it("the reviewer's case: a topic alone on the Aave forum is grade 1, not 4", async () => {
    for (const [i, title] of ['Circle to freeze USDC on Base next week, holders should exit', 'Circle to freeze USDC on Base next week'].entries()) {
      const r = await put(sighting('b:aave-gov', { id: `topic-${i}`, title, link: `https://governance.aave.com/t/circle-freeze/${i}` }), i);
      expect(r.outcome).toBe('created');
      expect(await record(idOf(r))).toMatchObject({ grade: 1, groups: 1 });
      expect(await sourcesOf(idOf(r))).toEqual([expect.objectContaining({ sourceId: 'b:aave-gov', official: false, open: true })]);
    }
  });

  it("the reviewer's variant: the same title on three forums joined by links is still one stranger: grade 1, nothing official, no groups", async () => {
    const title = 'Optimism to pause withdrawals on OP Mainnet during the Ethereum upgrade';
    const first = await put(sighting('b:optimism-gov', { id: 'op', title, link: 'https://gov.optimism.io/t/pause-withdrawals/9001' }));
    const second = await put(sighting('b:eth-magicians', { id: 'mag', title, link: 'https://ethereum-magicians.org/t/pause-withdrawals/9002', hrefs: ['https://gov.optimism.io/t/pause-withdrawals/9001'] }), 5);
    const third = await put(sighting('b:ethresearch', { id: 'res', title, link: 'https://ethresear.ch/t/pause-withdrawals/9003', hrefs: ['https://gov.optimism.io/t/pause-withdrawals/9001'] }), 10);
    expect([second.outcome, third.outcome]).toEqual(['attached', 'attached']);
    const row = await record(idOf(first));
    expect(row).toMatchObject({ grade: 1, groups: 1, observationCount: 3, status: 'open' });
    expect((await sourcesOf(row.id)).map((s) => [s.sourceId, s.official, s.open])).toEqual([
      ['b:optimism-gov', false, true],
      ['b:eth-magicians', false, true],
      ['b:ethresearch', false, true],
    ]);
    expect(incidentSourced(await sourcesOf(row.id))).toBe(false);
    // the same in the grade itself: any number of open venues is grade 1, and they add nothing to a desk's record
    const venue = (g: string): RecordSource => ({ sourceId: `b:${g}`, cluster: 'governance', group: g, official: false, open: true, link: null, seenAt: NOW.toISOString() });
    const desk = (g: string): RecordSource => ({ sourceId: `b:${g}`, cluster: 'news', group: g, official: false, link: null, seenAt: NOW.toISOString() });
    expect(gradeOf(['a', 'b', 'c', 'd'].map(venue), true)).toEqual({ grade: 1, groups: 1 });
    expect(gradeOf([desk('coindesk'), venue('a'), venue('b')], true)).toEqual({ grade: 1, groups: 1 });
    expect(gradeOf([desk('coindesk'), desk('decrypt'), venue('a')], false)).toEqual({ grade: 3, groups: 2 });
  });
});

describe('a stranger cannot take over a record', () => {
  it("the reviewer's case: a forum topic with the desk's link in its body gives the record no headline, no link, no grade, no entity", async () => {
    const id = await incident();
    const before = await record(id);
    const attack = await put(sighting('b:arbitrum-gov', { id: 'attack', title: 'Affected users: recover funds at base-rescue.xyz, says .@rescuebot', link: 'https://forum.arbitrum.foundation/t/recover-funds/31001', hrefs: [DESK_LINK] }), 30);
    // it shares the record's name (Arbitrum) and points at it, so it is carried on it, and that is all
    expect(attack).toEqual({ outcome: 'attached', recordId: id, matchedBy: 'relation' });
    const after = await record(id);
    expect(after).toMatchObject({ headline: before.headline, link: DESK_LINK, grade: 3, groups: 3, kind: 'incident', observationCount: 4 });
    expect(after.entities).toEqual(before.entities);
    expect(after.numbers).toEqual(before.numbers);
    expect(after.eventTime).toEqual(before.eventTime);
    expect(incidentSourced(after.sources as unknown as RecordSource[])).toBe(false);
    expect((after.sources as unknown as RecordSource[]).at(-1)).toMatchObject({ sourceId: 'b:arbitrum-gov', official: false, open: true });
    expect(JSON.stringify(after)).not.toMatch(/rescue/);
  });

  it('the same with a title no filter would stop: it is where the topic is posted that decides, not how it reads', async () => {
    const id = await incident();
    const calm = 'Acme Lend on Arbitrum exploit: affected users can recover funds through the rescue desk';
    const attack = await put(sighting('b:arbitrum-gov', { id: 'calm', title: calm, link: 'https://forum.arbitrum.foundation/t/acme-rescue/31002', hrefs: [DESK_LINK] }), 30);
    expect(attack.outcome).toBe('attached');
    const headline = 'Lender Acme Lend on Arbitrum exploited for $12 million in oracle attack';
    expect(await record(id)).toMatchObject({ headline, link: DESK_LINK, grade: 3, groups: 3 });
    // and without the link, by its words alone, from a forum that is about something else: carried, nothing more
    const byWords = await put(sighting('b:x-dev-forum', { id: 'calm-2', title: `${headline}, refunds are open`, link: 'https://devcommunity.x.com/t/acme/31003' }), 40);
    expect(byWords).toMatchObject({ outcome: 'attached', recordId: id, matchedBy: 'words' });
    expect(await record(id)).toMatchObject({ headline, link: DESK_LINK, grade: 3, groups: 3 });
    expect((await record(id)).entities).not.toContain('x-api');
    // a later desk is matched against the desks' titles, never against the stranger's
    const later = await put(sighting('b:blockworks', { id: 'bw', title: 'Acme Lend on Arbitrum exploit: affected users can recover funds through the rescue desk, says team', link: 'https://blockworks.co/news/acme-rescue' }), 50);
    expect(later.outcome).toBe('created');
  });

  it('a link places a sighting only on a record it shares a name and a time with', async () => {
    const id = await incident('Base');
    // a topic on the Arbitrum forum about a Base incident shares no name with it
    const elsewhere = await put(sighting('b:arbitrum-gov', { id: 'e', title: 'Affected users should read this thread', link: 'https://forum.arbitrum.foundation/t/read-this/31004', hrefs: [DESK_LINK] }), 30);
    expect(elsewhere.outcome).toBe('created');
    expect(idOf(elsewhere)).not.toBe(id);
    // ten days later the same link is only a link, even with the name
    const late = await ingestSighting(db, infoOf('b:the-defiant'), sighting('b:the-defiant', { id: 'late', title: 'A look back at the Base lending market after the Acme Lend exploit', link: 'https://thedefiant.io/news/look-back', hrefs: [DESK_LINK] }, new Date(NOW.getTime() + 10 * D)), { now: new Date(NOW.getTime() + 10 * D) });
    expect(late.outcome).toBe('created');
    expect((await record(id)).observationCount).toBe(3);
  });
});

describe('official means the entity itself, speaking about itself, on a record that was already about it', () => {
  it('at creation: an item is official for what its own text names, or for the one thing its source is about', async () => {
    const grade = async (sourceId: string, title: string, extra: { summary?: string } = {}) => {
      const r = await put(sighting(sourceId, { id: `${sourceId}:${title}`, title, link: `${new URL(infoOf(sourceId).id === 'b:base-status' ? 'https://base-l2.statuspage.io' : 'https://x.invalid').origin}/x`, ...extra }));
      const row = await record(idOf(r));
      return [row.grade, (row.sources as unknown as RecordSource[])[0]!.official];
    };
    // the entity's own release feed and status page are about nothing else
    expect(await grade('b:base-node', 'v1.3.0')).toEqual([4, true]);
    expect(await grade('b:base-status', 'Degraded RPC performance')).toEqual([4, true]);
    // a blog is official when it speaks about the entity it belongs to
    expect(await grade('b:circle', 'Circle brings native USDC to Robinhood Chain')).toEqual([4, true]);
    expect(await grade('b:ethereum-blog', 'Fusaka Mainnet Announcement', { summary: 'The upgrade activates on Ethereum mainnet in December.' })).toEqual([4, true]);
    // and not when it speaks about somebody else, or names nobody
    expect(await grade('b:circle', 'Tether to freeze USDT on Tron next week')).toEqual([1, false]);
    expect(await grade('b:stripe', 'What agents need from stablecoins')).toEqual([1, false]);
    expect(await grade('b:ethereum-blog', 'Protocol update 003')).toEqual([1, false]);
  });

  it('on a record that exists: only for an entity the record already had, however the sighting got there', async () => {
    // a desk's record about Circle; Stripe's blog joins it by its words and brings its own name along
    const a = await put(sighting('b:the-block', { id: 'tb', title: 'Circle expands USDC accounts to businesses in 100 countries', link: 'https://www.theblock.co/post/2/circle-accounts' }));
    const joined = await put(sighting('b:stripe', { id: 'st', title: 'Stripe: Circle expands USDC accounts to businesses in 100 countries', link: 'https://stripe.com/blog/circle-accounts' }), 10);
    expect(joined).toMatchObject({ outcome: 'attached', matchedBy: 'words' });
    let row = await record(idOf(a));
    // the record was not about Stripe before Stripe arrived: not official, the desk keeps its headline and link
    expect(row).toMatchObject({ grade: 3, groups: 2, headline: 'Circle expands USDC accounts to businesses in 100 countries', link: 'https://www.theblock.co/post/2/circle-accounts' });
    expect((row.sources as unknown as RecordSource[]).map((s) => s.official)).toEqual([false, false]);
    expect(row.entities).toContain('stripe');
    // Circle's own blog, about Circle, on a record that was about Circle: official, and now the headline and link are its
    await put(sighting('b:circle', { id: 'ci', title: 'Circle expands USDC accounts to businesses in 100 countries worldwide', link: 'https://www.circle.com/blog/usdc-accounts' }), 20);
    row = await record(idOf(a));
    expect(row).toMatchObject({ grade: 5, groups: 3, headline: 'Circle expands USDC accounts to businesses in 100 countries worldwide', link: 'https://www.circle.com/blog/usdc-accounts' });
    expect((row.sources as unknown as RecordSource[]).map((s) => s.official)).toEqual([false, false, true]);
  });

  it('a sighting that points at a record is never official on it and never gives it its headline or link, whoever it is', async () => {
    const a = await put(sighting('b:the-block', { id: 'tb', title: 'Circle to bring native USDC to Robinhood Chain', link: 'https://www.theblock.co/post/3/circle-robinhood' }));
    // Circle's own blog, about Circle, pointing at the desk's article
    const pointing = await put(sighting('b:circle', { id: 'ci', title: 'Our week in review: Circle and USDC', link: 'https://www.circle.com/blog/week-in-review', hrefs: ['https://www.theblock.co/post/3/circle-robinhood'] }), 10);
    expect(pointing).toEqual({ outcome: 'attached', recordId: idOf(a), matchedBy: 'relation' });
    const row = await record(idOf(a));
    expect(row).toMatchObject({ headline: 'Circle to bring native USDC to Robinhood Chain', link: 'https://www.theblock.co/post/3/circle-robinhood', grade: 3, groups: 2 });
    expect((row.sources as unknown as RecordSource[]).map((s) => s.official)).toEqual([false, false]);
    // the other way round (the desk pointed at Circle's page, and the page is then read) the page is the event itself
    const b = await put(sighting('b:decrypt', { id: 'dc', title: 'Circle rolls out a payments network for banks', link: 'https://decrypt.co/2/circle-network', hrefs: ['https://www.circle.com/blog/payments-network'] }), 20);
    await put(sighting('b:circle', { id: 'ci-2', title: 'Introducing the Circle Payments Network', link: 'https://www.circle.com/blog/payments-network' }), 30);
    expect(await record(idOf(b))).toMatchObject({ grade: 4, headline: 'Introducing the Circle Payments Network', link: 'https://www.circle.com/blog/payments-network' });
  });
});

describe('two records are one only when they could be', () => {
  it('a sighting that links one record and reads like another does not fold two unrelated stories together', async () => {
    const kraken = await put(sighting('b:coindesk', { id: 'k', title: 'Kraken acquires tokenization startup Backed for its stocks business', link: 'https://www.coindesk.com/business/kraken-backed' }));
    const page = await put(sighting('b:rekt', { id: 'p', title: 'Acme Lend - Rekt', link: 'https://rekt.news/acme-lend-rekt', undated: true, published: undefined }), 5);
    // it points at the post-mortem page and reads like the Kraken story; it names both
    const both = await put(sighting('b:the-defiant', { id: 'b', title: 'Kraken acquires tokenization startup Backed for its stocks business after exploit', link: 'https://thedefiant.io/news/kraken-backed', hrefs: ['https://rekt.news/acme-lend-rekt'] }), 10);
    expect(both).toEqual({ outcome: 'attached', recordId: idOf(page), matchedBy: 'relation' });
    expect(await db.select().from(dsRecords)).toHaveLength(2);
    expect((await record(idOf(kraken))).observationCount).toBe(1);
    // asked directly: no shared entity, no merge; a shared entity and kinds that cannot be one event, no merge
    expect(await mergeRecords(db, idOf(kraken), idOf(page), at(20))).toBeNull();
    const launch = await put(sighting('b:blockworks', { id: 'l', title: 'Kraken launches a wallet for tokenized stocks', link: 'https://blockworks.co/news/kraken-wallet' }), 30);
    const hack = await put(sighting('b:dl-news', { id: 'h', title: 'Kraken hacked: attacker drains hot wallet in overnight exploit', link: 'https://www.dlnews.com/articles/kraken-hack' }), 40);
    expect([(await record(idOf(launch))).kind, (await record(idOf(hack))).kind]).toEqual(['launch', 'incident']);
    expect(await mergeRecords(db, idOf(launch), idOf(hack), at(50))).toBeNull();
    expect(await db.select().from(dsRecords)).toHaveLength(4);
  });
});
