import { describe, expect, it } from 'vitest';
import { changedSections } from '@/lib/console-sections';
import { mock } from '@/lib/mock';
import { sanitizeConfig, validateChanges } from './supervisor';
import { EMPTY_WHAT_WORKS, sanitizeWhatWorks, WHAT_WORKS_MAX_CHARS } from './what-works';

const KERNEL = '0x2000000000000000000000000000000000000002';
const CONFIG = {
  agentId: '7',
  kernel: KERNEL,
  creator: '0x4000000000000000000000000000000000000004',
  model: 'openai/gpt-4.1-mini',
  worker: { kind: 'community', capabilities: {}, postIntervalMs: 7_200_000, jobLines: [] },
  revision: 3,
};

describe('the agent’s note on what works, as the console renders it', () => {
  it('keeps plain strings and bounded lists, and a current note only when it is listed', () => {
    const view = sanitizeWhatWorks({
      enabled: true,
      maxChars: 600,
      current: 'ww_2',
      nextRevisionAt: '2026-11-20T12:00:00.000Z',
      items: [
        { id: 'ww_2', text: 'Pictures draw more responses.', at: '2026-11-13T12:00:00.000Z', by: 'agent', facts: ['with a picture: 14 posts, median 9 responses; without: 31 posts, median 4', 7, null] },
        { id: 'ww_1', text: '', at: '2026-11-10T12:00:00.000Z', by: 'creator', facts: [] },
        { id: 'ww_0', text: 'x'.repeat(5000), at: '2026-11-01T12:00:00.000Z', by: 'someone', facts: Array.from({ length: 40 }, (_, i) => `line ${i} ${'y'.repeat(600)}`) },
        { id: 'no-time', text: 'dropped', at: 'yesterday' },
        { text: 'no id', at: '2026-11-01T12:00:00.000Z' },
        'not an item',
      ],
    });
    expect(view.items.map((i) => [i.id, i.by])).toEqual([
      ['ww_2', 'agent'],
      ['ww_1', 'creator'],
      ['ww_0', 'agent'],
    ]);
    expect(view.items[0]!.facts).toEqual(['with a picture: 14 posts, median 9 responses; without: 31 posts, median 4']);
    expect(view.items[2]!.text).toHaveLength(WHAT_WORKS_MAX_CHARS);
    expect(view.items[2]!.facts).toHaveLength(16);
    expect(view.items[2]!.facts[0]!.length).toBeLessThanOrEqual(300);
    expect(view).toMatchObject({ enabled: true, maxChars: 600, current: 'ww_2', nextRevisionAt: '2026-11-20T12:00:00.000Z' });
  });

  it('reads anything else as no note', () => {
    expect(sanitizeWhatWorks(null)).toEqual(EMPTY_WHAT_WORKS);
    expect(sanitizeWhatWorks({ items: 'nope', current: 'ww_9', maxChars: 99_999, nextRevisionAt: 'soon' })).toEqual(EMPTY_WHAT_WORKS);
    expect(sanitizeWhatWorks({ enabled: false, items: [] }).enabled).toBe(false);
    // a current id that names no listed version is not shown as one
    expect(sanitizeWhatWorks({ current: 'ww_gone', items: [{ id: 'ww_1', text: 'a', at: '2026-11-10T12:00:00.000Z', by: 'agent', facts: [] }] }).current).toBeNull();
  });

  it('mock mode has a note with the version before it, and a clear leaves none in force', () => {
    const before = mock.whatWorks(KERNEL);
    expect(before.items.length).toBeGreaterThanOrEqual(2);
    expect(before.current).toBe(before.items[0]!.id);
    expect(before.items[0]!.facts.length).toBeGreaterThan(0);
    const after = mock.clearWhatWorks(KERNEL);
    expect(after.current).toBeNull();
    expect(after.items[0]).toMatchObject({ by: 'creator', text: '' });
    expect(after.items.slice(1).map((i) => i.id)).toEqual(before.items.map((i) => i.id));
    // clearing again writes nothing more
    expect(mock.clearWhatWorks(KERNEL).items).toHaveLength(after.items.length);
  });
});

