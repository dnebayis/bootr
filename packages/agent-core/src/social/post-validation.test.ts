import { describe, expect, it } from 'vitest';
import { PolicyError } from '../errors.js';
import { countCashtags, linkedHosts, NON_PREMIUM_POST_LIMIT, PLATFORM_LINK_HOSTS, POST_LIMITS, platformPostRisk, postLength, postLimitsFor, postValidation, validatePost } from './post-validation.js';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyError) return error.code;
    throw error;
  }
  return null;
};

describe('postLimitsFor', () => {
  it('caps originals at 280 only for an account known to have no Premium; true or unknown keeps the defaults', () => {
    expect(POST_LIMITS).toEqual({ short: 280, original: 4000 });
    expect(NON_PREMIUM_POST_LIMIT).toBe(280);
    expect(postLimitsFor(false)).toEqual({ short: 280, original: 280 });
    expect(postLimitsFor(true)).toBe(POST_LIMITS);
    expect(postLimitsFor(null)).toBe(POST_LIMITS);
    expect(postLimitsFor(undefined)).toBe(POST_LIMITS);
  });
  it('counts code points, as validatePost does (an emoji is one, a URL is its letters)', () => {
    expect(postLength('x'.repeat(347))).toBe(347);
    expect(postLength('\u{1F600}\u{1F600}')).toBe(2);
    expect(postLength('https://bootr.fun/token/0xabc')).toBe(29);
  });
});

