import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { clankerV5ProtocolBps, DEAD_ADDRESS, feeModelOf, launcherName, launcherPct, ofVolume, pctLabel, platformSlot, slotsBps, splitFromSlots, swapFeePct, traderPaysPct, type FeeModel, type Slot } from './fee-split';

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

describe('fee model (Bootr vs Clanker)', () => {
  const clanker: FeeModel = { source: 'clanker', lpFeeBps: 10_000 };
  const clanker2: FeeModel = { source: 'clanker', lpFeeBps: 20_000 };

  it('defaults to the Bootr path at 1% and reads the token fields otherwise', () => {
    expect(feeModelOf(null)).toEqual({ source: 'bootr', lpFeeBps: 10_000 });
    expect(feeModelOf({ lpFeeBps: 0 })).toEqual({ source: 'bootr', lpFeeBps: 10_000 });
    expect(feeModelOf({ source: 'clanker', lpFeeBps: 20_000 })).toEqual(clanker2);
  });

  it('charges 20% on top for Clanker, computed from the coin fee', () => {
    expect(pctLabel(swapFeePct(clanker))).toBe('1.00%');
    expect(pctLabel(traderPaysPct(clanker))).toBe('1.20%');
    expect(pctLabel(launcherPct(clanker))).toBe('0.20%');
    expect(pctLabel(traderPaysPct(clanker2))).toBe('2.40%');
    expect(pctLabel(launcherPct(clanker2))).toBe('0.40%');
    // Bootr: 1% in total, RWAGMI's 10% within it.
    expect(pctLabel(traderPaysPct())).toBe('1.00%');
    expect(pctLabel(launcherPct())).toBe('0.10%');
  });

  it('gives the slots the whole fee on the Clanker path', () => {
    const preset = { agent: 500, creator: 6500, burn: 0, platform: 3000 };
    expect(pctLabel(ofVolume(preset, 'agent', clanker))).toBe('0.05%');
    expect(pctLabel(ofVolume(preset, 'creator', clanker))).toBe('0.65%');
    expect(pctLabel(ofVolume(preset, 'platform', clanker))).toBe('0.30%');
    expect(pctLabel(ofVolume(preset, 'creator', clanker2))).toBe('1.30%');
    expect(slotsBps(clanker)).toBe(10_000);
  });

  it('Clanker v5: the trader pays the tax, Clanker keeps its share inside it, the slots share the rest', () => {
    const v5: FeeModel = { source: 'clanker-v5', lpFeeBps: 15_000 };
    expect(clankerV5ProtocolBps(15_000)).toBe(3333);
    expect(clankerV5ProtocolBps(20_000)).toBe(2500);
    expect(clankerV5ProtocolBps(100_000)).toBe(1000);
    expect(pctLabel(traderPaysPct(v5))).toBe('1.50%');
    expect(pctLabel(launcherPct(v5))).toBe('0.50%');
    expect(slotsBps(v5)).toBe(6667);
    const standard = { agent: 500, creator: 6500, burn: 0, platform: 3000 };
    expect(pctLabel(ofVolume(standard, 'agent', v5))).toBe('0.05%');
    expect(pctLabel(ofVolume(standard, 'creator', v5))).toBe('0.65%');
    expect(pctLabel(ofVolume(standard, 'platform', v5))).toBe('0.30%');
    const buyback = { agent: 500, creator: 5000, burn: 1500, platform: 3000 };
    expect(pctLabel(ofVolume(buyback, 'burn', v5))).toBe('0.15%');
    // The coin's indexed slots (summing to 10000 − protocolBps) give the same shares and Clanker's share back.
    const coin = feeModelOf({ source: 'clanker-v5', lpFeeBps: 15_000, agentBps: 333, creatorBps: 4334, burnBps: 0, platformBps: 2000 });
    expect(coin).toEqual({ source: 'clanker-v5', lpFeeBps: 15_000, protocolBps: 3333 });
    expect(pctLabel(ofVolume({ agent: 333, creator: 4334, burn: 0, platform: 2000 }, 'creator', coin))).toBe('0.65%');
    // Without slots or a fee, a v5 coin reads as the 1.5% default.
    expect(feeModelOf({ source: 'clanker-v5' })).toEqual({ source: 'clanker-v5', lpFeeBps: 15_000, protocolBps: 3333 });
    expect(launcherName(v5)).toBe('Clanker');
  });

  it('classifies Clanker slots that total 10000 bps, with the burn slot at the dead address', () => {
    const rewards = [slot(KERNEL, 500), slot(CREATOR, 5000), slot(DEAD_ADDRESS, 1500), slot(PLATFORM, 3000)];
    expect(splitFromSlots(rewards, { kernel: KERNEL, creator: CREATOR, burner: null }, clanker)).toEqual({ agent: 500, creator: 5000, burn: 1500, platform: 3000 });
    expect(platformSlot(rewards, clanker)?.recipient).toBe(PLATFORM);
    // The same slots read as a Bootr coin do not add up.
    expect(splitFromSlots(rewards, { kernel: KERNEL, creator: CREATOR, burner: null })).toBeNull();
  });
});
