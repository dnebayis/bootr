import { describe, expect, it } from 'vitest';
import { classifyAddressing, directlyAddresses, isReceivedInteraction } from './addressing.js';
import type { XPost } from '../types.js';

const self = { ownUserId: '100', ownHandle: 'bootragent' };
const post = (overrides: Partial<XPost>): XPost => ({ id: '555', authorId: '200', text: '', ...overrides });

describe('classifyAddressing', () => {
  it('reply_to_self when X says the post replies to our account', () => {
    const a = classifyAddressing(post({ text: '@bootragent @other thanks', inReplyToUserId: '100', referencedPosts: [{ type: 'replied_to', id: '1' }] }), self);
    expect(a).toEqual({ kind: 'reply_to_self', body: 'thanks', replyToUserId: '100' });
  });
  it('explicit_mention when the handle appears in the body', () => {
    expect(classifyAddressing(post({ text: 'hey what does @bootragent think?' }), self).kind).toBe('explicit_mention');
    expect(classifyAddressing(post({ text: '@BootrAgent hello' }), self).kind).toBe('explicit_mention');
    expect(classifyAddressing(post({ text: 'hello', mentions: [{ username: 'bootragent' }] }), self).kind).toBe('explicit_mention');
  });
  it('carried_mention when our handle only rides in a reply prefix', () => {
    const a = classifyAddressing(post({ text: '@alice @bootragent I agree with you', inReplyToUserId: '300', referencedPosts: [{ type: 'replied_to', id: '2' }] }), self);
    expect(a.kind).toBe('carried_mention');
    expect(a.body).toBe('I agree with you');
    expect(a.replyToUserId).toBe('300');
  });
  it('not_addressed when we are not named', () => {
    expect(classifyAddressing(post({ text: '@alice hi' }), self)).toEqual({ kind: 'not_addressed', body: 'hi', replyToUserId: null });
    expect(classifyAddressing(post({ text: 'bootragent without at sign' }), self).kind).toBe('not_addressed');
    expect(classifyAddressing(post({ text: '@bootragentx hi' }), self).kind).toBe('not_addressed');
  });
});

describe('isReceivedInteraction / directlyAddresses', () => {
  it('rejects our own posts, retweets and invalid ids', () => {
    expect(isReceivedInteraction(post({ text: '@bootragent hi', authorId: '100' }), self)).toBe(false);
    expect(isReceivedInteraction(post({ text: '@bootragent hi', referencedPosts: [{ type: 'retweeted', id: '9' }] }), self)).toBe(false);
    expect(isReceivedInteraction(post({ text: '@bootragent hi', id: 'x' as string }), self)).toBe(false);
    expect(isReceivedInteraction(post({ text: '@bootragent hi' }), self)).toBe(true);
  });
  it('carried mentions are received but not direct', () => {
    const carried = post({ text: '@alice @bootragent ok', inReplyToUserId: '300' });
    expect(isReceivedInteraction(carried, self)).toBe(true);
    expect(directlyAddresses(carried, self)).toBe(false);
    expect(directlyAddresses(post({ text: 'tell me @bootragent' }), self)).toBe(true);
  });
});
