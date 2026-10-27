import { describe, expect, it } from 'vitest';
import { matchesPublishedPost, postReadbackWindow, readbackMatch } from './readback.js';
import type { XPost } from '../types.js';

const createdAt = Date.parse('2026-03-01T12:00:00.400Z');
const own = '100';
const post = (overrides: Partial<XPost> = {}): XPost => ({
  id: '777',
  authorId: own,
  text: 'hello world',
  createdAt: new Date(createdAt + 2000).toISOString(),
  ...overrides,
});

describe('postReadbackWindow', () => {
  it('spans -1s..+5min rounded to whole seconds', () => {
    const w = postReadbackWindow(createdAt);
    expect(w.start).toBe(Date.parse('2026-03-01T11:59:59.000Z'));
    expect(w.end).toBe(Date.parse('2026-03-01T12:05:01.000Z'));
    expect(postReadbackWindow(new Date(createdAt).toISOString())).toEqual(w);
    expect(() => postReadbackWindow('nope')).toThrow(/x_readback_invalid_time/);
  });
});

describe('matchesPublishedPost', () => {
  it('matches text, parent and time', () => {
    expect(matchesPublishedPost(post(), { createdAt, input: { text: 'hello world' } })).toBe(true);
    expect(matchesPublishedPost(post(), { createdAt, input: { text: 'hello there' } })).toBe(false);
    expect(matchesPublishedPost(post({ createdAt: new Date(createdAt - 5000).toISOString() }), { createdAt, input: { text: 'hello world' } })).toBe(false);
    expect(matchesPublishedPost(post({ referencedPosts: [{ type: 'replied_to', id: '1' }] }), { createdAt, input: { text: 'hello world' } })).toBe(false);
    expect(matchesPublishedPost(post({ referencedPosts: [{ type: 'replied_to', id: '1' }] }), { createdAt, input: { text: 'hello world', replyTo: '1' } })).toBe(true);
  });
  it('expands shortened links and strips the media link only with media', () => {
    const linked = post({ text: 'see https://t.co/abc', urls: [{ url: 'https://t.co/abc', expandedUrl: 'https://example.com/x' }] });
    expect(matchesPublishedPost(linked, { createdAt, input: { text: 'see https://example.com/x' } })).toBe(true);
    const media = post({ text: 'pic https://t.co/m', urls: [{ url: 'https://t.co/m', expandedUrl: 'https://x.com/u/status/777/photo/1' }], mediaKeys: ['k1'] });
    expect(matchesPublishedPost(media, { createdAt, input: { text: 'pic', hasMedia: true } })).toBe(true);
    expect(matchesPublishedPost(media, { createdAt, input: { text: 'pic', hasMedia: true, mediaKey: 'k2' } })).toBe(false);
    expect(matchesPublishedPost({ ...media, mediaKeys: [] }, { createdAt, input: { text: 'pic', hasMedia: true } })).toBe(false);
  });
  it('ignores a handle prefix only when the stable recipient id matches', () => {
    const reply = post({ text: '@alice thanks', inReplyToUserId: '200', referencedPosts: [{ type: 'replied_to', id: '5' }] });
    expect(matchesPublishedPost(reply, { createdAt, input: { text: 'thanks', replyTo: '5', replyAuthorId: '200' } })).toBe(true);
    expect(matchesPublishedPost(reply, { createdAt, input: { text: 'thanks', replyTo: '5', replyAuthorId: '999' } })).toBe(false);
    expect(matchesPublishedPost(reply, { createdAt, input: { text: 'thanks', replyTo: '5' } })).toBe(false);
  });
});

describe('readbackMatch', () => {
  it('requires our authorship, the window and the recipient', () => {
    const action = { createdAt, input: { text: 'hello world' } };
    expect(readbackMatch(post(), action, own)).toBe(true);
    expect(readbackMatch(post({ authorId: '2' }), action, own)).toBe(false);
    expect(readbackMatch(post({ createdAt: new Date(createdAt + 6 * 60_000).toISOString() }), action, own)).toBe(false);
    const reply = post({ text: 'thanks', inReplyToUserId: '200', referencedPosts: [{ type: 'replied_to', id: '5' }] });
    expect(readbackMatch(reply, { createdAt, input: { text: 'thanks', replyTo: '5' } }, own)).toBe(false);
    expect(readbackMatch(reply, { createdAt, input: { text: 'thanks', replyTo: '5', replyAuthorId: '200' } }, own)).toBe(true);
  });
});
