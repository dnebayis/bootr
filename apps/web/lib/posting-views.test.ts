import { describe, expect, it } from 'vitest';
import { aboutHref, aboutParts, scheduledNote } from './posting-views';

describe('aboutHref', () => {
  it('builds the link to the post on X from the handle and the post id', () => {
    expect(aboutHref({ handle: 'base', postId: '1850000000000000001' })).toBe('https://x.com/base/status/1850000000000000001');
    expect(aboutHref({ handle: 'A_b9', postId: '7' })).toBe('https://x.com/A_b9/status/7');
  });

  it('never reads a link that came with them', () => {
    expect(aboutHref({ handle: 'base', postId: '12', url: 'https://evil.example/steal' })).toBe('https://x.com/base/status/12');
    expect(aboutHref({ url: 'https://x.com/base/status/12' })).toBeNull();
  });

  it('refuses a handle or a post id that is not in X’s own form', () => {
    for (const handle of ['', 'a/b', '../../i/flow/login', '<script>alert(1)</script>', 'a b', 'name?x=1', 'x.com', 'abcdefghijklmnop', '@base', 'bäse', 7, null, undefined, ['base']]) {
      expect(aboutHref({ handle, postId: '12' }), String(handle)).toBeNull();
    }
    for (const postId of ['', '12a', '-1', '1.5', '12/photo/1', '12?s=20', '1'.repeat(26), ' 12', 12, null, undefined]) {
      expect(aboutHref({ handle: 'base', postId }), String(postId)).toBeNull();
    }
    for (const about of [null, undefined, 'base/12', 12, [], [{ handle: 'base', postId: '12' }]]) expect(aboutHref(about)).toBeNull();
  });
});

describe('aboutParts', () => {
  it('splits the line around the words that name the source', () => {
    expect(aboutParts('Commented on a post by @base', 'base')).toEqual({ before: 'Commented on ', link: 'a post by @base', after: '' });
    // what follows the name (the mark of an own agent) is kept
    expect(aboutParts('Commented on a post by @base · own agent', 'base')).toEqual({ before: 'Commented on ', link: 'a post by @base', after: ' · own agent' });
  });

  it('keeps a line that does not name the source whole, and the link follows it', () => {
    expect(aboutParts('Posted on X', 'base')).toEqual({ before: 'Posted on X ', link: 'The post by @base', after: '' });
  });
});

describe('scheduledNote', () => {
  const fmt = { when: () => 'Fri 14 Nov, 10:00', until: (_iso: string, now: number) => (now ? 'in 3 h' : '') };
  const at = '2026-11-14T10:00:00.000Z';

  it('says when the post goes out, and that only an approval lets it', () => {
    expect(scheduledNote(at, Date.parse(at) - 3 * 3_600_000, fmt)).toBe('Goes out Fri 14 Nov, 10:00 (in 3 h), and only if you approve it. Not approved in time, it is not sent.');
  });

  it('names the time alone until the page knows what time it is', () => {
    expect(scheduledNote(at, 0, fmt)).toBe('Goes out Fri 14 Nov, 10:00, and only if you approve it. Not approved in time, it is not sent.');
  });

  it('says a post whose time has come goes out at once when approved, and that one too late is not sent', () => {
    expect(scheduledNote(at, Date.parse(at) + 60_000, fmt)).toBe('Its time was Fri 14 Nov, 10:00. Approve it and it goes out at once; a post too far past its time is not sent.');
    expect(scheduledNote(at, Date.parse(at), fmt)).toMatch(/^Its time was/);
  });

  it('uses no internal words', () => {
    for (const now of [0, Date.parse(at) - 1000, Date.parse(at) + 1000]) expect(scheduledNote(at, now, fmt)).not.toMatch(/\b(runner|kernel|session key|relay|lease|tick|supervisor|grace|sweep)\b/i);
  });
});
