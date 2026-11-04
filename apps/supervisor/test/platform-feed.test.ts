import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { BOOTR_TODAY_MEANING, BOOTR_TODAY_UNAVAILABLE, bootrTodaySection } from '../src/context.js';
import type { IndexerClient } from '../src/indexer-client.js';
import { PLATFORM_FEED_MAX_CHARS, PLATFORM_FEED_TTL_MS, buildPlatformFeed, cachedPlatformFeed, formatPlatformFeed, milestoneWords, type PlatformFeedData } from '../src/platform-feed.js';
import { AGENT_ID, finishResponse, KERNEL, makeWorld, seedAgent } from './helpers.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const OWN = KERNEL.toLowerCase();
const OWL = '0x00000000000000000000000000000000000000aa';
const FOX = '0x00000000000000000000000000000000000000bb';
const OLD = '0x00000000000000000000000000000000000000cc';

function busyDay(): PlatformFeedData {
  return {
    now: NOW / 1000,
    since: NOW / 1000 - 7 * 86_400,
    totals: { tokens: 14, agentsTotal: 14, agentsAwake: 6, volume24hUsd: 12_345, volume7dUsd: 80_100, fees24hUsd: 120, updatedAt: sec('2026-11-04T11:58:00Z') },
    launches: [
      { token: '0x1', kernel: FOX, name: 'Fox Coin', symbol: 'FOX', creator: '0x1234567890abcdef1234567890abcdef12345678', launchedAt: sec('2026-11-04T06:00:00Z'), xHandle: null },
      { token: '0x2', kernel: OWL, name: 'Owl\nCoin\u0007 with a very long name that keeps going', symbol: 'OWL', creator: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', launchedAt: sec('2026-11-04T09:12:00Z'), xHandle: 'owlagent' },
      { token: '0x3', kernel: OLD, name: 'Old Coin', symbol: 'OLD', creator: '0x1234567890abcdef1234567890abcdef12345678', launchedAt: sec('2026-11-01T09:00:00Z'), xHandle: 'oldagent' },
      { token: '0x4', kernel: OWN, name: 'Bootr', symbol: 'BOOTR', creator: '0x1234567890abcdef1234567890abcdef12345678', launchedAt: sec('2026-11-04T01:00:00Z'), xHandle: 'AgentBootr' },
    ],
    statusChanges: [
      { kernel: OWL, symbol: 'OWL', status: 'awake', at: sec('2026-11-04T09:15:00Z'), xHandle: 'owlagent' },
      { kernel: OLD, symbol: 'OLD', status: 'sleeping', at: sec('2026-11-02T20:00:00Z'), xHandle: 'oldagent' },
      { kernel: OWN, symbol: 'BOOTR', status: 'awake', at: sec('2026-11-04T10:00:00Z'), xHandle: 'AgentBootr' },
    ],
    posts: [
      { kernel: OLD, symbol: 'OLD', xHandle: 'oldagent', lastPostAt: sec('2026-11-04T08:00:00Z'), postsCount24h: 1 },
      { kernel: OWL, symbol: 'OWL', xHandle: 'owlagent', lastPostAt: sec('2026-11-04T10:30:00Z'), postsCount24h: 3 },
      { kernel: OWN, symbol: 'BOOTR', xHandle: 'AgentBootr', lastPostAt: sec('2026-11-04T11:00:00Z'), postsCount24h: 2 },
    ],
    claims: [
      { token: '0x3', kernel: OLD, symbol: 'OLD', amountUsd: 42.1, at: sec('2026-11-04T07:00:00Z'), txHash: '0xaa' },
      { token: '0x3', kernel: OLD, symbol: 'OLD', amountUsd: 10, at: sec('2026-11-02T07:00:00Z'), txHash: '0xab' },
    ],
    milestones: [
      { token: '0x1', kernel: FOX, symbol: 'FOX', kind: 'holders', value: 25, at: sec('2026-11-04T11:30:00Z'), txHash: null },
      { token: '0x2', kernel: OWL, symbol: 'OWL', kind: 'first_swap', value: 0, at: sec('2026-11-04T09:30:00Z'), txHash: '0xac' },
      { token: '0x3', kernel: OLD, symbol: 'OLD', kind: 'volume24h', value: 1000, at: sec('2026-11-02T10:00:00Z'), txHash: '0xad' },
      { token: '0x4', kernel: OWN, symbol: 'BOOTR', kind: 'holders', value: 100, at: sec('2026-11-04T11:40:00Z'), txHash: null },
    ],
    firstPosts: [
      { kernel: OWL, symbol: 'OWL', xHandle: 'owlagent', firstPostAt: sec('2026-11-04T10:30:00Z'), lastPostAt: sec('2026-11-04T10:30:00Z'), postsCount24h: 3 },
      { kernel: OLD, symbol: 'OLD', xHandle: 'oldagent', firstPostAt: sec('2026-11-01T09:30:00Z'), lastPostAt: sec('2026-11-04T08:00:00Z'), postsCount24h: 1 },
      { kernel: OWN, symbol: 'BOOTR', xHandle: 'AgentBootr', firstPostAt: sec('2026-11-04T11:00:00Z'), lastPostAt: sec('2026-11-04T11:00:00Z'), postsCount24h: 2 },
    ],
  };
}

function stubIndexer(answer: () => Promise<Record<string, unknown> | null>) {
  const calls: number[] = [];
  const client = {
    async platformFeed(since: number) {
      calls.push(since);
      return answer();
    },
  } as unknown as IndexerClient;
  return { client, calls };
}

const log = pino({ level: 'silent' });

describe('platform feed formatting', () => {
  it('renders an empty day as nothing noteworthy, with the totals and the 7-day line', () => {
    const feed = formatPlatformFeed({ now: NOW / 1000, since: NOW / 1000 - 7 * 86_400, totals: { tokens: 3, agentsTotal: 3, agentsAwake: 1, volume24hUsd: 0, volume7dUsd: 15.5 } }, { now: NOW });
    expect(feed.available).toBe(true);
    expect(feed.noteworthy).toBe(false);
    expect(feed.text).toContain('Nothing noteworthy on Bootr in the last 24 h (since 2026-11-03T12:00:00Z)');
    expect(feed.text).toContain('Totals: 3 coins, 1 agent awake of 3, $0.00 traded in 24 h.');
    expect(feed.text).toContain('(since 2026-11-03T12:00:00Z): no launches, milestones, wake/sleep changes, posts or agent fee claims.');
    expect(feed.text).toContain('Last 7 d (since 2026-10-28T12:00:00Z): 0 new coins, 0 milestones, 0 wake/sleep changes, 0 agents posted, 0 agent fee claims, $15.50 traded.');
    expect(feed.day).toEqual({ launches: 0, statusChanges: 0, posters: 0, firstPosts: 0, claims: 0, claimedUsd: 0, milestones: 0 });
  });

  it('renders a busy day newest first with ISO dates, leaves out the reader itself and cleans third-party strings', () => {
    const feed = formatPlatformFeed(busyDay(), { now: NOW, exclude: KERNEL });
    expect(feed.noteworthy).toBe(true);
    expect(feed.day).toEqual({ launches: 2, statusChanges: 1, posters: 2, firstPosts: 1, claims: 1, claimedUsd: 42.1, milestones: 2 });
    expect(feed.week).toEqual({ launches: 3, statusChanges: 2, posters: 2, firstPosts: 2, claims: 2, claimedUsd: 52.1, milestones: 3 });
    const text = feed.text;
    expect(text.length).toBeLessThanOrEqual(PLATFORM_FEED_MAX_CHARS);
    expect(text).toContain('Last 24 h (since 2026-11-03T12:00:00Z), newest first: 2 new coins, 2 milestones, 1 wake/sleep change, 2 agents posted (1 for the first time), 1 agent fee claim.');
    expect(text).toContain('Totals: 14 coins, 6 agents awake of 14, $12.3k traded in 24 h (indexer at 2026-11-04T11:58:00Z).');
    // newest launch first; the name is cleaned and clipped, the creator shortened
    const owl = text.indexOf('- 2026-11-04T09:12:00Z Owl Coin with a very long name t ($OWL) launched by 0xabcd…abcd, agent @owlagent');
    const fox = text.indexOf('- 2026-11-04T06:00:00Z Fox Coin ($FOX) launched by 0x1234…5678, agent not on X yet');
    expect(owl).toBeGreaterThan(-1);
    expect(fox).toBeGreaterThan(owl);
    expect(text).toContain('- 2026-11-04T09:15:00Z $OWL agent (@owlagent) woke up');
    expect(text).not.toContain('went to sleep'); // 2026-11-02T20:00Z is older than 24 h
    expect(text.indexOf('$OWL agent (@owlagent): 3 posts in 24 h')).toBeLessThan(text.indexOf('$OLD agent (@oldagent): 1 post in 24 h'));
    expect(text).toContain('- 2026-11-04T07:00:00Z $OLD agent claimed $42.10 in fees');
    // milestones newest first; the one older than 24 h is counted in the week only
    const fox25 = text.indexOf('- 2026-11-04T11:30:00Z $FOX reached 25 holders');
    const owlFirst = text.indexOf('- 2026-11-04T09:30:00Z $OWL had its first trade');
    expect(fox25).toBeGreaterThan(-1);
    expect(owlFirst).toBeGreaterThan(fox25);
    expect(text).not.toContain('passed $1.0k traded');
    expect(text).toContain('- 2026-11-04T10:30:00Z $OWL agent (@owlagent) posted for the first time');
    expect(text).not.toContain('$OLD agent (@oldagent) posted for the first time');
    expect(text).toContain('Last 7 d (since 2026-10-28T12:00:00Z): 3 new coins ($OWL, $FOX, $OLD), 3 milestones, 2 wake/sleep changes, 2 agents posted (2 for the first time), 2 agent fee claims ($52.10), $80.1k traded.');
    // the reader's own coin, status, posts never appear
    expect(text).not.toContain('BOOTR');
    expect(text).not.toContain('AgentBootr');
    expect(text).not.toContain('\u0007');
  });

  it('words every milestone kind and never prints a control character', () => {
    expect(milestoneWords('first_swap', 0)).toBe('had its first trade');
    expect(milestoneWords('holders', 100)).toBe('reached 100 holders');
    expect(milestoneWords('holders', 1)).toBe('reached 1 holder');
    expect(milestoneWords('volume24h', 10_000)).toBe('passed $10.0k traded in 24 h');
    expect(milestoneWords('vol\u0007ume', 'x')).toBe('reached milestone vol ume 0');
  });

  it('a day with only a milestone or a first post is noteworthy', () => {
    const base = { now: NOW / 1000, since: NOW / 1000 - 7 * 86_400, totals: { tokens: 3, agentsTotal: 3, agentsAwake: 1 } };
    const m = formatPlatformFeed({ ...base, milestones: [{ token: '0x1', kernel: FOX, symbol: 'FOX', kind: 'holders', value: 500, at: sec('2026-11-04T11:00:00Z') }] }, { now: NOW, exclude: KERNEL });
    expect(m.noteworthy).toBe(true);
    expect(m.text).toContain('Milestones:\n- 2026-11-04T11:00:00Z $FOX reached 500 holders');
    const p = formatPlatformFeed({ ...base, firstPosts: [{ kernel: FOX, symbol: 'FOX', xHandle: 'foxagent', firstPostAt: sec('2026-11-04T11:00:00Z') }] }, { now: NOW, exclude: KERNEL });
    expect(p.noteworthy).toBe(true);
    expect(p.text).toContain('First posts:\n- 2026-11-04T11:00:00Z $FOX agent (@foxagent) posted for the first time');
    const own = formatPlatformFeed({ ...base, milestones: [{ token: '0x4', kernel: KERNEL, kind: 'holders', value: 500, at: sec('2026-11-04T11:00:00Z') }] }, { now: NOW, exclude: KERNEL });
    expect(own.noteworthy).toBe(false);
  });

  it('truncates to the character cap from the end of the lists and says how much was cut', () => {
    const data = busyDay();
    data.launches = Array.from({ length: 60 }, (_, i) => ({
      token: `0x${i}`,
      kernel: `0x${i.toString(16).padStart(40, '0')}`,
      name: `Launch number ${i} with a name`,
      symbol: `L${i}`,
      creator: '0x1234567890abcdef1234567890abcdef12345678',
      launchedAt: sec('2026-11-04T11:00:00Z') - i * 60,
      xHandle: `agent${i}`,
    }));
    const feed = formatPlatformFeed(data, { now: NOW, exclude: KERNEL });
    expect(feed.text.length).toBeLessThanOrEqual(PLATFORM_FEED_MAX_CHARS);
    expect(feed.text.length).toBeGreaterThan(PLATFORM_FEED_MAX_CHARS - 200);
    expect(feed.text).toMatch(/- \(\+\d+ more launches\)/);
    // the header, the totals and the 7-day summary survive; the newest launch is kept
    expect(feed.text).toContain('Last 24 h (since');
    expect(feed.text).toContain('Last 7 d (since');
    expect(feed.text).toContain('Launch number 0 with a name ($L0)');
    expect(feed.day.launches).toBe(60);
  });
});

describe('platform feed reading', () => {
  it('degrades when the indexer does not answer or throws', async () => {
    const silent = stubIndexer(async () => null);
    const feed = await buildPlatformFeed({ indexer: silent.client, now: () => NOW, log }, { exclude: KERNEL });
    expect(feed.available).toBe(false);
    expect(feed.noteworthy).toBe(false);
    expect(feed.text).toContain('unavailable');
    const broken = stubIndexer(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await buildPlatformFeed({ indexer: broken.client, now: () => NOW, log })).available).toBe(false);
  });

  it('makes one indexer call per tick and a fresh one after the TTL', async () => {
    let now = NOW;
    const stub = stubIndexer(async () => busyDay() as unknown as Record<string, unknown>);
    const ctx = { indexer: stub.client, now: () => now, log };
    const [a, b] = await Promise.all([cachedPlatformFeed(ctx, { exclude: KERNEL }), cachedPlatformFeed(ctx, { exclude: KERNEL })]);
    now += 10_000;
    const c = await cachedPlatformFeed(ctx, { exclude: KERNEL });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toBe(Math.floor((NOW - 7 * 86_400_000) / 1000));
    expect(a.text).toBe(b.text);
    expect(c.now).toBe(now);
    now += PLATFORM_FEED_TTL_MS;
    await cachedPlatformFeed(ctx, { exclude: KERNEL });
    expect(stub.calls).toHaveLength(2);
  });
});

