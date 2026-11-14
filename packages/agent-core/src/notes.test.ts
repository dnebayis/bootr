import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from './json-schema.js';
import { MAX_NOTES_PER_REMEMBER, NOTE_KINDS, forgivenDate, forgivenFlag, forgivenSubject, forgivenKind, forgivenMore, forgivenTags, noteSlug, notesOf } from './notes.js';
import { TOOLS, toFunctionDefinitions } from './tools.js';
import { parseAction, toolInputSchemas } from './types.js';

const remember = (input: unknown) => {
  const action = parseAction({ tool: 'remember', input });
  if (action.tool !== 'remember') throw new Error('not a remember action');
  return action.input;
};

describe('remember: what labels a note is forgiven, never refused', () => {
  it('takes tags as one string, splits it on commas, slugs each tag and drops what is left empty', () => {
    // The refusal the logs showed four times in one day: `input.tags:invalid_type`.
    expect(remember({ text: 'a note', tags: 'base, x402' }).tags).toEqual(['base', 'x402']);
    expect(remember({ text: 'a note', tags: 'Base L2; #Agents,  ,!!!' }).tags).toEqual(['base-l2', 'agents']);
    expect(remember({ text: 'a note', tags: ['Price Talk', 'ok', 42, null, { a: 1 }, 'ok', ''] }).tags).toEqual(['price-talk', 'ok', '42']);
    expect(remember({ text: 'a note', tags: ['a,b', 'c'] }).tags).toEqual(['a', 'b', 'c']);
  });

  it('keeps the note when tags cannot be read at all, and cuts a long list instead of refusing it', () => {
    for (const tags of [null, 7, true, {}, '', [], ['!!!']]) {
      const input = remember({ text: 'kept', tags });
      expect(input.text).toBe('kept');
      expect(input.tags).toBeUndefined();
    }
    expect(remember({ text: 'kept', tags: Array.from({ length: 20 }, (_, i) => `t${i}`) }).tags).toHaveLength(8);
    expect(remember({ text: 'kept', tags: 'x'.repeat(80) }).tags).toEqual(['x'.repeat(32)]);
  });

  it('a tag that was valid before is unchanged, so what was accepted yesterday parses the same today', () => {
    expect(remember({ text: 'TEST trades at $0.01 on 2026-10-24', tags: ['price'], sources: ['https://example.com/a'] })).toEqual({ text: 'TEST trades at $0.01 on 2026-10-24', tags: ['price'], sources: ['https://example.com/a'] });
    expect(remember({ text: 'note' })).toEqual({ text: 'note' });
    expect(remember({ text: 'for the treasury turn', tags: ['treasury'] }).tags).toEqual(['treasury']);
  });

  it('reads a kind, a subject, a due time and done, and drops any of them it cannot read', () => {
    const typed = remember({ text: 'said I would read the Base post', kind: 'Promise', subject: 'Base Post #1', dueAt: '2026-11-16T10:00:00Z', done: 'true' });
    expect(typed).toEqual({ text: 'said I would read the Base post', kind: 'promise', subject: 'base-post-1', dueAt: '2026-11-16T10:00:00.000Z', done: true });
    const loose = remember({ text: 'kept anyway', kind: 'outside-fact', subject: '???', dueAt: 'next week', done: 'maybe' });
    expect(loose).toEqual({ text: 'kept anyway' });
    expect(remember({ text: 'x', kind: 'people' }).kind).toBe('person');
    expect(remember({ text: 'x', kind: 'coin_fact' }).kind).toBe('coin');
    expect(remember({ text: 'x', done: false }).done).toBeUndefined();
  });

  it('takes up to five notes in one call: the first in the call, the others in more', () => {
    const input = remember({ text: 'one', kind: 'person', subject: 'alice', more: [{ text: 'two', tags: 'a, b' }, 'three', { text: 'four', kind: 'lesson' }, { text: 'five' }] });
    expect(notesOf(input)).toEqual([{ text: 'one', kind: 'person', subject: 'alice' }, { text: 'two', tags: ['a', 'b'] }, { text: 'three' }, { text: 'four', kind: 'lesson' }, { text: 'five' }]);
    expect(notesOf(input)).toHaveLength(MAX_NOTES_PER_REMEMBER);
    // One note given alone in `more` is a list of one.
    expect(notesOf(remember({ text: 'one', more: { text: 'two' } })).map((n) => n.text)).toEqual(['one', 'two']);
    expect(notesOf(remember({ text: 'alone' }))).toEqual([{ text: 'alone' }]);
  });

  it('still refuses what is not a note: no text, a sixth note, a source that is not https, an unknown field', () => {
    expect(() => remember({ tags: ['a'] })).toThrow();
    expect(() => remember({ text: '   ' })).toThrow();
    expect(() => remember({ text: 'one', more: [{ text: '2' }, { text: '3' }, { text: '4' }, { text: '5' }, { text: '6' }] })).toThrow();
    expect(() => remember({ text: 'one', more: [{ tags: ['no-text'] }] })).toThrow();
    expect(() => remember({ text: 'x', sources: ['http://plain.example'] })).toThrow();
    expect(() => remember({ text: 'x', sources: ['creator-chat'] })).toThrow();
    expect(() => remember({ text: 'x', more: 7 })).toThrow();
    expect(() => remember({ text: 'x', visibility: 'public' })).toThrow();
    expect(() => remember({ text: 'x', more: [{ text: 'y', more: [{ text: 'z' }] }] })).toThrow();
  });
});

