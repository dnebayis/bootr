/**
 * The gates of docs/design/agent-behaviour.md section 6.3 that this stage adds: G1 repeat, G4 cross-agent, G6 units,
 * each `off`, `shadow` (the default) or `enforce`, and the shadow log every gate writes (G3, the fee claims, too).
 * The posts are the ones quoted in section 2.3 of the note, or the same posts with a word or a figure changed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { openerOf } from '@bootr/agent-core';
import { queueForApproval } from '../src/approvals.js';
import { executeAction } from '../src/broker/index.js';
import { coinFeeSplit, feeSplitLine } from '../src/coin-fees.js';
import { gateShadow, said as saidTable, scheduledPosts } from '../src/db/schema.js';
import { gateHitId, gateMode, gateTextHash, logGateHit, openerMode } from '../src/gate-shadow.js';
import { HANDED_WORDS, ownWords } from '../src/handed-words.js';
import { agentConfigOf } from '../src/onboarding.js';
import { SIMILAR_MIN_WORDS, postGateRefusal, repeatProblem, similarProblem, sourceOpener, unitProblem } from '../src/post-gates.js';
import { postHooks, setPostHooks } from '../src/post-send.js';
import { SAID_OTHERS_MAX_ROWS, recordSaid, saidFieldsOf, wordSet, type SaidByOther, type SaidOriginal } from '../src/said.js';
import { sweepScheduled } from '../src/scheduled.js';
import '../src/thread-send.js';
import { AGENT_ID, makeWorld, seedAgent, type TestWorld } from './helpers.js';
import { POSTING_DEFAULTS, brokerEnv, pendingOf, storeTurn } from './posting-helpers.js';
import { callTool, errorOf, fakeSend, rowOf, schedule } from './scheduled-helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OTHER = '8';

// The posts of section 2.3.
const HOLDERS = '112 holders. the floor stops proving.';
const POOL = 'Fee pool: $0.05 WETH. 6 holders. No trades today.';
const AGENTS_600 = '0 → 600+ agents paying with Base';
const FEE_24 = 'Each trade pays a 2.4% fee';
const ECO_SHORT = '1.15M agents have registered an onchain identity.';
const ECO = 'Eco posted Dune data on 10 November: 1.15M agents have registered an onchain identity (ERC-8004) on Base, 1.02M of them between Oct 12 and 23.';
const JESSE = 'Jesse Pollak says agents can now pay for search in USDC on Base';
const GREEN_LIGHT = "That's not a red flag—it's a green light. So if you're thinking about entry—you're walking into a fee bucket that's already accelerating.";
const WALLETS = "Three wallets held 60% of today's volume. Same tx hash, same second, coordinated rebalance—not panic selling.";
const GOOD_REPLY = "1.2% per trade goes to agent, creator, burn and platform. But it's not hidden: you can see it happen on chain.";

/** An original as the ledger gives it to the repeat gate. */
function said(id: string, at: number, ...texts: string[]): SaidOriginal {
  return { actionId: id, postId: `p_${id}`, postedAt: at, opener: saidFieldsOf(texts[0]!).opener ?? '', facts: texts.flatMap((t) => saidFieldsOf(t).facts ?? []) };
}
const other = (text: string, at = T0 - HOUR, postId = 'p_other', agentId = OTHER): SaidByOther => ({ agentId, postId, postedAt: at, words: wordSet(text) });
const code = (p: { code: string } | null) => p?.code ?? null;
/** Whether an outcome is a refusal of one of the three gates (a reply may fail for other reasons: nobody wrote the post it answers). */
const gated = (o: { kind: string; error?: string }) => o.kind === 'failed' && /^(repeat_|unit_|similar_)/.test(o.error ?? '');

const shadowRows = async (w: TestWorld) => (await w.db.select().from(gateShadow)).sort((a, b) => (a.gate + a.code < b.gate + b.code ? -1 : 1));

/** One completed publish of an agent on the ledger. */
const seedSaid = (w: TestWorld, id: string, at: number, text: string, agentId: string = AGENT_ID, tool = 'publish_post') => recordSaid(w.ctx, { agentId, actionId: id, action: { tool, input: { text } }, result: { postId: `p_${id}` }, at });

async function world(config: Record<string, string> = {}, agentConfigOver: Record<string, unknown> = {}) {
  const w = await makeWorld({ config: { ...POSTING_DEFAULTS, ...config } });
  const agent = await seedAgent(w, { config: { socialStartedAt: new Date(T0 - 10 * HOUR).toISOString(), ...agentConfigOver }, runtime: { nextAt: new Date(T0 + 12 * HOUR) } });
  const config0 = agentConfigOf(agent)!;
  let n = 0;
  const post = (text: string, more: Record<string, unknown> = {}) => executeAction(w.ctx, agent, config0, pendingOf(`act-gate-${String(++n).padStart(5, '0')}`, 'publish_post', { text, ...more }), brokerEnv());
  const reply = (postId: string, text: string) => executeAction(w.ctx, agent, config0, pendingOf(`act-gate-${String(++n).padStart(5, '0')}`, 'publish_reply', { postId, text }), brokerEnv());
  return { w, agent, post, reply };
}

