import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, runtimes } from '../src/db/schema.js';
import type { IndexerClient } from '../src/indexer-client.js';
import type { PlatformFeedData } from '../src/platform-feed.js';
import { processAgent, tick } from '../src/tick.js';
import {
  DEFAULT_DIGEST_AT,
  DIGEST_GRACE_MS,
  DIGEST_WAKE_REASON,
  WEEKLY_DIGEST_INSTRUCTION,
  WEEKLY_DIGEST_PICTURE,
  digestDue,
  digestFacts,
  isoWeekKey,
  lastSlotAt,
  nothingHappened,
  parseDigestAt,
  weeklyDigestSection,
  type WeeklyDigestPlan,
} from '../src/weekly-digest.js';
import { AGENT_ID, KERNEL, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const D = 24 * H;
/** Sunday 2026-11-08 16:05 UTC: five minutes into the default slot of ISO week 2026-W45. */
const SUNDAY = Date.parse('2026-11-08T16:05:00Z');
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const OWN = KERNEL.toLowerCase();
const FOX = '0x00000000000000000000000000000000000000aa';
const OWL = '0x00000000000000000000000000000000000000bb';

/** A week with a little of everything, in the seven days before `now` (dated for SUNDAY, shifted for a later `now`), plus the reader's own items and one stale launch. */
function busyWeek(now = SUNDAY): PlatformFeedData {
  const shift = (now - SUNDAY) / 1000;
  const t = <T extends Record<string, unknown>>(x: T, keys: (keyof T)[]): T => ({ ...x, ...Object.fromEntries(keys.filter((k) => typeof x[k] === 'number').map((k) => [k, (x[k] as number) + shift])) });
  const data: PlatformFeedData = {
    now: now / 1000,
    since: now / 1000 - 7 * 86_400,
    totals: { tokens: 9, agentsTotal: 9, agentsAwake: 4, volume24hUsd: 12_345, volume7dUsd: 80_100, fees24hUsd: 120, updatedAt: sec('2026-11-08T16:00:00Z') },
    launches: [
      { token: '0x1', kernel: FOX, name: 'Fox Coin', symbol: '$FOX', creator: '0x1234567890abcdef1234567890abcdef12345678', launchedAt: sec('2026-11-03T09:00:00Z'), xHandle: 'foxagent' },
      { token: '0x2', kernel: OWL, name: 'Owl\u0007 Coin', symbol: 'OWL', creator: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', launchedAt: sec('2026-11-06T18:30:00Z'), xHandle: null },
      { token: '0x3', kernel: OWN, name: 'Bootr', symbol: 'BOOTR', creator: '0x1234567890abcdef1234567890abcdef12345678', launchedAt: sec('2026-11-05T01:00:00Z'), xHandle: 'AgentBootr' },
      { token: '0x4', kernel: '0x00000000000000000000000000000000000000cc', name: 'Old Coin', symbol: 'OLD', creator: '0x1234567890abcdef1234567890abcdef12345678', launchedAt: sec('2026-10-20T09:00:00Z'), xHandle: 'oldagent' },
    ],
    statusChanges: [
      { kernel: FOX, symbol: 'FOX', status: 'awake', at: sec('2026-11-03T09:15:00Z'), xHandle: 'foxagent' },
      { kernel: OWN, symbol: 'BOOTR', status: 'awake', at: sec('2026-11-05T10:00:00Z'), xHandle: 'AgentBootr' },
    ],
    posts: [
      { kernel: FOX, symbol: 'FOX', xHandle: 'foxagent', lastPostAt: sec('2026-11-07T08:00:00Z'), postsCount24h: 2 },
      { kernel: OWN, symbol: 'BOOTR', xHandle: 'AgentBootr', lastPostAt: sec('2026-11-07T11:00:00Z'), postsCount24h: 1 },
    ],
    claims: [{ token: '0x1', kernel: FOX, symbol: 'FOX', amountUsd: 42.1, at: sec('2026-11-07T07:00:00Z'), txHash: '0xaa' }],
    milestones: [
      { token: '0x1', kernel: FOX, symbol: 'FOX', kind: 'holders', value: 25, at: sec('2026-11-04T11:30:00Z'), txHash: null },
      { token: '0x1', kernel: FOX, symbol: 'FOX', kind: 'first_swap', value: 0, at: sec('2026-11-03T09:30:00Z'), txHash: '0xac' },
    ],
    firstPosts: [{ kernel: FOX, symbol: 'FOX', xHandle: 'foxagent', firstPostAt: sec('2026-11-03T12:00:00Z'), lastPostAt: sec('2026-11-07T08:00:00Z'), postsCount24h: 2 }],
  };
  return {
    ...data,
    launches: data.launches!.map((x) => t(x, ['launchedAt'])),
    statusChanges: data.statusChanges!.map((x) => t(x, ['at'])),
    posts: data.posts!.map((x) => t(x, ['lastPostAt'])),
    claims: data.claims!.map((x) => t(x, ['at'])),
    milestones: data.milestones!.map((x) => t(x, ['at'])),
    firstPosts: data.firstPosts!.map((x) => t(x, ['firstPostAt', 'lastPostAt'])),
  };
}

function emptyWeek(now = SUNDAY): PlatformFeedData {
  return { now: now / 1000, since: now / 1000 - 7 * 86_400, totals: { tokens: 9, agentsTotal: 9, agentsAwake: 4 } };
}

/** Points the world's indexer at `answer` for `platformFeed` (one new client object: the per-tick cache is keyed by it). */
function feedFrom(w: TestWorld, answer: () => Promise<Record<string, unknown> | null>) {
  const calls: number[] = [];
  (w.ctx as { indexer: IndexerClient }).indexer = {
    ...(w.indexer.client as object),
    async platformFeed(since: number) {
      calls.push(since);
      return answer();
    },
  } as IndexerClient;
  return calls;
}

async function runtimeRow(w: TestWorld) {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
}

function firstObservation(w: TestWorld): Record<string, unknown> {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls[0]!.body as { messages: { role: string; content: string }[] };
  return JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
}

/** A platform agent whose own wake is far away and whose cadence (6 h) is not due, so only the digest can wake it. */
async function seedPlatformAgent(w: TestWorld, config: Record<string, unknown> = {}) {
  const now = w.ctx.now();
  return seedAgent(w, {
    config: { platform: true, xHandle: 'AgentBootr', postIntervalMs: 6 * H, socialStartedAt: new Date(now - H).toISOString(), ...config },
    runtime: { nextAt: new Date(now + 6 * H), lastDecisionAt: new Date(now - 60_000) },
  });
}

const post = (text: string, id = 'call_post') => toolCallResponse('publish_post', { text }, id);
const NO_PRICE = /price|volume|marketcap|market_cap|usd|fees|claimedUsd|amount/i;

describe('slot and week arithmetic', () => {
  it('parses the slot spec, with the default when unset', () => {
    expect(DEFAULT_DIGEST_AT).toBe('sun:16');
    expect(parseDigestAt(undefined)).toEqual({ day: 0, hour: 16 });
    expect(parseDigestAt('')).toEqual({ day: 0, hour: 16 });
    expect(parseDigestAt('Mon:9')).toEqual({ day: 1, hour: 9 });
    expect(parseDigestAt(' sat:23 ')).toEqual({ day: 6, hour: 23 });
    for (const bad of ['sun:24', 'xyz:1', 'sun', '16', 'sun:-1', 'sunday:16']) expect(() => parseDigestAt(bad)).toThrow(/PLATFORM_DIGEST_AT/);
  });

  it('keys ISO weeks, across year boundaries', () => {
    expect(isoWeekKey(Date.parse('2026-11-08T16:00:00Z'))).toBe('2026-W45'); // a Sunday: last day of its week
    expect(isoWeekKey(Date.parse('2026-11-09T00:00:00Z'))).toBe('2026-W46'); // the Monday after
    expect(isoWeekKey(Date.parse('2026-01-01T00:00:00Z'))).toBe('2026-W01'); // a Thursday
    expect(isoWeekKey(Date.parse('2027-01-01T00:00:00Z'))).toBe('2026-W53'); // a Friday: still the old year's last week
    expect(isoWeekKey(Date.parse('2024-12-30T00:00:00Z'))).toBe('2025-W01'); // a Monday: already the new year's first week
  });

  it('finds the latest slot at or before now', () => {
    const slot = parseDigestAt('sun:16');
    expect(lastSlotAt(slot, SUNDAY)).toBe(Date.parse('2026-11-08T16:00:00Z'));
    expect(lastSlotAt(slot, Date.parse('2026-11-08T16:00:00Z'))).toBe(Date.parse('2026-11-08T16:00:00Z'));
    expect(lastSlotAt(slot, Date.parse('2026-11-08T15:59:59Z'))).toBe(Date.parse('2026-11-01T16:00:00Z'));
    expect(lastSlotAt(slot, Date.parse('2026-11-04T12:00:00Z'))).toBe(Date.parse('2026-11-01T16:00:00Z'));
    expect(lastSlotAt(parseDigestAt('wed:9'), Date.parse('2026-11-04T12:00:00Z'))).toBe(Date.parse('2026-11-04T09:00:00Z'));
    expect(lastSlotAt(parseDigestAt('wed:13'), Date.parse('2026-11-04T12:00:00Z'))).toBe(Date.parse('2026-10-28T13:00:00Z'));
  });

  it('is due once per week at the slot, within the grace window, and not again for the same week', () => {
    const slot = parseDigestAt('sun:16');
    const slotAt = Date.parse('2026-11-08T16:00:00Z');
    expect(digestDue(slot, null, Date.parse('2026-11-08T15:59:00Z'))).toBeNull(); // the previous slot is a week old: past the grace window
    expect(digestDue(slot, null, slotAt)).toEqual({ week: '2026-W45', slotAt });
    expect(digestDue(slot, null, SUNDAY)).toEqual({ week: '2026-W45', slotAt });
    expect(digestDue(slot, '2026-W45', SUNDAY)).toBeNull();
    expect(digestDue(slot, '2026-W44', SUNDAY)).toEqual({ week: '2026-W45', slotAt });
    expect(digestDue(slot, '2026-W45', slotAt + DIGEST_GRACE_MS - 1)).toBeNull();
    expect(digestDue(slot, '2026-W44', slotAt + DIGEST_GRACE_MS)).toEqual({ week: '2026-W45', slotAt });
    expect(digestDue(slot, '2026-W44', slotAt + DIGEST_GRACE_MS + 1)).toBeNull(); // slept through it: skipped, not caught up
    expect(digestDue(slot, '2026-W45', slotAt + 7 * D)).toEqual({ week: '2026-W46', slotAt: slotAt + 7 * D });
    expect(DIGEST_GRACE_MS).toBe(2 * D);
  });
});

describe('facts and section', () => {
  it('hands the week oldest first, cleaned, without the reader itself, without cashtags and without a single price field', () => {
    const facts = digestFacts(busyWeek(), SUNDAY, KERNEL);
    expect(facts.source).toBe('indexer');
    expect(facts.totals).toEqual({ coins: 9, agentsAwake: 4, agentsTotal: 9 });
    expect(facts.counts).toEqual({ launches: 2, milestones: 2, firstPosts: 1, statusChanges: 1, posters: 1, claims: 1 });
    expect(facts.launches).toEqual([
      { name: 'Fox Coin', symbol: 'FOX', agent: '@foxagent', at: '2026-11-03T09:00:00Z' },
      { name: 'Owl Coin', symbol: 'OWL', agent: null, at: '2026-11-06T18:30:00Z' },
    ]);
    expect(facts.milestones).toEqual([
      { symbol: 'FOX', what: 'had its first trade', at: '2026-11-03T09:30:00Z' },
      { symbol: 'FOX', what: 'reached 25 holders', at: '2026-11-04T11:30:00Z' },
    ]);
    expect(facts.firstPosts).toEqual([{ symbol: 'FOX', agent: '@foxagent', at: '2026-11-03T12:00:00Z' }]);
    expect(facts.statusChanges).toEqual([{ symbol: 'FOX', agent: '@foxagent', status: 'awake', at: '2026-11-03T09:15:00Z' }]);
    expect(facts.posters).toEqual([{ symbol: 'FOX', agent: '@foxagent' }]);
    const json = JSON.stringify(facts);
    expect(json).not.toMatch(NO_PRICE);
    expect(json).not.toContain('$');
    expect(json).not.toContain('BOOTR');
    expect(nothingHappened(facts)).toBe(false);
    expect(nothingHappened(digestFacts(emptyWeek(), SUNDAY, KERNEL))).toBe(true);
    // a week where only the reader did things is an empty week
    const onlyMe: PlatformFeedData = { ...emptyWeek(), launches: busyWeek().launches!.filter((l) => l.kernel === OWN) };
    expect(nothingHappened(digestFacts(onlyMe, SUNDAY, KERNEL))).toBe(true);
  });

  it('is empty for a coin agent or without a plan, and says whether a picture may be made', () => {
    const plan: WeeklyDigestPlan = { week: '2026-W45', slotAt: SUNDAY - 5 * 60_000, from: SUNDAY - 7 * D, to: SUNDAY, facts: digestFacts(busyWeek(), SUNDAY, KERNEL) };
    const caps = { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false, services: false, bounties: false };
    const tools = [{ name: 'publish_post' }, { name: 'finish' }];
    expect(weeklyDigestSection({ platform: false, capabilities: caps }, plan, tools)).toEqual({});
    expect(weeklyDigestSection({ platform: true, capabilities: caps }, null, tools)).toEqual({});
    const off = weeklyDigestSection({ platform: true, capabilities: caps }, plan, tools) as { weeklyDigest: Record<string, unknown> };
    expect(off.weeklyDigest).toMatchObject({ due: true, week: '2026-W45', from: new Date(SUNDAY - 7 * D).toISOString(), to: new Date(SUNDAY).toISOString(), picture: 'off', instruction: WEEKLY_DIGEST_INSTRUCTION });
    expect(off.weeklyDigest.facts).toEqual(plan.facts);
    expect(WEEKLY_DIGEST_INSTRUCTION).toMatch(/No prices, no market caps/);
    expect(WEEKLY_DIGEST_INSTRUCTION).toMatch(/One post only/);
    expect(WEEKLY_DIGEST_INSTRUCTION).toMatch(/never as a cashtag/);
    expect(WEEKLY_DIGEST_INSTRUCTION).toMatch(/call finish and say so/);
    expect(WEEKLY_DIGEST_INSTRUCTION).not.toMatch(/generate_image/);
    // the capability alone is not enough: the tool must be offered this turn
    expect((weeklyDigestSection({ platform: true, capabilities: { ...caps, images: true } }, plan, tools) as { weeklyDigest: { picture: string } }).weeklyDigest.picture).toBe('off');
    const on = weeklyDigestSection({ platform: true, capabilities: { ...caps, images: true } }, plan, [...tools, { name: 'generate_image' }]) as { weeklyDigest: Record<string, unknown> };
    expect(on.weeklyDigest.picture).toBe('optional');
    expect(on.weeklyDigest.instruction).toBe(`${WEEKLY_DIGEST_INSTRUCTION} ${WEEKLY_DIGEST_PICTURE}`);
    expect(WEEKLY_DIGEST_PICTURE).toMatch(/generate_image/);
  });
});

describe('weekly digest in the tick', () => {
  it('wakes the platform agent at the slot, hands it the week, and closes it on the post without moving the cadence anchor', async () => {
    const w = await makeWorld({ script: [post('This week on Bootr: Fox Coin launched on 3 November and its agent @foxagent posted for the first time the same day.'), finishResponse(SUNDAY + 3 * H)] });
    try {
      w.setNow(SUNDAY);
      const calls = feedFrom(w, async () => busyWeek() as unknown as Record<string, unknown>);
      const agent = await seedPlatformAgent(w);
      const r = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
      expect(r.ran).toBe(true);
      expect(r.reasons).toEqual([DIGEST_WAKE_REASON]);
      expect(r.turn?.outcome).toBe('finished');
      expect(calls).toHaveLength(1);
      const obs = firstObservation(w);
      const digest = obs.weeklyDigest as Record<string, unknown>;
      expect(digest).toMatchObject({ due: true, week: '2026-W45', picture: 'off', from: '2026-11-01T16:05:00.000Z', to: '2026-11-08T16:05:00.000Z' });
      expect((digest.facts as { launches: unknown[] }).launches).toHaveLength(2);
      expect(JSON.stringify(digest.facts)).not.toMatch(NO_PRICE);
      // the regular slot was not due and still is not: the digest is not the cadence post
      expect((obs.social as { originalPost: { due: boolean } }).originalPost.due).toBe(false);
      const row = await runtimeRow(w);
      expect(row.state).toMatchObject({ lastDigestWeek: '2026-W45', lastPostAt: null });
      expect(row.turn).toBeNull();
      // the platform agent's posts wait for the creator: the digest is queued, which counts as posted
      expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(1);
      expect(w.sender.published).toHaveLength(0);
      // not due again this week, whatever the tick
      w.setNow(SUNDAY + 60_000);
      expect((await tick(w.ctx)).ran).toEqual([]);
      w.setNow(SUNDAY + 3 * D);
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.reasons).not.toContain(DIGEST_WAKE_REASON);
    } finally {
      await w.close();
    }
  });

  it('is due again the next week, alongside whatever else wakes the agent, and the second original post of a digest turn moves the anchor', async () => {
    const w = await makeWorld({
      script: [post('This week on Bootr: Owl Coin launched on 6 November; its agent is not on X yet.'), post('A separate note from the host, in its own words, about how a coin gets its agent.', 'call_post2'), finishResponse(SUNDAY + 7 * D + 3 * H)],
    });
    try {
      const nextSunday = SUNDAY + 7 * D;
      w.setNow(nextSunday);
      feedFrom(w, async () => busyWeek(nextSunday) as unknown as Record<string, unknown>);
      // last week's digest done; the cadence (started 10 h ago, 6 h interval) is due as well
      const agent = await seedAgent(w, {
        config: { platform: true, xHandle: 'AgentBootr', postIntervalMs: 6 * H, socialStartedAt: new Date(nextSunday - 10 * H).toISOString() },
        runtime: { nextAt: new Date(nextSunday + 6 * H), state: { phase: 'social', memory: '', agenda: '', summary: '', lastPostAt: null, lastDigestWeek: '2026-W45' } },
      });
      const r = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
      expect(r.ran).toBe(true);
      expect(r.reasons).toContain('original_post_due');
      expect(r.reasons).toContain(DIGEST_WAKE_REASON);
      expect((firstObservation(w).weeklyDigest as { week: string }).week).toBe('2026-W46');
      const row = await runtimeRow(w);
      // first post = the digest (anchor untouched), second post = the regular one (anchor moves)
      expect(row.state).toMatchObject({ lastDigestWeek: '2026-W46', lastPostAt: nextSunday });
      expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('a turn that ends with finish closes the week without a post, and so does a turn the runtime ends itself', async () => {
    for (const script of [[finishResponse(SUNDAY + 3 * H)], [toolCallResponse('finish', { memory: 'not a checkpoint' }, 'call_bad')]]) {
      const w = await makeWorld({ script, config: { MAX_TOOL_STEPS: '1' } });
      try {
        w.setNow(SUNDAY);
        feedFrom(w, async () => busyWeek() as unknown as Record<string, unknown>);
        const agent = await seedPlatformAgent(w);
        const r = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
        expect(r.ran).toBe(true);
        expect(r.reasons).toEqual([DIGEST_WAKE_REASON]);
        const row = await runtimeRow(w);
        expect(row.state).toMatchObject({ lastDigestWeek: '2026-W45', lastPostAt: null });
        expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(0);
        w.setNow(SUNDAY + 10 * 60_000);
        expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.reasons).not.toContain(DIGEST_WAKE_REASON);
      } finally {
        await w.close();
      }
    }
  });

  it('closes an empty week at the tick without waking the agent, and waits while the indexer is down', async () => {
    const w = await makeWorld({ script: [] });
    try {
      w.setNow(SUNDAY);
      let answer: Record<string, unknown> | null = null;
      const calls = feedFrom(w, async () => answer);
      const agent = await seedPlatformAgent(w);
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.ran).toBe(false);
      expect(calls).toHaveLength(1);
      expect((await runtimeRow(w)).state).not.toHaveProperty('lastDigestWeek');
      // the indexer answers on a later tick: nothing happened this week, closed without a turn
      w.setNow(SUNDAY + 2 * 60_000);
      answer = emptyWeek() as unknown as Record<string, unknown>;
      const r = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
      expect(r.ran).toBe(false);
      expect(r.reasons).toEqual([]);
      expect((await runtimeRow(w)).state).toMatchObject({ lastDigestWeek: '2026-W45' });
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('is held by the rhythm like any original post and comes back when the quiet hours end', async () => {
    const w = await makeWorld({ config: { PLATFORM_QUIET_HOURS_UTC: '15-17' }, script: [post('This week on Bootr: Fox Coin launched on 3 November with its agent @foxagent.'), finishResponse(SUNDAY + 3 * H)] });
    try {
      w.setNow(SUNDAY);
      const calls = feedFrom(w, async () => busyWeek() as unknown as Record<string, unknown>);
      const agent = await seedPlatformAgent(w);
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.ran).toBe(false);
      expect(calls).toHaveLength(0);
      expect((await runtimeRow(w)).state).not.toHaveProperty('lastDigestWeek');
      w.setNow(Date.parse('2026-11-08T17:01:00Z'));
      const r = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
      expect(r.ran).toBe(true);
      expect(r.reasons).toEqual([DIGEST_WAKE_REASON]);
      expect((await runtimeRow(w)).state).toMatchObject({ lastDigestWeek: '2026-W45' });
    } finally {
      await w.close();
    }
  });

  it('is nothing for a coin agent, and nothing for the platform agent before its slot', async () => {
    const w = await makeWorld({ script: [] });
    try {
      w.setNow(SUNDAY);
      const calls = feedFrom(w, async () => busyWeek() as unknown as Record<string, unknown>);
      const coin = await seedAgent(w, { config: { socialStartedAt: new Date(SUNDAY - H).toISOString() }, runtime: { nextAt: new Date(SUNDAY + 6 * H) } });
      expect((await processAgent(w.ctx, coin, await runtimeRow(w)))!.ran).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      await w.close();
    }
    // the daily numbers post (platform-numbers.ts, default 15:00 UTC) is moved out of the way: only the digest may wake it here
    const w2 = await makeWorld({ script: [], config: { PLATFORM_DIGEST_AT: 'sun:18', PLATFORM_NUMBERS_AT: '20' } });
    try {
      w2.setNow(SUNDAY);
      const calls = feedFrom(w2, async () => busyWeek() as unknown as Record<string, unknown>);
      const agent = await seedPlatformAgent(w2);
      expect((await processAgent(w2.ctx, agent, await runtimeRow(w2)))!.ran).toBe(false);
      expect(calls).toHaveLength(0);
      w2.setNow(Date.parse('2026-11-08T18:00:00Z'));
      expect((await processAgent(w2.ctx, agent, await runtimeRow(w2)))!.reasons).toEqual([DIGEST_WAKE_REASON]);
    } finally {
      await w2.close();
    }
  });
});
