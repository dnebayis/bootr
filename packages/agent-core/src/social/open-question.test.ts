import { describe, expect, it } from 'vitest';
import { mentionAsksQuestion, replyEligibility } from './eligibility.js';
import type { XPost } from '../types.js';

const self = { ownUserId: '100', ownHandle: 'bootragent' };
const now = 1_700_000_000_000;

/** An account with no badge mentioning the agent in a post of its own. */
const mention = (text: string, overrides: Partial<XPost> = {}): XPost => ({
  id: '901',
  authorId: '200',
  text,
  author: { id: '200', username: 'alice', verified: false },
  ...overrides,
});
const on = { ...self, now, openQuestions: true };

describe('mentionAsksQuestion: a question a reader sees', () => {
  it('a question mark next to words is a question, in any script', () => {
    for (const text of ['@bootragent how does the fee split work?', '@bootragent ca?', 'is it on base.org? @bootragent', '@bootragent これは何ですか？', '@bootragent ¿dónde está el contrato?', '@bootragent أين العقد؟', 'what is $BOOTR? @bootragent', '@bootragent wen\ntoken?']) {
      expect(mentionAsksQuestion(text), text).toBe(true);
    }
  });

  it('a statement is not, and neither is a mark with nothing said', () => {
    for (const text of ['@bootragent nice coin', '@bootragent gm', '@bootragent ?', '@bootragent???', '?', '', '@bootragent $BOOTR?', '@bootragent #wen?']) {
      expect(mentionAsksQuestion(text), JSON.stringify(text)).toBe(false);
    }
    expect(mentionAsksQuestion(null)).toBe(false);
    expect(mentionAsksQuestion(undefined)).toBe(false);
  });

  it('a question mark inside a link is not a question, with or without the scheme, and however the link is disguised', () => {
    for (const text of [
      '@bootragent look https://example.com/page?ref=1',
      '@bootragent look https://t.co/abc?x',
      '@bootragent look example.com/page?ref=1',
      '@bootragent look example.com?ref=1',
      '@bootragent look www.example.com/?a',
      // zero-width characters inside the scheme, so that a plain link pattern would miss it
      '@bootragent look ht​tps://example.com/page?ref=1',
      '@bootragent look https://exam⁠ple.com/page‍?ref=1',
      // full-width letters and a full-width question mark
      '@bootragent look ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ．ｃｏｍ／ｐａｇｅ？ｒｅｆ＝１',
    ]) {
      expect(mentionAsksQuestion(text), JSON.stringify(text)).toBe(false);
    }
    // the same post with a real question beside the link is one
    expect(mentionAsksQuestion('@bootragent is https://example.com/page?ref=1 yours?')).toBe(true);
  });

  it('a mark hidden behind characters nobody sees is not a question', () => {
    for (const text of [
      // nothing but filler and a mark: zero-width spaces, a Hangul filler, a braille blank, a soft hyphen, a word joiner
      '@bootragent ​​?',
      '@bootragent ㅤㅤㅤ?',
      '@bootragent ⠀⠀⠀ ?',
      '@bootragent ­⁠﻿?',
      '@bootragent ᅟᅠﾠ ？',
      // one visible letter padded with filler is still not something said
      '@bootragent a​​​?',
    ]) {
      expect(mentionAsksQuestion(text), JSON.stringify(text)).toBe(false);
    }
    // filler inside a real question changes nothing
    expect(mentionAsksQuestion('@bootragent wh​at is th​is?')).toBe(true);
  });
});

