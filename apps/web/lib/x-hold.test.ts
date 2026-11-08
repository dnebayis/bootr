import { describe, expect, it } from 'vitest';
import { activeXHold, formatHoldEnd, xHoldCopy, xRevokedCopy, xTrouble } from './x-hold';

const NOW = Date.parse('2026-11-08T20:00:00Z');
const HOLD = { reason: 'forbidden' as const, until: '2026-11-09T02:00:00.000Z', strikes: 1 };

describe('activeXHold', () => {
  it('keeps a forbidden hold whose end lies ahead', () => {
    expect(activeXHold(HOLD, NOW)).toEqual(HOLD);
  });

  it('drops a missing hold, one that has passed, one with an unreadable time and one of another kind', () => {
    expect(activeXHold(null, NOW)).toBeNull();
    expect(activeXHold(undefined, NOW)).toBeNull();
    expect(activeXHold(HOLD, Date.parse(HOLD.until))).toBeNull();
    expect(activeXHold({ ...HOLD, until: 'soon' }, NOW)).toBeNull();
    expect(activeXHold({ ...HOLD, reason: 'other' as 'forbidden' }, NOW)).toBeNull();
  });
});

describe('xHoldCopy', () => {
  it("says what X did, until when, what to check and that a reconnect ends the pause", () => {
    const copy = xHoldCopy('AgentBootr', 'Nov 9, 02:00');
    expect(copy.title).toBe("X is refusing this agent's posts");
    expect(copy.body).toBe(
      "X answered 'not permitted' when @AgentBootr tried to post, so posts and replies are paused until Nov 9, 02:00. Log in to the X account and check for a lock, a restriction or a notice from X. If you reconnect the account here, the pause ends at once.",
    );
  });

  it('takes a handle with or without its @, and names the agent when there is none', () => {
    expect(xHoldCopy('@AgentBootr', 'later').body).toMatch(/when @AgentBootr tried/);
    expect(xHoldCopy(null, 'later').body).toMatch(/when the agent tried/);
  });
});

describe('xTrouble', () => {
  it('a lost connection wins over a hold; a hold shows while it lasts; an unknown connection decides nothing', () => {
    expect(xTrouble('revoked', null, NOW)).toBe('revoked');
    expect(xTrouble('revoked', HOLD, NOW)).toBe('revoked');
    expect(xTrouble('connected', HOLD, NOW)).toBe('hold');
    expect(xTrouble(null, HOLD, NOW)).toBe('hold');
    expect(xTrouble('connected', HOLD, Date.parse(HOLD.until))).toBeNull();
    expect(xTrouble('connected', null, NOW)).toBeNull();
    expect(xTrouble('none', null, NOW)).toBeNull();
    expect(xTrouble(null, null, NOW)).toBeNull();
  });
});

describe('xRevokedCopy', () => {
  it("says the connection is gone, what that stops and that the same account goes back here", () => {
    const copy = xRevokedCopy('brianbrain');
    expect(copy.title).toBe('X connection lost');
    expect(copy.body).toBe("X no longer accepts @brianbrain's connection, so the agent cannot read or post. Connect the same X account again here; the agent resumes on the next pass.");
    expect(xRevokedCopy('@brianbrain').body).toMatch(/accepts @brianbrain's connection/);
    expect(xRevokedCopy(null).body).toMatch(/accepts the agent's connection/);
  });
});

describe('formatHoldEnd', () => {
  it('shows the time alone on the same day and the date before it otherwise', () => {
    // local dates, so the viewer's zone decides what "the same day" is, whatever zone the test runs in
    const localNow = new Date(2026, 10, 8, 10, 0).getTime();
    const sameDay = new Date(2026, 10, 8, 12, 0).toISOString();
    expect(formatHoldEnd(sameDay, localNow)).toMatch(/^\d{2}:\d{2}( [AP]M)?$/);
    expect(formatHoldEnd(new Date(2026, 10, 11, 12, 0).toISOString(), localNow)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}( [AP]M)?$/);
    expect(formatHoldEnd('soon', NOW)).toBe('later today');
  });
});
