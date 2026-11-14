/**
 * The quiet slot (docs/design/agent-behaviour.md rule R9, stage 3): a coin agent's due post slot buys no turn when
 * nothing is new since its last slot. The scenario is the one of section 2.3: a coin whose holder count does not
 * change, whose agent posted "112 holders" at every slot. Measured before (the rule off) and after.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DueView } from '@bootr/shared/own-agent';
import { createApp } from '../src/api.js';
import { fileRequest } from '../src/creator-requests.js';
import { agents, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { agentConfigOf } from '../src/onboarding.js';
import { QUIET_HOLDERS_SHARE, lastMilestoneAt, markQuietSlot, ownCoinNow, quietCeilingMs, quietSlot, quietSlotOf, quietSlotOn, quietTooLong, settledMark, whatIsNew, type QuietState } from '../src/quiet-slot.js';
import { scheduleFor, type AgentState } from '../src/runtime.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, KERNEL, SUPERVISOR_KEY, TOKEN, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { act, connectClient, finishInput, mention, openSocial, ownWorld, seedOwn, type OwnWorld } from './own-helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const thoughts = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
const stateOf = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.state as unknown as AgentState & QuietState;
const runtimeOf = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;

/** The coin as the index shows it: the holders, and the times of its trades (seconds, as the index gives them). */
interface Coin {
  holders: number;
  trades: number[];
}
const marketOf = (coin: Coin) => ({ priceUsd: 0.01, marketCapUsd: 1000, holders: coin.holders, trades24h: coin.trades.length, volume24hUsd: 0, trades: coin.trades.map((t) => ({ side: 'buy', timestamp: String(t), valueUsd: 5 })) });

/**
 * A hosted coin agent whose model, whenever a turn is bought, posts its holder count and finishes: the agent of
 * section 2.3. `coin` is what the index answers and can be changed between slots.
 */