const mounted = { ...postHooks };
afterEach(() => setPostHooks(mounted));

describe('G6 units: a currency sign on a token amount', () => {
  it('finds the posts that carried one', () => {
    expect(unitProblem('Day 10. 6 holders. Fee pool sits at $0.0475 WETH. last trade Nov 10.')).toMatchObject({
      code: 'unit_on_token_amount',
      detail: { found: '$0.0475 WETH', token: 'WETH' },
      message: 'unit_on_token_amount: "$0.0475 WETH" puts a currency sign on an amount of WETH. Write the amount of WETH without the sign ("0.0475 WETH"), or give a dollar value as dollars; never both on one number. Nothing was posted.',
    });
    expect(code(unitProblem(POOL))).toBe('unit_on_token_amount');
    expect(code(unitProblem('The treasury holds $0.2 ETH after the claim.'))).toBe('unit_on_token_amount');
    expect(unitProblem('Fee pool: $0.05 $WETH.', 'scheduled')?.message).toMatch(/Nothing was scheduled\.$/);
  });

  it('leaves amounts written right, dollar amounts, stablecoins and prices alone', () => {
    for (const text of [
      '0.0475 WETH (about $86)',
      "On a $100 trade, that's $58.50 equity for the co-owners, instant",
      'Shallow entries that came in at $5.48 are already out.',
      'The agent holds $5 USDC of fuel.',
      'ETH at $3,400. BTC next.',
      '$3,400 ETH is where it sat all week.',
      'The $100k BTC line again.',
      '$500 ETH volume in the pool today.',
      'A $5 ethereal thing.',
      HOLDERS,
    ])
      expect(unitProblem(text), text).toBeNull();
  });
});

