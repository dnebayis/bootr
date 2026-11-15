/**
 * The publish gate narrowed to what each rule exists for (2026-11-15). Every "passes" case below is a post the
 * platform account had refused in the week of 8 to 14 November 2026 (docs/dev/behaviour-check.md section 6), cut
 * where the owner's read cut it; every "still refused" case is a hostile variant the narrowed rule must keep: look-alike
 * letters, zero-width characters, a command wrapped in a report or a quote, a thread part, a reply.
 */
import { describe, expect, it } from 'vitest';
import { postFinding, type PostValidationContext } from './post-validation.js';
import { threadRefusal } from './thread.js';

const PLATFORM: PostValidationContext = { platform: true };
const codeOf = (text: string, context: PostValidationContext = PLATFORM, attributions: unknown = []) => postFinding(text, attributions, 'original', false, context)?.code ?? null;
/** A zero-width space, a word joiner and a soft hyphen: invisible, and gone before any rule reads the text. */
const ZW = '​';
const WJ = '⁠';
const SHY = '­';

describe('platform_price_talk_forbidden: "buy" and "sell" are ordinary words', () => {
  it('lets the measured honest posts through', () => {
    for (const text of [
      'UCL published a paper in June on "agent-to-agent finance" — agents that discover counterparties, buy services, and settle payments autonomously…',
      "Small design detail in Clanker v5 worth noticing: creators earn in ETH or USDC, never in their own coin. That one choice removes a whole conflict of interest — no creator being subtly pressured to sell what they're supposed to be…",
      "…It earns from its own coin's trades — a slice of every buy and sell goes straight to i…",
      "Jesse Pollak says agents can now buy search in USDC on Base. What I like is the receipt: every query is a small payment from the agent's own wallet…",
      "Question for builders on Base: If your agent had its own wallet, what's the first thing it should refuse to pay for? … It should buy only for a need of its ow…",
      // and the plain verb in other honest shapes
      'Agents bought 6,000 searches on Base this week.',
      'Sell-side research is catching up with agents.',
      'Buy and sell orders on Base settle in about a second.',
      'An agent can buy tokens through the swap tool, within the limits its creator set.',
      'Agents buy more compute when a job needs it.',
      'In short: buy services, not tokens.',
      '"Buy" is the word people use most in our mentions.',
      'Bootr does not sell your data.',
      'Tickets sold out in an hour.',
    ]) expect(codeOf(text), text).toBeNull();
  });

  it('still refuses a call: a coin as the object, urgency, a nudge, an order opening a sentence', () => {
    for (const text of [
      'buy $BOOTR',
      'Buy the dip.',
      'Time to sell.',
      'sell your bags',
      'buy now',
      'buy more',
      'Now is a good time to buy.',
      'You should buy bootr before the weekend.',
      "Don't sell.",
      'Keep buying, it is early.',
      'Buy. Then thank me later.',
      'Sell before the news.',
      'Load up on $BOOTR.',
      'I would buy 1,000 $BOOTR here.',
      // obfuscated: zero-width characters, a soft hyphen, look-alike letters (Greek upsilon, Cyrillic a, e, o)
      `b${ZW}uy $BOOTR`,
      `bu${WJ}y n${SHY}ow`,
      'bυy $BOOTR',
      'time to sеll',
      'Buy thе dip.',
      'ＢＵＹ ＮＯＷ',
      // wrapped in a report or a quote
      'A holder told me: "buy $BOOTR before it is too late." I disagree.',
      "Report: analysts say you should buy bootr this week.",
      // the other words of the rule stand as they were
      'This one is going to pump.',
      'Easy 10x from here.',
      '$BOOTR is still early.',
      'NFA, but look at this volume.',
    ]) expect(codeOf(text), text).toBe('platform_price_talk_forbidden');
  });

  it('reaches every part of a thread and a reply', () => {
    expect(threadRefusal(['Agents buy services on Base now.', 'And you should buy $BOOTR too.'], [], PLATFORM)).toMatch(/^platform_price_talk_forbidden: part 2 .*"you should buy"/);
    expect(postFinding('buy the dip', [], 'short', false, { platform: true, reply: true })?.code).toBe('platform_price_talk_forbidden');
  });
});

describe('platform_treasury_talk_forbidden: a first-person sentence that mentions a fee', () => {
  it('lets the measured honest posts through', () => {
    for (const text of [
      'One thing I wanted people to understand about Bootr: the fee split a creator sets at launch is locked in the contract — no one can change it after the fact…',
      "Something I like about how Bootr is built: a coin's fee split is set at launch and then locked. Nobody, me included, can change it later…",
      "Bankr's guide to running an index from a script has a detail I like: the fee you set at creation can never be changed…",
      '@brian_armstrong says Base lending markets now hold $7.49B supplied and $2.65B borrowed, and calls it "beloved by agents." My take: an agent with its own wallet needs somewhere to pay, earn and settle…',
      // a third party that earns, and the fee as how Bootr works
      'Creators earn in ETH or USDC, never in their own coin.',
      'I think the fee split is the most important number on a coin page.',
      'We explain the fee split on every coin page: 50% creator, 30% platform, 15% burn, 5% agent.',
      'Creators keep the fees earned on their coin; nobody can redirect them.',
    ]) expect(postFinding(text, text.startsWith('@brian_armstrong') ? [{ username: 'brian_armstrong', sourceUrl: 'https://x.com/brian_armstrong/status/1' }] : [], 'original', false, PLATFORM)?.code ?? null, text).toBeNull();
  });

  it("still refuses the agent's own treasury operations", () => {
    for (const text of [
      'I just claimed my fees for the week.',
      "We've swapped some ETH to keep the lights on.",
      'Refuelled my gas this morning, all good.',
      'Fees earned so far: about $40.',
      'Our treasury holds enough for another month.',
      'Gas top-up done.',
      'I have finally collected 0.3 ETH.',
      "I'm topping up tonight.",
      'We will withdraw on Friday.',
      'my balance is 2 ETH',
      'I paid the gas myself this time.',
      'We spent 1.10 USDC of fuel on that post.',
      // obfuscated
      `I ju${ZW}st cla${ZW}imed`,
      'I clаimed my share today.',
      'οur treasury is full',
      // wrapped in a report or a quote
      'Asked what changed, the answer is simple: "we swapped half to USDC."',
      'Update. Fees claimed today: $12.',
    ]) expect(codeOf(text), text).toBe('platform_treasury_talk_forbidden');
  });

  it('reaches every part of a thread', () => {
    expect(threadRefusal(['How the fee split works on Bootr.', 'I claimed mine this morning.'], [], PLATFORM)).toMatch(/^platform_treasury_talk_forbidden: part 2 .*"i claimed"/);
  });
});
