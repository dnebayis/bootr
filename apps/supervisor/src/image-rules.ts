/**
 * The hard rules for pictures, decided in code before any money moves (images.ts calls `imagePromptRisk` before the
 * paid call) and again where a picture meets a post (the broker's `mediaForAction` and the review queue run
 * `altTextRisk`). The prompt tells the model the same rules in words; these are the deterministic side:
 *
 *   - never on request: when a message received this turn asks for a picture, no picture is made this turn
 *     (`pictureRequested`); a picture is the agent's own idea for its own post or never;
 *   - no real people: public figures by name, anyone by @handle, photographs or portraits of real persons;
 *   - no logos of other projects: a logo or brand mark is only ever the agent's own coin's;
 *   - no charts, prices or numbers that read as gains: no candles, rockets, percentages or dollar amounts;
 *   - the alt text is public text (X shows it): it passes the same gates as a post (no execution bait, no secrets,
 *     no internal references, the platform rules for the platform account), carries at most one cashtag and no
 *     @mentions (an alt text cannot credit a source), and is at most ALT_MAX_CHARS long.
 *
 * Word lists are short and conservative on purpose: a false refusal costs one picture, a miss costs the account.
 */
import { countCashtags, mentionedHandles, outgoingActionRisk, outgoingDisclosureRisk, platformPostRisk, type PostValidationContext } from '@bootr/agent-core';

export const ALT_MAX_CHARS = 1000;

export interface ImageRuleContext {
  /** The platform account: its stricter public-text rules apply to the alt text too. */
  platform: boolean;
  /** The agent's own coin: its name and symbol (a logo of these is allowed). */
  ownNames?: readonly string[];
}

export interface ImageRefusal {
  code: string;
  /** What the model is told: the rule, in plain words, and what to do instead. */
  message: string;
}

/** People a picture must never show, by name (lowercase, matched on word boundaries). */
export const PUBLIC_FIGURES: readonly string[] = [
  'elon musk', 'musk', 'donald trump', 'trump', 'joe biden', 'biden', 'barack obama', 'obama', 'kamala harris', 'vitalik', 'buterin', 'jesse pollak', 'pollak', 'brian armstrong', 'armstrong',
  'changpeng zhao', 'cz binance', 'sam bankman', 'bankman-fried', 'sbf', 'sam altman', 'altman', 'zuckerberg', 'jeff bezos', 'bezos', 'satoshi', 'michael saylor', 'saylor', 'cathie wood', 'taylor swift',
  'kanye', 'drake', 'ronaldo', 'messi', 'putin', 'xi jinping', 'narendra modi', 'macron', 'erdogan', 'netanyahu', 'zelensky', 'do kwon', 'justin sun', 'andreessen', 'peter thiel', 'thiel', 'jensen huang', 'tim cook', 'satya nadella', 'sundar pichai', 'dario amodei', 'amodei',
];

/** Brands whose logo or mark is never drawn (lowercase, word boundaries). The agent's own coin is handled by `ownNames`. */
export const THIRD_PARTY_BRANDS: readonly string[] = [
  'coinbase', 'base', 'uniswap', 'clanker', 'zora', 'farcaster', 'warpcast', 'ethereum', 'bitcoin', 'solana', 'binance', 'okx', 'kraken', 'openai', 'chatgpt', 'anthropic', 'claude', 'gemini', 'google', 'apple', 'nike', 'adidas', 'twitter', 'tesla', 'spacex', 'nvidia',
  'microsoft', 'amazon', 'meta', 'facebook', 'instagram', 'tiktok', 'aerodrome', 'virtuals', 'pump.fun', 'pumpfun', 'dexscreener', 'basescan', 'metamask', 'phantom', 'rainbow wallet', 'opensea', 'polymarket', 'hyperliquid', 'doge', 'dogecoin', 'pepe', 'shiba', 'disney', 'marvel', 'pokemon', 'nintendo', 'mcdonald', 'starbucks', 'coca-cola', 'pepsi', 'ferrari', 'lamborghini',
];

const LOGO_WORDS = /\b(logos?|logotype|wordmark|brand ?marks?|trademarks?|emblem|insignia|mascot of|official mark)\b/i;
const REAL_PERSON = /\b(photo(graph)?s?|portraits?|selfies?|likeness|faces?|headshots?|caricatures?|deepfakes?|pictures?|images?|paintings?|drawings?|renderings?) of (a |an |the )?(real |actual |famous |well[- ]known |specific )?(person|people|man|woman|guy|girl|celebrit(y|ies)|politicians?|founders?|ceos?|influencers?|presidents?|billionaires?|streamers?|developers? named|builder named)\b/i;
const REAL_PERSON_WORDS = /\b(celebrit(y|ies)|politicians?|deepfakes?|real (person|people|human|face)|actual person|famous person|public figure|look(s|ing)? (exactly )?like [A-Z][a-z]+ [A-Z][a-z]+|in the likeness of|photorealistic (face|portrait|person|man|woman))\b/;
const HANDLE = /(^|[^\w@])@\w{1,15}\b/;
const MARKET = /\b(charts?|candles?|candlesticks?|ticker|prices?|market ?cap|mcap|volume|pump(ing|ed)?|moon(ing)?|to the moon|rockets?|rocketship|lambo|gains?|profits?|returns?|roi|ath|all[- ]time[- ]high|x\d+|\d+x|up[- ]only|bull ?run|bullish|bearish|the dip|green candles?|red candles?|stonks|line going up|arrow (going |pointing )?up|up and to the right|number go up|\d+(\.\d+)?\s?%|\$\s?\d[\d,.]*k?)\b/i;

