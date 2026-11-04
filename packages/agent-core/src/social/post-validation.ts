import { PolicyError } from '../errors.js';
import { outgoingActionRisk, type RiskContext } from './communication-policy.js';
import { outgoingDisclosureRisk, type DisclosureContext } from './disclosure-policy.js';
import type { Attribution } from '../types.js';

export type PostFormat = 'short' | 'original';

export const POST_LIMITS: Record<PostFormat, number> = { short: 280, original: 4000 };
export const MAX_ATTRIBUTIONS = 3;
export const MAX_MENTIONS = 3;

const CASHTAG = /(?<![a-z0-9_])\$[a-z][a-z0-9_]*\b/gi;
const MENTION = /(?:^|[^a-z0-9_])@([a-z0-9_]+)/gi;
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
  | 'platform_emoji_string_forbidden';

/** The one cashtag the platform account may use: its own coin. */
export const PLATFORM_CASHTAG = '$BOOTR';

const FIRST_PERSON = "(?:i|i'?ve|i'?m|i'?d|i have|we|we'?ve|we'?re|we have|my|our|me|us)";
const TREASURY_VERB =
  '(?:claim(?:ed|ing|s)?|swap(?:ped|ping|s)?|refuel(?:l?ed|l?ing|s)?|top(?:ped|ping|s)?[ -]?up|topped[ -]up|collect(?:ed|ing|s)?|harvest(?:ed|ing|s)?|earn(?:ed|ing|s)?|gas|fees?|treasury|balance|allowance)';
/**
 * The agent's own treasury operations in the first person: "I claimed", "we just swapped", "refuelled my gas",
 * "fees earned", "our treasury holds". The subject and the verb must share a sentence.
 */
const TREASURY_TALK = new RegExp(
  [
    `(?<![a-z0-9])${FIRST_PERSON}\\b[^.!?\\n]{0,60}?\\b${TREASURY_VERB}\\b`,
    `\\bfees?\\s+(?:earned|claimed|collected|harvested|came in|landed)\\b`,
    `\\b(?:gas|treasury)\\s+top[ -]?up\\b`,
  ].join('|'),
  'i',
);

/** Price, buy and hype vocabulary, plus "10x"-style multipliers and "wen". */
const PRICE_TALK = new RegExp(
  [
    "\\b(?:buy|buying|bought|sell|selling|sold|pump(?:ed|ing|s)?|dump(?:ed|ing|s)?|moon(?:ed|ing|s)?|mooning|wen|ath|lfg|wagmi|ngmi|bullish|bearish|undervalued|overvalued|cheap|dip|dips|rug|rugged|degen|ape|aped|aping|send it|to the moon|price target|price (?:prediction|call|action)|market cap|mcap|chart)\\b",
    '(?<![a-z0-9])\\d+(?:[.,]\\d+)?\\s?(?:x|×)(?![a-z0-9])',
  ].join('|'),
  'i',
);

/** Three or more consecutive all-caps words carrying eight or more letters ("THIS IS HUGE"); acronyms alone pass. */
const SHOUTING = /\b[A-Z]{2,}(?:[\s,!]+[A-Z]{2,}){2,}\b/g;
const shouting = (text: string): boolean => [...text.matchAll(SHOUTING)].some((m) => m[0].replace(/[^A-Z]/g, '').length >= 8);

/** Two or more pictographic emoji in a row (spaces, variation selectors and joiners allowed between). */
const EMOJI = /\p{Extended_Pictographic}(?:[\uFE0F\u200D]\p{Extended_Pictographic}?)*/gu;
const EMOJI_STRING = /\p{Extended_Pictographic}(?:[\uFE0F\u200D]|\p{Extended_Pictographic})*\s*\p{Extended_Pictographic}/u;

/** The platform-only reasons a text must not be published, or null. Pure; the text must already be a string. */
export function platformPostRisk(text: string): PlatformCode | null {
  if (TREASURY_TALK.test(text)) return 'platform_treasury_talk_forbidden';
  if (PRICE_TALK.test(text)) return 'platform_price_talk_forbidden';
  if ([...text.matchAll(CASHTAG)].some((m) => m[0].toUpperCase() !== PLATFORM_CASHTAG)) return 'platform_foreign_cashtag_forbidden';
  if (shouting(text)) return 'platform_shouting_forbidden';
  if (EMOJI_STRING.test(text) || [...text.matchAll(EMOJI)].length >= 3) return 'platform_emoji_string_forbidden';
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
 * Deterministic publish gate. Throws PolicyError with one of:
 * - any outgoingActionRisk code
 * - any outgoingDisclosureRisk code (secrets, internal references, runtime jargon, foreign addresses)
 * - invalid_short_post / invalid_original_post (type, empty, length, attribution count)
 * - x_post_requires_at_most_one_cashtag
 * - invalid_source_credit (bad handle, non-https url, credentials in url, duplicate)
 * - mentions_require_source_credit (more than 3 mentions, or mention/credit sets differ)
 * - any PlatformCode when `risk.platform` is true (treasury talk, price talk, foreign cashtags, shouting, emoji strings)
 */
export function validatePost(
  text: unknown,
  attributions: unknown = [],
  format: PostFormat = 'short',
  hasMedia = false,
  risk: PostValidationContext = {},
): asserts text is string {
  const riskCode = outgoingActionRisk(text, risk);
  if (riskCode) throw new PolicyError(riskCode);
  const disclosure = outgoingDisclosureRisk(text, risk);
  if (disclosure) throw new PolicyError(disclosure);
  const invalid = format === 'original' ? 'invalid_original_post' : 'invalid_short_post';
  if (typeof text !== 'string') throw new PolicyError(invalid);
  if (!text.trim() && !hasMedia) throw new PolicyError(invalid);
  if ([...text].length > POST_LIMITS[format]) throw new PolicyError(invalid);
  if (!Array.isArray(attributions) || attributions.length > MAX_ATTRIBUTIONS) throw new PolicyError(invalid);
  if (risk.platform) {
    const platformCode = platformPostRisk(text);
    if (platformCode) throw new PolicyError(platformCode);
  }
  // X counts occurrences, so two uses of the same symbol still count as two.
  if (countCashtags(text) > 1) throw new PolicyError('x_post_requires_at_most_one_cashtag');

  const credited = new Set<string>();
  for (const source of attributions as unknown[]) {
    const credit = source as Partial<Attribution> | null;
    if (!credit || typeof credit.username !== 'string' || !HANDLE.test(credit.username)) throw new PolicyError('invalid_source_credit');
    if (typeof credit.sourceUrl !== 'string' || credit.sourceUrl.length > 2000) throw new PolicyError('invalid_source_credit');
    let url: URL;
    try {
      url = new URL(credit.sourceUrl);
    } catch {
      throw new PolicyError('invalid_source_credit');
    }
    const name = credit.username.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || credited.has(name)) throw new PolicyError('invalid_source_credit');
    credited.add(name);
  }
  const mentions = mentionedHandles(text);
  if (mentions.length > MAX_MENTIONS) throw new PolicyError('mentions_require_source_credit');
  if (mentions.some((name) => !credited.has(name))) throw new PolicyError('mentions_require_source_credit');
  if ([...credited].some((name) => !mentions.includes(name))) throw new PolicyError('mentions_require_source_credit');
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
