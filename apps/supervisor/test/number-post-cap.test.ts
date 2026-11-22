/**
 * G7, the cap on a coin's own numbers posts (number-post-cap.ts): at most `COIN_NUMBER_POSTS_PER_DAY` originals per
 * rolling 24 hours state the coin's own market figures. The posts are the ones a coin made on 2026-11-22, about every
 * 70 minutes: "Day 16: 119 holders now, 75 trades, $9.7k volume, real adoption is boring", each with a holder count one
 * or two off the last, which the repeat gate lets through as news.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { executeAction } from '../src/broker/index.js';
import { COIN_TODAY_MEANING, coinTodayQuotaMeaning, coinTodaySection } from '../src/coin-today.js';
import { agents, gateShadow, runtimes } from '../src/db/schema.js';
import { gateMode } from '../src/gate-shadow.js';
import { MARKET_SUBJECTS, NUMBER_POST_WINDOW_MS, marketFigures, numberPostCap, numberPostProblem, numbersPostQuota, numbersPostsSince, ownMarketFigures } from '../src/number-post-cap.js';
import { agentConfigOf } from '../src/onboarding.js';
import { postGateRefusal } from '../src/post-gates.js';
import { scheduleFor, type AgentState } from '../src/runtime.js';
import { originalsSince, recordSaid, saidFieldsOf, type SaidOriginal } from '../src/said.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { POSTING_DEFAULTS, brokerEnv, observed, pendingOf, storeTurn } from './posting-helpers.js';

const T0 = Date.parse('2026-11-22T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The coin's posts of the day, each as it went out. */
const NUMBERS_117 = 'Day 16: 117 holders now. 71 trades, $9.4k volume. real adoption is boring.';
const NUMBERS_119 = 'Day 16: 119 holders now. 75 trades, $9.7k volume. real adoption is boring.';
/** What the index says of the coin when the second one is written. */
const MARKET = { priceUsd: 0.000041, marketCapUsd: 41_250, change24hPct: 2.19, holders: 119, trades24h: 75, volume24hUsd: 9712.4, fees24hUsd: 97.1, trades: [{ side: 'buy', timestamp: String(Math.floor(T0 / 1000) - 600), valueUsd: 0.1, amountEth: 0.001 }] };
/** Posts about something else: no figure, somebody else's figure, a figure that is not a market figure. */
const IDEA = 'Brian Armstrong argues that payments should settle in seconds, not days. The slow part was never the technology.';
const THEIR_FIGURE = 'Brian Armstrong says Coinbase cut its trading fee to 0.4% for small orders. A fee nobody has to look up is a product decision.';
const TREASURY = 'The treasury holds 0.05 WETH after the claim.';

/** An original as the ledger gives it to the gate. */
const said = (id: string, at: number, ...texts: string[]): SaidOriginal => ({ actionId: id, postId: `p_${id}`, postedAt: at, opener: saidFieldsOf(texts[0]!).opener ?? '', facts: texts.flatMap((t) => saidFieldsOf(t).facts ?? []) });
const own = () => ownMarketFigures({ market: { snapshot: MARKET } });
const seedSaid = (w: TestWorld, id: string, at: number, text: string, tool = 'publish_post') => recordSaid(w.ctx, { agentId: AGENT_ID, actionId: id, action: { tool, input: tool === 'publish_reply' ? { text, postId: '501' } : { text } }, result: { postId: `p_${id}` }, at });
const shadowRows = async (w: TestWorld) => (await w.db.select().from(gateShadow)).filter((r) => r.gate === 'G7');

async function world(config: Record<string, string> = {}, agentConfigOver: Record<string, unknown> = {}) {
  const w = await makeWorld({ config: { ...POSTING_DEFAULTS, NUMBER_POST_GATE: 'enforce', ...config } });
  w.setNow(T0);
  w.ctx.indexer.market = (async () => MARKET) as never;
  const agent = await seedAgent(w, { config: { socialStartedAt: new Date(T0 - 10 * HOUR).toISOString(), ...agentConfigOver }, runtime: { nextAt: new Date(T0 + 12 * HOUR) } });
  const config0 = agentConfigOf(agent)!;
  let n = 0;
  const post = (text: string, more: Record<string, unknown> = {}) => executeAction(w.ctx, agent, config0, pendingOf(`act-cap-${String(++n).padStart(5, '0')}`, 'publish_post', { text, ...more }), brokerEnv());
  const reply = (postId: string, text: string) => executeAction(w.ctx, agent, config0, pendingOf(`act-cap-${String(++n).padStart(5, '0')}`, 'publish_reply', { postId, text }), brokerEnv());
  return { w, agent, post, reply };
}