describe('questions from anyone (openQuestions)', () => {
  it('without it an unverified question is closed, as before', () => {
    expect(replyEligibility(mention('@bootragent how does the fee split work?'), { ...self, now })).toEqual({ eligible: false, reason: 'verified_audience_required' });
    expect(replyEligibility(mention('@bootragent how does the fee split work?'), { ...self, now, openQuestions: false })).toEqual({ eligible: false, reason: 'verified_audience_required' });
  });

  it('with it an unverified author who asks is answered and marked; one who states something is not', () => {
    expect(replyEligibility(mention('@bootragent how does the fee split work?'), on)).toEqual({ eligible: true, open: true, openAs: 'question' });
    expect(replyEligibility(mention('@bootragent nice coin'), on)).toEqual({ eligible: false, reason: 'verified_audience_required' });
    expect(replyEligibility(mention('@bootragent look https://example.com/page?ref=1'), on)).toEqual({ eligible: false, reason: 'verified_audience_required' });
    expect(replyEligibility(mention('@bootragent ​ㅤ?'), on)).toEqual({ eligible: false, reason: 'verified_audience_required' });
  });

  it('a reply to the agent\'s account that asks is answered too, under any of its posts', () => {
    const reply = mention('@bootragent and where is the contract?', { inReplyToUserId: '100', referencedPosts: [{ type: 'replied_to', id: '900' }] });
    expect(replyEligibility(reply, on)).toEqual({ eligible: true, open: true, openAs: 'question' });
    // where the coin also answers everything under its own posts, that is the way in it is counted as
    expect(replyEligibility(reply, { ...on, openReplyTo: ['900'] })).toEqual({ eligible: true, open: true, openAs: 'own_thread' });
    expect(replyEligibility(mention('@bootragent thanks', { inReplyToUserId: '100', referencedPosts: [{ type: 'replied_to', id: '900' }] }), { ...on, openReplyTo: ['900'] })).toEqual({ eligible: true, open: true, openAs: 'own_thread' });
  });

  it('a verified account and the creator\'s list need no such way in, with or without a question, and are not counted as one', () => {
    const blue = { id: '200', username: 'alice', verified: true, verifiedType: 'blue' as const };
    const business = { id: '200', username: 'alice', verified: true, verifiedType: 'business' as const };
    for (const author of [blue, business]) {
      expect(replyEligibility(mention('@bootragent how does the fee split work?', { author }), on)).toEqual({ eligible: true });
      expect(replyEligibility(mention('@bootragent nice coin', { author }), on)).toEqual({ eligible: true });
      expect(replyEligibility(mention('@bootragent nice coin', { author }), { ...self, now })).toEqual({ eligible: true });
    }
    expect(replyEligibility(mention('@bootragent nice coin'), { ...on, replyAuthorIds: ['200'] })).toEqual({ eligible: true });
    // a government badge is not the blue tick: such an account is answered when it asks, like anyone
    const government = { id: '200', username: 'alice', verified: true, verifiedType: 'government' as const };
    expect(replyEligibility(mention('@bootragent nice coin', { author: government }), on)).toEqual({ eligible: false, reason: 'verified_audience_required' });
    expect(replyEligibility(mention('@bootragent is this official?', { author: government }), on)).toEqual({ eligible: true, open: true, openAs: 'question' });
  });

  it('X\'s own rule still holds: only somebody who addressed the agent, never a handle that merely rides along', () => {
    // the agent is not named at all
    expect(replyEligibility(mention('how does the fee split work?'), on)).toEqual({ eligible: false, reason: 'not_addressed_to_agent' });
    // a reply to somebody else further down a thread, the agent's handle carried in the prefix
    expect(replyEligibility(mention('@bob @bootragent how does the fee split work?', { inReplyToUserId: '300', referencedPosts: [{ type: 'replied_to', id: '700' }] }), on)).toEqual({ eligible: false, reason: 'not_addressed_to_agent' });
    // a repost of a question
    expect(replyEligibility(mention('@bootragent how does the fee split work?', { referencedPosts: [{ type: 'retweeted', id: '700' }] }), on)).toEqual({ eligible: false, reason: 'not_addressed_to_agent' });
    // the agent's own post
    expect(replyEligibility(mention('@bootragent how does the fee split work?', { authorId: '100', author: { id: '100', username: 'bootragent', verified: false } }), on).eligible).toBe(false);
  });

  it('an author who said stop, opted out earlier or is on the creator\'s blocked list is not answered, question or not', () => {
    expect(replyEligibility(mention('@bootragent stop'), on)).toEqual({ eligible: false, reason: 'consent_stop' });
    expect(replyEligibility(mention('@bootragent how does the fee split work?'), { ...on, optedOutAuthorIds: ['200'] })).toEqual({ eligible: false, reason: 'recipient_opted_out' });
    expect(replyEligibility(mention('@bootragent how does the fee split work?'), { ...on, blockedAuthorIds: ['200'] })).toEqual({ eligible: false, reason: 'owner_blocked' });
  });

  it('a question that was deferred or just shown waits like any other mention', () => {
    expect(replyEligibility(mention('@bootragent how does the fee split work?'), { ...on, deferredUntil: now + 60_000 })).toEqual({ eligible: false, reason: 'deferred' });
    expect(replyEligibility(mention('@bootragent how does the fee split work?'), { ...on, seenAt: now - 1000 })).toEqual({ eligible: false, reason: 'recently_presented' });
  });
});
