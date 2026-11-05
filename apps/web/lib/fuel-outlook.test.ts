import { describe, expect, it } from 'vitest';
import { failedOpsStreak, fuelOutlook, runwayLine } from './fuel-outlook';
import type { AgentActivityItem, AgentFuel } from './types';

const NOW = Date.parse('2026-11-05T08:00:00.000Z');
const DAY = 86_400_000;
const USDC = (n: number) => String(Math.round(n * 1e6));

function fuel(thoughts: number, spentUsdc: number, ageDays = 2): AgentFuel {
  return {
    days: 7,
    since: new Date(NOW - 7 * DAY).toISOString(),
    firstAt: new Date(NOW - ageDays * DAY).toISOString(),
    byModel: [{ model: 'x/y', thoughts, chargedMicroUsdc: USDC(spentUsdc) }],
  };
}

const op = (ageMs: number, kind: string, summary: string): AgentActivityItem => ({ at: new Date(NOW - ageMs).toISOString(), kind, summary });
const outlook = (over: Partial<Parameters<typeof fuelOutlook>[0]>) => fuelOutlook({ fuel: fuel(100, 10), spenderUsdc: USDC(10), treasuryUsdc: USDC(5), activity: [], now: NOW, ...over });

describe('runwayLine', () => {
  it('says the runway in plain words', () => {
    expect(runwayLine(3.2)).toBe('About 3 days of fuel at the recent rate.');
    expect(runwayLine(1)).toBe('About 1 day of fuel at the recent rate.');
    expect(runwayLine(0.5)).toBe('About 12 hours of fuel at the recent rate.');
    expect(runwayLine(1 / 24)).toBe('About 1 hour of fuel at the recent rate.');
    expect(runwayLine(0.01)).toBe('Less than an hour of fuel at the recent rate.');
    expect(runwayLine(400)).toBe('More than 60 days of fuel at the recent rate.');
    expect(runwayLine(0)).toBe('Out of fuel.');
    expect(runwayLine(null)).toBeNull();
  });
});

describe('fuelOutlook', () => {
  it('divides everything the agent can spend by what it spent per day of its real history', () => {
    // $10 over 2 days is $5 a day; $15 of fuel lasts 3 days. A week-long divisor would have said 10.
    expect(outlook({}).runway).toBe('About 3 days of fuel at the recent rate.');
    expect(outlook({}).warnings).toEqual([]);
  });

  it('says nothing on thin data', () => {
    expect(outlook({ fuel: fuel(3, 0.3) })).toEqual({ runway: null, warnings: [] });
    expect(outlook({ fuel: fuel(100, 10, 0.1) }).runway).toBeNull();
    expect(outlook({ fuel: null })).toEqual({ runway: null, warnings: [] });
    expect(outlook({ fuel: { ...fuel(100, 10), firstAt: undefined } }).runway).toBeNull();
    expect(outlook({ spenderUsdc: null })).toEqual({ runway: null, warnings: [] });
  });

  it('says nothing with zero spend', () => {
    expect(outlook({ fuel: fuel(100, 0) })).toEqual({ runway: null, warnings: [] });
  });

  it('warns when the ready fuel cannot cover the next thoughts, and points at the reserve', () => {
    const { warnings } = outlook({ fuel: fuel(100, 9), spenderUsdc: USDC(1.78), treasuryUsdc: USDC(20) });
    expect(warnings).toEqual([{ key: 'low_fuel', tone: 'warning', text: 'Low on fuel: enough for about 19 more thoughts right now. $20.00 more is in reserve and should move over on its own.' }]);
  });

  it('does not warn when the ready fuel covers the next thoughts', () => {
    expect(outlook({ fuel: fuel(100, 9), spenderUsdc: USDC(2.16) }).warnings).toEqual([]);
  });

  it('handles an empty wallet', () => {
    const out = outlook({ spenderUsdc: '0', treasuryUsdc: '0' });
    expect(out.runway).toBe('Out of fuel.');
    expect(out.warnings).toEqual([{ key: 'low_fuel', tone: 'danger', text: 'Out of fuel to think with right now. Add fuel to keep the agent thinking.' }]);
  });

  it('warns when treasury operations keep failing, even without fuel data', () => {
    const activity = [op(1000, 'post', 'Posted on X'), op(2000, 'claim', 'Fee claim failed'), op(3000, 'fuel', 'Fuel top-up failed'), op(4000, 'claim', 'Claimed 0.1 WETH')];
    expect(outlook({ activity, fuel: null }).warnings).toEqual([{ key: 'ops_failing', tone: 'warning', text: 'The last 2 fee claims, swaps or top-ups failed, so new fuel may not arrive.' }]);
  });

  it('never uses internal words', () => {
    const out = outlook({ fuel: fuel(100, 9), spenderUsdc: '0', treasuryUsdc: USDC(20), activity: [op(1, 'claim', 'Fee claim failed'), op(2, 'swap', 'Swap failed')] });
    expect(out.warnings).toHaveLength(2);
    expect(JSON.stringify(out)).not.toMatch(/spender|kernel|x402|EOA|float/i);
  });
});

describe('failedOpsStreak', () => {
  it('stops at the first operation that went through', () => {
    expect(failedOpsStreak([op(1, 'claim', 'Claimed 0.1 WETH'), op(2, 'claim', 'Fee claim failed')], NOW)).toBe(0);
    expect(failedOpsStreak([op(1, 'claim', 'Fee claim failed'), op(2, 'gas', 'Gas top-up failed')], NOW)).toBe(2);
    expect(failedOpsStreak([], NOW)).toBe(0);
  });

  it('forgets failures older than a day', () => {
    expect(failedOpsStreak([op(2 * DAY, 'claim', 'Fee claim failed'), op(3 * DAY, 'claim', 'Fee claim failed')], NOW)).toBe(0);
  });

  it('ignores a failed publish on the tape', () => {
    expect(failedOpsStreak([op(1, 'approval_rejected', 'Post failed'), op(2, 'post', 'Posted on X')], NOW)).toBe(0);
  });
});
