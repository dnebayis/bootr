import { PolicyError } from '../errors.js';
import { normalizedCommunication, outgoingActionFinding, type RiskContext } from './communication-policy.js';
import { outgoingDisclosureFinding, type DisclosureContext } from './disclosure-policy.js';
import { excerptOf, gateRefusal, type GateFinding } from './gate-words.js';
import type { Attribution } from '../types.js';

export type PostFormat = 'short' | 'original';

/** The defaults: what an account with X Premium may send (replies are 280 everywhere). */
export const POST_LIMITS: Record<PostFormat, number> = { short: 280, original: 4000 };
/** An original post from an account without X Premium: X refuses a longer one with a bare 403 "not permitted". */
export const NON_PREMIUM_POST_LIMIT = 280;

/**
 * The post limits of one X account: `premium === false` caps originals at NON_PREMIUM_POST_LIMIT; `true` or unknown
 * (`null`, `undefined`) keeps POST_LIMITS. Callers without the account's flag use POST_LIMITS as before.
 */
export function postLimitsFor(premium: boolean | null | undefined): Record<PostFormat, number> {
  return premium === false ? { ...POST_LIMITS, original: NON_PREMIUM_POST_LIMIT } : POST_LIMITS;
}

/**
 * How long a post is for the limits here: code points, as `validatePost` counts. X weighs its own count (a URL is 23,
 * some characters 2); that weighting is not reproduced, so a post full of links is counted long and a few scripts short.
 */
export function postLength(text: string): number {
  return [...text].length;
}
export const MAX_ATTRIBUTIONS = 3;
export const MAX_MENTIONS = 3;

const CASHTAG = /(?<![a-z0-9_])\$[a-z][a-z0-9_]*\b/gi;
// X reads the full-width sign as a mention too; every rule about who may be named with an @ reads this one pattern.
const MENTION = /(?:^|[^a-z0-9_])[@\uFF20]([a-z0-9_]+)/gi;
const HANDLE = /^[a-z0-9_]{1,15}$/i;

export function countCashtags(text: string): number {
  return [...text.matchAll(CASHTAG)].length;
}

// ---------------------------------------------------------------------------
// Platform account: the launchpad's own voice gets a stricter gate
// ---------------------------------------------------------------------------

export type PlatformCode =
  | 'platform_treasury_talk_forbidden'
  | 'platform_price_talk_forbidden'
  | 'platform_foreign_cashtag_forbidden'
  | 'platform_shouting_forbidden'
  | 'platform_emoji_string_forbidden'
  | 'platform_link_forbidden';

/**
 * The only sites the platform account may link: its own, X, the explorer, the two launch and chart sites, plus the
 * source a post credits (attributions). An injected model could otherwise post any https link from the launchpad's
 * own voice, and a phishing link there would carry its name. Subdomains count (www.bootr.fun).
 */
export const PLATFORM_LINK_HOSTS: readonly string[] = ['bootr.fun', 'x.com', 'twitter.com', 'basescan.org', 'clanker.world', 'dexscreener.com'];

/** Common endings X turns into a link even without `https://` ("bootr-claim.com/x" is a link on X). ".eth" is not one. */
const LINK_TLDS = 'com|net|org|io|xyz|fun|app|co|dev|world|finance|fi|me|link|site|online|info|ai|gg|lol|wtf|club|top|cloud|network|money|exchange|cash|crypto|tech|live|pro|us|uk|de|ch|so|to|ly|sh|zip|mov|eu|ca|tv|cc|id|is|in|it|be|at|nl|fr|es';
const EXPLICIT_LINK = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const BARE_LINK = new RegExp(`(?<![\\w@/.-])(?:www\\.)?(?:[a-z0-9-]+\\.)+(?:${LINK_TLDS})(?=[/?#]|\\b)(?:[/?#][^\\s<>"')\\]]*)?`, 'gi');

