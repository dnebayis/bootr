import { describe, expect, it } from 'vitest';
import { BOUNTY_STATUS_LABEL, bountyAnchor, closesLabel, entriesLine, ineligibleLabel, outcomeLine, usdcLabel, utcLabel, winnerMarks } from './bounties';

describe('bounties copy', () => {
  it('says where a job stands in plain words, and nothing while it takes entries or is paid', () => {
    expect(BOUNTY_STATUS_LABEL.draft).toBe('Waiting to be posted');
    expect(outcomeLine({ status: 'no_winner' })).toBe('No entry met the job; nothing paid.');
    expect(outcomeLine({ status: 'proposed' })).toContain('Nothing is paid until they say yes.');
    expect(outcomeLine({ status: 'draft' })).toContain('goes out on X once');
    expect(outcomeLine({ status: 'open' })).toBeNull();
    expect(outcomeLine({ status: 'paid' })).toBeNull();
  });

  it('spells out why entries were not judged, with the service’s own reason keys', () => {
    expect(ineligibleLabel('no_address')).toBe('no address');
    expect(ineligibleLabel('account_too_new')).toBe('account under 30 days old');
    expect(ineligibleLabel('not_considered')).toBe('after the first 12');
    expect(ineligibleLabel('some_new_reason')).toBe('some new reason');
    expect(entriesLine({ received: 0, eligible: 0, considered: 0, ineligible: {} })).toBe('No entries yet');
    expect(entriesLine({ received: 7, eligible: 4, considered: 4, ineligible: { no_address: 2, duplicate_media: 1 } })).toBe('7 entries, 4 could be judged (2 no address, 1 same picture as an earlier entry)');
    expect(entriesLine({ received: 20, eligible: 15, considered: 12, ineligible: { no_address: 5 } })).toBe('20 entries, 15 could be judged (5 no address), 12 judged');
    expect(entriesLine({ received: 1, eligible: 1, considered: 1, ineligible: {} })).toBe('1 entry, 1 could be judged');
  });

  it('formats amounts, closing times and anchors', () => {
    expect(usdcLabel('0.5')).toBe('0.50 USDC');
    expect(usdcLabel('1')).toBe('1.00 USDC');
    expect(usdcLabel('500000', 'micro')).toBe('0.50 USDC');
    expect(usdcLabel(null)).toBe('— USDC');
    expect(utcLabel('2026-11-09T16:05:00.000Z')).toBe('9 Nov 2026, 16:05 UTC');
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(closesLabel('2026-11-09T16:00:00Z', now)).toBe('closes in 4 h');
    expect(closesLabel('2026-11-09T12:20:00Z', now)).toBe('closes in 20 min');
    expect(closesLabel('2026-11-07T12:00:00Z', now)).toBe('closed 2 d ago');
    expect(closesLabel('2026-11-09T11:00:00Z', now)).toBe('closed 1 h ago');
    expect(bountyAnchor('0xABCDEF0123456789')).toBe('bounty-0xabcdef0123456789');
  });

  it('reads the winner’s marks against the criteria, one per criterion', () => {
    const criteria = ['a', 'b', 'c'];
    const verdict = { winner: 2, winningEntryUrl: null, perCriterion: { '1': ['fail', 'pass', 'pass'], '2': ['pass', 'pass'] }, reason: '', invalid: null, deliveryHash: null, reasonHash: null, judgedAt: '2026-11-09T16:05:00.000Z' } as const;
    expect(winnerMarks({ criteria, verdict: { ...verdict, perCriterion: { '1': ['fail', 'pass', 'pass'], '2': ['pass', 'pass'] } } })).toEqual(['pass', 'pass', 'insufficient_evidence']);
    expect(winnerMarks({ criteria, verdict: { ...verdict, winner: null, perCriterion: {} } })).toBeNull();
    expect(winnerMarks({ criteria, verdict: null })).toBeNull();
  });
});