describe('what a numbers post is', () => {
  it('reads the figures the fingerprint reads, and counts the ones about a market', () => {
    expect(MARKET_SUBJECTS).toEqual(['holders', 'trades', 'volume', 'price', 'fee']);
    // the post of 2026-11-22: three market figures; "Day 16" is a label, not a figure
    expect(marketFigures([NUMBERS_119]).map((f) => [f.subject, f.unit, f.value])).toEqual([
      ['holders', '', 119],
      ['trades', '', 75],
      ['volume', '$', 9700],
    ]);
    expect(marketFigures(['Market cap $41k, up 2.19% on the day.']).map((f) => f.subject)).toEqual(['price', 'price']);
    expect(marketFigures(['Those trades paid about $97 in fees.']).map((f) => f.subject)).toEqual(['fee']);
    expect(marketFigures(['six holders. still here.']).map((f) => [f.subject, f.value])).toEqual([['holders', 6]]);
    // every post of a thread is read
    expect(marketFigures([IDEA, NUMBERS_119])).toHaveLength(3);
    // not a market figure: no figure at all, the day count, the treasury, the supply, the fee split's shares
    for (const text of [IDEA, 'Day 16. Still here.', TREASURY, '100B supply, fixed at launch.', '40% goes to the agent and 30% to the creator.']) expect(marketFigures([text])).toEqual([]);
  });

  it('the coin\'s own market data is the plain fields of its snapshot and the brief, never its list of trades', () => {
    const numbers = ownMarketFigures({ market: { snapshot: MARKET }, coinToday: { digest: '$BRIANBRAIN on 2026-11-22: 119 holders. Last 24 hours: 75 trades, $9,712.40 traded.', meaning: 'at most 3 posts' } }).map((e) => e.value);
    for (const held of [119, 75, 9712.4, 97.1, 41_250, 2.19]) expect(numbers).toContain(held);
    // the trade rows are left out: among a hundred small amounts any number finds a match by chance
    expect(numbers).not.toContain(0.001);
    expect(numbers).not.toContain(0.1);
    // the snapshot the index gives now is read the same way, and nothing readable gives nothing
    expect(ownMarketFigures(null, { holders: '121' }).map((e) => e.value)).toEqual([121]);
    expect(ownMarketFigures(null, null)).toEqual([]);
    expect(ownMarketFigures({}, undefined)).toEqual([]);
  });
});

