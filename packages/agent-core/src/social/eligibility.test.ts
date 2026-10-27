import { describe, expect, it } from 'vitest';
import { eligibleBadge, replyEligibility, replyExclusion } from './eligibility.js';
import type { XPost } from '../types.js';

const self = { ownUserId: '100', ownHandle: 'bootragent' };
const now = 1_700_000_000_000;
const verified = (overrides: Partial<XPost> = {}): XPost => ({
  id: '555',
  authorId: '200',
  text: '@bootragent what is the treasury doing?',
  author: { id: '200', username: 'alice', verified: true, verifiedType: 'blue' },
  ...overrides,
});

describe('eligibleBadge / replyExclusion', () => {
  it('accepts blue and business badges only', () => {
    expect(eligibleBadge({ id: '1', verified: true, verifiedType: 'blue' })).toBe(true);
    expect(eligibleBadge({ id: '1', verified: true, verifiedType: 'business' })).toBe(true);
    expect(eligibleBadge({ id: '1', verified: true, verifiedType: 'government' })).toBe(false);
    expect(eligibleBadge({ id: '1', verified: false, verifiedType: 'blue' })).toBe(false);
    expect(eligibleBadge(undefined)).toBe(false);
  });
  it('owner exception is bound to the fetched stable author id', () => {
    const unverified = verified({ author: { id: '200', username: 'alice', verified: false } });
    expect(replyExclusion(unverified)).toBe('verified_audience_required');
    expect(replyExclusion(unverified, ['200'])).toBeNull();
    expect(replyExclusion(verified({ author: { id: '999', verified: false } }), ['200'])).toBe('verified_audience_required');
    expect(replyExclusion(verified({ author: undefined }), ['200'])).toBe('verified_audience_required');
  });
});

describe('replyEligibility', () => {
  it('passes an addressed, verified, unseen post', () => {
    expect(replyEligibility(verified(), { ...self, now })).toEqual({ eligible: true });
  });
  it('rejects posts not addressed to us and carried mentions unless invited', () => {
    expect(replyEligibility(verified({ text: 'hello world' }), { ...self, now })).toEqual({ eligible: false, reason: 'not_addressed_to_agent' });
    const carried = verified({ text: '@alice @bootragent sure', inReplyToUserId: '300' });
    expect(replyEligibility(carried, { ...self, now }).reason).toBe('not_addressed_to_agent');
    expect(replyEligibility(carried, { ...self, now, allowCarriedMention: true }).eligible).toBe(true);
    expect(replyEligibility(verified({ authorId: '100', author: { id: '100', verified: true, verifiedType: 'blue' } }), { ...self, now }).reason).toBe('not_addressed_to_agent');
  });
  it('honors stop commands, opt-outs and owner blocks before the badge rule', () => {
    expect(replyEligibility(verified({ text: '@bootragent stop' }), { ...self, now }).reason).toBe('consent_stop');
    expect(replyEligibility(verified(), { ...self, now, optedOutAuthorIds: ['200'] }).reason).toBe('recipient_opted_out');
    expect(replyEligibility(verified(), { ...self, now, optedOutAuthorIds: new Set(['200']) }).reason).toBe('recipient_opted_out');
    expect(replyEligibility(verified(), { ...self, now, blockedAuthorIds: ['200'] }).reason).toBe('owner_blocked');
  });
  it('requires a verified badge unless the owner listed the author', () => {
    const unverified = verified({ author: { id: '200', verified: false } });
    expect(replyEligibility(unverified, { ...self, now }).reason).toBe('verified_audience_required');
    expect(replyEligibility(unverified, { ...self, now, replyAuthorIds: ['200'] }).eligible).toBe(true);
  });
  it('applies deferral and the two-minute seen rule', () => {
    expect(replyEligibility(verified(), { ...self, now, deferredUntil: now + 1 }).reason).toBe('deferred');
    expect(replyEligibility(verified(), { ...self, now, deferredUntil: now }).eligible).toBe(true);
    expect(replyEligibility(verified(), { ...self, now, seenAt: now - 119_000 }).reason).toBe('recently_presented');
    expect(replyEligibility(verified(), { ...self, now, seenAt: now - 120_000 }).eligible).toBe(true);
    expect(replyEligibility(verified(), { ...self, now, seenAt: null }).eligible).toBe(true);
  });
});