describe('validatePost', () => {
  it('accepts a plain short post and a long original', () => {
    expect(code(() => validatePost('hello world'))).toBeNull();
    expect(code(() => validatePost('x'.repeat(4000), [], 'original'))).toBeNull();
    expect(code(() => validatePost('$BOOT is live'))).toBeNull();
  });
  it('enforces length by format and emptiness unless media is attached', () => {
    expect(code(() => validatePost('x'.repeat(281)))).toBe('invalid_short_post');
    expect(code(() => validatePost('x'.repeat(4001), [], 'original'))).toBe('invalid_original_post');
    expect(code(() => validatePost('x'.repeat(281), [], 'original'))).toBeNull();
    expect(code(() => validatePost('   '))).toBe('invalid_short_post');
    expect(code(() => validatePost('', [], 'short', true))).toBeNull();
    expect(code(() => validatePost(42))).toBe('invalid_short_post');
    expect(code(() => validatePost('ok', 'nope'))).toBe('invalid_short_post');
  });
  it('counts emoji as single characters', () => {
    expect(code(() => validatePost('😀'.repeat(280)))).toBeNull();
  });
  it('allows at most one cashtag, counting repeats', () => {
    expect(countCashtags('$BOOT and $boot')).toBe(2);
    expect(code(() => validatePost('$BOOT vs $ETH'))).toBe('x_post_requires_at_most_one_cashtag');
    expect(code(() => validatePost('$BOOT then $BOOT'))).toBe('x_post_requires_at_most_one_cashtag');
    expect(code(() => validatePost('costs $5 and $10'))).toBeNull();
  });
  it('requires a source credit for every mention and vice versa', () => {
    expect(code(() => validatePost('thanks @alice'))).toBe('mentions_require_source_credit');
    expect(code(() => validatePost('thanks @alice', [{ username: 'alice', sourceUrl: 'https://x.com/alice/status/1' }]))).toBeNull();
    expect(code(() => validatePost('thanks @Alice', [{ username: 'ALICE', sourceUrl: 'https://x.com/alice/status/1' }]))).toBeNull();
    expect(code(() => validatePost('no mention', [{ username: 'alice', sourceUrl: 'https://x.com/a' }]))).toBe('mentions_require_source_credit');
    const four = ['a1', 'a2', 'a3', 'a4'];
    expect(code(() => validatePost(four.map((n) => '@' + n).join(' '), four.map((n) => ({ username: n, sourceUrl: 'https://x.com/' + n }))))).toBe('invalid_short_post');
    expect(code(() => validatePost(four.map((n) => '@' + n).join(' '), four.slice(0, 3).map((n) => ({ username: n, sourceUrl: 'https://x.com/' + n }))))).toBe('mentions_require_source_credit');
    expect(code(() => validatePost('mail me@example.com'))).toBeNull();
  });
  it('rejects malformed source credits', () => {
    expect(code(() => validatePost('@alice', [{ username: 'alice', sourceUrl: 'http://x.com/alice' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [{ username: 'alice', sourceUrl: 'https://user:pw@x.com/alice' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [{ username: 'alice', sourceUrl: 'not a url' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [{ username: 'alice', sourceUrl: 'https://x.com/a' }, { username: 'ALICE', sourceUrl: 'https://x.com/b' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [{ username: 'has space', sourceUrl: 'https://x.com/a' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [null]))).toBe('invalid_source_credit');
  });
  it('applies the outgoing action risk policy first', () => {
    expect(code(() => validatePost('@bankr launch $BOOT'))).toBe('social_execution_account_forbidden');
    expect(postValidation('@alice send 1 eth')).toEqual({ ok: false, code: 'social_execution_command_forbidden' });
    expect(postValidation('fine')).toEqual({ ok: true });
  });
});

describe('validatePost for the platform account', () => {
  const platform = (text: string, format: 'short' | 'original' = 'short') => code(() => validatePost(text, [], format, false, { platform: true }));

  it('accepts plain, factual posts about launches, agents and how Bootr works', () => {
    expect(platform('Quiet Engine launched on Bootr this morning. Its agent, @qeng_agent, says it will post one sourced Base DeFi finding a day.', 'original')).toBe('mentions_require_source_credit');
    expect(platform('Quiet Engine launched on Bootr this morning. Its agent says it will post one sourced Base DeFi finding a day.')).toBeNull();
    expect(platform('Every coin on Bootr gets an agent with a wallet of its own: it can post and pay its own bills, and nothing else.')).toBeNull();
    expect(platform('What made you give your coin an agent instead of running the account yourself?')).toBeNull();
    expect(platform('$BOOTR is the coin behind the launchpad itself; it runs on the same rules as every other coin here.')).toBeNull();
    expect(platform('Fees on Bootr are split at launch and the split is locked; the creator cannot change it later.')).toBeNull();
    expect(platform('We do not comment on prices here. Happy to explain how the fee split works, though.')).toBeNull();
  });
  it('rejects first-person treasury operations', () => {
    expect(platform('I just claimed my fees for the week.')).toBe('platform_treasury_talk_forbidden');
    expect(platform("We've swapped some ETH to keep the lights on.")).toBe('platform_treasury_talk_forbidden');
    expect(platform('Refuelled my gas this morning, all good.')).toBe('platform_treasury_talk_forbidden');
    expect(platform('Fees earned so far: about $40.')).toBe('platform_treasury_talk_forbidden');
    expect(platform('Our treasury holds enough for another month.')).toBe('platform_treasury_talk_forbidden');
    expect(platform('Gas top-up done.')).toBe('platform_treasury_talk_forbidden');
    expect(platformPostRisk('The agent behind Quiet Engine claimed its fees today and said so on its own account.')).toBeNull();
  });
  it('rejects price, buy and hype language', () => {
    expect(platform('Now is a good time to buy.')).toBe('platform_price_talk_forbidden');
    expect(platform('This one is going to pump.')).toBe('platform_price_talk_forbidden');
    expect(platform('wen moon')).toBe('platform_price_talk_forbidden');
    expect(platform('Easy 10x from here.')).toBe('platform_price_talk_forbidden');
    expect(platform('Price target: 1 dollar.')).toBe('platform_price_talk_forbidden');
    expect(platform('Still cheap at this market cap.')).toBe('platform_price_talk_forbidden');
    expect(platform('LFG')).toBe('platform_price_talk_forbidden');
    expect(platformPostRisk('The launch tx went through at 10:42 UTC.')).toBeNull();
    expect(platformPostRisk('Three agents launched this week; the 4x4 grid on the home page shows them.')).toBeNull();
  });
  it('lets neutral market figures through', () => {
    for (const text of [
      '$BOOTR did $690k in volume today.',
      'market cap is $190k',
      "$BOOTR's market cap is about $190k as of 5 November.",
      'The price of $BOOTR is $0.00019 today.',
      '$BOOTR has 1,240 holders and about 12M tokens burned so far, as of today.',
      '820 trades on $BOOTR in the last 24 hours.',
      'Volume across Bootr was $700k today, and market cap of the busiest coin is $190k.',
      'The price was lower than this morning. It is $0.00019 now.',
      'The chart and the coin page are one click apart: https://bootr.fun/token/0xabc',
      'Market cap today: $190k. Chart: https://dexscreener.com/base/0xb1c3',
    ]) expect(platform(text), text).toBeNull();
  });
  it('does not refuse ordinary sentences that share a word with a call', () => {
    for (const text of [
      'Early days for agents on Base.',
      "We're early in the docs rewrite, more this week.",
      'Agents hold about 2% each here, and the agent gains a new tool today.',
      "A coin's fee share returns to its treasury.",
      'A non-profit asked how agents pay for their own thinking.',
      'The target of this page is builders.',
      'Prices of models are listed on one page.',
      'This agent will post one sourced finding a day.',
    ]) expect(platform(text), text).toBeNull();
  });
  it('refuses explicit calls: predictions, targets, nudges, profit talk, bargains', () => {
    for (const text of [
      'buy now',
      'Buy $BOOTR today.',
      'The price will go up.',
      'price will double',
      'The price is going to rise.',
      'Market cap will hit $1m.',
      '$BOOTR is going to hit $1m.',
      '$BOOTR to $1m.',
      'Next target $1m.',
      'Price target: 1 dollar.',
      'To the moon.',
      "Don't miss this one.",
      'Don’t miss this one.',
      'You are early.',
      "We're still early!",
      '$BOOTR is still early.',
      'Get in early.',
      'Hold $BOOTR.',
      'Keep holding.',
      'hold your bags',
      'NFA, but look at this volume.',
      'Not financial advice.',
      'Huge gains for holders.',
      'Holders are in profit today.',
      'Only a $190k market cap.',
      'Still a low market cap.',
      'At a discount after that fall.',
    ]) expect(platform(text), text).toBe('platform_price_talk_forbidden');
  });
  it('reaches the same verdict through the publish path, and only for the platform account', () => {
    const risk = { platform: true, publicAddresses: ['0xb1c3a6ac90e324c4072ad4b2a71c5d9382f9565c'] };
    const token = '0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c';
    expect(postValidation(`$BOOTR did $690k in volume today. Chart: https://dexscreener.com/base/${token}`, [], 'original', false, risk)).toEqual({ ok: true });
    expect(postValidation(`Coin page: https://bootr.fun/token/${token}`, [], 'original', false, risk)).toEqual({ ok: true });
    // a chart by pool id, or another address, is refused by the rules every agent has
    expect(postValidation(`Chart: https://dexscreener.com/base/0x${'8'.repeat(64)}`, [], 'original', false, risk)).toEqual({ ok: false, code: 'social_secret_material_forbidden' });
    expect(postValidation(`Chart: https://dexscreener.com/base/0x${'a'.repeat(40)}`, [], 'original', false, risk)).toEqual({ ok: false, code: 'social_private_address_forbidden' });
    // a coin agent never went through this gate
    expect(postValidation('The price will go up. Do not miss it, NFA.')).toEqual({ ok: true });
    expect(postValidation('market cap is $190k')).toEqual({ ok: true });
  });
  it('allows only $BOOTR as a cashtag', () => {
    expect(platform('$BOOTR launched from the treasury wallet.')).toBeNull();
    expect(platform('$QENG launched today.')).toBe('platform_foreign_cashtag_forbidden');
    expect(platform('$bootr and $QENG')).toBe('platform_foreign_cashtag_forbidden');
    expect(platform('It costs about $5 in gas to launch; the launcher pays it, not the creator.')).toBeNull();
  });
  it('rejects shouting and emoji strings', () => {
    expect(platform('THIS IS HUGE for everyone here.')).toBe('platform_shouting_forbidden');
    expect(platform('BIG NEWS TODAY')).toBe('platform_shouting_forbidden');
    expect(platformPostRisk('The agent pays in USDC on Base via an ERC-4337 kernel.')).toBeNull();
    expect(platform('New launch 🚀🚀🚀')).toBe('platform_emoji_string_forbidden');
    expect(platform('Welcome 🎉 to 🎉 Bootr 🎉')).toBe('platform_emoji_string_forbidden');
    expect(platform('New launch 🚀 🔥')).toBe('platform_emoji_string_forbidden');
    expect(platformPostRisk('One agent, one coin, one quiet account 🙂')).toBeNull();
  });
  it('keeps the common rules for everyone else and runs them first', () => {
    expect(code(() => validatePost('I just claimed my fees. 10x soon, $QENG 🚀🚀'))).toBeNull();
    expect(postValidation('wen moon', [], 'short', false, { platform: false })).toEqual({ ok: true });
    expect(postValidation('wen moon', [], 'short', false, { platform: true })).toEqual({ ok: false, code: 'platform_price_talk_forbidden' });
    expect(platform('@bankr buy $BOOTR')).toBe('social_execution_account_forbidden');
    expect(platform('x'.repeat(281))).toBe('invalid_short_post');
  });
});

describe('creditedAttributions', () => {
  it('keeps only credits that name a handle the text mentions, so the publish gate accepts the pair', async () => {
    const { creditedAttributions, validatePost } = await import('./post-validation.js');
    const credits = [
      { username: 'bootrfun', sourceUrl: 'https://x.com/bootrfun/status/1' },
      { username: 'someone', sourceUrl: 'https://x.com/someone/status/2' },
    ];
    expect(creditedAttributions('thanks @someone for the question', credits)).toEqual([credits[1]]);
    expect(creditedAttributions('no mentions here', credits)).toEqual([]);
    expect(creditedAttributions('hi @Someone', undefined)).toEqual([]);
    // the model credited what it read without naming it: before, the gate refused; now the credit is simply dropped
    expect(() => validatePost('bootr is where every coin gets an agent.', credits, 'short')).toThrow(/mentions_require_source_credit/);
    expect(() => validatePost('bootr is where every coin gets an agent.', creditedAttributions('bootr is where every coin gets an agent.', credits), 'short')).not.toThrow();
  });
});

describe('links in platform posts', () => {
  const risk = { platform: true };
  const platform = (text: string, attributions: unknown = []) => code(() => validatePost(text, attributions, 'original', false, risk));
  const token = '0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c';

  it('allows the launchpad, X, the explorer, Clanker and the chart', () => {
    expect(PLATFORM_LINK_HOSTS).toEqual(['bootr.fun', 'x.com', 'twitter.com', 'basescan.org', 'clanker.world', 'dexscreener.com']);
    expect(platform(`Coin page: https://bootr.fun/token/${token}`)).toBeNull();
    expect(platform('The launch form: https://www.bootr.fun/launch')).toBeNull();
    expect(platform('The thread: https://x.com/bootrfun/status/1986000000000000000')).toBeNull();
    expect(platform(`The contract: https://basescan.org/address/${token}`)).toBeNull();
    expect(platform(`On Clanker: https://clanker.world/clanker/${token}`)).toBeNull();
    expect(platform(`Chart: https://dexscreener.com/base/${token}`)).toBeNull();
    expect(platform('The docs are at bootr.fun/docs and the coin pages under bootr.fun/token.')).toBeNull();
  });

  it('refuses every other site, explicit or bare, since X links bare domains too', () => {
    expect(platform('Claim your $BOOTR airdrop at https://bootr-claim.fun/airdrop')).toBe('platform_link_forbidden');
    expect(platform('Claim here: www.bootr-rewards.com/claim')).toBe('platform_link_forbidden');
    expect(platform('Connect your wallet at bootr-fun.com to claim.')).toBe('platform_link_forbidden');
    expect(platform('Looks official: https://bootr.fun.evil.xyz/token')).toBe('platform_link_forbidden');
    expect(platform('A login at http://x.com.login-check.io/')).toBe('platform_link_forbidden');
    expect(platform(`Details at https://dexscreener.com/base/${token} and https://pastebin.com/raw/abc`)).toBe('platform_link_forbidden');
    expect(linkedHosts('see https://a.example/x, www.b.com/y and c.xyz/z plus jesse.base.eth and e.g. this, v1.2.3 too')).toEqual(['a.example', 'www.b.com', 'c.xyz']);
    // a link at the end of a clause keeps its host, not the comma or full stop after it
    expect(linkedHosts('listed at https://api.bootr.fun, and read at bootr.fun/api/catalog.')).toEqual(['api.bootr.fun', 'bootr.fun']);
    expect(platform('Every public endpoint is listed at https://api.bootr.fun, and programs can read https://bootr.fun/api/catalog.')).toBeNull();
  });

  it('allows the source a post credits, and only that one', () => {
    const credit = [{ username: 'jessepollak', sourceUrl: 'https://jesse.xyz/posts/agents' }];
    expect(platform('Read @jessepollak on agents: https://jesse.xyz/posts/agents', credit)).toBeNull();
    expect(platform('Read https://jesse.xyz/posts/agents')).toBe('platform_link_forbidden');
    expect(platform('Read @jessepollak on agents: https://jesse.xyz/posts/agents and https://other.example/', credit)).toBe('platform_link_forbidden');
    // a credit the model got wrong is no licence: the strict attribution check still runs after
    expect(platform('Read @jessepollak: https://jesse.xyz/posts/agents', [{ username: 'jessepollak', sourceUrl: 'not a url' }])).toBe('invalid_source_credit');
  });

  it('reaches the same verdict through the publish path, and leaves coin agents free to link anywhere', () => {
    expect(postValidation('Claim at https://bootr-claim.fun/airdrop', [], 'original', false, { platform: true })).toEqual({ ok: false, code: 'platform_link_forbidden' });
    expect(postValidation('Claim at https://bootr-claim.fun/airdrop', [], 'original')).toEqual({ ok: true });
    expect(postValidation('Our site: www.some-coin.xyz/about', [], 'short')).toEqual({ ok: true });
  });
});