describe('numberPostProblem: the rule', () => {
  const earlier = [said('act_n1', T0 - 2 * HOUR, NUMBERS_117)];

  it('the first numbers post of the day passes; the next one is refused, whether or not its figures moved', () => {
    expect(numberPostProblem([NUMBERS_119], [], 1, own())).toBeNull();
    const found = numberPostProblem([NUMBERS_119], earlier, 1, own());
    expect(found).toMatchObject({ code: 'number_post_cap', detail: { figures: ['119 (holders)', '75 (trades)', '$9700 (volume)'], cap: 1, ownData: true, earlier: [{ postId: 'p_act_n1', saidAt: new Date(T0 - 2 * HOUR).toISOString() }] } });
    expect(found!.message).toBe(
      "number_post_cap: you already posted your coin's numbers in the last 24 hours (117 (holders), 71 (trades), $9400 (volume) on 2026-11-22), and this post gives them again (119 (holders), 75 (trades), $9700 (volume)). " +
        "At most one post a day may state your coin's own figures, whether or not they moved. " +
        'Write about something else (what an account you follow said, what your creator set you up to talk about, something you learned) or finish without a post. ' +
        'You may still give the figures in a reply to somebody who asks. Nothing was posted.',
    );
    // one of its own figures is enough, in any post of a thread
    expect(numberPostProblem([IDEA, 'Meanwhile: 119 holders.'], earlier, 1, own())?.detail.figures).toEqual(['119 (holders)']);
    expect(numberPostProblem([NUMBERS_119], earlier, 1, own(), 'scheduled')!.message).toMatch(/Nothing was scheduled\.$/);
  });

  it('a post about something else passes after the day\'s numbers post: no figure, somebody else\'s figure, a figure that is no market figure', () => {
    for (const text of [IDEA, THEIR_FIGURE, TREASURY, 'Coinbase reported $1.2B volume for the quarter.', 'Base passed 12M holders of USDC this week.']) expect(numberPostProblem([text], earlier, 1, own())).toBeNull();
    // a figure of its own next to somebody else's still makes it a numbers post
    expect(numberPostProblem([`${THEIR_FIGURE} Here: 119 holders.`], earlier, 1, own())?.detail.figures).toEqual(['119 (holders)']);
  });

  it('a figure is the coin\'s own within rounding, as the number gate reads it', () => {
    for (const text of ['$9.7k volume today.', 'About $9,712 traded.', 'Volume near $10k.', '119 holders.', 'Fees: $97.']) expect(numberPostProblem([text], earlier, 1, own())?.code).toBe('number_post_cap');
    for (const text of ['$4.2k volume today.', '250 holders.']) expect(numberPostProblem([text], earlier, 1, own())).toBeNull();
  });

  it('when the coin\'s own data cannot be read, every market figure counts: a silent index does not switch the cap off', () => {
    expect(numberPostProblem([THEIR_FIGURE], earlier, 1, null)).toMatchObject({ code: 'number_post_cap', detail: { ownData: false } });
    expect(numberPostProblem([THEIR_FIGURE], earlier, 1, [])?.code).toBe('number_post_cap');
    expect(numberPostProblem([IDEA], earlier, 1, null)).toBeNull();
  });

  it('the count is the deployment\'s: two a day, or none at all', () => {
    const two = [said('act_n2', T0 - HOUR, NUMBERS_119), ...earlier];
    expect(numberPostProblem([NUMBERS_119], earlier, 2, own())).toBeNull();
    expect(numberPostProblem([NUMBERS_119], two, 2, own())!.message).toMatch(/At most 2 posts a day may state your coin's own figures/);
    const never = numberPostProblem([NUMBERS_119], [], 0, own())!;
    expect(never.message).toMatch(/^number_post_cap: this post states your coin's own figures \(119 \(holders\), 75 \(trades\), \$9700 \(volume\)\), and here they are not posted as a post of their own\. Write about something else/);
    expect(numberPostCap({ config: {} })).toBe(1);
    expect(numberPostCap({ config: { COIN_NUMBER_POSTS_PER_DAY: 3 } })).toBe(3);
    expect(numberPostCap({ config: { COIN_NUMBER_POSTS_PER_DAY: 0 } })).toBe(0);
  });
});

describe('the settings', () => {
  it('the gate is enforced and the count is one a day unless set otherwise', async () => {
    expect(gateMode({ config: {} }, 'G7')).toBe('enforce');
    expect(gateMode({ config: { NUMBER_POST_GATE: 'shadow' } }, 'G7')).toBe('shadow');
    expect(gateMode({ config: { NUMBER_POST_GATE: 'off', REPEAT_GATE: 'enforce' } }, 'G7')).toBe('off');
    // an unset setting (the compose file passes it empty) is the default
    const w = await makeWorld({ config: { NUMBER_POST_GATE: '', COIN_NUMBER_POSTS_PER_DAY: '' } });
    try {
      expect(w.ctx.config.NUMBER_POST_GATE).toBe('enforce');
      expect(w.ctx.config.COIN_NUMBER_POSTS_PER_DAY).toBe(1);
    } finally {
      await w.close();
    }
  });
});

describe('the count: a rolling 24 hours of originals on the ledger', () => {
  it('counts originals with a market figure, a thread once, no reply, nothing older than the window', async () => {
    const { w } = await world();
    try {
      await seedSaid(w, 'act_old', T0 - NUMBER_POST_WINDOW_MS - MINUTE, NUMBERS_117);
      await seedSaid(w, 'act_idea', T0 - 5 * HOUR, IDEA);
      await seedSaid(w, 'act_reply', T0 - 4 * HOUR, '119 holders right now, since you ask.', 'publish_reply');
      await seedSaid(w, 'act_treasury', T0 - 3 * HOUR, TREASURY);
      expect(await numbersPostsSince(w.ctx, AGENT_ID, T0 - NUMBER_POST_WINDOW_MS)).toEqual([]);
      await recordSaid(w.ctx, { agentId: AGENT_ID, actionId: 'act_thread', action: { tool: 'publish_post', input: { text: IDEA, thread: [{ text: 'Meanwhile: 118 holders.' }, { text: '73 trades today.' }] } }, result: { postId: 'p1', sent: 3 }, at: T0 - 2 * HOUR });
      await seedSaid(w, 'act_n1', T0 - HOUR, NUMBERS_119);
      const made = await numbersPostsSince(w.ctx, AGENT_ID, T0 - NUMBER_POST_WINDOW_MS);
      expect(made.map((o) => o.actionId)).toEqual(['act_n1', 'act_thread']);
      // the action being decided is left out, and another agent's posts are not this one's
      expect((await numbersPostsSince(w.ctx, AGENT_ID, T0 - NUMBER_POST_WINDOW_MS, 'act_n1')).map((o) => o.actionId)).toEqual(['act_thread']);
      expect(await numbersPostsSince(w.ctx, '8', T0 - NUMBER_POST_WINDOW_MS)).toEqual([]);
      expect((await originalsSince(w.ctx, AGENT_ID, T0 - NUMBER_POST_WINDOW_MS)).map((o) => o.actionId)).toEqual(['act_n1', 'act_thread', 'act_treasury', 'act_idea']);
      // with the ledger off nothing can be counted
      expect(await numbersPostsSince({ db: w.db, config: { SAID_KEEP_DAYS: 0 } }, AGENT_ID, T0 - NUMBER_POST_WINDOW_MS)).toEqual([]);
    } finally {
      await w.close();
    }
  });
});

describe('on the publish paths', () => {
  it('enforced: the second numbers post of the day is refused and nothing is sent; a post about something else and a reply with the figures go out', async () => {
    const { w, post, reply } = await world();
    try {
      await seedSaid(w, 'act_n1', T0 - 2 * HOUR, NUMBERS_117);
      await storeTurn(w, observed({ market: { snapshot: MARKET } }));
      const refused = await post(NUMBERS_119);
      expect(refused).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^number_post_cap: you already posted your coin's numbers in the last 24 hours \(117 \(holders\), 71 \(trades\), \$9400 \(volume\) on 2026-11-22\).*Write about something else.*Nothing was posted\.$/) });
      expect(w.sender.published).toEqual([]);
      expect((await post(IDEA)).kind).toBe('completed');
      expect((await post(THEIR_FIGURE)).kind).toBe('completed');
      // a reply is not asked: whatever becomes of it (nobody wrote the post it answers), it is not this gate's refusal
      const answered = await reply('501', '119 holders right now, 75 trades in the last day.');
      expect(answered.kind === 'failed' && /^number_post_cap/.test(answered.error ?? '')).toBe(false);
      expect(w.sender.published.map((p) => (p as { text: string }).text)).toEqual(expect.arrayContaining([IDEA, THEIR_FIGURE]));
      expect((await shadowRows(w)).map((r) => [r.code, r.actionId, r.enforced, r.detail.kind])).toEqual([['number_post_cap', 'act-cap-00001', true, 'original']]);
      // no gate bought a thought
      expect(w.inference.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('the window rolls: a day after the last numbers post the next one goes out, and uses the day up again', async () => {
    const { w, post } = await world();
    try {
      await seedSaid(w, 'act_n1', T0 - NUMBER_POST_WINDOW_MS + HOUR, NUMBERS_117);
      expect((await post(NUMBERS_119)).kind).toBe('failed');
      w.setNow(T0 + HOUR + MINUTE);
      expect((await post(NUMBERS_119)).kind).toBe('completed');
      // once the runtime settled it, the post that just went out is on the ledger (the broker alone writes none), and is the day's one
      await seedSaid(w, 'act-cap-00002', w.ctx.now(), NUMBERS_119);
      expect(await post('Day 16: still 119 holders. 75 trades.')).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^number_post_cap: /) });
      expect(w.sender.published).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('in shadow the post goes out and the row says what would have been refused; off, nothing is asked', async () => {
    const shadow = await world({ NUMBER_POST_GATE: 'shadow' });
    try {
      await seedSaid(shadow.w, 'act_n1', T0 - 2 * HOUR, NUMBERS_117);
      expect((await shadow.post(NUMBERS_119)).kind).toBe('completed');
      expect((await shadowRows(shadow.w)).map((r) => [r.code, r.enforced])).toEqual([['number_post_cap', false]]);
    } finally {
      await shadow.w.close();
    }
    const off = await world({ NUMBER_POST_GATE: 'off' });
    try {
      await seedSaid(off.w, 'act_n1', T0 - 2 * HOUR, NUMBERS_117);
      expect((await off.post(NUMBERS_119)).kind).toBe('completed');
      expect(await shadowRows(off.w)).toEqual([]);
    } finally {
      await off.w.close();
    }
  });

  it('the platform account is not asked: its numbers are its own posts', async () => {
    const { w, agent } = await world();
    try {
      await seedSaid(w, 'act_n1', T0 - 2 * HOUR, NUMBERS_117);
      const platform = { ...agent, config: { ...agent.config, platform: true } };
      expect(await postGateRefusal(w.ctx, platform, { actionId: 'act_p', parts: [NUMBERS_119], kind: 'original' })).toBeNull();
      expect(await postGateRefusal(w.ctx, agent, { actionId: 'act_c', parts: [NUMBERS_119], kind: 'original' })).toMatch(/^number_post_cap: /);
      expect((await shadowRows(w)).map((r) => r.actionId)).toEqual(['act_c']);
    } finally {
      await w.close();
    }
  });

  it('a post is asked when it goes out, not when it is scheduled, and a reply never', async () => {
    const { w, agent } = await world();
    try {
      await seedSaid(w, 'act_n1', T0 - 2 * HOUR, NUMBERS_117);
      expect(await postGateRefusal(w.ctx, agent, { actionId: 'act_s', parts: [NUMBERS_119], kind: 'original', done: 'scheduled' })).toBeNull();
      expect(await postGateRefusal(w.ctx, agent, { actionId: 'act_r', parts: [NUMBERS_119], kind: 'reply' })).toBeNull();
      // the scheduled post at its send: no turn of its own, so the index says what the coin's figures are
      expect(await postGateRefusal(w.ctx, agent, { actionId: 'act_s', parts: [NUMBERS_119], kind: 'original' })).toMatch(/^number_post_cap: /);
      expect(await postGateRefusal(w.ctx, agent, { actionId: 'act_s2', parts: [THEIR_FIGURE], kind: 'original' })).toBeNull();
      // the index does not answer and no turn is stored: every market figure counts
      w.ctx.indexer.market = (async () => {
        throw new Error('indexer down');
      }) as never;
      expect(await postGateRefusal(w.ctx, agent, { actionId: 'act_s3', parts: [THEIR_FIGURE], kind: 'original' })).toMatch(/^number_post_cap: /);
      expect(await postGateRefusal(w.ctx, agent, { actionId: 'act_s4', parts: [IDEA], kind: 'original' })).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('with the ledger off nothing can be counted, so nothing is refused', async () => {
    const { w, post } = await world({ SAID_KEEP_DAYS: '0' });
    try {
      expect((await post(NUMBERS_117)).kind).toBe('completed');
      expect((await post(NUMBERS_119)).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });
});

describe('the coinToday section once the day\'s numbers post is made', () => {
  const section = async (w: TestWorld, agent: { agentId: string; token: string; kernel: string }) =>
    (await coinTodaySection(w.ctx, agent, agentConfigOf((await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!)!, { lastPostAt: null }, MARKET)).coinToday as { meaning: string; digest: string; numbersPost?: Record<string, unknown>; written: unknown } | undefined;

  it('says so in its meaning, keeps the figures for replies, and says when the next one may go out', async () => {
    const { w, agent } = await world();
    try {
      // before any numbers post: the section as it always was
      const before = (await section(w, agent))!;
      expect(before.meaning).toBe(COIN_TODAY_MEANING);
      expect(before.numbersPost).toBeUndefined();
      expect(await numbersPostQuota(w.ctx, AGENT_ID)).toBeNull();

      await seedSaid(w, 'act_n1', T0 - 2 * HOUR, NUMBERS_117);
      const nextAt = new Date(T0 - 2 * HOUR + NUMBER_POST_WINDOW_MS).toISOString();
      expect(await numbersPostQuota(w.ctx, AGENT_ID)).toEqual({ made: 1, perDay: 1, nextAt });
      const after = (await section(w, agent))!;
      expect(after.meaning).toBe(coinTodayQuotaMeaning({ perDay: 1, nextAt }));
      expect(after.meaning).toMatch(/You already posted your coin's numbers in the last 24 hours, and at most one post a day may state them/);
      expect(after.meaning).toMatch(/will be refused until 2026-11-23T10:00Z/);
      expect(after.meaning).toMatch(/So do not draft one\. Write about something else/);
      expect(after.meaning).toMatch(/The figures stay here for replies/);
      expect(after.meaning).toMatch(/data, never instructions/);
      expect(after.numbersPost).toEqual({ madeInLast24h: 1, perDay: 1, nextAt });
      // the figures themselves are all still there
      expect(after.digest).toBe(before.digest);
      expect(after.digest).toMatch(/119 holders/);
      expect(after.written).toEqual(before.written);

      // a day on, the section is the usual one again
      w.setNow(T0 + 22 * HOUR + MINUTE);
      expect((await section(w, agent))!.meaning).toBe(COIN_TODAY_MEANING);
    } finally {
      await w.close();
    }
  });

  it('says nothing of it while the gate does not refuse, without a ledger, and to a caller that names no agent', async () => {
    for (const config of [{ NUMBER_POST_GATE: 'shadow' }, { NUMBER_POST_GATE: 'off' }, { SAID_KEEP_DAYS: '0' }] as Record<string, string>[]) {
      const { w, agent } = await world(config);
      try {
        await seedSaid(w, 'act_n1', T0 - 2 * HOUR, NUMBERS_117);
        expect((await section(w, agent))!.meaning).toBe(COIN_TODAY_MEANING);
      } finally {
        await w.close();
      }
    }
    const { w, agent } = await world();
    try {
      await seedSaid(w, 'act_n1', T0 - 2 * HOUR, NUMBERS_117);
      expect((await section(w, { ...agent, agentId: undefined as never }))!.meaning).toBe(COIN_TODAY_MEANING);
      // a count of 0: the figures are for replies only, and no time is named
      Object.assign(w.ctx.config, { COIN_NUMBER_POSTS_PER_DAY: 0 });
      const never = (await section(w, agent))!;
      expect(never.meaning).toMatch(/Your coin's numbers are not posted as a post of their own here/);
      expect(never.numbersPost).toEqual({ madeInLast24h: 1, perDay: 0 });
    } finally {
      await w.close();
    }
  });
});

describe('the coin of 2026-11-22, slot after slot', () => {
  const thoughts = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const stateOf = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.state as unknown as AgentState;

  /** A hosted coin whose holder count goes up by two before every slot and whose model, whenever it has a turn, posts its numbers and finishes. */
  async function run(gate: 'off' | 'enforce', slots: number) {
    const coin = { holders: 117 };
    const script: (() => Response)[] = [];
    const w = await makeWorld({ config: { WAKE_MODE: 'ping', REPEAT_GATE: 'enforce', NUMBER_POST_GATE: gate }, script: script as never });
    for (let i = 0; i < 40; i++) script.push(() => toolCallResponse('publish_post', { text: `Day 16: ${coin.holders} holders now. 75 trades, $9.7k volume. real adoption is boring.` }), () => finishResponse(w.ctx.now() + MINUTE));
    w.ctx.indexer.market = (async () => ({ ...MARKET, holders: coin.holders, trades: [] })) as never;
    await seedAgent(w);
    const meanings: string[] = [];
    for (let slot = 0; slot < slots; slot++) {
      const agent = (await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      const schedule = scheduleFor(agentConfigOf(agent)!, await stateOf(w), w.ctx.now())!;
      if (schedule.nextAt > w.ctx.now()) w.setNow(schedule.nextAt + 1000);
      coin.holders += 2;
      const before = thoughts(w).length;
      await tick(w.ctx);
      const first = thoughts(w)[before]?.body as { messages: { role: string; content: string }[] } | undefined;
      const observation = first ? (JSON.parse(first.messages.find((m) => m.role === 'user')!.content) as { coinToday?: { meaning: string } }) : null;
      meanings.push(observation?.coinToday?.meaning ?? '');
    }
    const posts = w.sender.published.map((p) => (p as { text: string }).text);
    await w.close();
    return { posts, meanings };
  }

  it('before: a numbers post at every slot, each with a count the repeat gate reads as new', async () => {
    const { posts, meanings } = await run('off', 5);
    expect(posts).toHaveLength(5);
    expect(posts.every((p) => /^Day 16: \d+ holders now/.test(p))).toBe(true);
    expect(meanings.every((m) => m === COIN_TODAY_MEANING)).toBe(true);
  });

  it('after: one numbers post, the next slots are told the day\'s post is made, and a draft of another is refused', async () => {
    const { posts, meanings } = await run('enforce', 5);
    expect(posts).toEqual(['Day 16: 119 holders now. 75 trades, $9.7k volume. real adoption is boring.']);
    expect(meanings[0]).toBe(COIN_TODAY_MEANING);
    for (const later of meanings.slice(1)) expect(later).toMatch(/You already posted your coin's numbers in the last 24 hours/);
  });
});