async function quietWorld(config: Record<string, string> = {}, agentConfig: Record<string, unknown> = {}) {
  const coin: Coin = { holders: 112, trades: [] };
  const script: (() => Response)[] = [];
  const w = await makeWorld({ config: { WAKE_MODE: 'ping', ...config }, script: script as never });
  for (let i = 0; i < 40; i++) script.push(() => toolCallResponse('publish_post', { text: `${coin.holders} holders. the floor stops proving.` }), () => finishResponse(w.ctx.now() + MINUTE));
  w.ctx.indexer.market = (async () => marketOf(coin)) as never;
  await seedAgent(w, { config: agentConfig });
  /** Moves the clock to the agent's next slot and runs the tick; returns what the tick bought. */
  const atNextSlot = async () => {
    const agent = (await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
    const schedule = scheduleFor(agentConfigOf(agent)!, await stateOf(w), w.ctx.now())!;
    if (schedule.nextAt > w.ctx.now()) w.setNow(schedule.nextAt + 1000);
    const before = { thoughts: thoughts(w), posts: w.sender.published.length };
    const report = await tick(w.ctx);
    return { ran: report.ran.includes(AGENT_ID), thoughts: thoughts(w) - before.thoughts, posts: w.sender.published.length - before.posts };
  };
  return { w, coin, script, atNextSlot };
}

describe('whatIsNew: the rule', () => {
  const mark = { at: T0, holders: 112 };
  const still = { holders: 112, lastTradeAt: T0 - HOUR, tradesKnown: true };

  it('nothing is new for a coin that stood still since the last slot', () => {
    expect(whatIsNew({ mark, coin: still })).toEqual([]);
    expect(whatIsNew({ mark, coin: { ...still, lastTradeAt: null } })).toEqual([]);
    expect(whatIsNew({ mark, coin: still, milestoneAt: T0 - MINUTE })).toEqual([]);
  });

  it('a holder more or less on a small coin is new, a flicker on a large one is not', () => {
    expect(whatIsNew({ mark, coin: { ...still, holders: 113 } })).toEqual(['holders_changed']);
    expect(whatIsNew({ mark, coin: { ...still, holders: 111 } })).toEqual(['holders_changed']);
    expect(whatIsNew({ mark: { at: T0, holders: 6 }, coin: { ...still, holders: 7 } })).toEqual(['holders_changed']);
    // One holder, or 1% of the count, whichever is more.
    expect(QUIET_HOLDERS_SHARE).toBe(0.01);
    expect(whatIsNew({ mark: { at: T0, holders: 5000 }, coin: { ...still, holders: 5049 } })).toEqual([]);
    expect(whatIsNew({ mark: { at: T0, holders: 5000 }, coin: { ...still, holders: 5050 } })).toEqual(['holders_changed']);
    expect(whatIsNew({ mark: { at: T0, holders: null }, coin: still })).toEqual(['holders_changed']);
  });

  it('a trade or a milestone after the last slot is new', () => {
    expect(whatIsNew({ mark, coin: { ...still, lastTradeAt: T0 + MINUTE } })).toEqual(['new_trade']);
    expect(whatIsNew({ mark, coin: still, milestoneAt: T0 + MINUTE })).toEqual(['new_milestone']);
  });

  it('somebody writing, the creator asking or changing the settings, an X hold that ended and a platform update are new', () => {
    expect(whatIsNew({ mark, coin: still, mentionWaiting: true, creatorRequest: true, configChanged: true, holdEnded: true, platformUpdate: true })).toEqual(['mention', 'creator_request', 'config_changed', 'hold_ended', 'platform_update']);
    expect(whatIsNew({ mark, coin: still, holdEnded: true })).toEqual(['hold_ended']);
  });

  it('a first slot, and a coin the index says nothing about, are never known to be unchanged', () => {
    expect(whatIsNew({ mark: null, coin: still })).toEqual(['first_slot']);
    expect(whatIsNew({ mark, coin: null })).toEqual(['coin_unknown']);
    expect(whatIsNew({ mark, coin: { holders: null, lastTradeAt: null, tradesKnown: false } })).toEqual(['coin_unknown']);
  });
});

describe('what the rule reads', () => {
  it('ownCoinNow: the holders and the newest trade of the market snapshot', () => {
    expect(ownCoinNow(marketOf({ holders: 112, trades: [1_794_000_000, 1_794_000_500] }))).toEqual({ holders: 112, lastTradeAt: 1_794_000_500_000, tradesKnown: true });
    expect(ownCoinNow({ holders: '6', trades: [] })).toEqual({ holders: 6, lastTradeAt: null, tradesKnown: true });
    expect(ownCoinNow({ priceUsd: 0.01, marketCapUsd: 1000 })).toEqual({ holders: null, lastTradeAt: null, tradesKnown: false });
    expect(ownCoinNow(null)).toBeNull();
  });

  it("lastMilestoneAt: the coin's own milestones of the kinds the brief names", () => {
    const feed = { now: 0, since: 0, milestones: [{ token: TOKEN, kind: 'holders', value: 100, at: T0 / 1000 - 60 }, { token: TOKEN.toUpperCase().replace('0X', '0x'), kind: 'volume24h', value: 1000, at: T0 / 1000 - 30 }, { token: '0x9999999999999999999999999999999999999999', kind: 'holders', value: 5, at: T0 / 1000 }, { token: TOKEN, kind: 'something_else', value: 1, at: T0 / 1000 }] };
    expect(lastMilestoneAt(feed, { token: TOKEN, kernel: KERNEL }, T0)).toBe(T0 - 30_000);
    expect(lastMilestoneAt(null, { token: TOKEN, kernel: KERNEL }, T0)).toBeNull();
  });

  it('the switch: on for a coin that never set it, off by the creator or the deployment, never for the platform account', () => {
    expect(quietSlotOf({})).toBe(true);
    expect(quietSlotOf({ quietSlot: true })).toBe(true);
    expect(quietSlotOf({ quietSlot: false })).toBe(false);
    const on = { config: { QUIET_SLOT: true } };
    expect(quietSlotOn(on, { config: {} })).toBe(true);
    expect(quietSlotOn(on, { config: { quietSlot: false } })).toBe(false);
    expect(quietSlotOn(on, { config: { platform: true } })).toBe(false);
    expect(quietSlotOn({ config: { QUIET_SLOT: false } }, { config: {} })).toBe(false);
    expect(quietSlotOn({}, { config: {} })).toBe(false);
  });

  it('what a turn was shown becomes the mark once its slot was used, and not before', () => {
    const on = { config: { QUIET_SLOT: true } };
    const state: QuietState = { lastPostAt: T0 - 2 * HOUR, quietMark: { at: T0 - 2 * HOUR, holders: 112 }, quietSkipped: { count: 3, lastAt: T0 - HOUR } };
    markQuietSlot(on, { config: {} }, { platform: false }, state, marketOf({ holders: 113, trades: [] }), T0);
    expect(state).toMatchObject({ quietSeen: { at: T0, holders: 113 }, quietMark: { at: T0 - 2 * HOUR, holders: 112 }, quietSkipped: null });
    // The turn has not used its slot yet (the model did not answer, the runtime cut it short): the mark stands.
    expect(settledMark(state)).toEqual({ at: T0 - 2 * HOUR, holders: 112 });
    // It posted, or finished without a post: from here on "new" is measured against what it was shown.
    state.lastPostAt = T0 + 1000;
    expect(settledMark(state)).toEqual({ at: T0, holders: 113 });
    expect(state.quietSeen).toBeNull();
    const passed: QuietState = { lastSlotSkippedAt: T0 + 1000, quietSeen: { at: T0, holders: 6 } };
    expect(settledMark(passed)).toEqual({ at: T0, holders: 6 });
  });

  it('quietTooLong: the last original post and the last slot a turn used are both a ceiling back', () => {
    const DAY = 24 * HOUR;
    const mark = { at: T0, holders: 112 };
    expect(quietTooLong({ lastPostAt: T0 }, mark, T0 + DAY - 1, DAY)).toBe(false);
    expect(quietTooLong({ lastPostAt: T0 }, mark, T0 + DAY, DAY)).toBe(true);
    // A turn that finished without a post still used its slot: the day starts again from it.
    expect(quietTooLong({ lastPostAt: T0 - 5 * DAY }, mark, T0 + DAY - 1, DAY)).toBe(false);
    // ...and so does a post that went out by itself (a scheduled one) since.
    expect(quietTooLong({ lastPostAt: T0 + HOUR }, mark, T0 + DAY, DAY)).toBe(false);
    // No ceiling, and no mark (the first slot runs anyway).
    expect(quietTooLong({ lastPostAt: T0 }, mark, T0 + 30 * DAY, 0)).toBe(false);
    expect(quietTooLong({ lastPostAt: null }, null, T0 + 30 * DAY, DAY)).toBe(false);
    expect(quietCeilingMs({ config: { QUIET_SLOT_MAX_QUIET_MS: DAY } })).toBe(DAY);
    expect(quietCeilingMs({ config: { QUIET_SLOT_MAX_QUIET_MS: 0 } })).toBe(0);
    expect(quietCeilingMs({})).toBe(0);
  });

  it('markQuietSlot keeps the last known count when a snapshot does not say, and keeps no record for a coin the rule is off for', () => {
    const on = { config: { QUIET_SLOT: true } };
    const state: QuietState = { quietMark: { at: T0 - HOUR, holders: 112 } };
    markQuietSlot(on, { config: {} }, { platform: false }, state, null, T0);
    expect(state.quietSeen).toEqual({ at: T0, holders: 112 });
    const off: QuietState = {};
    markQuietSlot(on, { config: { quietSlot: false } }, { platform: false }, off, marketOf({ holders: 5, trades: [] }), T0);
    markQuietSlot(on, { config: { platform: true } }, { platform: true }, off, marketOf({ holders: 5, trades: [] }), T0);
    expect(off).toEqual({});
  });
});

describe('a coin whose holder count does not change (section 2.3)', () => {
  const SLOTS = 5;

  it('before: with the rule off every slot buys a turn and the count is posted again', async () => {
    for (const [config, agentConfig] of [[{ QUIET_SLOT: 'false' }, {}], [{}, { quietSlot: false }]] as const) {
      const { w, atNextSlot } = await quietWorld(config, agentConfig);
      try {
        for (let i = 0; i < SLOTS; i++) expect(await atNextSlot(), `slot ${i + 1}`).toEqual({ ran: true, thoughts: 2, posts: 1 });
        expect(thoughts(w)).toBe(2 * SLOTS);
        expect(w.sender.published.map((p) => (p as { text: string }).text)).toEqual(Array.from({ length: SLOTS }, () => '112 holders. the floor stops proving.'));
      } finally {
        await w.close();
      }
    }
  });

  it('after: the first slot is taken, and no later slot buys a turn while nothing is new', async () => {
    const { w, atNextSlot } = await quietWorld();
    try {
      expect(await atNextSlot()).toEqual({ ran: true, thoughts: 2, posts: 1 });
      expect((await stateOf(w)).quietSeen).toMatchObject({ holders: 112 });
      for (let i = 2; i <= SLOTS; i++) {
        const slotAt = w.ctx.now();
        expect(await atNextSlot(), `slot ${i}`).toEqual({ ran: false, thoughts: 0, posts: 0 });
        const state = await stateOf(w);
        // The slot is spent like one the agent passed on, and the wake moved to the next slot.
        expect(state.lastSlotSkippedAt).toBe(w.ctx.now());
        expect(state.quietSkipped).toEqual({ count: i - 1, lastAt: w.ctx.now() });
        expect(state).toMatchObject({ quietMark: { holders: 112 }, quietSeen: null });
        expect((await runtimeOf(w)).nextAt.getTime()).toBeGreaterThanOrEqual(w.ctx.now() + 2 * HOUR);
        expect(w.ctx.now()).toBeGreaterThan(slotAt);
        // A minute later nothing is asked again: the next slot is the next chance.
        w.setNow(w.ctx.now() + MINUTE);
        const before = thoughts(w);
        expect((await tick(w.ctx)).ran).toEqual([]);
        expect(thoughts(w)).toBe(before);
        expect((await stateOf(w)).quietSkipped).toEqual({ count: i - 1, lastAt: w.ctx.now() - MINUTE });
      }
      // Five slots: two thoughts instead of ten, one post instead of five.
      expect(thoughts(w)).toBe(2);
      expect(w.sender.published).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('the ceiling: a coin where nothing changes is quiet for a day, then gets one turn, then is quiet again', async () => {
    const DAY = 24 * HOUR;
    const { w, atNextSlot } = await quietWorld();
    try {
      expect(w.ctx.config.QUIET_SLOT_MAX_QUIET_MS).toBe(DAY);
      expect(await atNextSlot()).toEqual({ ran: true, thoughts: 2, posts: 1 });
      const posted = (await stateOf(w)).lastPostAt!;
      // Every slot inside the day is skipped.
      let skipped = 0;
      for (;;) {
        const slot = await atNextSlot();
        if (slot.ran) break;
        expect(w.ctx.now() - posted).toBeLessThan(DAY);
        skipped += 1;
        expect(skipped).toBeLessThan(20);
      }
      // The first slot a day or more after the last post is the agent's, though nothing changed: one turn, told nothing special.
      expect(skipped).toBeGreaterThanOrEqual(10);
      expect(w.ctx.now() - posted).toBeGreaterThanOrEqual(DAY);
      expect(thoughts(w)).toBe(4);
      expect(w.sender.published).toHaveLength(2);
      // Then the day starts again.
      const again = (await stateOf(w)).lastPostAt!;
      expect(again).toBeGreaterThan(posted);
      for (let i = 0; i < 5; i++) expect(await atNextSlot(), `slot ${i + 1} after the ceiling`).toEqual({ ran: false, thoughts: 0, posts: 0 });
    } finally {
      await w.close();
    }
  });

  it('the turn the ceiling gives may finish without a post: the day starts again all the same', async () => {
    const DAY = 24 * HOUR;
    const { w, script, atNextSlot } = await quietWorld();
    try {
      expect((await atNextSlot()).ran).toBe(true);
      const posted = (await stateOf(w)).lastPostAt!;
      // The next turn that is bought, the ceiling's, finds nothing to say and only finishes.
      script.unshift(() => finishResponse(w.ctx.now() + MINUTE));
      let slot = await atNextSlot();
      for (let i = 0; !slot.ran && i < 20; i++) slot = await atNextSlot();
      expect(slot).toEqual({ ran: true, thoughts: 1, posts: 0 });
      expect(w.ctx.now() - posted).toBeGreaterThanOrEqual(DAY);
      expect((await stateOf(w)).lastPostAt).toBe(posted);
      // The slot was used: the next ones are skipped again, although the last post is now more than a day old.
      for (let i = 0; i < 3; i++) expect(await atNextSlot(), `slot ${i + 1} after the ceiling`).toEqual({ ran: false, thoughts: 0, posts: 0 });
      expect(w.ctx.now() - posted).toBeGreaterThan(DAY);
    } finally {
      await w.close();
    }
  });

  it('QUIET_SLOT_MAX_QUIET_MS=0 is no ceiling: the coin stays quiet for as long as nothing is new', async () => {
    const { w, atNextSlot } = await quietWorld({ QUIET_SLOT_MAX_QUIET_MS: '0' });
    try {
      expect((await atNextSlot()).ran).toBe(true);
      const posted = (await stateOf(w)).lastPostAt!;
      for (let i = 0; i < 16; i++) expect((await atNextSlot()).ran, `slot ${i + 2}`).toBe(false);
      expect(w.ctx.now() - posted).toBeGreaterThan(24 * HOUR);
      expect(thoughts(w)).toBe(2);
    } finally {
      await w.close();
    }
  });

  it('a new holder, a trade, a mention, a creator request and changed settings each buy the next slot\'s turn', async () => {
    const { w, coin, atNextSlot } = await quietWorld();
    try {
      expect((await atNextSlot()).ran).toBe(true);
      expect((await atNextSlot()).ran).toBe(false);

      coin.holders = 113;
      expect(await atNextSlot()).toEqual({ ran: true, thoughts: 2, posts: 1 });
      expect((await stateOf(w)).quietSeen).toMatchObject({ holders: 113 });
      expect((await stateOf(w)).quietSkipped ?? null).toBeNull();
      expect((await atNextSlot()).ran).toBe(false);

      // A trade made after the last slot the agent had.
      coin.trades = [Math.floor(w.ctx.now() / 1000) + 60];
      expect((await atNextSlot()).ran).toBe(true);
      // ...and the same trade is not news a second time.
      expect((await atNextSlot()).ran).toBe(false);

      // A mention waiting: the turn runs, and the slot is its to post in.
      w.sender.items = [mention('1001')];
      const withMention = await atNextSlot();
      expect(withMention.ran).toBe(true);
      w.sender.items = [];
      expect((await atNextSlot()).ran).toBe(false);

      // The creator asked for something in the private chat.
      await fileRequest(w.ctx, AGENT_ID, { text: 'Post about the new coin page.', turn: 'social' });
      expect((await atNextSlot()).ran).toBe(true);
    } finally {
      await w.close();
    }
  });

  it('settings the creator changed are new; an index that does not answer is not "nothing new"', async () => {
    const { w, atNextSlot } = await quietWorld();
    try {
      expect((await atNextSlot()).ran).toBe(true);
      expect((await atNextSlot()).ran).toBe(false);
      const agent = (await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      await w.db.update(agents).set({ config: { ...agent.config, revision: 2 } }).where(eq(agents.agentId, AGENT_ID));
      expect((await atNextSlot()).ran).toBe(true);
      expect((await atNextSlot()).ran).toBe(false);
      w.ctx.indexer.market = (async () => null) as never;
      expect((await atNextSlot()).ran).toBe(true);
    } finally {
      await w.close();
    }
  });

  it('a turn that never got to use its slot does not use up what was new', async () => {
    const { w, coin, script, atNextSlot } = await quietWorld({ MAX_TOOL_STEPS: '2' });
    try {
      expect((await atNextSlot()).ran).toBe(true);
      coin.holders = 113;
      // The model reads around until the runtime cuts the turn short: no post, no finish, and the slot stays due.
      script.unshift(() => toolCallResponse('recall', { query: 'holders' }), () => toolCallResponse('recall', { query: 'floor' }));
      expect(await atNextSlot()).toEqual({ ran: true, thoughts: 2, posts: 0 });
      const cut = await stateOf(w);
      expect(cut).toMatchObject({ quietSeen: { holders: 113 }, quietMark: { holders: 112 }, runtimeEnded: { postDue: true } });
      // When the slot is tried again the new holder is still news: the turn is bought and the count goes out.
      w.setNow(cut.runtimeEnded!.until + 1000);
      expect(await atNextSlot()).toEqual({ ran: true, thoughts: 2, posts: 1 });
      expect((w.sender.published.at(-1) as { text: string }).text).toBe('113 holders. the floor stops proving.');
      expect((await atNextSlot()).ran).toBe(false);
    } finally {
      await w.close();
    }
  });

  it('a slot X held back is the agent\'s to use when the hold ends, whatever the coin did', async () => {
    const { w, atNextSlot } = await quietWorld();
    try {
      expect((await atNextSlot()).ran).toBe(true);
      expect((await atNextSlot()).ran).toBe(false);
      // A hold the model was told about has ended and no turn has been told yet (runtime.ts `trackHoldEnd`).
      const state = await stateOf(w);
      await w.db.update(runtimes).set({ state: { ...state, postHoldEndedNote: { reason: 'x_quota', until: w.ctx.now() - MINUTE, at: w.ctx.now() - MINUTE, how: 'expired' } } as unknown as Record<string, unknown> }).where(eq(runtimes.agentId, AGENT_ID));
      expect((await atNextSlot()).ran).toBe(true);
      expect((await atNextSlot()).ran).toBe(false);
    } finally {
      await w.close();
    }
  });

  it('holds in loop mode too: the wake the agent asked for is moved past the slot it has nothing for', async () => {
    const { w, atNextSlot } = await quietWorld({ WAKE_MODE: 'loop' });
    try {
      expect((await atNextSlot()).ran).toBe(true);
      expect(await atNextSlot()).toEqual({ ran: false, thoughts: 0, posts: 0 });
      w.setNow(w.ctx.now() + MINUTE);
      expect((await tick(w.ctx)).ran).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('the platform account is never given the quiet slot', async () => {
    const { w, atNextSlot } = await quietWorld({}, { platform: true, requireApproval: false });
    try {
      expect((await atNextSlot()).ran).toBe(true);
      expect((await atNextSlot()).ran).toBe(true);
      expect(await stateOf(w)).not.toHaveProperty('quietMark');
      expect(await stateOf(w)).not.toHaveProperty('quietSeen');
    } finally {
      await w.close();
    }
  });
});

describe('quietSlot: what it costs and what it never does', () => {
  it('reads nothing for a slot that is not due or a coin the rule is off for, and one market snapshot otherwise', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      let reads = 0;
      w.ctx.indexer.market = (async () => {
        reads += 1;
        return marketOf({ holders: 112, trades: [] });
      }) as never;
      const signals = { due: true, mentionWaiting: false, configChanged: false };
      expect(await quietSlot(w.ctx, agent, {}, { ...signals, due: false })).toEqual({ skipped: false, reasons: [] });
      expect(await quietSlot(w.ctx, { ...agent, config: { ...agent.config, quietSlot: false } }, {}, signals)).toEqual({ skipped: false, reasons: [] });
      expect(await quietSlot(w.ctx, agent, {}, { ...signals, mentionWaiting: true })).toEqual({ skipped: false, reasons: ['mention'] });
      expect(reads).toBe(0);
      // The snapshot it read is handed back, so the turn does not read it again.
      const first = await quietSlot(w.ctx, agent, {}, signals);
      expect(first).toMatchObject({ skipped: false, reasons: ['first_slot'], market: { holders: 112 } });
      const state: QuietState = { quietMark: { at: T0 - HOUR, holders: 112 } };
      expect(await quietSlot(w.ctx, agent, state, signals)).toMatchObject({ skipped: true, reasons: [] });
      expect(state).toMatchObject({ lastSlotSkippedAt: T0, quietSkipped: { count: 1, lastAt: T0 } });
      expect(reads).toBe(2);
      expect(w.inference.calls).toHaveLength(0);
      // A check that fails keeps the slot.
      const broken = { ...w.ctx, db: { select: () => { throw new Error('the database is away'); } } } as unknown as typeof w.ctx;
      expect(await quietSlot(broken, agent, { quietMark: { at: T0 - HOUR, holders: 112 } }, signals)).toEqual({ skipped: false, reasons: ['coin_unknown'] });
    } finally {
      await w.close();
    }
  });
});

describe('an own agent: `due` says a post slot is not due when nothing is new', () => {
  const finish = (w: OwnWorld, credential: string, turnId: string) => w.run('finish', credential, { turnId, ...finishInput(w) });

  async function own(agentConfig: Record<string, unknown> = {}) {
    const coin: Coin = { holders: 6, trades: [] };
    const w = await ownWorld();
    w.ctx.indexer.market = (async () => marketOf(coin)) as never;
    await seedOwn(w, { config: agentConfig });
    const { credential } = await connectClient(w);
    const toNextSlot = async () => {
      const agent = (await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      const schedule = scheduleFor(agentConfigOf(agent)!, await stateOf(w), w.ctx.now())!;
      if (schedule.nextAt > w.ctx.now()) w.setNow(schedule.nextAt + 1000);
    };
    /** Opens the turn that is due, posts the holder count and finishes. */
    const takeSlot = async () => {
      const turn = await openSocial(w, credential);
      expect(turn.reasons).toContain('original_post_due');
      expect((await act(w, credential, turn.turnId, 'publish_post', { text: `${coin.holders} holders here already.` })).body.status).toBe('completed');
      expect((await finish(w, credential, turn.turnId)).status).toBe(200);
    };
    const due = async () => (await w.run<DueView>('due', credential)).body.social;
    return { w, coin, credential, toNextSlot, takeSlot, due };
  }

  it('the first slot is due; the next one is not while the coin stands still, and is again once a holder joins', async () => {
    const { w, coin, toNextSlot, takeSlot, due } = await own();
    try {
      expect((await due()).reasons).toContain('original_post_due');
      await takeSlot();
      expect((await stateOf(w)).quietSeen).toMatchObject({ holders: 6 });

      await toNextSlot();
      const quiet = await due();
      expect(quiet).toMatchObject({ on: true, due: false, reasons: [] });
      // The slot is spent: the client is told to look again at the slot after it, not in a minute.
      expect((await stateOf(w)).lastSlotSkippedAt).toBe(w.ctx.now());
      expect(Date.parse(quiet.nextAt!)).toBeGreaterThanOrEqual(w.ctx.now() + 2 * HOUR);
      w.setNow(w.ctx.now() + MINUTE);
      expect((await due()).due).toBe(false);

      coin.holders = 7;
      await toNextSlot();
      expect((await due()).reasons).toContain('original_post_due');
      // Asking again before the client opens the turn does not spend the slot: the change is still new.
      expect((await due()).reasons).toContain('original_post_due');
      await takeSlot();
      expect(await stateOf(w)).toMatchObject({ quietSeen: { holders: 7 }, quietMark: { holders: 6 } });
      expect(w.sender.published).toHaveLength(2);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('the ceiling holds for an own agent too: a day after its last post the slot is due though nothing changed', async () => {
    const { w, toNextSlot, takeSlot, due } = await own();
    try {
      await takeSlot();
      const posted = (await stateOf(w)).lastPostAt!;
      let told = await due();
      for (let i = 0; i < 20 && !told.reasons.includes('original_post_due'); i++) {
        expect(w.ctx.now() - posted).toBeLessThan(24 * HOUR);
        await toNextSlot();
        told = await due();
      }
      expect(told.reasons).toContain('original_post_due');
      expect(w.ctx.now() - posted).toBeGreaterThanOrEqual(24 * HOUR);
    } finally {
      await w.close();
    }
  });

  it('a creator who switched it off is told every slot is due', async () => {
    const { w, toNextSlot, takeSlot, due } = await own({ quietSlot: false });
    try {
      await takeSlot();
      await toNextSlot();
      expect((await due()).reasons).toContain('original_post_due');
      await takeSlot();
      expect(w.sender.published).toHaveLength(2);
    } finally {
      await w.close();
    }
  });
});

describe("the creator's switch", () => {
  function api(w: TestWorld) {
    const nowSec = () => Math.floor(w.ctx.now() / 1000);
    const app = createApp(w.ctx, nowSec);
    const path = `/internal/agents/${AGENT_ID}/config`;
    return {
      get: async () => (await (await app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } })).json()) as Record<string, unknown>,
      put: async (body: unknown) => {
        const text = JSON.stringify(body);
        const res = await app.request(path, { method: 'PUT', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'PUT', path, text, nowSec()) } });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      },
    };
  }

  it('is on for a coin whose stored config never named it, and is stored when the creator switches it off and on again', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const { get, put } = api(w);
      // An existing coin: nothing in its stored config, and the rule applies.
      expect(((await w.db.query.agents.findFirst())!.config as Record<string, unknown>).quietSlot).toBeUndefined();
      expect((await get()).quietSlot).toBe(true);
      expect((await put({ by: CREATOR, quietSlot: 'no' })).status).toBe(400);
      expect((await put({ by: CREATOR, quietSlot: true })).status).toBe(409);
      const off = await put({ by: CREATOR, quietSlot: false });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ quietSlot: false, revision: 2 });
      const stored = (await w.db.query.agents.findFirst())!;
      expect((stored.config as Record<string, unknown>).quietSlot).toBe(false);
      expect(quietSlotOn(w.ctx, stored)).toBe(false);
      expect((await put({ by: CREATOR, quietSlot: true })).body).toMatchObject({ quietSlot: true, revision: 3 });
      expect(quietSlotOn(w.ctx, (await w.db.query.agents.findFirst())!)).toBe(true);
    } finally {
      await w.close();
    }
  });

  it('is not offered for the platform account', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w, { config: { platform: true } });
      const { get, put } = api(w);
      expect((await get()).quietSlot).toBeNull();
      expect(await put({ by: CREATOR, quietSlot: false })).toMatchObject({ status: 400, body: { error: 'quiet_slot_not_offered' } });
    } finally {
      await w.close();
    }
  });
});
