import { describe, expect, it } from 'vitest';
import { openReply, replyEligibility } from './eligibility.js';
import type { XPost } from '../types.js';

const self = { ownUserId: '100', ownHandle: 'bootragent' };
const now = 1_700_000_000_000;

/** An unverified account replying directly under the agent's own post 900. */
const under = (overrides: Partial<XPost> = {}): XPost => ({
  id: '901',
  authorId: '200',
  text: '@bootragent how does the fee split work?',
  inReplyToUserId: '100',
  referencedPosts: [{ type: 'replied_to', id: '900' }],
  author: { id: '200', username: 'alice', verified: false },
  ...overrides,
});

describe('the reply audience own_threads (openReplyTo)', () => {
  it('without it an unverified reply under the agent\'s own post is closed, as before', () => {
    expect(replyEligibility(under(), { ...self, now })).toEqual({ eligible: false, reason: 'verified_audience_required' });
    expect(replyEligibility(under(), { ...self, now, openReplyTo: [] })).toEqual({ eligible: false, reason: 'verified_audience_required' });
  });

  it('with it a direct reply to one of the agent\'s own posts is answered, and marked as outside the verified audience', () => {
    expect(replyEligibility(under(), { ...self, now, openReplyTo: ['900'] })).toEqual({ eligible: true, open: true });
    expect(replyEligibility(under(), { ...self, now, openReplyTo: new Set(['900', '800']) })).toEqual({ eligible: true, open: true });
    // a verified author needs no such way in and is not counted as one
    expect(replyEligibility(under({ author: { id: '200', username: 'alice', verified: true, verifiedType: 'blue' } }), { ...self, now, openReplyTo: ['900'] })).toEqual({ eligible: true });
    // the creator's list likewise
    expect(replyEligibility(under(), { ...self, now, replyAuthorIds: ['200'], openReplyTo: ['900'] })).toEqual({ eligible: true });
  });

  it('only a direct reply under a post that is the agent\'s own: not a mention, not a reply to somebody else, not an unknown post', () => {
    const open = { ...self, now, openReplyTo: ['900'] };
    // a plain mention from an unverified account
    expect(replyEligibility(under({ inReplyToUserId: null, referencedPosts: [] }), open).reason).toBe('verified_audience_required');
    // a reply to somebody else's post in the same conversation that names the agent
    expect(replyEligibility(under({ inReplyToUserId: '300', referencedPosts: [{ type: 'replied_to', id: '900' }] }), open).reason).toBe('verified_audience_required');
    // a reply to the agent's account under a post that is not in the list (somebody else's id, a made-up one)
    expect(replyEligibility(under({ referencedPosts: [{ type: 'replied_to', id: '555' }] }), open).reason).toBe('verified_audience_required');
    // a quote of the agent's post is not a reply under it
    expect(replyEligibility(under({ inReplyToUserId: null, referencedPosts: [{ type: 'quoted', id: '900' }] }), open).reason).toBe('verified_audience_required');
    expect(openReply(under(), '100', ['900'])).toBe(true);
    expect(openReply(under(), '100', undefined)).toBe(false);
    expect(openReply(under(), '999', ['900'])).toBe(false);
  });

  it('never opens what the other rules close: a stop request, an opt-out, the owner\'s block list, a deferral', () => {
    const open = { ...self, now, openReplyTo: ['900'] };
    expect(replyEligibility(under({ text: '@bootragent stop' }), open).reason).toBe('consent_stop');
    expect(replyEligibility(under(), { ...open, optedOutAuthorIds: ['200'] }).reason).toBe('recipient_opted_out');
    expect(replyEligibility(under(), { ...open, blockedAuthorIds: ['200'] }).reason).toBe('owner_blocked');
    expect(replyEligibility(under(), { ...open, deferredUntil: now + 1 }).reason).toBe('deferred');
    expect(replyEligibility(under(), { ...open, seenAt: now - 1000 }).reason).toBe('recently_presented');
    // the agent's own post is never a received interaction
    expect(replyEligibility(under({ authorId: '100', author: { id: '100', username: 'bootragent', verified: false } }), open).reason).toBe('not_addressed_to_agent');
  });
});
