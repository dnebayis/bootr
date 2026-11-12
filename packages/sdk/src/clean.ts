/**
 * Text from the network, made safe to show a person and a model side by side: every character that takes no room on
 * the screen, or changes the order in which the others are read, is removed, so nobody reads one thing while the
 * model reads another. The MCP server passes every result and error through it, and the CLI everything it prints.
 *
 * Removed:
 *   - control characters, except tab, line feed and carriage return;
 *   - every format character (the Unicode category Cf): the zero-width spaces and marks, the bidirectional
 *     embeddings, overrides and isolates (U+202A-202E, U+2066-2069, U+061C), the soft hyphen (U+00AD), the word
 *     joiner, the byte order mark, the interlinear annotation marks, the language tag (U+E0001) and the tag
 *     characters (U+E0020-E007F), with which a whole sentence can ride along unseen;
 *   - every other code point Unicode says to display as nothing (Default_Ignorable_Code_Point): the Mongolian vowel
 *     separator (U+180E), the variation selectors (U+FE00-FE0F, U+E0100-E01EF), the Hangul fillers (U+115F, U+1160,
 *     U+3164, U+FFA0), the combining grapheme joiner (U+034F), and the rest of U+E0000-E0FFF;
 *   - the line and paragraph separators (U+2028, U+2029).
 *
 * The zero-width joiner (U+200D) is kept in one place only: between two pictographs, where it builds one emoji out of
 * several (a family, a profession, a flag). Anywhere else it is removed. An emoji loses its variation selector, so a
 * few are drawn in their text form, and a flag made of tag characters is drawn as its plain base flag. Nothing that
 * can be seen is changed beyond that.
 *
 * The characters are written here as numbers and built into the patterns: this file holds none of them itself.
 */

const JOINER = 0x200d;

/** Ranges removed besides the two Unicode properties; several repeat what the properties cover, on purpose. */
const REMOVED: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0xe0000, 0xe0fff],
];

const point = (code: number) => `\\u{${code.toString(16)}}`;

const INVISIBLE = new RegExp(`(?!${point(JOINER)})[\\p{Cf}\\p{Default_Ignorable_Code_Point}${REMOVED.map(([from, to]) => (from === to ? point(from) : `${point(from)}-${point(to)}`)).join('')}]`, 'gu');

/** A joiner that is not between two pictographs (a skin tone may sit before it). */
const STRAY_JOINER = new RegExp(`(?<![\\p{Extended_Pictographic}\\p{Emoji_Modifier}])${point(JOINER)}|${point(JOINER)}(?!\\p{Extended_Pictographic})`, 'gu');

/** One string with every invisible and direction-changing character removed. */
export function cleanText(text: string): string {
  return text.replace(INVISIBLE, '').replace(STRAY_JOINER, '');
}

/** A copy with invisible and direction-changing characters removed from every string, keys included. */
export function clean<T>(value: T): T {
  if (typeof value === 'string') return cleanText(value) as T;
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), clean(v)])) as T;
  return value;
}
