import { describe, expect, it } from 'vitest';
import { THOUGHTS_PER_POST } from '@bootr/shared/fuel';
import { cadenceLabel, dailyFuelMicroUsdc, measuredThoughtCost, postBudgetNote, shownInterval } from './post-budget';

const H = 3_600_000;

describe('posts per day (console copy)', () => {
  it('shows the stored cadence while the budget is unchanged and the implied one once it moves', () => {
    expect(shownInterval(24, { postsPerDay: 24, postIntervalMs: 8 * H })).toBe(8 * H);
    expect(shownInterval(12, { postsPerDay: 24, postIntervalMs: 8 * H })).toBe(4 * H);
    expect(shownInterval(2, { postsPerDay: 24, postIntervalMs: 8 * H })).toBe(24 * H);
    expect(cadenceLabel(2 * H)).toBe('Every 2 h');
    expect(cadenceLabel(Math.round((24 * H) / 7 / 60_000) * 60_000)).toBe('Every 3.4 h');
    expect(cadenceLabel(24 * H)).toBe('Once a day');
  });

  it('measures the cost of a thought from the fuel report only with enough history, and falls back to the listed price', () => {
    expect(measuredThoughtCost(null)).toBeNull();
    expect(measuredThoughtCost({ days: 7, since: 'x', byModel: [{ model: 'm', thoughts: 4, chargedMicroUsdc: '4000' }] })).toBeNull();
    expect(measuredThoughtCost({ days: 7, since: 'x', byModel: [{ model: 'm', thoughts: 30, chargedMicroUsdc: '30000' }, { model: 'n', thoughts: 10, chargedMicroUsdc: '50000' }] })).toBe(2000);
    expect(dailyFuelMicroUsdc({ postsPerDay: 24, measuredMicroUsdc: 2000, listedUsd: 0.01 })).toBe(24 * THOUGHTS_PER_POST * 2000);
    expect(dailyFuelMicroUsdc({ postsPerDay: 24, measuredMicroUsdc: null, listedUsd: 0.01 })).toBe(24 * THOUGHTS_PER_POST * 10_000);
    expect(dailyFuelMicroUsdc({ postsPerDay: 24, measuredMicroUsdc: null, listedUsd: null })).toBeNull();
  });

  it('says what the budget covers, the cadence it implies and the rough daily fuel, in plain words', () => {
    const measured = postBudgetNote({ postsPerDay: 24, intervalMs: 2 * H, measuredMicroUsdc: 2000, listedUsd: 0.01 });
    expect(measured).toMatch(/^Original posts and replies together, over a rolling day\. Original posts go out about every 2 h; the rest of the budget answers mentions/);
    expect(measured).toMatch(/Roughly \$0\.24 a day in fuel at what its thoughts have cost lately \(about 5 thoughts a post\)/);
    const listed = postBudgetNote({ postsPerDay: 2, intervalMs: 24 * H, measuredMicroUsdc: null, listedUsd: 0.01 });
    expect(listed).toMatch(/about once a day/);
    expect(listed).toMatch(/\$0\.10 a day in fuel at the model’s listed price/);
    const unknown = postBudgetNote({ postsPerDay: 12, intervalMs: 4 * H, measuredMicroUsdc: null, listedUsd: null });
    expect(unknown).not.toMatch(/Roughly/);
    // public copy: no service names
    expect(`${measured} ${listed} ${unknown}`).not.toMatch(/sender|supervisor|quota|x402|relay/i);
  });
});
