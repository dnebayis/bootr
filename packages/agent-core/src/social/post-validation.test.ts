import { describe, expect, it } from 'vitest';
import { PolicyError } from '../errors.js';
import { countCashtags, platformPostRisk, postValidation, validatePost } from './post-validation.js';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyError) return error.code;
    throw error;
  }
  return null;
};

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