describe('comments and who gets a reply in the config', () => {
  it('reads the two fields from the agent service, with the defaults for a service that sends none', () => {
    expect(sanitizeConfig(CONFIG)).toMatchObject({ comments: true, replyAudience: 'verified' });
    expect(sanitizeConfig({ ...CONFIG, comments: false, replyAudience: 'own_threads' })).toMatchObject({ comments: false, replyAudience: 'own_threads' });
    expect(sanitizeConfig({ ...CONFIG, comments: 'no', replyAudience: 'everyone' })).toMatchObject({ comments: true, replyAudience: 'verified' });
  });

  it('accepts a change of each', () => {
    expect(validateChanges({ comments: false })).toEqual({ ok: true, changes: { comments: false } });
    expect(validateChanges({ replyAudience: 'own_threads' })).toEqual({ ok: true, changes: { replyAudience: 'own_threads' } });
  });

  it('refuses what is not a switch or one of the two audiences, and names the field', () => {
    const refused: [unknown, string][] = [
      [{ comments: 'off' }, 'comments'],
      [{ replyAudience: 'everyone' }, 'replyAudience'],
      [{ replyAudience: null }, 'replyAudience'],
    ];
    for (const [changes, field] of refused) expect(validateChanges(changes), JSON.stringify(changes)).toMatchObject({ ok: false, field });
  });

  it('puts an unsaved change on the tab that holds its control', () => {
    expect(changedSections({ comments: false })).toEqual(['posting']);
    expect(changedSections({ replyAudience: 'own_threads' })).toEqual(['posting']);
  });

  it('mock mode applies the two fields and says so on the tape in plain words', () => {
    const kernel = '0x2000000000000000000000000000000000000abc';
    expect(mock.agentConfig(kernel)).toMatchObject({ comments: true, replyAudience: 'verified' });
    const r = mock.updateAgentConfig(kernel, { comments: false, replyAudience: 'own_threads' }, '0x00000000000000000000000000000000000e2e01');
    expect(r.ok && r.config).toMatchObject({ comments: false, replyAudience: 'own_threads' });
    expect(mock.updateAgentConfig(kernel, { comments: false }, '0x00000000000000000000000000000000000e2e01')).toMatchObject({ ok: false, status: 409 });
  });
});

describe('a coin has no accounts to follow', () => {
  it('a list an agent service still sends is not passed on to the page, whatever it holds', () => {
    for (const stored of [['alice', 'bob_1'], [], 'alice', 42, null, ['@x', 'Not A Handle']]) {
      const config = sanitizeConfig({ ...CONFIG, watchlist: stored, comments: false });
      expect(config, JSON.stringify(stored)).not.toBeNull();
      expect(config, JSON.stringify(stored)).not.toHaveProperty('watchlist');
      expect(config).toMatchObject({ comments: false, replyAudience: 'verified' });
    }
  });

  it('a list a page still sends is dropped from the changes, well formed or not, and the other changes stand', () => {
    for (const sent of [['alice'], [], 'alice', ['a', 'b', 'c', 'd', 'e', 'f'], [42]]) {
      expect(validateChanges({ watchlist: sent, comments: false }), JSON.stringify(sent)).toEqual({ ok: true, changes: { comments: false } });
      // alone it is no change at all
      expect(validateChanges({ watchlist: sent }), JSON.stringify(sent)).toEqual({ ok: false, field: 'changes', message: 'Nothing to change.' });
    }
    expect(changedSections({ watchlist: ['alice'] } as never)).toEqual([]);
  });

  it('mock mode keeps no list and takes none', () => {
    const kernel = '0x2000000000000000000000000000000000000abc';
    expect(mock.agentConfig(kernel)).not.toHaveProperty('watchlist');
    expect(mock.updateAgentConfig(kernel, { watchlist: ['alice'] } as never, '0x00000000000000000000000000000000000e2e01')).toMatchObject({ ok: false, status: 409 });
  });
});
