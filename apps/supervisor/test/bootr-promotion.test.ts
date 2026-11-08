import { describe, expect, it, vi } from 'vitest';
import { validatePost } from '@bootr/agent-core';
import { workerTemplateById } from '@bootr/shared/workers';
import { actions } from '../src/db/schema.js';
import { BOOTR_OFFICIAL_HANDLE, publishAttributions } from '../src/attributions.js';
import { bootrPromotionSection, bootrPromotionView, PROMOTION_SPACING, recentOriginalPosts } from '../src/bootr-promotion.js';
import { coinPromotionLine, defaultIdentity } from '../src/onboarding.js';
import { AGENT_ID, agentConfig, makeWorld, seedAgent } from './helpers.js';

vi.mock('../src/agent-directory.js', () => ({ agentDirectory: async () => ({ byHandle: new Map() }) }));
vi.mock('../src/platform-feed.js', () => ({ cachedPlatformFeedData: async () => ({ launches: [] }) }));

const CARD_URI = 'https://bootr.fun/agents/7.json';
const TEMPLATE_LINES = workerTemplateById('community')!.preset.identity;

describe('the promotion rule in a coin agent\'s persona', () => {
  it('tells a coin agent it runs on Bootr, what that means for its coin, the limits, and invites builders; the platform agent gets its own persona instead', () => {
    const coin = defaultIdentity('Test Coin', 'TEST', CARD_URI, false, TEMPLATE_LINES);
    expect(coin).toContain(coinPromotionLine('TEST'));
    expect(coin).toMatch(/You run on Bootr \(bootr\.fun\)/);
    expect(coin).toMatch(/\$TEST has its own agent with its own wallet, its fee split was locked at launch and its own trades pay it, and the agent pays for its own thinking/);
    expect(coin).toMatch(/builders who want the same for a coin can launch it there/);
    expect(coin).toMatch(/At most one original post in six/);
    expect(coin).toMatch(/never in a reply to someone's unrelated question, never with a prediction or a buy call/);
    expect(coin).toMatch(/A fee figure only from coinFees, only about your own coin/);
    expect(coin).toMatch(/@bootrfun is Bootr's official account/);
    // Public copy: no internal names.
    expect(coin).not.toMatch(/x402|session key|kernel|spender|relay/i);
    // The platform persona promotes Bootr in its own words and never gets the coin line.
    const platform = defaultIdentity('Bootr', 'BOOTR', CARD_URI, true);
    expect(platform).not.toContain('You run on Bootr (bootr.fun)');
    expect(platform).not.toMatch(/At most one original post in six/);
    expect(platform).toMatch(/Promote it and Bootr proudly/);
  });

  it('a sample promotion post passes the publish gate, with @bootrfun credited by the supervisor', async () => {
    const plain = 'Quiet day for $TEST: 14 trades, nothing unusual in the pool. Small note: this account is run by the coin\'s own agent on Bootr (bootr.fun), with its own wallet and a fee split locked at launch; builders can launch a coin with an agent there too.';
    expect(() => validatePost(plain, [], 'original', false, {})).not.toThrow();
    const withHandle = `Quiet day for $TEST: 14 trades, nothing unusual in the pool. This account is the coin\'s own agent, running on Bootr (bootr.fun); the platform\'s account is @${BOOTR_OFFICIAL_HANDLE}.`;
    const ctx = { config: { SITE_URL: 'https://bootr.fun/' }, sender: { readAccount: vi.fn() }, now: () => 0, log: { warn: () => {} } } as never;
    const credited = await publishAttributions(ctx, AGENT_ID, withHandle, undefined);
    expect(credited).toEqual([{ username: 'bootrfun', sourceUrl: 'https://bootr.fun/' }]);
    expect(() => validatePost(withHandle, credited, 'original', false, {})).not.toThrow();
    // ...without the credit the gate refuses the mention, as designed...
    expect(() => validatePost(withHandle, [], 'original', false, {})).toThrow(/mentions_require_source_credit/);
    // ...and a handle next to "launch a coin" or next to fees reads as an instruction to an account, which is why the persona keeps them apart.
    expect(() => validatePost(`${plain} The platform\'s account is @${BOOTR_OFFICIAL_HANDLE}.`, credited, 'original', false, {})).toThrow(/social_execution_command_forbidden/);
  });
});

describe('bootrPromotion (the one-in-six count)', () => {
  it('frees the slot only when none of the last five original posts named Bootr', () => {
    expect(bootrPromotionView([])).toMatchObject({ slotFree: true, postsSinceLast: PROMOTION_SPACING });
    expect(bootrPromotionView(['a', 'b', 'c', 'd', 'e'])).toMatchObject({ slotFree: true, postsSinceLast: 5 });
    expect(bootrPromotionView(['a', 'b', 'runs on Bootr', 'd'])).toMatchObject({ slotFree: false, postsSinceLast: 2 });
    expect(bootrPromotionView(['Bootr today'])).toMatchObject({ slotFree: false, postsSinceLast: 0 });
    expect(bootrPromotionView(['Bootr today']).meaning).toMatch(/in your last original post: not again until 5 more went out/);
    // The sixth post back no longer counts; a word containing "bootr" (a handle) does not count as naming the platform.
    expect(bootrPromotionView(['a', 'b', 'c', 'd', 'e', 'Bootr long ago'])).toMatchObject({ slotFree: true });
    expect(bootrPromotionView(['hi @bootrfun'])).toMatchObject({ slotFree: true });
  });

  it('reads the agent\'s own sent original posts, newest first, and says nothing for the platform agent or without the power', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const now = w.ctx.now();
      const row = (i: number, text: string, tool = 'publish_post', status = 'completed') => ({ actionId: `p${i}`, agentId: AGENT_ID, cycleKey: `c${i}`, action: { tool, input: { text } }, status, attempts: 1, createdAt: new Date(now - i * 3_600_000), updatedAt: new Date(now - i * 3_600_000) });
      await w.db.insert(actions).values([row(1, 'one'), row(2, 'two'), row(3, 'this coin runs on Bootr'), row(4, 'four'), row(5, 'five'), row(6, 'six'), row(0, 'a reply naming Bootr', 'publish_reply'), row(7, 'Bootr, refused', 'publish_post', 'failed')] as never);
      expect(await recentOriginalPosts(w.ctx, AGENT_ID)).toEqual(['one', 'two', 'this coin runs on Bootr', 'four', 'five']);
      const config = agentConfig(now) as never;
      expect(await bootrPromotionSection(w.ctx, AGENT_ID, config)).toEqual({ bootrPromotion: expect.objectContaining({ slotFree: false, postsSinceLast: 2 }) });
      expect(await bootrPromotionSection(w.ctx, AGENT_ID, { ...(config as object), platform: true } as never)).toEqual({});
      expect(await bootrPromotionSection(w.ctx, AGENT_ID, { ...(config as object), capabilities: { ...(config as { capabilities: object }).capabilities, xPublish: false } } as never)).toEqual({});
      expect(await bootrPromotionSection(w.ctx, 'nobody', config)).toEqual({ bootrPromotion: expect.objectContaining({ slotFree: true }) });
    } finally {
      await w.close();
    }
  });
});
