/**
 * What `remember` takes, and how its input is forgiven (docs/design/agent-behaviour.md section 6.2).
 *
 * A refused tool call is a thought the agent paid for and got nothing from. `remember` was refused for the shape of a
 * field that does not matter to the note: `tags` sent as one string ("base, x402") instead of a list was the most
 * common refusal in the logs. So the fields that only label a note are forgiven here, before the schema sees them: a
 * value that can be read is put into shape, one that cannot is dropped, and the note is kept either way. The text of
 * a note and its sources are not forgiven: they are what the note is.
 *
 * A note can say what it is (`kind`) and name its subject (`subject`). The same kind and subject again updates that
 * note in place, so one person or one topic is one note. The field is not called `key`: the MCP server that hands these
 * tools to a creator's own AI client lets no tool take a parameter whose name reads like a secret (packages/mcp). A promise carries a due time and stays open until it is closed.
 * One call takes up to `MAX_NOTES_PER_REMEMBER` notes: the first in the call's own fields, the others in `more`.
 */

/** What a typed note is about: someone the agent spoke with, something it said it would do, what it learned about its own posting, a fact about its own coin. */
export const NOTE_KINDS = ['person', 'promise', 'lesson', 'coin'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Notes one `remember` call takes. */
export const MAX_NOTES_PER_REMEMBER = 5;
export const NOTE_TAG_RE = /^[a-z0-9-]{1,32}$/;
export const NOTE_SUBJECT_RE = /^[a-z0-9-]{1,64}$/;
export const NOTE_MAX_TAGS = 8;

/** Other words a model uses for a kind. Anything else is no kind: the note is kept without one. */
const KIND_WORDS: Record<string, NoteKind> = {
  person: 'person',
  people: 'person',
  promise: 'promise',
  promises: 'promise',
  lesson: 'lesson',
  lessons: 'lesson',
  coin: 'coin',
  'coin-fact': 'coin',
  'own-coin': 'coin',
};

/** `value` as a slug of at most `max` characters (lowercase letters, digits, single dashes), or null when nothing is left. */
export function noteSlug(value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const slug = String(value)
    .normalize('NFKD')
    // An accented letter is its letter: the mark NFKD split off goes, the letter stays.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || null;
}

/**
 * Tags as the schema wants them, from whatever was sent: a string is split on commas, a list is taken item by item,
 * each tag is slugged, one that leaves nothing is dropped, repeats are dropped and the list is cut to `NOTE_MAX_TAGS`.
 * Undefined (no tags) for anything else, and when nothing is left.
 */
export function forgivenTags(value: unknown): string[] | undefined {
  const parts: unknown[] = typeof value === 'string' ? value.split(/[,;\n]+/) : Array.isArray(value) ? value.flatMap((v) => (typeof v === 'string' ? v.split(/[,;\n]+/) : [v])) : [];
  const tags = [...new Set(parts.map((p) => noteSlug(p, 32)).filter((t): t is string => t !== null))].slice(0, NOTE_MAX_TAGS);
  return tags.length ? tags : undefined;
}

/** A kind the catalog knows, or undefined: an unknown kind never costs the note. */
export function forgivenKind(value: unknown): NoteKind | undefined {
  const word = noteSlug(value, 32);
  return word ? KIND_WORDS[word] : undefined;
}

/** A subject as a slug, or undefined. */
export function forgivenSubject(value: unknown): string | undefined {
  return noteSlug(value, 64) ?? undefined;
}

/** A time that parses, as an ISO string, or undefined. */
export function forgivenDate(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const at = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) && Math.abs(at) < 8.64e15 ? new Date(at).toISOString() : undefined;
}

/** True for `true` and "true"; undefined for anything else (a flag that is not set is absent, never refused). */
export function forgivenFlag(value: unknown): true | undefined {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true') ? true : undefined;
}

/** `more` as a list: one note given alone becomes a list of one, and a bare string a note with that text. Anything else is left for the schema to refuse. */
export function forgivenMore(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  const list = Array.isArray(value) ? value : typeof value === 'object' || typeof value === 'string' ? [value] : value;
  return Array.isArray(list) ? list.map((item) => (typeof item === 'string' ? { text: item } : item)) : list;
}

/** One note as `remember` takes it. */
export interface NoteInput {
  text: string;
  sources?: string[] | undefined;
  tags?: string[] | undefined;
  kind?: NoteKind | undefined;
  subject?: string | undefined;
  dueAt?: string | undefined;
  done?: boolean | undefined;
}

/** The notes of one parsed `remember` input, in order: its own fields first, then `more`. */
export function notesOf(input: NoteInput & { more?: NoteInput[] | undefined }): NoteInput[] {
  const { more, ...first } = input;
  return [first, ...(more ?? [])];
}
