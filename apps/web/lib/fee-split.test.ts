import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { ofVolume, pctLabel, platformSlot, splitFromSlots, type Slot } from './fee-split';

const KERNEL = '0x1000000000000000000000000000000000000001' as Address;
const CREATOR = '0x2000000000000000000000000000000000000002' as Address;
const BURNER = '0x3000000000000000000000000000000000000003' as Address;
const PLATFORM = '0x4000000000000000000000000000000000000004' as Address;
const RWAGMI = '0x5000000000000000000000000000000000000005' as Address;

const slot = (recipient: Address, bps: number): Slot => ({ recipient, bps });

describe('fee split', () => {
  it('labels shares of volume with two or three decimals', () => {
    expect(pctLabel(0.045)).toBe('0.045%');
    expect(pctLabel(0.585)).toBe('0.585%');
    expect(pctLabel(0.27)).toBe('0.27%');
    expect(pctLabel(0.1)).toBe('0.10%');
    expect(pctLabel(1)).toBe('1.00%');
  });

  it('maps launcher presets (of 10000) and locker slots (of 9000) to the same share of volume', () => {
    const preset = { agent: 500, creator: 5000, burn: 1500, platform: 3000 };
    const slots = { agent: 450, creator: 4500, burn: 1350, platform: 2700 };
    for (const k of ['agent', 'creator', 'burn', 'platform'] as const) expect(ofVolume(preset, k)).toBeCloseTo(ofVolume(slots, k), 12);
    expect(pctLabel(ofVolume(preset, 'agent'))).toBe('0.045%');
    expect(pctLabel(ofVolume(preset, 'creator'))).toBe('0.45%');
    expect(pctLabel(ofVolume(preset, 'burn'))).toBe('0.135%');
    expect(pctLabel(ofVolume({ agent: 500, creator: 6500, burn: 0, platform: 3000 }, 'creator'))).toBe('0.585%');
  });

  it('classifies Bootr slots by recipient and leaves the appended RWAGMI slot out', () => {
    const rewards = [slot(KERNEL, 450), slot(CREATOR, 4500), slot(BURNER, 1350), slot(PLATFORM, 2700), slot(RWAGMI, 1000)];
    expect(splitFromSlots(rewards, { kernel: KERNEL, creator: CREATOR, burner: BURNER })).toEqual({ agent: 450, creator: 4500, burn: 1350, platform: 2700 });
    expect(platformSlot(rewards)?.recipient).toBe(PLATFORM);
    // Without the RWAGMI slot the result is the same.
    expect(platformSlot(rewards.slice(0, 4))?.recipient).toBe(PLATFORM);
  });

  it('rejects slots that do not add up to 9000 bps', () => {
    const rewards = [slot(KERNEL, 2000), slot(CREATOR, 5000), slot(PLATFORM, 3000)];
    expect(splitFromSlots(rewards, { kernel: KERNEL, creator: CREATOR, burner: null })).toBeNull();
    expect(platformSlot(rewards)).toBeNull();
    expect(platformSlot([])).toBeNull();
  });
});
