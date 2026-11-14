/**
 * What a post says, reduced to something code can compare (docs/design/agent-behaviour.md section 5, M1 and M8).
 * Repetition lives in the facts, not the words: an agent that writes "112 holders" in six different sentences has
 * said one thing six times, and word overlap does not see it.
 *
 * `factFingerprints`: one string per number in the text, `subject:value[unit]`, where the value is rounded to two
 * significant figures, the unit is what is written on the number (`%`, `$`, or the token or word right after it) and
 * the subject is the nearest word of a fixed list in the same sentence (`none` when there is none). Dates, clock times,
 * years and "24h" windows are not facts and give no fingerprint; neither does a contract address. A small number
 * written as a word right before a subject word ("six holders") is the number it names: one coin agent's week of
 * 8 to 14 November 2026 said "six holders" in 18 originals and "five holders" in 13, and not one of them in digits.
 * `postFacts`: the same numbers one by one, each with its subject, its unit, its fingerprint and the value as written
 * (not rounded), so a reader that must tell 112 holders from 114 can: both round to one fingerprint.
 * `openerOf`: the first three words, lowercased, numbers as `#`, handles as `@`.
 * All three are pure and need no model. The said-ledger, the repeat gate and the weekly check all read these two functions,
 * so a change here changes all three together.
 */
const SUBJECTS: readonly [string, RegExp][] = [
  ['holders', /\bholders?\b/i],
  ['trades', /\b(?:trades?|swaps?|buys?|sells?)\b/i],
  ['volume', /\b(?:volume|traded)\b/i],
  ['fee', /\b(?:fees?|tax)\b/i],
  ['burn', /\b(?:burn(?:ed|s|ing)?)\b/i],
  ['split', /\b(?:split|share|creator|platform|agent)\b/i],
  ['supply', /\bsupply\b/i],
  ['treasury', /\b(?:treasury|balance|fuel)\b/i],
  ['price', /\b(?:price|market ?cap|mcap|floor|liquidity)\b/i],
  ['coins', /\b(?:coins?|tokens?|launch(?:es|ed)?)\b/i],
  ['agents', /\bagents?\b/i],
  ['posts', /\b(?:posts?|repl(?:y|ies)|mentions?)\b/i],
  ['users', /\b(?:users?|wallets?|accounts?|followers?|developers?|builders?)\b/i],
  ['payments', /\b(?:payments?|transactions?|transfers?|revenue|earned)\b/i],
];
/**
 * Two to twelve in words, read as a number only when a subject word follows at once ("six holders", "three wallets").
 * "one" is left out: it is an article more often than a count ("one agent wrote", "no one").
 */
const NUMBER_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const WORDED_NUMBER = new RegExp(`\\b(${NUMBER_WORDS.join('|')})(?=\\s+(?:${SUBJECTS.map(([, re]) => re.source.replace(/^\\b|\\b$/g, '')).join('|')})\\b)`, 'gi');
const ADDRESS = /0x[0-9a-fA-F]{6,}/g;
const LINK = /https?:\/\/\S+/g;
/** A number as written: an optional `$`, digits with separators, an optional decimal part, an optional k/m/b, an optional `%`. */
const NUMBER = /(\$)?(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k|m|mn|b|bn|million|billion|thousand)?(%)?(?![\w])/gi;
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const UNIT_AFTER = /^\s?(weth|eth|usdc|usd|btc|cbbtc|sol|bps|x)\b/i;
/** A month by its name or its short form, and nothing longer: "3 markets" and "12 decentralized apps" are counts, not dates. */
const MONTH_NAME = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH = new RegExp(`^(?:\\s|-)?${MONTH_NAME}\\b`, 'i');
const MONTH_BEFORE = new RegExp(`\\b${MONTH_NAME}\\s$`, 'i');
const TIME_AFTER = /^(?::\d{2}|\s?(?:utc|am|pm|h|hr|hrs|hours?|d|days?|min|mins|minutes?|weeks?|months?|years?|st|nd|rd|th)\b)/i;
/** How close after a number its own noun stands, in characters. */
const FOLLOWS_WITHIN = 25;
const DAY_BEFORE = /\b(?:day|week|episode|ep|v|version|part|step|q)\s?$/i;
/** The number of a standard or a model, written after a hyphen ("ERC-8004", "EIP-1559", "GPT-5"): a name, not a count. */
const LABEL_BEFORE = /[a-z]-$/i;
/** The second day of a range of dates: "between Oct 12 and 23", "12-23 November". */
const RANGE_BEFORE = new RegExp(`\\b${MONTH_NAME}\\s\\d{1,2}(?:st|nd|rd|th)?\\s?(?:and|to|-|–|—)\\s?$`, 'i');
const RANGE_AFTER = new RegExp(`^\\s?(?:and|to|-|–|—)\\s?\\d{1,2}(?:st|nd|rd|th)?\\s${MONTH_NAME}\\b`, 'i');

