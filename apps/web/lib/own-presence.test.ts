import { ownPresenceOf, ownTapeStatus } from '@bootr/shared/own-presence';
import { describe, expect, it } from 'vitest';
import { OWN_RUNNER_LINE, ownPresence, ownStatusLine } from './own-presence';
import type { Agent, AgentConfig } from './types';

/**
 * What the coin page says about an own agent, next to what the status row of the coin's tape says about the same coin
 * (apps/supervisor `activity.ts` writes that row with `ownTapeStatus`). Both come from one rule, so each case is
 * checked on both: they may word a moment differently (the page redraws and counts minutes, a stored row names the
 * time), never disagree on what the agent is waiting for.
 */
const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const HOUR = 3_600_000;
const TOKEN = { xHandle: 'bootr_agent' };
const config = (own: AgentConfig['own'], postIntervalMs = 2 * HOUR) => ({ own, worker: { postIntervalMs } }) as Pick<AgentConfig, 'own' | 'worker'>;
const page = (own: AgentConfig['own'], postIntervalMs?: number) => ownStatusLine(TOKEN, null, config(own, postIntervalMs), NOW);
const tape = (own: NonNullable<AgentConfig['own']>, postIntervalMs = 2 * HOUR) => ownTapeStatus(ownPresenceOf(own, postIntervalMs, NOW));

describe('an own agent with no client connected', () => {
  it('is waiting for its creator’s AI client, on the page and on the tape, and is never active', () => {
    const never = { lastTurnAt: null, clients: 0 };
    expect(page(never)).toEqual({ active: false, text: `${OWN_RUNNER_LINE} · no client connected` });
    expect(tape(never)).toBe('Waiting for its creator’s AI client: none is connected');
    // A turn finished a moment ago does not make it active: the client that ran it is gone.
    const left = { lastTurnAt: new Date(NOW - 5 * 60_000).toISOString(), clients: 0 };
    expect(page(left)).toEqual({ active: false, text: `${OWN_RUNNER_LINE} · no client connected · away since 12 Nov, 09:55 UTC` });
    expect(tape(left)).toBe('Waiting for its creator’s AI client: none is connected · away since 12 Nov, 09:55 UTC');
  });
});

describe('an own agent with a client connected', () => {
  it('has no turn yet, was last active, or has been away since, by the same cut on both', () => {
    expect(page({ lastTurnAt: null, clients: 1 })).toEqual({ active: false, text: `${OWN_RUNNER_LINE} · no turn yet` });
    expect(tape({ lastTurnAt: null, clients: 1 })).toBe('AI client connected · no turn yet');

    const recent = { lastTurnAt: new Date(NOW - 14 * 60_000).toISOString(), clients: 2 };
    expect(page(recent)).toEqual({ active: true, text: `${OWN_RUNNER_LINE} · last active 14 minutes ago` });
    expect(tape(recent)).toBe('Last active 12 Nov, 09:46 UTC');

    // Two posting intervals is the cut, an hour at least: four hours and a minute after a turn it is away.
    const edge = { lastTurnAt: new Date(NOW - 4 * HOUR).toISOString(), clients: 1 };
    expect(page(edge).active).toBe(true);
    expect(tape(edge)).toMatch(/^Last active /);
    const old = { lastTurnAt: new Date(NOW - 4 * HOUR - 60_000).toISOString(), clients: 1 };
    expect(page(old)).toEqual({ active: false, text: `${OWN_RUNNER_LINE} · away since 12 Nov, 05:59 UTC` });
    expect(tape(old)).toBe('Away since 12 Nov, 05:59 UTC');
    // A fast agent (a post every ten minutes) is still given an hour.
    expect(page({ lastTurnAt: new Date(NOW - 50 * 60_000).toISOString(), clients: 1 }, 10 * 60_000).active).toBe(true);
    expect(page({ lastTurnAt: new Date(NOW - 61 * 60_000).toISOString(), clients: 1 }, 10 * 60_000).active).toBe(false);
  });

  it('never says sleeping, awake or fuel', () => {
    for (const own of [
      { lastTurnAt: null, clients: 0 },
      { lastTurnAt: null, clients: 1 },
      { lastTurnAt: new Date(NOW - 60_000).toISOString(), clients: 1 },
      { lastTurnAt: '2026-11-09T14:20:00.000Z', clients: 1 },
    ]) {
      expect(`${page(own).text} ${tape(own)}`).not.toMatch(/sleep|awake|fuel/i);
    }
  });
});

describe('what comes before the client', () => {
  it('the coin’s own state and a missing X account are said first, as before', () => {
    const own = config({ lastTurnAt: null, clients: 0 });
    expect(ownStatusLine(TOKEN, { status: 'paused' } as Agent, own, NOW).text).toBe(`${OWN_RUNNER_LINE} · paused by creator`);
    expect(ownStatusLine(TOKEN, { status: 'dormant' } as Agent, own, NOW).text).toBe(`${OWN_RUNNER_LINE} · dormant`);
    expect(ownStatusLine({ xHandle: null }, null, own, NOW).text).toBe(`${OWN_RUNNER_LINE} · waiting for an X account`);
    expect(ownStatusLine(TOKEN, null, null, NOW).text).toBe(OWN_RUNNER_LINE);
  });

  it('a count that is not known claims nothing about the clients (the console card passes none)', () => {
    expect(ownPresence(null, 2 * HOUR, NOW)).toEqual({ active: false, text: 'no turn yet' });
    expect(ownPresence(new Date(NOW - 60_000).toISOString(), 2 * HOUR, NOW)).toEqual({ active: true, text: 'last active 1 minute ago' });
  });
});
