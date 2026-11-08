import { describe, expect, it } from 'vitest';
import { CONSOLE_SECTIONS } from './console-sections';
import { fuelFromAgent, onboardingComplete, onboardingHiddenKey, onboardingItems, onboardingPending, SECTION_HINTS, type OnboardingInput } from './onboarding';

const fresh: OnboardingInput = { xHandle: null, instructions: '', fuelUsdc: 0n, fuelReceivedUsdc: 0n, gasWei: 0n };
const settled: OnboardingInput = { xHandle: 'owl_agent', instructions: 'A patient analyst.', fuelUsdc: 12_000_000n, fuelReceivedUsdc: 40_000_000n, gasWei: 10n ** 15n };

describe('onboardingItems', () => {
  it('lists the four first steps undone for a brand-new agent, each pointing at a section or the X banner', () => {
    const items = onboardingItems(fresh);
    expect(items.map((i) => i.key)).toEqual(['x', 'instructions', 'fuel', 'gas']);
    expect(items.every((i) => i.done === false)).toBe(true);
    expect(items.map((i) => i.target)).toEqual(['x', 'mind', 'fuel', 'fuel']);
    expect(onboardingComplete(items)).toBe(false);
    expect(onboardingPending(items)).toBe(false);
  });

  it('is complete once every step is done', () => {
    const items = onboardingItems(settled);
    expect(items.every((i) => i.done === true)).toBe(true);
    expect(onboardingComplete(items)).toBe(true);
  });

  it('counts fuel as added when it was ever received, even if spent', () => {
    expect(onboardingItems({ ...fresh, fuelUsdc: 0n, fuelReceivedUsdc: 1n }).find((i) => i.key === 'fuel')?.done).toBe(true);
    expect(onboardingItems({ ...fresh, fuelUsdc: 1n, fuelReceivedUsdc: 0n }).find((i) => i.key === 'fuel')?.done).toBe(true);
  });

  it('treats dust as no gas, the same line the console draws for "out of gas"', () => {
    expect(onboardingItems({ ...fresh, gasWei: 10n ** 12n }).find((i) => i.key === 'gas')?.done).toBe(false);
    expect(onboardingItems({ ...fresh, gasWei: 10n ** 15n }).find((i) => i.key === 'gas')?.done).toBe(true);
  });

  it('ignores whitespace-only instructions', () => {
    expect(onboardingItems({ ...fresh, instructions: '   ' }).find((i) => i.key === 'instructions')?.done).toBe(false);
  });

  it('is pending, not undone, while a balance is still loading', () => {
    const items = onboardingItems({ ...fresh, fuelUsdc: null, fuelReceivedUsdc: null });
    expect(items.find((i) => i.key === 'fuel')?.done).toBeNull();
    expect(onboardingPending(items)).toBe(true);
    expect(onboardingPending(onboardingItems({ ...settled, gasWei: null }))).toBe(true);
    expect(onboardingComplete(onboardingItems({ ...settled, gasWei: null }))).toBe(false);
  });
});

describe('fuelFromAgent', () => {
  it('adds the kernel and spender USDC and reads what was ever received', () => {
    expect(fuelFromAgent({ treasuryUsdc: '1000000', spenderUsdc: '250000', fuelReceivedUsdc: '20000000' })).toEqual({ fuelUsdc: 1_250_000n, fuelReceivedUsdc: 20_000_000n });
  });
  it('is unknown without an agent row and tolerant of bad strings', () => {
    expect(fuelFromAgent(null)).toEqual({ fuelUsdc: null, fuelReceivedUsdc: null });
    expect(fuelFromAgent({ treasuryUsdc: 'x', spenderUsdc: null, fuelReceivedUsdc: undefined })).toEqual({ fuelUsdc: 0n, fuelReceivedUsdc: 0n });
  });
});

describe('copy', () => {
  it('has one hint per section, in plain words', () => {
    for (const s of CONSOLE_SECTIONS) {
      const text = SECTION_HINTS[s.id];
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/x402|session key|kernel|supervisor|spender/i);
    }
    for (const i of onboardingItems(fresh)) expect(`${i.label} ${i.detail} ${i.action}`).not.toMatch(/x402|session key|kernel|supervisor|spender|EOA/i);
  });

  it('keys the hidden flag by agent', () => {
    expect(onboardingHiddenKey('0xABC')).toBe('bootr:onboarding-hidden:0xabc');
  });
});
