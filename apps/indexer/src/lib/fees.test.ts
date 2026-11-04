import { describe, expect, it } from 'vitest';

import { bpsByKind, classifyRecipient, classifySlots, DEAD_ADDRESS, REWARD_BPS_TOTAL, SLOTS_BPS_TOTAL, splitFee, swapFeePips, type RewardSlot } from './fees';

const parties = {
  kernel: '0x00000000000000000000000000000000000000a1',
  creator: '0x00000000000000000000000000000000000000c1',
  burner: '0x00000000000000000000000000000000000000b1',
  platformRecipient: '0x00000000000000000000000000000000000000f1',
} as const;
const LAUNCHER = '0x00000000000000000000000000000000000000ee';
const RWAGMI = '0xB20b907C55B29fdd39680224941Eef4Cff6ebB20';
const slot = (recipient: `0x${string}`, bps: number, admin: `0x${string}` = LAUNCHER): RewardSlot => ({ admin, recipient, bps });

describe('RWAGMI reward slots', () => {
  it('classifies the standard preset [kernel, creator, platform] + RWAGMI', () => {
    const rewards = [slot(parties.kernel, 450), slot(parties.creator, 5850), slot(parties.platformRecipient, 2700), slot(RWAGMI, 1000, RWAGMI)];
    const kinds = classifySlots(rewards, { ...parties, burner: null });
    expect(kinds).toEqual(['agent', 'creator', 'platform', 'protocol']);
    expect(bpsByKind(rewards, kinds)).toEqual({ agent: 450, creator: 5850, burn: 0, platform: 2700, protocol: 1000 });
  });

  it('classifies the buyback preset [kernel, creator, burner, platform] + RWAGMI', () => {
    const rewards = [
      slot(parties.kernel, 450),
      slot(parties.creator, 4500),
      slot(parties.burner, 1350),
      slot(parties.platformRecipient, 2700),
      slot(RWAGMI, 1000, RWAGMI),
    ];
    const kinds = classifySlots(rewards, parties);
    expect(kinds).toEqual(['agent', 'creator', 'burn', 'platform', 'protocol']);
    const bps = bpsByKind(rewards, kinds);
    expect(bps.agent + bps.creator + bps.burn + bps.platform).toBe(9000);
    expect(bps.agent + bps.creator + bps.burn + bps.platform + bps.protocol).toBe(REWARD_BPS_TOTAL);
  });

  it('keeps creator and platform apart when they are the same address (slot order wins)', () => {
    const same = { ...parties, burner: null, platformRecipient: parties.creator };
    const rewards = [slot(parties.kernel, 450), slot(parties.creator, 5850), slot(parties.creator, 2700), slot(RWAGMI, 1000)];
    expect(classifySlots(rewards, same)).toEqual(['agent', 'creator', 'platform', 'protocol']);
  });

  it('falls back to addresses for unexpected order and leaves unknown middle slots unclassified', () => {
    const rewards = [slot(parties.creator, 5850), slot('0x0000000000000000000000000000000000000999', 450), slot(parties.kernel, 2700), slot(RWAGMI, 1000)];
    expect(classifySlots(rewards, { ...parties, burner: null })).toEqual(['creator', null, 'agent', 'protocol']);
  });

  it('splits a fee like the locker credits a slot (floor of amount * bps / 10_000)', () => {
    // Base mainnet pool 0xf376...: settledCumulative 23462424488034028 credited 21116182039230625 to the
    // 9000-bps creator slot and 2346242448803402 to RWAGMI's 1000-bps slot (locker poolRecord, 2026-10-29).
    expect(splitFee(23462424488034028n, [9000, 1000])).toEqual([21116182039230625n, 2346242448803402n]);
    expect(splitFee(0n, [450, 5850])).toEqual([0n, 0n]);
  });
});

describe('two launch paths', () => {
  it('Bootr slots total 9000 inside the fee (RWAGMI keeps 1000), Clanker slots total 10000 (Clanker charges on top)', () => {
    expect(SLOTS_BPS_TOTAL).toEqual({ bootr: 9000, clanker: 10_000 });
    const clanker = [slot(parties.kernel, 500), slot(parties.creator, 5000), slot(DEAD_ADDRESS, 1500), slot(parties.platformRecipient, 3000)];
    const kinds = classifySlots(clanker, { ...parties, burner: DEAD_ADDRESS }, 'clanker');
    expect(kinds).toEqual(['agent', 'creator', 'burn', 'platform']);
    const bps = bpsByKind(clanker, kinds);
    expect(bps.agent + bps.creator + bps.burn + bps.platform).toBe(SLOTS_BPS_TOTAL.clanker);
    expect(bps.protocol).toBe(0);
  });

  it('the dead address is the burn slot on either path, even without a burner on the token', () => {
    expect(classifyRecipient(DEAD_ADDRESS, { ...parties, burner: null })).toBe('burn');
    expect(classifyRecipient(parties.burner, parties)).toBe('burn');
    expect(classifyRecipient(parties.burner, { ...parties, burner: null })).toBeNull();
  });

  it('what a trader pays per swap, in pips, from Swap.fee and the coin’s own lpFeeBps', () => {
    expect(swapFeePips('bootr', 0, 10_000)).toBe(10_000);
    expect(swapFeePips('bootr', 0, 20_000)).toBe(20_000);
    expect(swapFeePips('clanker', 10_000, 10_000)).toBe(12_000);
    expect(swapFeePips('clanker', 20_000, 20_000)).toBe(24_000);
    expect(swapFeePips('clanker', 0, 20_000)).toBe(24_000);
  });
});