describe('remember: the helpers', () => {
  it('slug, kind, subject, date, flag and more', () => {
    expect(noteSlug('  Héllo  Wörld__x ', 64)).toBe('hello-world-x');
    expect(noteSlug('abc-def', 4)).toBe('abc');
    expect(noteSlug({}, 8)).toBeNull();
    expect(forgivenTags('one')).toEqual(['one']);
    expect(forgivenTags(undefined)).toBeUndefined();
    for (const kind of NOTE_KINDS) expect(forgivenKind(kind)).toBe(kind);
    expect(forgivenKind('note')).toBeUndefined();
    expect(forgivenKind(null)).toBeUndefined();
    expect(forgivenSubject('@Jesse Pollak')).toBe('jesse-pollak');
    expect(forgivenSubject(undefined)).toBeUndefined();
    expect(forgivenDate('2026-11-16')).toBe('2026-11-16T00:00:00.000Z');
    expect(forgivenDate(Date.UTC(2026, 10, 16))).toBe('2026-11-16T00:00:00.000Z');
    expect(forgivenDate('soon')).toBeUndefined();
    expect(forgivenDate(Number.MAX_VALUE)).toBeUndefined();
    expect(forgivenFlag(true)).toBe(true);
    expect(forgivenFlag(' TRUE ')).toBe(true);
    expect(forgivenFlag(1)).toBeUndefined();
    expect(forgivenMore(null)).toBeUndefined();
    expect(forgivenMore('a')).toEqual([{ text: 'a' }]);
    expect(forgivenMore(5)).toBe(5);
  });
});

describe('remember: what the model is shown', () => {
  it('is a plain object schema with the shape behind each forgiven field, text alone required', () => {
    const schema = zodToJsonSchema(toolInputSchemas.remember) as { type: string; required: string[]; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['text']);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(['text', 'sources', 'tags', 'kind', 'subject', 'dueAt', 'done', 'more']);
    expect(schema.properties.tags).toEqual({ type: 'array', items: { type: 'string', pattern: '^[a-z0-9-]{1,32}$' }, maxItems: 8 });
    expect(schema.properties.kind).toEqual({ type: 'string', enum: ['person', 'promise', 'lesson', 'coin'] });
    expect(schema.properties.subject).toEqual({ type: 'string', pattern: '^[a-z0-9-]{1,64}$' });
    expect(schema.properties.done).toEqual({ type: 'boolean' });
    const more = schema.properties.more as { type: string; maxItems: number; items: { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean } };
    expect(more.type).toBe('array');
    expect(more.maxItems).toBe(4);
    expect(more.items.required).toEqual(['text']);
    expect(more.items.additionalProperties).toBe(false);
    expect(Object.keys(more.items.properties)).toEqual(['text', 'sources', 'tags', 'kind', 'subject', 'dueAt', 'done']);
  });

  it('says in its description that one call takes several notes and a turn takes two calls', () => {
    const [definition] = toFunctionDefinitions([TOOLS.remember]);
    expect(definition!.function.description).toContain('One call takes up to 5 notes');
    expect(definition!.function.description).toContain('twice at most');
    expect(definition!.function.description).toContain('done: true');
  });
});