function hasAny(text: string, words: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const w of words) {
    const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (re.test(lower)) return w;
  }
  return null;
}

function namesOwnCoin(text: string, ownNames: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return ownNames.some((n) => n.trim().length >= 2 && lower.includes(n.trim().toLowerCase())) || /\bbootr\b/i.test(text);
}

/** Why a prompt and alt text must not become a picture, or null when the pair passes every rule. Free: no call is made. */
export function imagePromptRisk(input: { prompt: string; altText: string }, ctx: ImageRuleContext): ImageRefusal | null {
  const both = `${input.prompt}\n${input.altText}`;
  const figure = hasAny(both, PUBLIC_FIGURES);
  if (figure) return { code: 'image_real_person', message: `image_real_person: pictures never show a real person (${figure}); draw your coin's own characters or scenes instead` };
  if (HANDLE.test(both)) return { code: 'image_real_person', message: 'image_real_person: pictures never show a real person, and an @handle names one; draw your coin\'s own characters or scenes instead' };
  if (REAL_PERSON.test(both) || REAL_PERSON_WORDS.test(both)) return { code: 'image_real_person', message: 'image_real_person: pictures never show a real or recognisable person; draw your coin\'s own characters or scenes instead' };
  if (LOGO_WORDS.test(both)) {
    const brand = hasAny(both, THIRD_PARTY_BRANDS);
    if (brand) return { code: 'image_other_logo', message: `image_other_logo: a logo or brand mark is only ever your own coin's, never ${brand}'s; describe a scene instead` };
    if (!namesOwnCoin(both, ctx.ownNames ?? [])) return { code: 'image_other_logo', message: 'image_other_logo: a logo or brand mark is only ever your own coin\'s; name your coin in the prompt or describe a scene instead' };
  }
  const foreignCashtag = both.match(/\$[A-Za-z][A-Za-z0-9]{1,15}\b/g)?.find((tag) => !(ctx.ownNames ?? []).some((n) => n.toLowerCase() === tag.slice(1).toLowerCase()) && tag.toLowerCase() !== '$bootr');
  if (foreignCashtag) return { code: 'image_other_logo', message: `image_other_logo: a picture never shows another coin (${foreignCashtag}); draw your own` };
  const market = MARKET.exec(both);
  if (market) return { code: 'image_market_numbers', message: `image_market_numbers: no charts, prices, percentages or anything that reads as gains in a picture ("${market[0]}"); draw a scene, a character or an idea instead` };
  return altTextRisk(input.altText, ctx);
}

/**
 * Why an alt text must not go out with a post, or null. The same gates as a post's text (execution bait, secrets,
 * internal references; the platform rules for the platform account), plus: at most one cashtag, no @mentions, at
 * most ALT_MAX_CHARS characters, and none of the picture rules above in the words.
 */
export function altTextRisk(alt: string, ctx: Pick<ImageRuleContext, 'platform'>): ImageRefusal | null {
  const text = typeof alt === 'string' ? alt.trim() : '';
  if (!text) return { code: 'image_alt_invalid', message: 'image_alt_invalid: the alt text must describe the picture in a sentence' };
  if ([...text].length > ALT_MAX_CHARS) return { code: 'image_alt_invalid', message: `image_alt_invalid: the alt text is at most ${ALT_MAX_CHARS} characters` };
  const risk: PostValidationContext = { platform: ctx.platform };
  const action = outgoingActionRisk(text, risk);
  if (action) return { code: action, message: `${action}: the alt text is public text and does not pass the publish gate; describe the picture plainly` };
  const disclosure = outgoingDisclosureRisk(text, risk);
  if (disclosure) return { code: disclosure, message: `${disclosure}: the alt text is public text and does not pass the publish gate; describe the picture plainly` };
  if (ctx.platform) {
    const platform = platformPostRisk(text);
    if (platform) return { code: platform, message: `${platform}: the alt text is public text and does not pass the platform rules; describe the picture plainly` };
  }
  if (countCashtags(text) > 1) return { code: 'x_post_requires_at_most_one_cashtag', message: 'x_post_requires_at_most_one_cashtag: the alt text carries at most one cashtag' };
  if (mentionedHandles(text).length) return { code: 'image_alt_mentions', message: 'image_alt_mentions: the alt text names nobody with an @; it describes the picture' };
  const market = MARKET.exec(text);
  if (market) return { code: 'image_market_numbers', message: `image_market_numbers: no charts, prices, percentages or gains in the alt text ("${market[0]}")` };
  return null;
}

const PICTURE_REQUEST = /\b(draw|make|create|generate|render|paint|sketch|design|show|send|post|give|gib)\b[^.!?\n]{0,40}\b(pic|pics|picture|pictures|image|images|art|artwork|meme|memes|illustration|logo|portrait|avatar|pfp|banner|wallpaper|fanart|drawing)\b|\b(pic|picture|image|meme|illustration|portrait|avatar|pfp|drawing) of\b|\bcan you draw\b/i;

/** True when a received message asks for a picture: a picture is never made on request, so none is made that turn. */
export function pictureRequested(texts: Iterable<string>): boolean {
  for (const text of texts) if (typeof text === 'string' && PICTURE_REQUEST.test(text)) return true;
  return false;
}

export const REQUESTED_MESSAGE = 'image_requested_by_others: somebody wrote to you this turn asking for a picture, and pictures are never made on request; answer in words or resolve the mention, and make a picture of your own on another turn';
