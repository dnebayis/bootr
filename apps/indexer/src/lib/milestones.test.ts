import { describe, expect, it } from 'vitest';

import { crossed, holderMilestones, milestoneId, swapMilestones } from './milestones';

const TX = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const LAUNCH = '0x2222222222222222222222222222222222222222222222222222222222222222' as const;

describe('milestones', () => {
  it('reports thresholds passed, once, from strictly below to at or above', () => {
    expect(crossed(0, 25, [25, 100])).toEqual([25]);
    expect(crossed(24, 130, [25, 100, 500])).toEqual([25, 100]);
    expect(crossed(25, 26, [25])).toEqual([]);
    expect(crossed(100, 50, [25, 100])).toEqual([]);
    expect(crossed(Number.NaN, 1000, [25])).toEqual([]);
  });

  it('holder milestones are 25 / 100 / 500 / 1000', () => {
    expect(holderMilestones(99, 100)).toEqual([{ kind: 'holders', value: 100 }]);
    expect(holderMilestones(0, 1200)).toEqual([25, 100, 500, 1000].map((value) => ({ kind: 'holders', value })));
    expect(holderMilestones(100, 99)).toEqual([]);
  });

  it('a swap in the launch tx (the dev buy) is not the first trade; later ones are, plus 24 h volume thresholds', () => {
    expect(swapMilestones({ txHash: LAUNCH, launchTx: LAUNCH, prevVolume24hUsd: 0, nextVolume24hUsd: 50 })).toEqual([]);
    expect(swapMilestones({ txHash: TX, launchTx: LAUNCH, prevVolume24hUsd: 0, nextVolume24hUsd: 50 })).toEqual([{ kind: 'first_swap', value: 0 }]);
    expect(swapMilestones({ txHash: TX, launchTx: LAUNCH, prevVolume24hUsd: 900, nextVolume24hUsd: 12_000 })).toEqual([
      { kind: 'first_swap', value: 0 },
      { kind: 'volume24h', value: 1_000 },
      { kind: 'volume24h', value: 10_000 },
    ]);
  });

  it('ids are one per (token, kind, value)', () => {
    expect(milestoneId('0xabc', 'holders', 100)).toBe('0xabc-holders-100');
    expect(milestoneId('0xabc', 'first_swap', 0)).toBe('0xabc-first_swap-0');
  });
});
