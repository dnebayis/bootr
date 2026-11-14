/**
 * The words code hands every coin agent, so the cross-agent gate (post-gates.ts, G4) can leave them out.
 *
 * Bootr writes some sentences for its agents: the fee split line of a coin (coin-fees.ts `feeSplitLine`), the brief
 * of the coin's own day and its dates and amounts written out (coin-today.ts), and the names of its own coin's labels
 * (your-coin.ts: "contract address", "cashtag"). Two coins with the same split that state it use the same words, because the words are Bootr's, and
 * the same holds for "112 holders, the same as when you last posted". A gate that compared those words would let the
 * first coin that said them make the second one's post "similar", and anybody could post them every two days to make
 * every other coin's plain statement of its own facts fail. So the gate compares what an agent wrote itself: a post's
 * words minus these, and minus every figure (the figures of a default split are the same on every coin too).
 *
 * The set is built once, from the functions themselves run on sample coins, so a sentence that changes there changes
 * here with it. Only sentences an agent repeats are in it, not the instructions that come with a section (its
 * `meaning`): those are a hundred everyday words ("post", "says", "price"), no agent posts them, and leaving them out
 * of every comparison would blind the gate to ordinary copying. What is left of a post after this is small for a post that only restates handed facts, and such a
 * post is then too short to be compared at all (`SIMILAR_MIN_WORDS`).
 */
import * as coinToday from './coin-today.js';
import { coinFeeSplit, feeSplitLine } from './coin-fees.js';
import { milestoneWords, type PlatformFeedData } from './platform-feed.js';
import { wordsOf } from './said.js';

/** Every string value in `value`, however deep, but for a section's `meaning`: that is an instruction to the model, not a sentence it repeats. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.entries(value).flatMap(([key, v]) => (key === 'meaning' ? [] : strings(v))) : [];
}

/** The sentences, from the code that writes them, each run on coins made up to show every branch of its wording. */
function handedTexts(): string[] {
  const out: string[] = [];
  const add = (make: () => unknown) => {
    try {
      out.push(...strings(make()));
    } catch {
      // A sample one of the functions no longer takes adds nothing; the words listed by hand below still stand.
    }
  };
  const shares = { agentBps: 500, creatorBps: 5000, burnBps: 1500, platformBps: 3000 };
  const v5 = { source: 'clanker-v5', ...shares, rewardsBps: 500, dividendBps: 500, buyTaxBps: 10_000, protocolBps: 2000, minDividendHolding: 1e24 };
  // The fee split line: through RWAGMI and through Clanker, with a burn and without one, and through Clanker v5 with one tax and with two, in ETH, in USDC and in another asset.
  for (const row of [
    { source: 'bootr', lpFeeBps: 10_000, protocolBps: 1000, ...shares },
    { source: 'clanker', lpFeeBps: 10_000, protocolBps: 2000, ...shares, burnBps: 0 },
    { ...v5, sellTaxBps: 10_000, pairedToken: null },
    { ...v5, sellTaxBps: 30_000, pairedToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    { ...v5, sellTaxBps: 30_000, pairedToken: '0x00000000000000000000000000000000000000aa' },
  ])
    add(() => {
      const split = coinFeeSplit(row);
      return split ? feeSplitLine(split) : null;
    });
  // The coin's own day: every sentence of the brief, with the count the same as, above and below the one at the last post.
  const now = Date.UTC(2026, 10, 14, 12);
  const token = '0x0000000000000000000000000000000000000001';
  const kernel = '0x0000000000000000000000000000000000000002';
  const market = { source: 'bootr', lpFeeBps: 10_000, protocolBps: 1000, ...shares, holders: 112, trades24h: 7, volume24hUsd: 4300, fees24hUsd: 43, trades: [{ timestamp: String(Math.floor(now / 1000) - 3 * 86_400) }] };
  const feed = { now: now / 1000, since: now / 1000 - 86_400, launches: [], posts: [], milestones: (['first_swap', 'holders', 'volume24h'] as const).map((kind, i) => ({ token, kernel, kind, value: 100, at: now / 1000 - 600 * (i + 1) })) } as unknown as PlatformFeedData;
  for (const holders of [112, 100, 120]) add(() => coinToday.renderCoinBrief({ symbol: 'X', token, kernel, now, market, feed, base: { at: now - 7_200_000, holders }, maxChars: 4000 })?.text);
  add(() => ['first_swap', 'holders', 'volume24h'].map((kind) => milestoneWords(kind, 100)));
  // The dates, the day count and the amounts written out for a turn (rule R12): the block exists once the stage that
  // adds it is merged, and is read from there when it does; its words are also among the ones listed by hand below.
  const written = (coinToday as { writtenFacts?: (input: unknown) => unknown }).writtenFacts;
  if (typeof written === 'function') {
    for (const trades of [market.trades, [], [{ timestamp: String(Math.floor(now / 1000)) }], [{ timestamp: String(Math.floor(now / 1000) - 86_400) }]])
      add(() => written({ now, launchedAt: now - 9 * 86_400_000, market: { ...market, trades }, treasury: { balances: { weth: 0.0475 }, claimable: { weth: 0.0123, asset: 'WETH' }, usd: { weth: 86, claimableWeth: 22 } } }));
  }
  return out;
}

/**
 * By hand: the words of the `written` block and of amounts (weekdays, how long ago, the units a fee or a treasury is
 * counted in), and the names of the labels of an agent's own coin (your-coin.ts: the address rides as the last line of
 * a post, under the same two or three words on every coin; the cashtag and the address themselves are the coin's own).
 */
const BY_HAND = 'sunday monday tuesday wednesday thursday friday saturday utc day days launched today yesterday ago none index about weth eth usdc usd contract address ca cashtag';

/** Every word of the sentences code hands a coin agent. */
export const HANDED_WORDS: ReadonlySet<string> = new Set([...handedTexts().flatMap(wordsOf), ...BY_HAND.split(' ')]);

/**
 * What of a post's word set (said.ts `wordSet`) the agent wrote itself: no word of a sentence code hands every coin
 * agent, and no figure. This is what the cross-agent gate compares, on both sides.
 */
export function ownWords(words: readonly string[]): string[] {
  return words.filter((w) => !/\d/.test(w) && !HANDED_WORDS.has(w));
}