/** The hosts of every link in `text`, explicit or bare, lowercased; an unparsable one counts as '' (never allowed). */
export function linkedHosts(text: string): string[] {
  const hosts: string[] = [];
  const bare = text.replace(EXPLICIT_LINK, (m) => {
    hosts.push(hostOf(m));
    return ' ';
  });
  for (const m of bare.matchAll(BARE_LINK)) hosts.push(hostOf(`https://${m[0]}`));
  return hosts;
}

/** The host of a link as written in prose: the sentence's trailing punctuation is not part of it. */
function hostOf(url: string): string {
  try {
    return new URL(url.replace(/[.,;:!?]+$/, '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const hostAllowed = (host: string, allowed: readonly string[]) => host !== '' && allowed.some((a) => host === a || host.endsWith(`.${a}`));

/**
 * `platform_link_forbidden` when the text links a site outside PLATFORM_LINK_HOSTS and the credited sources, else
 * null. Pure; the attributions are read leniently here (the strict check comes after, in `validatePost`).
 */
export function platformLinkRisk(text: string, attributions: unknown = []): PlatformCode | null {
  return platformLinkFinding(text, attributions)?.code ?? null;
}

/** A refusal of the platform account's own rules: the code, and the words of its own text that tripped it. */
export interface PlatformFinding extends GateFinding {
  code: PlatformCode;
}

/** `platformLinkRisk` with the site that tripped it: the first linked host outside the allowed ones, as the text wrote it. */
export function platformLinkFinding(text: string, attributions: unknown = []): PlatformFinding | null {
  const credited = Array.isArray(attributions) ? attributions.map((a) => hostOf(String((a as { sourceUrl?: unknown } | null)?.sourceUrl ?? ''))).filter(Boolean) : [];
  const allowed = [...PLATFORM_LINK_HOSTS, ...credited];
  const outside = linkedHosts(text).find((h) => !hostAllowed(h, allowed));
  return outside === undefined ? null : { code: 'platform_link_forbidden', excerpt: excerptOf(outside) };
}

/** The one cashtag the platform account may use: its own coin. */
export const PLATFORM_CASHTAG = '$BOOTR';

/** The speaker as the one who acts: "I", "we", with their contractions, and with a name set off by commas ("i, the platform agent,"). */
const FIRST_PERSON_SUBJECT = "(?:i|we)(?:['’](?:ve|m|re|d|ll))?(?:\\s*,[^,.!?\\n]{1,40},)?";
/** What may stand between the speaker and the verb without changing who acts ("we have just", "i'm now", "i will"). */
const SUBJECT_FILLER =
  "(?:just|already|finally|also|then|now|recently|today|again|actually|quietly|successfully|automatically|manually|have|has|had|will|shall|would|did|do|am|are|was|were|been|be|gonna|going to|need to|needed to|want to|plan to|about to|should|must|went|gone|go|ahead|and|managed to|decided to|tried to|got to)";
/** The treasury operations themselves. */
const TREASURY_OPERATION =
  '(?:claim(?:ed|ing|s)?|swap(?:ped|ping|s)?|refuel(?:l?ed|l?ing|s)?|top(?:ped|ping|s)?[ -]?up|collect(?:ed|ing|s)?|harvest(?:ed|ing|s)?|earn(?:ed|ing|s)?|withdr(?:ew|aw|awn|awing|aws)|cash(?:ed|ing)? out)';
/** The money the speaker would hold: plural fees (the fee, a fee split, is how Bootr works and passes), gas, fuel, the wallet, the rest. */
const OWN_MONEY = '(?:fees|fee (?:income|earnings|revenue)|gas|fuel|treasury|balance|allowance|earnings|funds|wallet balance|wallet)';
/** A sum of money, or the words for one, as the object of an ordinary verb ("made 0.4 eth", "moved the fees", "got $40"). */
const MONEY_OBJECT =
  '(?:(?:the|our|my|some|all|about|around|over|another|nearly|almost|\\$?\\d[\\d.,]*\\s*[kmb]?)\\s*){0,3}(?:eth|weth|usdc|usdt|fees|gas|fuel|treasury|dollars|bucks)\\b(?!\\s+(?:question|questions|split|page|model|structure|rules?|explainer|thread|post|guide)\\b)|\\$\\s?\\d';
/**
 * The agent's own treasury operations: the speaker as the one who acts ("I claimed", "we have just swapped", "I'm
 * topping up"), the speaker's own money ("my fees", "refuelled my gas", "our treasury holds", "my balance"), and the
 * report of one with no subject at the head of a sentence ("Fees earned so far", "0.4 eth of fees claimed today", "Gas
 * top-up done"), and the speaker getting, making, moving or sending a sum ("i made 0.4 eth in fees", "we moved 0.5 eth
 * of fees to the treasury"; an amount or the money's own word must follow, so "i made a guide" passes). The subject must
 * stand right before the verb, with at most three fillers between ("i finally went and claimed"; the security review of
 * 2026-11-15 got that, a name set off by commas and the fuel and the wallet through): a first-person sentence that
 * only mentions a fee ("something I like: the fee split is locked"), and a third party that earns ("creators earn in
 * ETH"), are this account's own beat and pass. Read over the folded text (`normalizedCommunication`), so a zero-width
 * or a look-alike letter does not hide a word.
 */
const TREASURY_TALK = new RegExp(
  [
    `(?<![a-z0-9])${FIRST_PERSON_SUBJECT}(?:\\s+${SUBJECT_FILLER}){0,3}\\s+${TREASURY_OPERATION}(?![a-z0-9])`,
    `(?<![a-z0-9])${FIRST_PERSON_SUBJECT}(?:\\s+${SUBJECT_FILLER}){0,3}\\s+(?:paid|spent|burn(?:ed|t))\\b(?:[^.!?\\n]|\\.(?=\\d)){0,30}?\\b(?:gas|fees|fuel|eth|usdc)\\b`,
    `(?<![a-z0-9])${FIRST_PERSON_SUBJECT}(?:\\s+${SUBJECT_FILLER}){0,3}\\s+(?:got|made|received|moved|sent|routed|took|pulled|put)\\s+(?:${MONEY_OBJECT})`,
    `(?<![a-z0-9])(?:my|our)\\s+(?:own\\s+)?${OWN_MONEY}(?![a-z0-9])`,
    `(?:^|[.!?:;\\n]\\s*)(?:(?:\\$?\\d[\\d.,]*\\s*[kmb]?\\s*(?:eth|weth|usdc|usdt)?|about|around|over|some)\\s+(?:of|in)\\s+)?fees?\\s+(?:earned|claimed|collected|harvested|came in|landed)\\b`,
    `\\b(?:gas|treasury)\\s+top[ -]?up\\b`,
  ].join('|'),
  'i',
);

/** A trade verb: "buy", "sell" and their forms. Alone it is an ordinary word ("agents buy services", "every buy and sell"). */
const TRADE = '(?:buy|buying|bought|buys|sell|selling|sold|sells)';
/** The forms an order takes: "buy", "sell". */
const TRADE_ORDER = '(?:buy|sell)';
/**
 * What makes a trade verb a call: a coin as its object ("$BOOTR", "bootr", "the dip", "bags", "the coin", "this
 * one"). A generic "coins" or "tokens" is not one: "agents buy tokens through the swap tool" says what a product does.
 */
const COIN_OBJECT =
  '(?:\\$[a-z]|bootr\\b|(?:the|this|that|these|those|your|my|our)\\s+(?:coin|coins|token|tokens|dip|dips|bottom|top|news|rumou?r|bags?)\\b|(?:a|some|more)\\s+bags?\\b|(?:dip|dips|bags?)\\b|this one\\b|it all\\b)';
/**
 * What may stand between the verb and the coin, up to three of them: an amount or a quantity ("buy 1,000 $BOOTR",
 * "buy 0.1 eth of", "buy a bag of", "sell some", "buy up all the"), a particle ("buy into", "buy back into", "sell
 * off", "sell out of") or a determiner ("sell your", "buy the"). Before 2026-11-15 one of the last two in front of the
 * coin let a call through ("buy into $BOOTR", "sell your $BOOTR now").
 */
const QUANTITY =
  '(?:(?:some|more|a\\s+(?:bit|little|lot|bag|few)\\s+(?:of\\s+)?|any|all(?:\\s+of)?|half(?:\\s+of)?|into|up|back(?:\\s+into)?|off|out\\s+of|the|your|my|our|\\$?\\d[\\d.,]*\\s*[kmb]?(?:\\s*(?:eth|weth|usdc|usdt|sol|dollars?|bucks))?(?:\\s+(?:of|worth of|in))?)\\s*)';
/** The end of a clause: what follows a bare "buy more" or "bought early" for it to be the whole call. */
const CLAUSE_END = '(?=\\s*(?:[.!?,;:…)]|$))';
/** What makes a trade verb a nudge by itself: urgency right after ("buy now", "sell today", "buy it now", "buy more."). */
const URGENCY = `(?:(?:it|them|in|some)\\s+)?(?:now|today|tonight|asap|immediately|here|soon|quick(?:ly)?|the news)\\b|(?:more|early|in|back)${CLAUSE_END}`;
/** A nudge in front of an order: "time to sell", "you should buy", "go buy", "i'd buy", "don't sell.", "keep buying". */
const NUDGE = [
  `(?:(?:good|great|best|perfect|right)\\s+)?time\\s+to\\s+${TRADE_ORDER}\\b`,
  `(?:you|u|y['’]?all|everyone|anyone|we|people)\\s+(?:should|must|need to|have to|gotta|better|ought to)\\s+(?:\\w+\\s+)?${TRADE_ORDER}\\b`,
  `(?:i['’]?d|i\\s+would|go|please|pls)\\s+${TRADE_ORDER}\\b`,
  `(?:don['’]?t|do not|dont|never)\\s+sell${CLAUSE_END}`,
  '(?:keep|start|stop|consider)\\s+(?:buying|selling)\\b',
  `${TRADE_ORDER}\\s+signals?\\b`,
].join('|');
/**
 * Hype and market calls: predictions, targets, nudges, profit talk, a figure framed as a bargain, "10x"-style
 * multipliers and "wen". Neutral figures pass: the platform agent may state a price, a market cap, a volume or link a
 * chart ("$BOOTR did $690k in volume today", "market cap is $190k"), so those words alone are not here. What it says
 * about them is.
 *
 * "Buy" and "sell" are calls only in a call's shape (2026-11-15; before, the bare words refused 1 in 10 posts, among
 * them "agents that buy services" and "every buy and sell"): with a coin as the object ("buy $BOOTR", "buy the dip",
 * "sell your bags", "buy 1,000 bootr"), with urgency or more after ("buy now", "buy more"), with a nudge before
 * ("time to sell", "you should buy", "don't sell", "keep buying"), or as the order that opens a sentence ("Buy.",
 * "Sell before the news", "just buy,"). A plain "buy" or "sell" with $BOOTR a few words on in its clause is a call, the
 * coin run into the verb ("buy-$BOOTR") too, and "worth buying" and "at these levels" are (the security review of
 * 2026-11-15). Read over the folded text, so a zero-width or a look-alike letter does not hide a word.
 */
const PRICE_TALK = new RegExp(
  [
    `\\b${TRADE}(?![-'’])\\s+${QUANTITY}{0,3}${COIN_OBJECT}`,
    // the coin run into the verb: "buy-$BOOTR", "buy＄BOOTR" (the full-width sign folds to "$"), "sell/bootr"
    `\\b${TRADE}[\\s\\-–—_:/]*\\$[a-z]|\\b${TRADE}[\\-–—_:/]+bootr\\b`,
    // the plain verb with $BOOTR a few words on, in its clause: "buy some of that sweet $BOOTR"; not "every buy and sell of $BOOTR"
    `(?<!\\b(?:every|each|a|an|the|any|per|one|no|this|that)\\s+(?:[a-z]+\\s+(?:and|or|&)\\s+)?)\\b(?:buy|sell)(?:ing)?\\b(?![-'’])[^.!?\\n;:]{0,30}\\$bootr\\b`,
    `\\b${TRADE}(?![-'’])\\s+(?:${URGENCY})`,
    `\\b(?:${NUDGE})(?![-'’])`,
    `(?:^|[.!?:;\\n"“'‘(]\\s*)(?:(?:just|simply)\\s+)?${TRADE_ORDER}(?:${CLAUSE_END}|\\s+(?:before|while|and\\s+(?:hold|forget|wait))\\b)`,
    '\\bworth\\s+(?:buying|selling|a\\s+buy|grabbing|picking up|stacking|accumulating)\\b|\\bat these (?:levels|prices)\\b|\\bthank me later\\b',
    '\\b(?:load(?:ing)?\\s+up\\s+on|stack(?:ing)?|accumulat(?:e|ing))\\s+(?:some\\s+|more\\s+)?(?:\\$[a-z]|bootr\\b)',
    "\\b(?:pump(?:ed|ing|s)?|dump(?:ed|ing|s)?|moon(?:ed|ing|s)?|mooning|wen|ath|lfg|wagmi|ngmi|bullish|bearish|undervalued|overvalued|cheap|dip|dips|rug|rugged|degen|ape|aped|aping|send it|to the moon|price target|price (?:prediction|call|action))\\b",
    // A prediction: "price will", "$BOOTR to $1m", "will go up", "going to hit $1m", "target $1m".
    "\\b(?:price|market cap|mcap|valuation)\\s+(?:will|won['’]?t|is going to|is gonna|gonna|can only)\\b",
    "\\b(?:will|won['’]?t|could|might|may|should|going to|gonna|about to|set to|bound to)\\s+(?:go up|go down|rise|fall|soar|skyrocket|explode|rally|double|triple|recover|bounce)\\b",
    "\\b(?:will|going to|gonna)\\s+(?:hit|reach|flip)\\s+\\$?\\d",
    "\\$bootr\\s+to\\s+\\$?\\d",
    "\\btargets?\\s+(?:of\\s+)?\\$\\d",
    // A nudge: "don't miss", "last chance", "you're early", "hold $BOOTR", and the disclaimers that only follow a call.
    "\\b(?:don['’]?t|do not|dont)\\s+miss\\b|\\blast chance\\b|\\b(?:not|before it['’]?s) too late\\b",
    "\\b(?:you|we)(?:['’]?re| are)\\s+(?:still\\s+)?early(?=\\s*(?:[.!?,…]|$|to\\b|here\\b))|\\$bootr\\b[^.!?\\n]{0,30}\\bstill early\\b|\\bget(?:ting)?\\s+in\\s+early\\b|\\bearly\\s+(?:entry|buyers?)\\b",
    "\\bhodl\\b|\\bdiamond hands\\b|\\bkeep holding\\b|\\bhold(?:ing)?\\s+(?:\\$[a-z]|your\\s+(?:bags?|coins?|tokens?)|bags?\\b)",
    "\\bnfa\\b|\\bnot financial advice\\b|\\bdyor\\b",
    // Profit talk, and a figure framed as a bargain. "Gains" and "returns" alone are ordinary words.
    "(?<![a-z0-9-])profits?\\b|\\bprofitable\\b|\\broi\\b|\\bget rich\\b|\\bup only\\b|\\b(?:your|big|huge|massive|quick|easy|high|guaranteed)\\s+(?:gains|returns)\\b",
    "\\b(?:only|just)\\s+(?:a\\s+)?\\$?\\d[\\d.,]*\\s*[kmb]?\\s+(?:market cap|mcap)\\b|\\b(?:low|tiny|small)\\s+(?:market cap|mcap)\\b|\\bat a discount\\b|\\bhidden gem\\b",
    '(?<![a-z0-9])\\d+(?:[.,]\\d+)?\\s?(?:x|×)(?![a-z0-9])',
  ].join('|'),
  'i',
);

/** Three or more consecutive all-caps words carrying eight or more letters ("THIS IS HUGE"); acronyms alone pass. */
const SHOUTING = /\b[A-Z]{2,}(?:[\s,!]+[A-Z]{2,}){2,}\b/g;

/** Two or more pictographic emoji in a row (spaces, variation selectors and joiners allowed between). */
const EMOJI = /\p{Extended_Pictographic}(?:[\uFE0F\u200D]\p{Extended_Pictographic}?)*/gu;
const EMOJI_STRING = /\p{Extended_Pictographic}(?:[\uFE0F\u200D]|\p{Extended_Pictographic})*\s*\p{Extended_Pictographic}/u;

/** The platform-only reasons a text must not be published, or null. Pure; the text must already be a string. */
export function platformPostRisk(text: string): PlatformCode | null {
  return platformPostFinding(text)?.code ?? null;
}

/**
 * `platformPostRisk` with the words of the text that tripped the rule. The word rules read the folded text (entities
 * and escapes decoded, zero-width characters gone, look-alike letters read as Latin: `normalizedCommunication`), as
 * the common rules do; shouting and emoji read the text as written, since case and pictographs are what they are about.
 */
export function platformPostFinding(text: string): PlatformFinding | null {
  const folded = normalizedCommunication(text);
  const treasury = TREASURY_TALK.exec(folded);
  if (treasury) return { code: 'platform_treasury_talk_forbidden', excerpt: excerptOf(treasury[0]) };
  const price = PRICE_TALK.exec(folded);
  if (price) return { code: 'platform_price_talk_forbidden', excerpt: excerptOf(price[0]) };
  // As written first, so the refusal quotes the cashtag as the post has it; folded after, for a full-width one.
  const isForeign = (m: RegExpMatchArray) => m[0].toUpperCase() !== PLATFORM_CASHTAG;
  const foreign = [...text.matchAll(CASHTAG)].find(isForeign) ?? [...folded.matchAll(CASHTAG)].find(isForeign);
  if (foreign) return { code: 'platform_foreign_cashtag_forbidden', excerpt: excerptOf(foreign[0]) };
  const loud = [...text.matchAll(SHOUTING)].find((m) => m[0].replace(/[^A-Z]/g, '').length >= 8);
  if (loud) return { code: 'platform_shouting_forbidden', excerpt: excerptOf(loud[0]) };
  if (EMOJI_STRING.test(text) || [...text.matchAll(EMOJI)].length >= 3) return { code: 'platform_emoji_string_forbidden', excerpt: null };
  return null;
}

/** Validation context: the risk and disclosure contexts, plus `platform` for the launchpad's own account. */
export interface PostValidationContext extends RiskContext, DisclosureContext {
  /** True for the platform agent: the stricter `platformPostRisk` rules apply on top of the common ones. */
  platform?: boolean;
}

export function mentionedHandles(text: string): string[] {
  return [...text.matchAll(MENTION)].map((m) => m[1]!.toLowerCase());
}

/**
 * The attributions `validatePost` will accept for `text`: those crediting a handle the text actually mentions.
 * The model often credits what it read (a tweet, a page) as a source without naming the account in the post; a
 * credit without a mention carries nothing to X and would only fail the publish gate (`mentions_require_source_credit`).
 */
export function creditedAttributions<T extends { username: string }>(text: string, attributions: readonly T[] | undefined): T[] {
  if (!attributions?.length) return [];
  const mentions = new Set(mentionedHandles(text));
  return attributions.filter((a) => typeof a.username === 'string' && mentions.has(a.username.toLowerCase()));
}

/**
 * Deterministic publish gate, as a finding: null when the text may go, else the code with the words of the text that
 * tripped it (gate-words.ts turns a finding into what the agent reads). The codes, in the order they are checked:
 * - any outgoingActionFinding code
 * - any outgoingDisclosureFinding code (secrets, internal references, runtime jargon, foreign addresses)
 * - invalid_short_post / invalid_original_post (type, empty, length, attribution count)
 * - x_post_requires_at_most_one_cashtag
 * - invalid_source_credit (bad handle, non-https url, credentials in url, duplicate)
 * - mentions_require_source_credit (more than 3 mentions, or mention/credit sets differ)
 * - any PlatformCode when `risk.platform` is true (treasury talk, market calls, foreign cashtags, shouting, emoji
 *   strings, a link outside PLATFORM_LINK_HOSTS and the credited sources)
 * A credit is passed beside the text and is not the agent's own post, so a finding about one never quotes it.
 */
export function postFinding(text: unknown, attributions: unknown = [], format: PostFormat = 'short', hasMedia = false, risk: PostValidationContext = {}): GateFinding | null {
  const action = outgoingActionFinding(text, risk);
  if (action) return action;
  const disclosure = outgoingDisclosureFinding(text, risk);
  if (disclosure) return disclosure;
  const invalid = format === 'original' ? 'invalid_original_post' : 'invalid_short_post';
  if (typeof text !== 'string') return { code: invalid };
  if (!text.trim() && !hasMedia) return { code: invalid };
  if (postLength(text) > POST_LIMITS[format]) return { code: invalid, cause: 'too_long', count: postLength(text), limit: POST_LIMITS[format] };
  if (!Array.isArray(attributions) || attributions.length > MAX_ATTRIBUTIONS) return { code: invalid, cause: 'attributions' };
  if (risk.platform) {
    const platform = platformPostFinding(text);
    if (platform) return platform;
  }
  // X counts occurrences, so two uses of the same symbol still count as two.
  const cashtags = [...text.matchAll(CASHTAG)].map((m) => m[0]);
  if (cashtags.length > 1) return { code: 'x_post_requires_at_most_one_cashtag', excerpt: excerptOf(cashtags.slice(0, 2).join(' and ')) };

  const credited = new Set<string>();
  for (const source of attributions as unknown[]) {
    const credit = source as Partial<Attribution> | null;
    if (!credit || typeof credit.username !== 'string' || !HANDLE.test(credit.username)) return { code: 'invalid_source_credit' };
    if (typeof credit.sourceUrl !== 'string' || credit.sourceUrl.length > 2000) return { code: 'invalid_source_credit' };
    let url: URL;
    try {
      url = new URL(credit.sourceUrl);
    } catch {
      return { code: 'invalid_source_credit' };
    }
    const name = credit.username.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || credited.has(name)) return { code: 'invalid_source_credit' };
    credited.add(name);
  }
  const mentions = mentionedHandles(text);
  if (mentions.length > MAX_MENTIONS) return { code: 'mentions_require_source_credit', cause: 'too_many' };
  const uncredited = mentions.find((name) => !credited.has(name));
  if (uncredited) return { code: 'mentions_require_source_credit', excerpt: excerptOf(`@${uncredited}`) };
  if ([...credited].some((name) => !mentions.includes(name))) return { code: 'mentions_require_source_credit', cause: 'credit_without_mention' };
  // Last, once the credits are known to be well formed: the platform account links only its own sites and its sources.
  if (risk.platform) return platformLinkFinding(text, attributions);
  return null;
}

/**
 * The publish gate. Throws PolicyError with a `postFinding` code; its message is the refusal the agent reads, the code
 * first and then what tripped and how to say it (`gateRefusal`).
 */
export function validatePost(
  text: unknown,
  attributions: unknown = [],
  format: PostFormat = 'short',
  hasMedia = false,
  risk: PostValidationContext = {},
): asserts text is string {
  const finding = postFinding(text, attributions, format, hasMedia, risk);
  if (finding) throw new PolicyError(finding.code, { message: gateRefusal(finding) });
}

/** Non-throwing variant for callers that prefer a result. */
export function postValidation(
  text: unknown,
  attributions: unknown = [],
  format: PostFormat = 'short',
  hasMedia = false,
  risk: PostValidationContext = {},
): { ok: true } | { ok: false; code: string } {
  try {
    validatePost(text, attributions, format, hasMedia, risk);
    return { ok: true };
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, code: error.code };
    throw error;
  }
}

/** The refusal the agent reads (`code: what tripped and what to do`), or null when the text may go. */
export function postRefusal(text: unknown, attributions: unknown = [], format: PostFormat = 'short', hasMedia = false, risk: PostValidationContext = {}): string | null {
  const finding = postFinding(text, attributions, format, hasMedia, risk);
  return finding ? gateRefusal(finding) : null;
}
