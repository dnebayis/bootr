import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, runtimes } from '../src/db/schema.js';
import type { IndexerClient } from '../src/indexer-client.js';
import {
  BURN_ADDRESS,
  DEFAULT_NUMBERS_AT,
  NUMBERS_GRACE_MS,
  NUMBERS_WAKE_REASON,
  PLATFORM_NUMBERS_INSTRUCTION,
  PLATFORM_NUMBERS_MEANING,
  TOP_COINS_QUERY,
  dayKey,
  lastNumbersSlotAt,
  numbersDue,
  parseNumbersAt,
  platformNumbersSection,
  readPlatformNumbers,
} from '../src/platform-numbers.js';
import { processAgent, tick } from '../src/tick.js';
import { AGENT_ID, TOKEN, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const D = 24 * H;
/** Saturday 2026-10-24 15:05 UTC: five minutes into the default slot. */
const SLOT = Date.parse('2026-10-24T15:00:00Z');
const AT = SLOT + 5 * 60_000;
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const FEED = {
  now: AT / 1000,
  since: AT / 1000 - 7 * 86_400,
  totals: { tokens: 42, agentsTotal: 40, agentsAwake: 19, volume24hUsd: 12_345.678, volume7dUsd: 80_100, fees24hUsd: 120.004, updatedAt: sec('2026-10-24T15:00:00Z') },
};
const FEES = {
  total: { tokens: 42, volumeTotalUsd: 900_000, feesTotalUsd: 9_000, byKind: { agent: 3_600, creator: 2_700, burn: 1_800, platform: 900 }, feesClaimedUsd: 5_000, feesPlatformClaimedUsd: 800, updatedAt: sec('2026-10-24T14:59:00Z') },
  bySource: {},
};
const GRAPH = {
  top: {
    items: [
      { id: '0x1', name: 'Fox\u0007 Coin', symbol: '$FOX', volume24hUsd: 5_000.5, holders: 120 },
      { id: TOKEN.toLowerCase(), name: 'Bootr', symbol: 'BOOTR', volume24hUsd: 4_000, holders: 900 },
      { id: '0x3', name: 'Owl Coin', symbol: 'OWL', volume24hUsd: 300, holders: 7 },
    ],
  },
  bootr: { items: [{ id: TOKEN.toLowerCase(), holders: 900 }] },
};

interface Answers {
  feed: Record<string, unknown> | null;
  fees: Record<string, unknown> | null;
  graph: Record<string, unknown> | null;
}

/** Points the world's indexer at `answers` (one new client object: the caches are keyed by it). */
function indexerFrom(w: TestWorld, answers: Answers) {
  const calls = { feed: 0, fees: 0, graph: [] as { query: string; variables: Record<string, unknown> }[] };
  (w.ctx as { indexer: IndexerClient }).indexer = {
    ...(w.indexer.client as object),
    async platformFeed() {
      calls.feed += 1;
      return answers.feed;
    },
    async platformFees() {
      calls.fees += 1;
      return answers.fees;
    },
    async graphql(query: string, variables: Record<string, unknown>) {
      calls.graph.push({ query, variables });
      return answers.graph;
    },
  } as unknown as IndexerClient;
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

/** A platform agent whose own wake is far away and whose cadence (6 h) is not due, so only the numbers post can wake it. */
async function seedPlatformAgent(w: TestWorld, config: Record<string, unknown> = {}, runtime: Record<string, unknown> = {}) {
  const now = w.ctx.now();
  return seedAgent(w, {
    config: { platform: true, xHandle: 'AgentBootr', postIntervalMs: 6 * H, socialStartedAt: new Date(now - H).toISOString(), ...config },
    runtime: { nextAt: new Date(now + 6 * H), lastDecisionAt: new Date(now - 60_000), ...runtime },
  });
}

const post = (text: string, id = 'call_post') => toolCallResponse('publish_post', { text }, id);
const NUMBERS_POST = 'Bootr today, 24 October: 42 coins, 19 agents awake, about $12k traded across them in the last day, agents and their creators took $120 in fees, 1.5M $BOOTR burned so far. Fox Coin was the busiest.';

describe('slot and day arithmetic', () => {
  it('parses the hour, with the default when unset', () => {
    expect(DEFAULT_NUMBERS_AT).toBe('15');
    expect(parseNumbersAt(undefined)).toBe(15);
    expect(parseNumbersAt('')).toBe(15);
    expect(parseNumbersAt('09')).toBe(9);
    expect(parseNumbersAt(' 23 ')).toBe(23);
    for (const bad of ['24', '-1', 'sun:16', '15:00', 'x']) expect(() => parseNumbersAt(bad)).toThrow(/PLATFORM_NUMBERS_AT/);
  });

  it('finds the latest slot at or before now and keys it by UTC day', () => {
    expect(dayKey(AT)).toBe('2026-10-24');
    expect(lastNumbersSlotAt(15, AT)).toBe(SLOT);
    expect(lastNumbersSlotAt(15, SLOT)).toBe(SLOT);
    expect(lastNumbersSlotAt(15, SLOT - 1)).toBe(SLOT - D);
    expect(lastNumbersSlotAt(0, Date.parse('2026-10-24T00:00:00Z'))).toBe(Date.parse('2026-10-24T00:00:00Z'));
    expect(lastNumbersSlotAt(23, Date.parse('2026-10-24T01:00:00Z'))).toBe(Date.parse('2026-10-23T23:00:00Z'));
  });

  it('is due once per day at the slot, within the grace window, and not again for the same day', () => {
    expect(numbersDue(15, null, SLOT - 1)).toBeNull(); // yesterday's slot, 24 h old: past the grace
    expect(numbersDue(15, null, SLOT - D + NUMBERS_GRACE_MS)).toEqual({ day: '2026-10-23', slotAt: SLOT - D }); // at the end of its grace: still due
    expect(numbersDue(15, null, SLOT)).toEqual({ day: '2026-10-24', slotAt: SLOT });
    expect(numbersDue(15, null, AT)).toEqual({ day: '2026-10-24', slotAt: SLOT });
    expect(numbersDue(15, '2026-10-24', AT)).toBeNull();
    expect(numbersDue(15, '2026-10-23', AT)).toEqual({ day: '2026-10-24', slotAt: SLOT });
    expect(numbersDue(15, '2026-10-23', SLOT + NUMBERS_GRACE_MS)).toEqual({ day: '2026-10-24', slotAt: SLOT });
    expect(numbersDue(15, '2026-10-23', SLOT + NUMBERS_GRACE_MS + 1)).toBeNull(); // slept through it: skipped, not caught up
    expect(numbersDue(15, '2026-10-24', SLOT + D)).toEqual({ day: '2026-10-25', slotAt: SLOT + D });
    expect(NUMBERS_GRACE_MS).toBe(8 * H);
  });
});

describe('the numbers and the section', () => {
  it('reads the totals, the fee split, the burn and the busiest coins, cleaned and rounded', async () => {
    const w = await makeWorld({ chain: { token: 1_500_000n * 10n ** 18n } });
    try {
      w.setNow(AT);
      const calls = indexerFrom(w, { feed: FEED, fees: FEES, graph: GRAPH });
      const n = (await readPlatformNumbers(w.ctx, { token: { address: TOKEN, symbol: 'BOOTR', name: 'Bootr', chainId: 84532 } }))!;
      expect(n.observedAt).toBe(new Date(AT).toISOString());
      expect(n.totals).toEqual({ coins: 42, agentsAwake: 19, agentsTotal: 40, volume24hUsd: 12_345.68, fees24hUsd: 120, fees24hNote: expect.any(String), updatedAt: '2026-10-24T15:00:00.000Z' });
      expect(n.feesAllTime).toEqual({ note: expect.any(String), total: 9_000, agent: 3_600, creator: 2_700, burn: 1_800, platform: 900, updatedAt: '2026-10-24T14:59:00.000Z' });
      // the mocked token has no `decimals` / `totalSupply`: 18 decimals assumed, no share of supply
      expect(n.bootr).toEqual({ symbol: 'BOOTR', burned: 1_500_000, burnedShareOfSupplyPct: null, holders: 900 });
      expect(n.topCoins24h).toEqual([
        { name: 'Fox Coin', symbol: 'FOX', volume24hUsd: 5_000.5, holders: 120 },
        { name: 'Bootr', symbol: 'BOOTR', volume24hUsd: 4_000, holders: 900 },
        { name: 'Owl Coin', symbol: 'OWL', volume24hUsd: 300, holders: 7 },
      ]);
      expect(calls.graph).toEqual([{ query: TOP_COINS_QUERY, variables: { bootr: TOKEN.toLowerCase(), limit: 3 } }]);
      expect(w.state.calls.find((c) => c.fn === 'balanceOf' && String(c.args[0]).toLowerCase() === BURN_ADDRESS.toLowerCase())).toBeTruthy();
      expect(JSON.stringify(n)).not.toMatch(/price|marketCap|market_cap/i);
    } finally {
      await w.close();
    }
  });

  it('is null without the feed totals, and carries nulls for the parts that failed on their own', async () => {
    const w = await makeWorld();
    try {
      w.setNow(AT);
      indexerFrom(w, { feed: null, fees: FEES, graph: GRAPH });
      expect(await readPlatformNumbers(w.ctx, { token: { address: TOKEN, symbol: 'BOOTR', name: 'Bootr', chainId: 84532 } })).toBeNull();
      indexerFrom(w, { feed: FEED, fees: null, graph: null });
      const n = (await readPlatformNumbers(w.ctx, { token: { address: TOKEN, symbol: 'BOOTR', name: 'Bootr', chainId: 84532 } }))!;
      expect(n.totals.coins).toBe(42);
      expect(n.feesAllTime).toBeNull();
      expect(n.topCoins24h).toBeNull();
      expect(n.bootr).toMatchObject({ burned: 0, holders: null });
    } finally {
      await w.close();
    }
  });

  it('is empty for a coin agent, says when the numbers are unavailable, and carries the instruction only when the post is due', () => {
    expect(platformNumbersSection({ platform: false }, null, { day: '2026-10-24', slotAt: SLOT })).toEqual({});
    const off = platformNumbersSection({ platform: true }, null, null) as { platformNumbers: Record<string, unknown> };
    expect(off.platformNumbers).toMatchObject({ instructionAuthority: false, available: false, post: { due: false } });
    const numbers = { observedAt: new Date(AT).toISOString(), totals: { coins: 1, agentsAwake: 1, agentsTotal: 1, volume24hUsd: 0, fees24hUsd: 0, fees24hNote: '', updatedAt: null }, feesAllTime: null, bootr: null, topCoins24h: null };
    const due = platformNumbersSection({ platform: true }, numbers, { day: '2026-10-24', slotAt: SLOT }) as { platformNumbers: Record<string, unknown> };
    expect(due.platformNumbers).toMatchObject({ available: true, totals: numbers.totals, post: { due: true, day: '2026-10-24', instruction: PLATFORM_NUMBERS_INSTRUCTION } });
    expect(PLATFORM_NUMBERS_INSTRUCTION).toMatch(/\$BOOTR's market cap or price only if you read it this turn \(your market data, read_market\), as of today\. No returns, no predictions, no buy or sell call, no hype/);
    expect(PLATFORM_NUMBERS_MEANING).toMatch(/The platform-wide totals belong in the daily numbers post/);
    expect(PLATFORM_NUMBERS_INSTRUCTION).toMatch(/with the date/);
    expect(PLATFORM_NUMBERS_INSTRUCTION).toMatch(/One post only/);
    expect(PLATFORM_NUMBERS_INSTRUCTION).toMatch(/never as a cashtag/);
    expect(PLATFORM_NUMBERS_INSTRUCTION).toMatch(/never the phrase 'fees earned'/);
    expect(PLATFORM_NUMBERS_INSTRUCTION).toMatch(/call finish and say so/);
    expect(PLATFORM_NUMBERS_INSTRUCTION).toMatch(/\$BOOTR's burn comes from \$BOOTR's own trades: never say every trade on Bootr burns anything/);
  });
});

describe('the numbers post in the tick', () => {
  it('wakes the platform agent at its hour, hands it the numbers, and closes the day on the post without moving the cadence anchor', async () => {
    const w = await makeWorld({ chain: { token: 1_500_000n * 10n ** 18n }, script: [post(NUMBERS_POST), finishResponse(AT + 3 * H)] });
    try {
      w.setNow(AT);
      const calls = indexerFrom(w, { feed: FEED, fees: FEES, graph: GRAPH });
      const agent = await seedPlatformAgent(w);
      const r = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
      expect(r.ran).toBe(true);
      expect(r.reasons).toEqual([NUMBERS_WAKE_REASON]);
      expect(r.turn?.outcome).toBe('finished');
      // one indexer read of each kind: the wake and the observation share the ten-minute cache
      expect(calls.feed).toBe(1);
      expect(calls.fees).toBe(1);
      expect(calls.graph).toHaveLength(1);
      const obs = firstObservation(w);
      const section = obs.platformNumbers as Record<string, unknown>;
      expect(section).toMatchObject({ available: true, post: { due: true, day: '2026-10-24', instruction: PLATFORM_NUMBERS_INSTRUCTION } });
      expect((section.totals as { coins: number }).coins).toBe(42);
      expect((section.bootr as { burned: number }).burned).toBe(1_500_000);
      expect((obs.social as { originalPost: { due: boolean } }).originalPost.due).toBe(false);
      const row = await runtimeRow(w);
      expect(row.state).toMatchObject({ lastNumbersDay: '2026-10-24', lastPostAt: null });
      expect(row.turn).toBeNull();
      // the platform agent's posts wait for the creator: queued counts as posted
      expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(1);
      // not due again today, whatever the tick
      w.setNow(AT + 60_000);
      expect((await tick(w.ctx)).ran).toEqual([]);
      w.setNow(AT + 5 * H);
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.reasons).not.toContain(NUMBERS_WAKE_REASON);
    } finally {
      await w.close();
    }
  });

  it('a turn that ends with finish closes the day without a post, and so does a turn the runtime ends itself', async () => {
    for (const script of [[finishResponse(AT + 3 * H)], [toolCallResponse('finish', { memory: 'not a checkpoint' }, 'call_bad')]]) {
      const w = await makeWorld({ script, config: { MAX_TOOL_STEPS: '1' } });
      try {
        w.setNow(AT);
        indexerFrom(w, { feed: FEED, fees: FEES, graph: GRAPH });
        const agent = await seedPlatformAgent(w);
        const r = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
        expect(r.ran).toBe(true);
        expect(r.reasons).toEqual([NUMBERS_WAKE_REASON]);
        expect((await runtimeRow(w)).state).toMatchObject({ lastNumbersDay: '2026-10-24', lastPostAt: null });
        expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(0);
        w.setNow(AT + 10 * 60_000);
        expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.reasons).not.toContain(NUMBERS_WAKE_REASON);
      } finally {
        await w.close();
      }
    }
  });

  it('waits while the numbers cannot be read, is held by the rhythm, and respects the configured hour', async () => {
    const w = await makeWorld({ script: [post(NUMBERS_POST), finishResponse(AT + 3 * H)] });
    try {
      w.setNow(AT);
      const answers: Answers = { feed: null, fees: FEES, graph: GRAPH };
      const calls = indexerFrom(w, answers);
      const agent = await seedPlatformAgent(w);
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.ran).toBe(false);
      expect(calls.feed).toBe(1);
      expect((await runtimeRow(w)).state).not.toHaveProperty('lastNumbersDay');
      // the indexer answers on a later tick (the failed read was not cached)
      w.setNow(AT + 2 * 60_000);
      answers.feed = FEED;
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.reasons).toEqual([NUMBERS_WAKE_REASON]);
      expect((await runtimeRow(w)).state).toMatchObject({ lastNumbersDay: '2026-10-24' });
    } finally {
      await w.close();
    }
    const quiet = await makeWorld({ config: { PLATFORM_QUIET_HOURS_UTC: '15-17' }, script: [post(NUMBERS_POST), finishResponse(AT + 3 * H)] });
    try {
      quiet.setNow(AT);
      const calls = indexerFrom(quiet, { feed: FEED, fees: FEES, graph: GRAPH });
      const agent = await seedPlatformAgent(quiet);
      expect((await processAgent(quiet.ctx, agent, await runtimeRow(quiet)))!.ran).toBe(false);
      expect(calls.feed).toBe(0);
      quiet.setNow(Date.parse('2026-10-24T17:01:00Z'));
      expect((await processAgent(quiet.ctx, agent, await runtimeRow(quiet)))!.reasons).toEqual([NUMBERS_WAKE_REASON]);
    } finally {
      await quiet.close();
    }
    const later = await makeWorld({ config: { PLATFORM_NUMBERS_AT: '18' }, script: [] });
    try {
      later.setNow(AT);
      const calls = indexerFrom(later, { feed: FEED, fees: FEES, graph: GRAPH });
      const agent = await seedPlatformAgent(later);
      expect((await processAgent(later.ctx, agent, await runtimeRow(later)))!.ran).toBe(false);
      expect(calls.feed).toBe(0);
      later.setNow(Date.parse('2026-10-24T18:00:00Z'));
      expect((await processAgent(later.ctx, agent, await runtimeRow(later)))!.reasons).toEqual([NUMBERS_WAKE_REASON]);
    } finally {
      await later.close();
    }
  });

  it('hands the platform agent the numbers on every turn (post not due) and nothing to a coin agent', async () => {
    const w = await makeWorld({ script: [finishResponse(AT + 3 * H)] });
    try {
      // 10:05 UTC: the slot is hours away; the cadence (6 h, started 10 h ago) wakes the agent
      const morning = Date.parse('2026-10-24T10:05:00Z');
      w.setNow(morning);
      const calls = indexerFrom(w, { feed: FEED, fees: FEES, graph: GRAPH });
      const agent = await seedPlatformAgent(w, { socialStartedAt: new Date(morning - 10 * H).toISOString() });
      const r = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
      expect(r.ran).toBe(true);
      expect(r.reasons).toContain('original_post_due');
      expect(r.reasons).not.toContain(NUMBERS_WAKE_REASON);
      const section = firstObservation(w).platformNumbers as Record<string, unknown>;
      expect(section).toMatchObject({ available: true, post: { due: false } });
      expect(calls.feed).toBe(1);
      expect((await runtimeRow(w)).state).not.toHaveProperty('lastNumbersDay');
    } finally {
      await w.close();
    }
    const coin = await makeWorld({ script: [finishResponse(AT + 3 * H)] });
    try {
      coin.setNow(AT);
      const calls = indexerFrom(coin, { feed: FEED, fees: FEES, graph: GRAPH });
      const agent = await seedAgent(coin, { config: { socialStartedAt: new Date(AT - 10 * H).toISOString() }, runtime: { nextAt: new Date(AT + 6 * H) } });
      const r = (await processAgent(coin.ctx, agent, await runtimeRow(coin)))!;
      expect(r.ran).toBe(true);
      expect(r.reasons).not.toContain(NUMBERS_WAKE_REASON);
      expect(firstObservation(coin)).not.toHaveProperty('platformNumbers');
      expect(calls.fees).toBe(0);
    } finally {
      await coin.close();
    }
  });
});