/** One number a post states. */
export interface PostFact {
  /** `subject:value[unit]`, the value rounded to two significant figures: what `factFingerprints` lists. */
  fingerprint: string;
  subject: string;
  unit: string;
  /** The number as written with its k / m / b applied, not rounded. */
  value: number;
}

/** `value` to two significant figures, as a short string (`1200` -> `1.2e3`, `0.0475` -> `4.8e-2`, `487` -> `4.9e2`). */
function twoFigures(value: number): string {
  if (value === 0) return '0';
  return value.toExponential(1).replace('+', '');
}

export function postFacts(text: string): PostFact[] {
  if (typeof text !== 'string' || !text) return [];
  const out = new Map<string, PostFact>();
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.replace(ADDRESS, ' ').replace(LINK, ' ').replace(WORDED_NUMBER, (word) => String(NUMBER_WORDS.indexOf(word.toLowerCase()) + 2));
    for (const m of sentence.matchAll(NUMBER)) {
      const at = m.index;
      const before = sentence.slice(Math.max(0, at - 12), at);
      const rest = sentence.slice(at + m[0].length);
      const digits = Number(`${m[2]!.replace(/,/g, '')}${m[3] ?? ''}`);
      if (!Number.isFinite(digits)) continue;
      const plain = !m[1] && !m[4] && !m[5];
      // Dates, times, windows, ordinals and labels ("day 7", "v5") are not facts about anything.
      if (plain && (MONTH.test(rest) || MONTH_BEFORE.test(before) || TIME_AFTER.test(rest) || DAY_BEFORE.test(before))) continue;
      if (plain && (LABEL_BEFORE.test(before) || RANGE_BEFORE.test(sentence.slice(Math.max(0, at - 24), at)) || RANGE_AFTER.test(rest))) continue;
      if (plain && !m[3] && digits >= 1990 && digits <= 2100) continue;
      const unitAfter = UNIT_AFTER.exec(rest)?.[1]?.toLowerCase();
      const unit = m[5] ? '%' : m[1] ? '$' : unitAfter && unitAfter !== 'usd' ? unitAfter : unitAfter === 'usd' ? '$' : '';
      const value = digits * (m[4] ? (SCALE[m[4].toLowerCase()] ?? 1) : 1);
      // The subject: the nearest word of the list that follows the number closely ("112 holders", "50% to the
      // creator"), else the nearest one anywhere in the sentence ("the fee pool holds 0.0475 WETH").
      let subject = 'none';
      let best = Infinity;
      let after = Infinity;
      for (const [name, re] of SUBJECTS) {
        for (const s of sentence.matchAll(new RegExp(re.source, 'gi'))) {
          const follows = s.index >= at;
          const distance = follows ? s.index - (at + m[0].length) : at - (s.index + s[0].length);
          if (follows && distance <= FOLLOWS_WITHIN && distance < after) {
            after = distance;
            subject = name;
          } else if (after === Infinity && distance < best) {
            best = distance;
            subject = name;
          }
        }
      }
      const fingerprint = `${subject}:${twoFigures(value)}${unit}`;
      out.set(`${fingerprint}=${value}`, { fingerprint, subject, unit, value });
    }
  }
  return [...out.values()];
}

export function factFingerprints(text: string): string[] {
  return [...new Set(postFacts(text).map((fact) => fact.fingerprint))].sort();
}

export function openerOf(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(LINK, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => (/^[@＠]\w+/.test(w) ? '@' : /\d/.test(w) ? '#' : w.replace(/[^\p{L}\p{N}$'-]/gu, '')))
    .filter(Boolean)
    .join(' ');
}
