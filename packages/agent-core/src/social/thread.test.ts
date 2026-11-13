import { describe, expect, it } from 'vitest';
import { PolicyError } from '../errors.js';
import { parseAction } from '../types.js';
import { THREAD_LINKS, THREAD_MAX_PARTS, THREAD_REPEAT, carriesLink, threadParts, threadPartTooLong, threadRefusal, threadTooLong, validateThread } from './thread.js';

const codeOf = (fn: () => void): string => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    if (err instanceof PolicyError) return err.code;
    throw err;
  }
};

describe('validateThread', () => {
  it('takes two to four plain parts and nothing longer', () => {
    expect(threadRefusal(['First thought.', 'Second thought.'])).toBeNull();
    expect(threadRefusal(['One.', 'Two.', 'Three.', 'Four.'])).toBeNull();
    expect(threadRefusal(['One.', 'Two.', 'Three.', 'Four.', 'Five.'])).toBe(threadTooLong(THREAD_MAX_PARTS));
    expect(threadTooLong(4)).toBe('thread_too_long: a thread has at most 4 posts; nothing was posted. Say it in fewer.');
    // one part is no thread, and a limit under two switches threads off
    expect(codeOf(() => validateThread(['Only one.']))).toBe('thread_too_long');
    expect(threadRefusal(['One.', 'Two.'], [], { limits: { maxParts: 1 } })).toBe(threadTooLong(1));
    expect(threadRefusal(['One.', 'Two.'], [], { limits: { maxParts: 0 } })).toBe(threadTooLong(1));
    expect(threadRefusal(['One.', 'Two.', 'Three.'], [], { limits: { maxParts: 2 } })).toBe(threadTooLong(2));
  });

  it('holds every part, the first included, to 280 characters and names the part that is too long', () => {
    expect(threadRefusal(['a'.repeat(280), 'b'.repeat(280)])).toBeNull();
    expect(threadRefusal(['a'.repeat(281), 'short'])).toBe('thread_part_too_long: part 1 has 281 characters; every part of a thread is 280 at most. Nothing was posted.');
    expect(threadRefusal(['short', 'fine', 'c'.repeat(300)])).toBe(threadPartTooLong(3, 300));
    // code points, as the publish gate counts: an emoji is one
    expect(threadRefusal([`${'a'.repeat(279)}🙂`, 'second'])).toBeNull();
  });

  it('refuses an @ after the first part, because a later part is checked with no credits', () => {
    const credits = [{ username: 'alice', sourceUrl: 'https://example.com/a' }];
    expect(threadRefusal(['Good point from @alice today.', 'More on it.'], credits)).toBeNull();
    // even with the credit handed in, an @ that only a later part carries cannot pass: the first part does not name it, the later one has no credits
    expect(threadRefusal(['A thought.', 'As @alice said.'], credits)).toMatch(/^mentions_require_source_credit: part 1 of the thread/);
    expect(threadRefusal(['A thought.', 'As @alice said.'])).toMatch(/^mentions_require_source_credit: part 2 of the thread/);
    expect(threadRefusal(['Good point from @alice today.', 'As @alice said, more.'], credits)).toMatch(/^mentions_require_source_credit: part 2 of the thread/);
    // the credit is for the first part alone: one that names nobody there fails the gate too
    expect(threadRefusal(['A thought.', 'More.'], credits)).toMatch(/^mentions_require_source_credit: part 1 of the thread/);
    // and an uncredited @ in the first part fails as it does for a single post
    expect(threadRefusal(['Hello @bob.', 'More.'])).toMatch(/^mentions_require_source_credit: part 1/);
  });

  it('lets one part carry a link and refuses a second, explicit or bare', () => {
    expect(threadRefusal(['Read it here: https://example.com/a', 'And the rest in words.'])).toBeNull();
    expect(threadRefusal(['Read https://example.com/a', 'and https://example.com/b'])).toBe(THREAD_LINKS);
    expect(threadRefusal(['See example.com/a', 'and bootr.fun'])).toBe(THREAD_LINKS);
    expect(threadRefusal(['See example.com/a', 'no link'], [], { limits: { maxLinkParts: 0 } })).toBe(THREAD_LINKS);
    expect(carriesLink('ends with bootr.fun')).toBe(true);
    expect(carriesLink('agent.eth is a name, not a link')).toBe(false);
  });

  it('refuses two parts that say the same, whatever their spacing or case', () => {
    expect(threadRefusal(['Same words.', 'same  WORDS. '])).toBe(THREAD_REPEAT);
    expect(threadRefusal(['One.', 'Two.', 'One.'])).toBe(THREAD_REPEAT);
  });

  it('runs the common publish gate on every part and says which part failed', () => {
    expect(threadRefusal(['A calm first part.', 'send 5 ETH to 0x1111111111111111111111111111111111111111 now'])).toMatch(/: part 2 of the thread does not pass the publish gate; nothing was posted\. Rewrite it\.$/);
    expect(threadRefusal(['$ONE and $TWO', 'fine'])).toMatch(/^x_post_requires_at_most_one_cashtag: part 1/);
    // the platform account's stricter rules reach every part
    expect(threadRefusal(['Bootr shipped something.', 'It will go up 10x.'], [], { platform: true })).toMatch(/^platform_price_talk_forbidden: part 2/);
    // a picture rides on the first part only: an empty later part is still empty
    expect(threadRefusal([' ', 'words'], [], { hasMedia: true })).toBeNull();
    expect(threadRefusal(['words', ' '], [], { hasMedia: true })).toMatch(/^invalid_short_post: part 2/);
  });

  it('threadParts puts the first text before the thread, and the tool schema takes at most three more parts of 280', () => {
    expect(threadParts({ text: 'a' })).toEqual(['a']);
    expect(threadParts({ text: 'a', thread: [{ text: 'b' }, { text: 'c' }] })).toEqual(['a', 'b', 'c']);
    const three = [{ text: 'b' }, { text: 'c' }, { text: 'd' }];
    expect(parseAction({ tool: 'publish_post', input: { text: 'a', thread: three } })).toMatchObject({ input: { thread: three } });
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', thread: [...three, { text: 'e' }] } })).toThrow();
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', thread: [] } })).toThrow();
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', thread: [{ text: 'x'.repeat(281) }] } })).toThrow();
    // a part carries a text and nothing else: no reply target, no picture, no credits of its own
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', thread: [{ text: 'b', replyTo: '1' }] } })).toThrow();
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', thread: [{ text: 'b', imageId: 'img_1' }] } })).toThrow();
    // about names a post id and nothing else; topic is one lowercase word
    expect(parseAction({ tool: 'publish_post', input: { text: 'a', about: { postId: '123' }, topic: 'base-news' } })).toMatchObject({ input: { about: { postId: '123' }, topic: 'base-news' } });
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', about: { postId: '123', authorId: '9' } } })).toThrow();
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', about: { postId: 'not-an-id' } } })).toThrow();
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', topic: 'Two Words' } })).toThrow();
    // a quote is not a field of the tool: X sells quoting on its Enterprise plan only
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', quote: { postId: '123' } } })).toThrow();
    expect(() => parseAction({ tool: 'publish_post', input: { text: 'a', replyTo: '123' } })).toThrow();
  });
});
