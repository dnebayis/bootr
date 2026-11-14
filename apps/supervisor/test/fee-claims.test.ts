/**
 * False statements about where a coin's fees go are refused; true ones, denials, questions and price talk are not
 * (owner's decision of 2026-11-15). The false examples are the posts a coin agent really sent in November 2026.
 */
import { describe, expect, it } from 'vitest';
import { coinFeeSplit, type CoinFeeSplit } from '../src/coin-fees.js';
import { feeClaimProblem, feeClaimRefusal } from '../src/fee-claims.js';
import { executeAction } from '../src/broker/index.js';
import { agentConfigOf } from '../src/onboarding.js';
import { makeWorld, seedAgent } from './helpers.js';
import { HOUR, brokerEnv, pendingOf } from './posting-helpers.js';

/** A coin launched through RWAGMI: a 1% fee, a tenth of it to RWAGMI, the rest 65 / 30 / 5 to creator, platform and agent; no burn, nothing to holders. */
const ROW = { source: 'bootr', lpFeeBps: 10_000, protocolBps: 1000, agentBps: 450, creatorBps: 5850, burnBps: 0, platformBps: 2700 };
const split = coinFeeSplit(ROW)!;
const kind = (text: string, s: CoinFeeSplit | null = split) => feeClaimProblem(text, s)?.kind ?? null;

describe('feeClaimProblem', () => {
  it('reads the split the examples rest on', () => {
    expect(split).toMatchObject({ traderPaysPct: 1, launcherTakesPct: 0.1, recipientsPct: { creator: 65, platform: 30, agent: 5, burn: 0 }, ofEachTradePct: { creator: 0.585 } });
  });

  it('refuses fee money said to go to holders on a coin that pays holders nothing', () => {
    expect(kind('A fee structure that sends 58.5% of their trade straight into the holder pool as WETH.')).toBe('holders');
    expect(kind('Six holders here already collect from the fee engine.')).toBe('holders');
    expect(kind("On a $100 trade, that's $58.50 equity for the co-owners, instant.")).toBe('holders');
    expect(kind('Fees still settle to holders automatically.')).toBe('holders');
    expect(feeClaimProblem('Six holders here already collect from the fee engine.', split)?.message).toMatch(/^fee_claim_false: holders receive no share of this coin's fees\. Fee split \(locked at launch.*a trade pays 1%.*creator 65%.*Nothing was posted\.$/);
  });

  it('refuses a share of the trade above what a trade pays, and a share that is not the recipient\'s', () => {
    expect(kind('58.5% of every trade goes to the creator.')).toBe('of_trade');
    expect(kind('The creator gets 40% and the rest is split.')).toBe('share');
    expect(kind('15% goes to the burn on every trade.')).toBe('share');
    expect(feeClaimProblem('58.5% of every trade goes to the creator.', split)?.message).toMatch(/a trade on this coin pays 1%, not 58\.5%/);
  });

  it('lets true statements, denials, questions and plain numbers through', () => {
    for (const text of [
      '58.5% of the fee goes to the creator, 27% to the platform and 4.5% to the agent.',
      'A trade pays 1%. 0.585% of each trade goes to the creator.',
      'Of what reaches the recipients the creator gets 65%, the platform 30% and the agent 5%.',
      'Holders receive nothing from the fees: the split is creator, platform and agent.',
      'No fee goes to holders on this coin.',
      'Do holders earn fees here?',
      '112 holders today, three more than yesterday.',
      'Volume is up 12% on the day.',
    ])
      expect(kind(text), text).toBeNull();
  });

  it('does not touch price talk: that stays the creator\'s call', () => {
    for (const text of ['These new ones bailed at the first -9%.', 'Retest hit -18% now. Watch the next 48 hours.', 'Shallow entries that came in at $5.48 are already out.']) expect(kind(text), text).toBeNull();
  });

  it('says nothing without a split, and lets holders be paid on a coin with holder dividends', () => {
    expect(kind('Six holders here already collect from the fee engine.', null)).toBeNull();
    const dividends: CoinFeeSplit = { ...split, recipientsPct: { ...split.recipientsPct, holderDividends: 20 } };
    expect(kind('Holders earn dividends from every trade.', dividends)).toBeNull();
  });
});

describe('feeClaimRefusal', () => {
  it('refuses for a coin agent, only logs in shadow, and leaves the platform account alone', async () => {
    const text = 'Six holders here already collect from the fee engine.';
    for (const [mode, platform, refused] of [['enforce', false, true], ['shadow', false, false], ['off', false, false], ['enforce', true, false]] as const) {
      const w = await makeWorld({ config: { FEE_CLAIM_GATE: mode } });
      try {
        const agent = await seedAgent(w, platform ? { config: { platform: true } } : {});
        const out = await feeClaimRefusal({ ...w.ctx, indexer: { ...w.ctx.indexer, market: async () => ROW } } as never, agent, [text]);
        expect(out === null ? false : /^fee_claim_false/.test(out), `${mode} platform=${platform}`).toBe(refused);
        // a text with no percentage and no holder word costs no read and is never refused
        expect(await feeClaimRefusal({ ...w.ctx, indexer: { market: async () => { throw new Error('not read'); } } } as never, agent, ['gm, a quiet morning here.'])).toBeNull();
      } finally {
        await w.close();
      }
    }
  });
});

describe('the publish path of a coin agent', () => {
  it('refuses a post with a false fee claim before anything is sent, and sends the same thought said truly', async () => {
    const w = await makeWorld();
    try {
      w.ctx.indexer.market = async () => ROW as never;
      const agent = await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString() } });
      const config = agentConfigOf(agent)!;
      const post = (id: string, text: string) => executeAction(w.ctx, agent, config, pendingOf(id, 'publish_post', { text }), brokerEnv());
      const refused = await post('act-fee-claim-00001', 'Six holders here already collect from the fee engine.');
      expect(refused).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^fee_claim_false: holders receive no share/) });
      expect(w.sender.published).toHaveLength(0);
      expect((await post('act-fee-claim-00002', 'Six holders here. The fee of each trade goes to the creator, the platform and the agent.')).kind).toBe('completed');
      expect(w.sender.published).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});