describe('G1 repeat: a post none of whose figures is new', () => {
  it('finds the same figures said again in other words', () => {
    // "112 holders" in four of five posts (BRIANBRAIN, 12 November).
    expect(repeatProblem(['Still 112 holders, the floor stops proving.'], [said('a1', T0 - 2 * HOUR, HOLDERS)])).toMatchObject({
      code: 'repeat_fact',
      message: 'repeat_fact: every figure in this post is one you already posted, and none has changed since: 112 (holders) on 2026-10-24. A fact is said once. Post a figure again only when it changed, and leave the ones you already gave out of a post about something else. Nothing was posted.',
      detail: { repeated: [{ figure: '112 (holders)', saidAt: new Date(T0 - 2 * HOUR).toISOString(), postId: 'p_a1' }] },
    });
    // The same post every two hours (CLANKFISH): the holder count and the fee pool.
    expect(code(repeatProblem(['6 holders here. Fee pool sits at $0.05 WETH.'], [said('a1', T0 - 2 * HOUR, POOL)]))).toBe('repeat_fact');
    // One event, two posts (the platform account, 11 and 13 November).
    expect(code(repeatProblem(['Jesse Pollak: 0 → 600+ agents now pay with Base.'], [said('a2', T0 - HOUR, 'Something else entirely.'), said('a1', T0 - 2 * DAY, AGENTS_600)]))).toBe('repeat_fact');
    // The fee, said again.
    expect(code(repeatProblem(['Every trade on $BOOTR pays a 2.4% fee.'], [said('a1', T0 - DAY, FEE_24)]))).toBe('repeat_fact');
    // A thread counts with all its posts, on both sides.
    expect(code(repeatProblem(['A quiet day.', 'Still 112 holders.'], [said('a1', T0 - DAY, 'Morning.', HOLDERS)]))).toBe('repeat_fact');
  });

  it('lets a figure through that changed, though it rounds to the same fingerprint', () => {
    expect(repeatProblem(['114 holders this morning.'], [said('a1', T0 - 2 * HOUR, HOLDERS)])).toBeNull();
    expect(repeatProblem(['114 holders now, up from 112.'], [said('a1', T0 - 2 * HOUR, HOLDERS)])).toBeNull();
    // It went up and came back: the last thing the readers were told is 7.
    expect(repeatProblem(['Back to 6 holders.'], [said('a2', T0 - HOUR, '7 holders now.'), said('a1', T0 - DAY, '6 holders.')])).toBeNull();
    // ...and saying 7 again is the repeat.
    expect(code(repeatProblem(['7 holders, a calm one.'], [said('a2', T0 - HOUR, '7 holders now.'), said('a1', T0 - DAY, '6 holders.')]))).toBe('repeat_fact');
  });

  it('lets a post through that adds a figure to one already given, or states one for the first time', () => {
    // The follow-up of the note's model post: the count again, and what is new about it.
    expect(repeatProblem([ECO], [said('a1', T0 - DAY, ECO_SHORT)])).toBeNull();
    expect(repeatProblem(['112 holders, and $4.3k traded in the day.'], [said('a1', T0 - DAY, HOLDERS)])).toBeNull();
    expect(repeatProblem([HOLDERS], [])).toBeNull();
    expect(repeatProblem([HOLDERS], [said('a1', T0 - DAY, 'No figures here at all, only words.')])).toBeNull();
    // Figures the fingerprint gives no subject are not compared, and a post without figures is not a repeat of anything.
    expect(repeatProblem(['Shallow entries that came in at $5.48 are already out.'], [said('a1', T0 - DAY, 'I said the shallow entries at $5.48 were out.')])).toBeNull();
    expect(repeatProblem([JESSE], [said('a1', T0 - DAY, 'Another post without a number in it.')])).toBeNull();
  });

  it('finds an opener used before, and not one too short to be a phrasing', () => {
    expect(repeatProblem(['118 holders. The floor is still there.'], [said('a1', T0 - 2 * HOUR, HOLDERS)])).toMatchObject({
      code: 'repeat_opener',
      message: 'repeat_opener: this post opens with the same three words as your post of 2026-10-24 ("# holders the"; a number reads as #, a handle as @). Open it differently: lead with what is new in it. Nothing was posted.',
      detail: { opener: '# holders the', postId: 'p_a1' },
    });
    expect(code(repeatProblem(['Agents on Bootr pay for what they read.'], [said('a1', T0 - DAY, 'Agents on Bootr earn from their own coin.')]))).toBe('repeat_opener');
    // Only the first post of a thread opens it; two words are no phrasing.
    expect(repeatProblem(['Something new today.', '118 holders. The floor is still there.'], [said('a1', T0 - 2 * HOUR, HOLDERS)])).toBeNull();
    expect(repeatProblem(['gm frens'], [said('a1', T0 - DAY, 'gm frens')])).toBeNull();
  });

  it('leaves an opener that names its source alone: the sourced shape is the same three words on every news post', () => {
    // The week of 15 to 21 November: 23 of the platform account's 30 opener finds were these, each a different story.
    const base = 'The base account said today, 19 november, that tokenized stocks are live.';
    expect(repeatProblem(['@base said today, 20 november, that a new chain is live.'], [said('a1', T0 - DAY, '@solana said today, 19 november, that equities hold $1.22b.')])).toBeNull();
    expect(repeatProblem(['@coinbase said on 21 november that grok leads the agents.'], [said('a1', T0 - DAY, '@base said on 19 november that stocks are live.')])).toBeNull();
    expect(repeatProblem(['Bloomberg reported on Tuesday that ETF flows turned.'], [said('a1', T0 - DAY, 'Bloomberg reported on Monday that a fund closed.')])).toBeNull();
    // This test pinned "Jesse Pollak says ..." as a repeat before 2026-11-22; a name and "says" is a source line too.
    expect(repeatProblem(['Jesse Pollak says the next one ships on Monday.'], [said('a1', T0 - DAY, JESSE)])).toBeNull();
    expect(sourceOpener(openerOf(base))).toBe(false);
    expect([sourceOpener('@ said today'), sourceOpener('@ wrote today'), sourceOpener('bloomberg reported on'), sourceOpener('agents on bootr'), sourceOpener('# holders now')]).toEqual([true, true, true, false, false]);
    // A repeated figure is still a repeat behind a source line: only the opener check steps aside.
    expect(code(repeatProblem(['@jessepollak said today that 112 holders hold it.'], [said('a1', T0 - DAY, HOLDERS)]))).toBe('repeat_fact');
  });

  it('reads no further back than the history it is given', () => {
    // The window is the caller's (`REPEAT_WINDOW_ORIGINALS`): with the old post outside it, the figure is new again.
    expect(repeatProblem(['Still 112 holders.'], [said('a2', T0 - HOUR, 'A day of nothing.')])).toBeNull();
  });
});

