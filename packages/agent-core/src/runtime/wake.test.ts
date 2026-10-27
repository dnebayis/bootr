import { describe, expect, it } from 'vitest';
import { decisionDue, pendingReplyDue, wakeDecision, type InboxCandidate, type WakeInput } from './wake.js';

const now = 1_800_000_000_000;
const base: WakeInput = { now, enabled: true, status: 'waiting', nextAt: now + 30 * 60_000, configRevision: 3, lastDecision: { at: now - 60_000, revision: 3 } };
const mention = (overrides: Partial<InboxCandidate> = {}): InboxCandidate => ({ postId: '1', status: 'pending', eligible: true, ...overrides });

describe('pendingReplyDue', () => {
  it('needs an eligible pending entry not presented in the last two minutes', () => {
    expect(pendingReplyDue([mention()], now)).toBe(true);
    expect(pendingReplyDue([mention({ seenAt: now - 60_000 })], now)).toBe(false);
    expect(pendingReplyDue([mention({ seenAt: now - 120_000 })], now)).toBe(true);
    expect(pendingReplyDue([mention({ eligible: false })], now)).toBe(false);
    expect(pendingReplyDue([mention({ status: 'answered' })], now)).toBe(false);
    expect(pendingReplyDue([mention({ deferredUntil: now + 1 })], now)).toBe(false);
    expect(pendingReplyDue([], now)).toBe(false);
  });
});

describe('decisionDue', () => {
  it('lists every concrete reason, and nothing on a bare pulse', () => {
    expect(decisionDue({ configRevision: 3, lastDecision: { at: now, revision: 3 } })).toEqual([]);
    expect(decisionDue({ continuation: true, inbox: true, postDue: true, replyRetryDue: true })).toEqual(['continuation', 'pending_mention', 'reply_retry', 'original_post_due']);
    expect(decisionDue({ configRevision: 4, lastDecision: { at: now, revision: 3 } })).toEqual(['config_changed']);
    expect(decisionDue({ configRevision: 0, lastDecision: null })).toEqual(['config_changed']);
  });
});

describe('wakeDecision', () => {
  it('does not run on a bare one-minute pulse but keeps pulsing', () => {
    expect(wakeDecision(base)).toEqual({ run: false, reasons: [], nextAt: now + 60_000 });
  });
  it('runs when the scheduled wake arrived', () => {
    expect(wakeDecision({ ...base, nextAt: now })).toEqual({ run: true, reasons: ['scheduled'], nextAt: now });
  });
  it('runs for an eligible unseen mention only while waiting', () => {
    expect(wakeDecision({ ...base, inbox: [mention()] })).toMatchObject({ run: true, reasons: ['pending_mention'] });
    expect(wakeDecision({ ...base, inbox: [mention({ seenAt: now - 30_000 })] }).run).toBe(false);
    expect(wakeDecision({ ...base, status: 'working', inbox: [mention()] }).run).toBe(false);
  });
  it('runs when the original post is due and composing is allowed, and pulls nextAt forward to the slot', () => {
    expect(wakeDecision({ ...base, schedule: { due: true, nextAt: now - 1, mayCompose: true } })).toMatchObject({ run: true, reasons: ['scheduled', 'original_post_due'] });
    expect(wakeDecision({ ...base, schedule: { due: true, nextAt: now - 1, mayCompose: false } }).run).toBe(false);
    const soon = wakeDecision({ ...base, schedule: { due: false, nextAt: now + 20_000, mayCompose: true } });
    expect(soon).toEqual({ run: false, reasons: [], nextAt: now + 20_000 });
  });
  it('runs on continuation, reply retry and config revision change', () => {
    expect(wakeDecision({ ...base, continuation: true }).reasons).toEqual(['continuation']);
    expect(wakeDecision({ ...base, replyRetryDue: true }).reasons).toEqual(['reply_retry']);
    expect(wakeDecision({ ...base, configRevision: 4 }).reasons).toEqual(['config_changed']);
  });
  it('never runs while disabled, paused, blocked, unknown, held or leased', () => {
    expect(wakeDecision({ ...base, enabled: false, nextAt: now })).toEqual({ run: false, reasons: ['disabled'], nextAt: null });
    expect(wakeDecision({ ...base, status: 'paused', nextAt: now }).run).toBe(false);
    expect(wakeDecision({ ...base, status: 'blocked', nextAt: now }).nextAt).toBeNull();
    expect(wakeDecision({ ...base, status: 'unknown', nextAt: now }).reasons).toEqual(['unknown']);
    expect(wakeDecision({ ...base, heldAction: true, nextAt: now })).toEqual({ run: false, reasons: ['held_action'], nextAt: null });
    expect(wakeDecision({ ...base, leaseUntil: now + 5000, nextAt: now })).toEqual({ run: false, reasons: ['leased'], nextAt: now + 15_000 });
    expect(wakeDecision({ ...base, leaseUntil: now - 1, nextAt: now }).run).toBe(true);
  });
});
