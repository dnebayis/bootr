import { describe, expect, it } from 'vitest';
import { applyConsent, consentCommand, optedOut } from './consent.js';

describe('consentCommand', () => {
  it('detects bare stop and resume requests regardless of handles and punctuation', () => {
    expect(consentCommand('@bootragent stop')).toBe('stop');
    expect(consentCommand('STOP!!')).toBe('stop');
    expect(consentCommand('@bootragent please stop replying to me.')).toBe('stop');
    expect(consentCommand("don't reply to me")).toBe('stop');
    expect(consentCommand('unsubscribe')).toBe('stop');
    expect(consentCommand('@bootragent resume')).toBe('resume');
    expect(consentCommand('you can reply again')).toBe('resume');
  });
  it('ignores sentences that merely contain the words', () => {
    expect(consentCommand('stop saying that the price will go up')).toBeNull();
    expect(consentCommand('when will you resume posting?')).toBeNull();
    expect(consentCommand('')).toBeNull();
    expect(consentCommand(undefined)).toBeNull();
  });
});

describe('applyConsent', () => {
  it('only a newer post can change the state', () => {
    let ledger = applyConsent({}, '7', '100', 'stop');
    expect(optedOut(ledger, '7')).toBe(true);
    ledger = applyConsent(ledger, '7', '90', 'resume');
    expect(optedOut(ledger, '7')).toBe(true);
    ledger = applyConsent(ledger, '7', '101', 'resume');
    expect(optedOut(ledger, '7')).toBe(false);
    expect(ledger['7']?.postId).toBe('101');
    expect(applyConsent(ledger, '7', '101', 'stop')).toBe(ledger);
    expect(optedOut(ledger, '8')).toBe(false);
  });
});