describe('G4 cross-agent: the words of another agent\'s post', () => {
  it('finds a post in the words of another agent, changed or not', () => {
    expect(similarProblem([`${JESSE}.`], [other(JESSE)], 60)).toMatchObject({
      code: 'similar_post',
      message: "similar_post: 100% of the words of this post are the words of a post another Bootr agent made on 2026-10-24 (figures and the standard lines about a coin's fees and day are not counted). X does not allow substantially similar posts across accounts. Say it in your own words and about your own subject, or leave it out. Nothing was posted.",
      detail: { otherAgentId: OTHER, otherPostId: 'p_other', overlapPct: 100 },
    });
    expect(code(similarProblem([GREEN_LIGHT.replace('green light', 'green signal')], [other(GREEN_LIGHT)], 60))).toBe('similar_post');
    expect(code(similarProblem([ECO.replace('Eco posted', 'Eco shared')], [other('unrelated words about a quiet morning on the launchpad today'), other(ECO)], 60))).toBe('similar_post');
    // Any post of a thread.
    expect(code(similarProblem(['A first post of my own, in my own words, about my own coin today.', WALLETS], [other(WALLETS)], 60))).toBe('similar_post');
  });

  it('lets through a post of its own, a short one, and a comment on the very post it is about', () => {
    // Two coins saying what their own day was: the same kind of post, not the same words.
    expect(similarProblem([HOLDERS], [other(POOL)], 60)).toBeNull();
    expect(similarProblem([WALLETS], [other(GREEN_LIGHT), other(ECO), other(GOOD_REPLY)], 60)).toBeNull();
    // Under SIMILAR_MIN_WORDS words of its own two posts agree by chance.
    expect(SIMILAR_MIN_WORDS).toBe(6);
    expect(ownWords(wordSet('gm to the 112 holders'))).toEqual(['gm']);
    expect(similarProblem(['gm to the 112 holders'], [other('gm to the 112 holders')], 60)).toBeNull();
    // A comment that takes up the words of the post it is about.
    expect(similarProblem([`${JESSE}? Yes, and here is how.`], [other(JESSE, T0 - HOUR, '555')], 60, { exceptPostIds: ['555'] })).toBeNull();
    // The threshold is the deployment's.
    expect(similarProblem([GREEN_LIGHT.replace('green light', 'green signal')], [other(GREEN_LIGHT)], 100)).toBeNull();
    expect(similarProblem([JESSE], [], 60)).toBeNull();
  });
});

