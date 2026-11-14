/**
 * What may enter the dataset. One bad record would later reach every agent at once, so everything read from outside
 * (a feed, a JSON API, a page, later an X post) is untrusted evidence and never an instruction. The rules, all applied
 * here and tested with hostile inputs in test/dataset-poison.test.ts:
 *
 *  1. Bounded before anything else. A string is cut to PRE_CUT characters before the first pattern runs over it, so a
 *     2 MB title costs a slice, and every stored field has its own small limit (TITLE_MAX, EXCERPT_MAX, HEADLINE_MAX,
 *     SUMMARY_MAX, LINK_MAX, and counts for entities, words, numbers and refs).
 *  2. No markup, nothing invisible. Tags, scripts, styles and CDATA wrappers are removed; only the five XML entities
 *     and numeric character references are decoded (no entity a document defines is ever expanded, so there is no
 *     entity bomb to expand); the text is folded to NFKC, and control, zero-width, direction, tag and filler
 *     characters are removed.
 *  3. A record's text is built by code from those bounded fields: a headline is a cleaned title cut to HEADLINE_MAX, a
 *     summary exists only where code wrote the sentence itself from numbers (layer a, metrics). No free text from a
 *     source is stored in a field that reads as an instruction to anyone: there is no "note", "advice" or "action"
 *     field, and nothing here is ever concatenated into a prompt by this stage.
 *  4. Text that reads like an instruction is withheld. A title or excerpt that addresses the reader ("ignore your
 *     rules", "you are", "system:", "post this"), or carries an address, a cashtag or an @handle, still counts as a
 *     sighting (the source did carry the event), but its words are not stored: the record's headline then comes from
 *     another source or from code ("an item from <source name>").
 *  5. Links are data. A link is kept only as a parsed https URL without credentials, on a host of the checked-in
 *     source list, with tracking parameters and the fragment removed and cut to LINK_MAX; anything else is dropped.
 *     Nothing in this module fetches a link it found in a source.
 *  6. Numbers are found by pattern, never taken as prose: a value, a unit and at most three cleaned words of what it
 *     counts, at most NUMBERS_MAX of them a sighting.
 *
 * Every fetch itself goes through web-reader.ts `fetchPublic` (public hosts only, redirects re-checked, byte and time
 * limits); see fetch.ts.
 */
import type { RecordNumber } from './types.js';

/** A string from outside is cut to this before any pattern runs over it. */
export const PRE_CUT = 8_000;
export const TITLE_MAX = 200;
export const EXCERPT_MAX = 300;
export const HEADLINE_MAX = 120;
export const SUMMARY_MAX = 280;
export const LINK_MAX = 500;
export const EXTERNAL_ID_MAX = 200;
export const NUMBERS_MAX = 4;

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The five XML entities, `&nbsp;` and numeric references; any other entity is left as the text it is. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function stripTags(text: string): string {
  return text
    .replace(/<!\[CDATA\[|\]\]>/g, ' ')
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[a-zA-Z!?][^<>]{0,2000}>/g, ' ');
}

/**
 * Characters a reader does not see or that change how the rest is read: C0 and C1 controls, soft hyphen, zero-width
 * and joiner characters, direction marks and overrides, line and paragraph separators, invisible operators, the
 * byte-order mark, Hangul and Mongolian fillers, variation selectors and the Unicode tag block.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202f], [0x205f, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff9, 0xfffb], [0xe0000, 0xe007f],
];
// Built from code points, so that no invisible character and no escape of one stands in this file.
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`, 'gu');

/** Cuts on a code point, never inside a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1) >= 0xd800 && text.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * A string from outside as the dataset may hold it: cut first, markup removed, entities decoded (a feed's description
 * is escaped HTML, so the pass runs twice), folded to NFKC, invisible characters removed, whitespace collapsed, cut to
 * `max`. Anything that is not a string or a number gives ''.
 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let text = cut(String(value), PRE_CUT);
  text = stripTags(decodeEntities(text));
  text = stripTags(decodeEntities(text));
  try {
    text = text.normalize('NFKC');
  } catch {
    // an unpaired surrogate: keep the text as it is, the next line removes what cannot be shown
  }
  text = text.replace(INVISIBLE, ' ').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, ' ');
  return cut(text.replace(/\s+/g, ' ').trim(), max).trim();
}

/** `text` cut to `max` at a word boundary, with an ellipsis when something was left out. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = cut(text, max - 1);
  const space = text.charAt(head.length) === ' ' ? head.length : head.lastIndexOf(' ');
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, '')}…`;
}

const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all|any|every|everything|your|the|these|those|previous|prior|above|earlier|system)\b/i,
  /\byou\s+(?:are|must|should|will|need to|have to)\b|\byou['’]re\b/i,
  /\b(?:system|assistant|developer|user|instructions?|prompt)\s*:/i,
  /\b(?:post|tweet|share|repost|retweet|publish|reply|say|write|announce)\s+(?:this|that|the following|exactly|with)\b/i,
  /\b(?:new|updated|following)\s+instructions?\b|\byour\s+(?:rules|instructions|system prompt|guidelines|task)\b/i,
  /\bas an? (?:ai|assistant|agent|language model)\b|\bdo not (?:tell|mention|reveal|disclose)\b/i,
  /0x[0-9a-fA-F]{40}\b/,
  /(?:^|[^A-Za-z0-9_])\$[A-Za-z][A-Za-z0-9]{1,9}\b/,
  /(?:^|[^A-Za-z0-9_.])@[A-Za-z0-9_]{1,15}\b/,
];

/**
 * Whether cleaned text reads like something addressed to the reader, or carries what a post must not pick up from a
 * stranger (an address, a cashtag, an @handle). Such a sighting is counted and its text withheld (rule 4 above).
 */
