import { describe, expect, it } from 'vitest';
import { OWN_AGENT_MODEL_ID } from '@bootr/shared/own-agent';
import { awaitsOwnJudge, closedUnjudged, JUDGE_ABSENT, outcomeLine, OWN_JUDGE_ABSENT, OWN_JUDGE_WAITING } from './bounties';

const verdict = (invalid: string | null) => ({ winner: null, winningEntryUrl: null, perCriterion: {}, reason: '', invalid, deliveryHash: null, reasonHash: null, judgedAt: null });
const OWN = { model: OWN_AGENT_MODEL_ID };
const HOSTED = { model: 'anthropic/claude-sonnet-4.6' };

describe('bounties of a coin whose agent runs in its creator’s own AI client', () => {
  it('a job whose window closed waits for that agent’s ruling, and says so with the 48 hours', () => {
    // the agent service says so on the job, or the coin itself is run that way
    expect(awaitsOwnJudge({ status: 'judging', verdict: null, ownJudge: { ruleBy: '2026-11-14T12:00:00.000Z' } })).toBe(true);
    expect(awaitsOwnJudge({ status: 'judging', verdict: null }, OWN)).toBe(true);
    expect(outcomeLine({ status: 'judging' }, OWN)).toBe(OWN_JUDGE_WAITING);
    expect(outcomeLine({ status: 'judging', ownJudge: { ruleBy: '2026-11-14T12:00:00.000Z' } })).toBe(OWN_JUDGE_WAITING);
    expect(OWN_JUDGE_WAITING).toContain('Judged when the creator’s agent is next online, within 48 hours.');
    expect(OWN_JUDGE_WAITING).toContain('nothing is paid');
    // plain public copy: none of the service's own words
    expect(`${OWN_JUDGE_WAITING} ${OWN_JUDGE_ABSENT}`).not.toMatch(/own-agent|runner|MCP|client turn|judge_absent|supervisor|session/i);
  });

  it('a hosted coin’s job being judged says nothing more than before', () => {
    expect(awaitsOwnJudge({ status: 'judging', verdict: null }, HOSTED)).toBe(false);
    expect(awaitsOwnJudge({ status: 'judging', verdict: null })).toBe(false);
    expect(awaitsOwnJudge({ status: 'judging', verdict: null, ownJudge: null }, HOSTED)).toBe(false);
    expect(outcomeLine({ status: 'judging' }, HOSTED)).toBeNull();
    expect(outcomeLine({ status: 'judging' })).toBeNull();
  });

  it('only a job that is being judged and has no verdict waits', () => {
    for (const status of ['draft', 'open', 'proposed', 'paid', 'no_winner', 'cancelled', 'expired', 'failed'] as const) expect(awaitsOwnJudge({ status, verdict: null, ownJudge: { ruleBy: 'x' } }, OWN), status).toBe(false);
    expect(awaitsOwnJudge({ status: 'judging', verdict: verdict(null) }, OWN)).toBe(false);
    expect(outcomeLine({ status: 'open' }, OWN)).toBeNull();
    expect(outcomeLine({ status: 'proposed' }, OWN)).toContain('Nothing is paid until they say yes.');
  });

  it('a job that closed because the ruling never came says so, and any other job with no winner says what it said', () => {
    expect(JUDGE_ABSENT).toBe('judge_absent');
    expect(closedUnjudged({ status: 'no_winner', verdict: verdict('judge_absent') })).toBe(true);
    expect(outcomeLine({ status: 'no_winner', verdict: verdict('judge_absent') })).toBe(OWN_JUDGE_ABSENT);
    expect(outcomeLine({ status: 'no_winner', verdict: verdict('judge_absent') }, HOSTED)).toBe(OWN_JUDGE_ABSENT);
    expect(OWN_JUDGE_ABSENT).toBe('The creator’s agent did not judge the entries within 48 hours; nothing paid.');
    expect(closedUnjudged({ status: 'no_winner', verdict: verdict('no_entries') })).toBe(false);
    expect(closedUnjudged({ status: 'no_winner', verdict: verdict(null) })).toBe(false);
    expect(closedUnjudged({ status: 'no_winner', verdict: null })).toBe(false);
    expect(closedUnjudged({ status: 'expired', verdict: verdict('judge_absent') })).toBe(false);
    expect(outcomeLine({ status: 'no_winner', verdict: verdict('winner_not_passing') }, OWN)).toBe('No entry met the job; nothing paid.');
    expect(outcomeLine({ status: 'no_winner' })).toBe('No entry met the job; nothing paid.');
  });
});