describe('G4 and the words code hands every coin', () => {
  // The default split of a coin launched through RWAGMI: what `feeSplitLine` says of it is the same on every such coin.
  const LINE = feeSplitLine(coinFeeSplit({ source: 'bootr', lpFeeBps: 10_000, protocolBps: 1000, agentBps: 450, creatorBps: 5850, burnBps: 0, platformBps: 2700 })!);
  const SPLIT_SAID = 'On this coin the creator gets 65% of the fee, the platform 30% and the agent 5%. No burn.';
  const brief = (symbol: string, holders: number) => `$${symbol} on 2026-11-14, read from Bootr's index at 2026-11-14T12:00Z: ${holders} holders, the same as when you last posted (2026-11-14T10:00Z). Last 24 hours: 3 trades, $40.00 traded.`;

  it('the set is built from the functions that write the sentences, and holds no instruction to the model', () => {
    expect(LINE).toMatch(/^Fee split \(locked at launch, this coin's trades only\): a trade pays 1%/);
    for (const word of ['rwagmi', 'clanker', 'tax', 'dividends', 'locked', 'launch', 'creator', 'platform', 'burn', 'holders', 'trades', 'traded', 'posted', 'milestones', 'contract', 'address', 'cashtag', 'monday', 'yesterday', 'weth']) expect(HANDED_WORDS.has(word), word).toBe(true);
    for (const word of ['never', 'price', 'forecast', 'instructions', 'jesse', 'floor', 'green']) expect(HANDED_WORDS.has(word), word).toBe(false);
    // Nothing of the fee split line or of the day's brief is an agent's own, and no figure is.
    expect(ownWords(wordSet(LINE))).toEqual([]);
    expect(ownWords(wordSet(brief('CLANKFISH', 6)))).toEqual(['clankfish']);
    expect(ownWords(wordSet(SPLIT_SAID))).toEqual(['gets']);
    expect(ownWords(['112', '58.5%', '0.0475', 'floor'])).toEqual(['floor']);
  });

  it('two coins that state the same split, or the same kind of day, are not similar, whoever was first', () => {
    // An account that posts Bootr's own sentence first does not make the next coin's statement of its facts a copy...
    expect(similarProblem([LINE], [other(LINE)], 60)).toBeNull();
    expect(similarProblem([SPLIT_SAID], [other(LINE), other(SPLIT_SAID)], 60)).toBeNull();
    expect(similarProblem([`${SPLIT_SAID} That is the whole fee story here.`], [other(LINE), other(SPLIT_SAID)], 60)).toBeNull();
    expect(similarProblem([brief('BRIAN', 112)], [other(brief('CLANKFISH', 6))], 60)).toBeNull();
    // ...and neither does a figure two coins share.
    expect(similarProblem(['112 holders and 3 trades: a calm Tuesday for us here.'], [other('112 holders and 3 trades. Nothing to add from our side.')], 60)).toBeNull();
  });

  it('a copy is still a copy with handed words or other figures around it', () => {
    expect(code(similarProblem([`${GREEN_LIGHT} 112 holders, 3 trades.`], [other(`${GREEN_LIGHT} 6 holders, 0 trades.`)], 60))).toBe('similar_post');
    expect(code(similarProblem([`${LINE} ${WALLETS}`], [other(WALLETS)], 60))).toBe('similar_post');
  });

  it('enforced on the publish path: posting the handed sentences first blocks nobody', async () => {
    const { w, post, reply } = await world({ CROSS_AGENT_GATE: 'enforce' });
    try {
      // Another account posted the fee split line and a plain statement of the split, as originals, an hour ago.
      await seedSaid(w, 'act_o1', T0 - HOUR, LINE, OTHER);
      await seedSaid(w, 'act_o2', T0 - HOUR, SPLIT_SAID, OTHER);
      expect((await post(SPLIT_SAID)).kind).toBe('completed');
      expect((await post(LINE)).kind).toBe('completed');
      expect(gated(await reply('601', SPLIT_SAID))).toBe(false);
      expect(await shadowRows(w)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('reads the whole window, and at the ceiling of one read compares the newest and says so', async () => {
    const { w } = await world({ CROSS_AGENT_GATE: 'enforce' });
    try {
      const warn = vi.spyOn(w.ctx.log, 'warn');
      const ask = (text: string) => postGateRefusal(w.ctx, { agentId: AGENT_ID, config: {} }, { actionId: 'act_w', parts: [text], kind: 'original' });
      const filler = (i: number, at: number) => ({ id: `act_f${i}`, agentId: `coin${i % 60}`, actionId: `act_f${i}`, postId: `p_f${i}`, kind: 'original' as const, postedAt: new Date(at), words: ['filler', `word${i}`] });
      // 600 posts of 60 other agents in the last day, and behind them, 47 hours back, the post that is copied: more than the 400 rows the read once stopped at.
      await w.db.insert(saidTable).values(Array.from({ length: 600 }, (_, i) => filler(i, T0 - (i + 1) * 2 * 60_000)));
      await seedSaid(w, 'act_old', T0 - 47 * HOUR, JESSE, OTHER);
      expect(await ask(`${JESSE}.`)).toMatch(/^similar_post: /);
      expect(warn).not.toHaveBeenCalled();
      // Past the ceiling of one read the oldest posts of the window are not compared: the copy passes, nothing is refused, and a warning says the ceiling was met.
      await w.db.insert(saidTable).values(Array.from({ length: SAID_OTHERS_MAX_ROWS }, (_, i) => filler(1000 + i, T0 - 30 * 60_000 - i * 1000)));
      expect(await ask(`${JESSE}.`)).toBeNull();
      expect(warn).toHaveBeenCalledWith({ agentId: AGENT_ID, compared: SAID_OTHERS_MAX_ROWS }, expect.stringContaining('cross-agent gate'));
      // A copy of a post among the newest is found all the same.
      await seedSaid(w, 'act_new', T0 - 60_000, GREEN_LIGHT, OTHER);
      expect(await ask(GREEN_LIGHT)).toMatch(/^similar_post: /);
    } finally {
      await w.close();
    }
  });
});

describe('the shadow log', () => {
  it('writes one row per gate, agent, code, text and mode, with the columns the weekly check reads', async () => {
    const w = await makeWorld();
    try {
      const hit = { agentId: AGENT_ID, gate: 'G6', code: 'unit_on_token_amount', actionId: 'act_1', text: POOL, detail: { found: '$0.05 WETH' }, enforced: false } as const;
      await logGateHit(w.ctx, hit);
      // Found again (a scheduled post at its send, a repeated call), with other spacing and case: still one row.
      await logGateHit(w.ctx, { ...hit, actionId: 'sch_0123456789abcdef', text: `  ${POOL.toUpperCase()} ` });
      // Refused once the gate is enforced: a row of its own.
      w.setNow(T0 + HOUR);
      await logGateHit(w.ctx, { ...hit, enforced: true });
      const rows = (await w.db.select().from(gateShadow)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      expect(rows).toEqual([
        { id: gateHitId(hit, gateTextHash(POOL)), agentId: AGENT_ID, gate: 'G6', code: 'unit_on_token_amount', actionId: 'act_1', textHash: gateTextHash(POOL), detail: { found: '$0.05 WETH' }, enforced: false, createdAt: new Date(T0) },
        { id: gateHitId({ ...hit, enforced: true }, gateTextHash(POOL)), agentId: AGENT_ID, gate: 'G6', code: 'unit_on_token_amount', actionId: 'act_1', textHash: gateTextHash(POOL), detail: { found: '$0.05 WETH' }, enforced: true, createdAt: new Date(T0 + HOUR) },
      ]);
      // The post's text is not in the row.
      expect(JSON.stringify(rows)).not.toContain('No trades today');
    } finally {
      await w.close();
    }
  });

  it('never throws, and a gate is shadow unless its setting says otherwise', async () => {
    const log = { warn: () => undefined } as never;
    await expect(logGateHit({ log, db: { insert: () => { throw new Error('the database is away'); } } as never }, { agentId: '7', gate: 'G1', code: 'repeat_fact', text: HOLDERS, enforced: false })).resolves.toBeUndefined();
    await expect(logGateHit({ log }, { agentId: '7', gate: 'G1', code: 'repeat_fact', text: HOLDERS, enforced: false })).resolves.toBeUndefined();
    // The repeat gate is enforced by default since 2026-11-22, after its week in shadow; its opener part is not.
    expect([gateMode({ config: {} }, 'G1'), gateMode({ config: {} }, 'G4'), gateMode({ config: {} }, 'G6'), gateMode({ config: {} }, 'G3')]).toEqual(['enforce', 'shadow', 'shadow', 'enforce']);
    expect(gateMode({ config: { REPEAT_GATE: 'shadow', UNITS_GATE: 'off' } }, 'G1')).toBe('shadow');
    expect([openerMode({ config: {} }), openerMode({ config: { OPENER_GATE: 'enforce' } }), openerMode({ config: { REPEAT_GATE: 'shadow', OPENER_GATE: 'enforce' } }), openerMode({ config: { REPEAT_GATE: 'off', OPENER_GATE: 'enforce' } }), openerMode({ config: { OPENER_GATE: 'off' } })]).toEqual(['shadow', 'enforce', 'shadow', 'off', 'off']);
    expect(gateMode({ config: { REPEAT_GATE: 'enforce', UNITS_GATE: 'off' } }, 'G6')).toBe('off');
  });
});

describe('on the publish paths', () => {
  it('in shadow, every post goes out as written and each gate logs what it would refuse', async () => {
    const { w, post } = await world({ REPEAT_GATE: 'shadow' });
    try {
      await seedSaid(w, 'act_h1', T0 - 2 * HOUR, POOL);
      await seedSaid(w, 'act_o1', T0 - 3 * HOUR, JESSE, OTHER);
      // A repeat with the wrong unit, and a copy of another agent's post.
      expect((await post('6 holders here. Fee pool sits at $0.05 WETH.')).kind).toBe('completed');
      expect((await post(`${JESSE}.`)).kind).toBe('completed');
      expect(w.sender.published.map((p) => (p as { text: string }).text)).toEqual(['6 holders here. Fee pool sits at $0.05 WETH.', `${JESSE}.`]);
      expect((await shadowRows(w)).map((r) => [r.gate, r.code, r.actionId, r.enforced, r.detail.kind])).toEqual([
        ['G1', 'repeat_fact', 'act-gate-00001', false, 'original'],
        ['G4', 'similar_post', 'act-gate-00002', false, 'original'],
        ['G6', 'unit_on_token_amount', 'act-gate-00001', false, 'original'],
      ]);
      // No gate bought a thought.
      expect(w.inference.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('enforced, a repeat is refused with the rule and nothing is sent; the same post with what is new goes out', async () => {
    const { w, post } = await world({ REPEAT_GATE: 'enforce', OPENER_GATE: 'enforce' });
    try {
      await seedSaid(w, 'act_h1', T0 - 2 * HOUR, HOLDERS);
      expect(await post('Still 112 holders, the floor stops proving.')).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^repeat_fact: every figure in this post is one you already posted.*112 \(holders\) on 2026-10-24.*Nothing was posted\.$/) });
      expect(await post('118 holders. The floor is still there.')).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^repeat_opener: /) });
      expect(w.sender.published).toHaveLength(0);
      expect((await post('The floor moved: 118 holders this morning.')).kind).toBe('completed');
      expect(w.sender.published).toHaveLength(1);
      expect((await shadowRows(w)).map((r) => [r.gate, r.code, r.enforced])).toEqual([['G1', 'repeat_fact', true], ['G1', 'repeat_opener', true]]);
    } finally {
      await w.close();
    }
  });

  it('a reply is asked by the units gate alone: it may give a figure the agent already posted, and the words another agent used', async () => {
    const { w, reply } = await world({ REPEAT_GATE: 'enforce', UNITS_GATE: 'enforce', CROSS_AGENT_GATE: 'enforce' });
    try {
      await seedSaid(w, 'act_h1', T0 - 2 * HOUR, HOLDERS);
      await seedSaid(w, 'act_o1', T0 - 3 * HOUR, JESSE, OTHER);
      expect(gated(await reply('501', '112 holders right now, the same as this morning.'))).toBe(false);
      // A figure given in a reply does not use it up for a later original either: replies are not in the history.
      await seedSaid(w, 'act_r1', T0 - HOUR, 'There are 3 trades today.', AGENT_ID, 'publish_reply');
      expect(await postGateRefusal(w.ctx, { agentId: AGENT_ID, config: {} }, { actionId: 'act_x', parts: ['3 trades today, all small.'], kind: 'original' })).toBeNull();
      expect(await reply('502', 'The pool holds $0.05 WETH.')).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^unit_on_token_amount: /) });
      // The cross-agent gate does not read replies: two coins asked the same thing answer with the same facts.
      expect(gated(await reply('503', `${JESSE}!`))).toBe(false);
      expect(await postGateRefusal(w.ctx, { agentId: AGENT_ID, config: {} }, { actionId: 'act_r', parts: [`${JESSE}!`], kind: 'reply' })).toBeNull();
      expect(await postGateRefusal(w.ctx, { agentId: AGENT_ID, config: {} }, { actionId: 'act_o', parts: [`${JESSE}!`], kind: 'original' })).toMatch(/^similar_post: /);
      expect((await shadowRows(w)).map((r) => [r.gate, r.detail.kind])).toEqual([['G4', 'original'], ['G6', 'reply']]);
      // ...and a reply another agent made is not something an original can be "similar" to.
      await seedSaid(w, 'act_o2', T0 - HOUR, GREEN_LIGHT, OTHER, 'publish_reply');
      expect(await postGateRefusal(w.ctx, { agentId: AGENT_ID, config: {} }, { actionId: 'act_o3', parts: [GREEN_LIGHT], kind: 'original' })).toBeNull();
    } finally {
      await w.close();
    }
  });

  it("the platform account's numbers post and its digest are left alone by the repeat gate, its other posts are not", async () => {
    const { w, post } = await world({ REPEAT_GATE: 'enforce' }, { platform: true, requireApproval: false });
    try {
      const numbers = 'bootr numbers: 13 coins live, 3 agents awake.';
      await seedSaid(w, 'act_h1', T0 - DAY, numbers);
      await storeTurn(w, { numbersDay: '2026-10-24' });
      expect((await post('bootr numbers: 13 coins live, 3 agents awake.')).kind).not.toBe('failed');
      await storeTurn(w, { digestWeek: '2026-W43' });
      expect((await post('this week on bootr: 13 coins live, 3 agents awake.')).kind).not.toBe('failed');
      await storeTurn(w, {});
      expect(await post('still 13 coins live and 3 agents awake.')).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^repeat_fact: /) });
    } finally {
      await w.close();
    }
  });

  it('the review queue asks the gates before the creator sees the post', async () => {
    const { w, agent } = await world({ UNITS_GATE: 'enforce' }, { requireApproval: true });
    try {
      const queue = (id: string, text: string) => queueForApproval(w.ctx, agent, pendingOf(id, 'publish_post', { text }), brokerEnv());
      expect(await queue('act-queue-00001', 'Fee pool sits at $0.0475 WETH.')).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^unit_on_token_amount: /) });
      expect((await queue('act-queue-00002', 'Fee pool sits at 0.0475 WETH.')).kind).toBe('completed');
      expect((await shadowRows(w)).map((r) => [r.gate, r.actionId, r.enforced])).toEqual([['G6', 'act-queue-00001', true]]);
    } finally {
      await w.close();
    }
  });

  it('a scheduled post is asked when it is scheduled, and again at its send against what was said since', async () => {
    const { w } = await world({ REPEAT_GATE: 'enforce' });
    try {
      fakeSend(w);
      await seedSaid(w, 'act_h1', T0 - 2 * HOUR, HOLDERS);
      const refused = await callTool(w, 'schedule_post', { text: 'Still 112 holders, the floor stops proving.', sendAt: new Date(T0 + 3 * HOUR).toISOString() });
      expect(errorOf(refused)).toMatch(/^repeat_fact: .*Nothing was scheduled\.$/);
      // A new figure is scheduled; before its time the agent posts the same figure, so at the send it is a repeat.
      const id = await schedule(w, 'The count is 118 holders this morning.', T0 + 3 * HOUR);
      await seedSaid(w, 'act_h2', T0 + HOUR, 'Up to 118 holders since noon.');
      w.setNow(T0 + 3 * HOUR + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 1 });
      expect(await rowOf(w, id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/^repeat_fact: /) });
      expect((await w.db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)))[0]!.postId).toBeNull();
      expect((await shadowRows(w)).map((r) => [r.code, r.actionId === id, r.detail.scheduled ?? false])).toEqual([['repeat_fact', false, true], ['repeat_fact', true, false]]);
    } finally {
      await w.close();
    }
  });

  it('off checks nothing, and a gate whose read fails refuses nothing', async () => {
    const off = await world({ REPEAT_GATE: 'off', CROSS_AGENT_GATE: 'off', UNITS_GATE: 'off' });
    try {
      await seedSaid(off.w, 'act_h1', T0 - 2 * HOUR, POOL);
      expect((await off.post('6 holders here. Fee pool sits at $0.05 WETH.')).kind).toBe('completed');
      expect(await shadowRows(off.w)).toEqual([]);
    } finally {
      await off.w.close();
    }
    const { w } = await world({ REPEAT_GATE: 'enforce', CROSS_AGENT_GATE: 'enforce' });
    try {
      const broken = { ...w.ctx, db: { select: () => { throw new Error('the database is away'); }, insert: () => { throw new Error('the database is away'); } } } as unknown as typeof w.ctx;
      expect(await postGateRefusal(broken, { agentId: AGENT_ID, config: {} }, { actionId: 'act_x', parts: [`Still 112 holders. ${JESSE}.`], kind: 'original' })).toBeNull();
      // With the ledger switched off the two gates that read it find nothing; the units gate still does.
      const noLedger = { ...w.ctx, config: { ...w.ctx.config, SAID_KEEP_DAYS: 0, UNITS_GATE: 'enforce' as const } };
      await seedSaid(w, 'act_h1', T0 - 2 * HOUR, HOLDERS);
      expect(await postGateRefusal(noLedger, { agentId: AGENT_ID, config: {} }, { actionId: 'act_y', parts: ['Still 112 holders.'], kind: 'original' })).toBeNull();
      expect(await postGateRefusal(noLedger, { agentId: AGENT_ID, config: {} }, { actionId: 'act_z', parts: ['Fee pool: $0.05 WETH.'], kind: 'original' })).toMatch(/^unit_on_token_amount/);
    } finally {
      await w.close();
    }
  });

  it('costs two reads of the ledger for an original, none for a reply or a post with nothing to compare, and never a thought', async () => {
    const { w } = await world();
    try {
      await seedSaid(w, 'act_h1', T0 - 2 * HOUR, HOLDERS);
      let reads = 0;
      const counting = { ...w.ctx, db: new Proxy(w.ctx.db, { get: (db, key) => { if (key === 'select' || key === 'query') reads += 1; const v = Reflect.get(db, key) as unknown; return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(db) : v; } }) } as typeof w.ctx;
      const ask = async (parts: string[], kind: 'original' | 'reply', ofTurn = false) => {
        reads = 0;
        await postGateRefusal(counting, { agentId: AGENT_ID, config: { platform: true } }, { actionId: 'act_cost', parts, kind, ofTurn });
        return reads;
      };
      // A long original with a new figure: its own last originals, and what the others said. The platform's turn is not read for a post that passes.
      expect(await ask([`118 holders this morning, and the pool took its first trades since the weekend from three new wallets.`], 'original', true)).toBe(2);
      expect(await ask([`118 holders this morning, and the pool took its first trades since the weekend from three new wallets.`], 'reply')).toBe(0);
      expect(await ask(['gm frens'], 'original', true)).toBe(0);
      // Found as a repeat: the platform's turn is read to see whether it is the numbers post (one read more), and the row is written.
      expect(await ask(['Still 112 holders.'], 'original', true)).toBe(2);
      expect(w.inference.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('the fee-claim gate writes to the shadow log too, refused or not', async () => {
    const ROW = { source: 'bootr', lpFeeBps: 10_000, protocolBps: 1000, agentBps: 450, creatorBps: 5850, burnBps: 0, platformBps: 2700 };
    for (const [mode, refused] of [['enforce', true], ['shadow', false]] as const) {
      const { w, post } = await world({ FEE_CLAIM_GATE: mode });
      try {
        w.ctx.indexer.market = async () => ROW as never;
        const out = await post('Six holders here already collect from the fee engine.');
        expect(out.kind === 'failed', mode).toBe(refused);
        expect((await shadowRows(w)).map((r) => [r.gate, r.code, r.actionId, r.enforced, r.detail.kind])).toEqual([['G3', 'fee_claim_false', 'act-gate-00001', refused, 'holders']]);
      } finally {
        await w.close();
      }
    }
  });
});