describe('"Bootr today" observation section', () => {
  it('is empty for a coin agent and present, with its meaning, for the platform agent', async () => {
    const stub = stubIndexer(async () => busyDay() as unknown as Record<string, unknown>);
    const ctx = { indexer: stub.client, now: () => NOW, log } as never;
    expect(await bootrTodaySection(ctx, { kernel: KERNEL }, { platform: false })).toEqual({});
    const section = (await bootrTodaySection(ctx, { kernel: KERNEL }, { platform: true })) as { bootrToday: Record<string, unknown> };
    expect(section.bootrToday).toMatchObject({ instructionAuthority: false, meaning: BOOTR_TODAY_MEANING, source: 'indexer', available: true, noteworthy: true });
    expect(section.bootrToday.window).toEqual({ since: '2026-10-28T12:00:00.000Z', until: '2026-11-04T12:00:00.000Z' });
    expect(String(section.bootrToday.digest)).toContain('@owlagent');
    expect(BOOTR_TODAY_MEANING).toMatch(/facts you may mention/);
    expect(BOOTR_TODAY_MEANING).toMatch(/with its date/);
    expect(BOOTR_TODAY_MEANING).toMatch(/skip the slot/);
    const down = stubIndexer(async () => null);
    const off = (await bootrTodaySection({ indexer: down.client, now: () => NOW, log } as never, { kernel: KERNEL }, { platform: true })) as { bootrToday: Record<string, unknown> };
    expect(off.bootrToday).toMatchObject({ available: false, digest: BOOTR_TODAY_UNAVAILABLE });
  });

  it('reaches the platform agent\'s first observation through the turn, and no one else\'s', async () => {
    for (const platform of [true, false]) {
      const w = await makeWorld({ script: [finishResponse(NOW + 3_600_000)] });
      try {
        const stub = stubIndexer(async () => busyDay() as unknown as Record<string, unknown>);
        (w.ctx as { indexer: IndexerClient }).indexer = { ...(w.indexer.client as object), platformFeed: stub.client.platformFeed } as IndexerClient;
        w.setNow(NOW);
        await seedAgent(w, { config: { platform, socialStartedAt: new Date(NOW - 3_600_000).toISOString() } });
        const { tick } = await import('../src/tick.js');
        const report = await tick(w.ctx);
        expect(report.ran).toEqual([AGENT_ID]);
        const chat = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!;
        const observation = JSON.parse((chat.body as { messages: { content: string }[] }).messages[1]!.content) as Record<string, unknown>;
        if (platform) {
          expect(observation.bootrToday).toMatchObject({ available: true, noteworthy: true, meaning: BOOTR_TODAY_MEANING });
          expect(stub.calls).toHaveLength(1);
        } else {
          expect(observation.bootrToday).toBeUndefined();
          expect(stub.calls).toHaveLength(0);
        }
      } finally {
        await w.close();
      }
    }
  });
});