export function instructionShaped(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

const TRACKING = /^(?:utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|ref_url|source|src|cmpid|campaign|s|t)$/i;

/**
 * A link as data: an absolute https URL (http is read as https), without credentials or fragment, tracking parameters
 * removed and the rest sorted, no trailing slash, at most LINK_MAX characters, and, when `hosts` is given, on one of
 * those hosts (with or without `www.`). Null for anything else.
 */
export function canonicalLink(raw: unknown, hosts?: ReadonlySet<string>): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  if (hosts && !hosts.has(host) && !hosts.has(host.replace(/^www\./, ''))) return null;
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(params).toString();
  const path = url.pathname.replace(/\/+$/, '');
  const link = `https://${host}${path}${query ? `?${query}` : ''}`;
  return link.length > LINK_MAX ? null : link;
}

/** What two links are compared by: the canonical link without its scheme and a leading `www.`, `m.` or `mobile.`, lowercased host, path as written. */
export function linkKey(link: string): string {
  return link.replace(/^https:\/\//, '').replace(/^(?:www|m|mobile)\./, '');
}

const NUMBER = /(\$|€|£)?(?<![\w.,/-])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k|m|mn|b|bn|million|billion|thousand|trillion)?(%)?(?![\w/])/gi;
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, trillion: 1e12 };
const UNIT_AFTER = /^\s?(usdc|usdt|usd|eth|weth|btc|sol|bps)\b/i;
const NOT_A_FACT_AFTER = /^(?::\d{2}|\.\d|\s?(?:utc|am|pm|st|nd|rd|th)\b|(?:\s|-)(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b)/i;
const NOT_A_FACT_BEFORE = /(?:\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?|\b(?:v|version|eip|erc|rfc|q|no\.?|part|day|week|#))\s?$/i;

/**
 * The numbers a cleaned title states, by pattern: money, percentages and counts with what stands right after them.
 * Dates, clock times, years, versions and standard numbers (EIP-8004, v1.2.0) are not numbers about anything.
 */
export function numbersOf(text: string, sourceId: string, asOf: Date | null): RecordNumber[] {
  const out: RecordNumber[] = [];
  for (const m of text.matchAll(NUMBER)) {
    if (out.length >= NUMBERS_MAX) break;
    const at = m.index;
    const rest = text.slice(at + m[0].length, at + m[0].length + 40);
    const before = text.slice(Math.max(0, at - 12), at);
    const digits = Number(`${m[2]!.replace(/,/g, '')}${m[3] ?? ''}`);
    if (!Number.isFinite(digits)) continue;
    const plain = !m[1] && !m[4] && !m[5];
    if (plain && (NOT_A_FACT_AFTER.test(rest) || NOT_A_FACT_BEFORE.test(before))) continue;
    if (plain && !m[3] && digits >= 1900 && digits <= 2100) continue;
    const unitAfter = UNIT_AFTER.exec(rest)?.[1]?.toLowerCase();
    const unit = m[5] ? '%' : m[1] === '$' ? 'usd' : m[1] === '€' ? 'eur' : m[1] === '£' ? 'gbp' : (unitAfter ?? '');
    // A bare count needs a noun after it to be about something ("4 validators"); "Stage 1" or "top 10" is not a fact.
    const what = rest
      .replace(UNIT_AFTER, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');
    if (plain && !unit && !what) continue;
    out.push({ value: digits * (m[4] ? (SCALE[m[4].toLowerCase()] ?? 1) : 1), unit, what: what.slice(0, 40), asOf: asOf ? asOf.toISOString() : null, sourceId });
  }
  return out;
}

/** A date a source wrote, or null: only what `Date` parses to a time between 2009 and five years from `now`. */
export function parseDate(value: unknown, now: number): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value;
    return plausible(ms, now) ? new Date(ms) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, 64);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && plausible(ms, now) ? new Date(ms) : null;
}

function plausible(ms: number, now: number): boolean {
  return ms > Date.UTC(2009, 0, 1) && ms < now + 5 * 365 * 86_400_000;
}
