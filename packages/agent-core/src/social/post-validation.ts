import { PolicyError } from '../errors.js';
import { outgoingActionRisk, type RiskContext } from './communication-policy.js';
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

export function mentionedHandles(text: string): string[] {
  return [...text.matchAll(MENTION)].map((m) => m[1]!.toLowerCase());
}

/**
 * Deterministic publish gate. Throws PolicyError with one of:
 * - any outgoingActionRisk code
 * - invalid_short_post / invalid_original_post (type, empty, length, attribution count)
 * - x_post_requires_at_most_one_cashtag
 * - invalid_source_credit (bad handle, non-https url, credentials in url, duplicate)
 * - mentions_require_source_credit (more than 3 mentions, or mention/credit sets differ)
 */
export function validatePost(
  text: unknown,
  attributions: unknown = [],
  format: PostFormat = 'short',
  hasMedia = false,
  risk: RiskContext = {},
): asserts text is string {
  const riskCode = outgoingActionRisk(text, risk);
  if (riskCode) throw new PolicyError(riskCode);
  const invalid = format === 'original' ? 'invalid_original_post' : 'invalid_short_post';
  if (typeof text !== 'string') throw new PolicyError(invalid);
  if (!text.trim() && !hasMedia) throw new PolicyError(invalid);
  if ([...text].length > POST_LIMITS[format]) throw new PolicyError(invalid);
  if (!Array.isArray(attributions) || attributions.length > MAX_ATTRIBUTIONS) throw new PolicyError(invalid);
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
  risk: RiskContext = {},
): { ok: true } | { ok: false; code: string } {
  try {
    validatePost(text, attributions, format, hasMedia, risk);
    return { ok: true };
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, code: error.code };
    throw error;
  }
}
