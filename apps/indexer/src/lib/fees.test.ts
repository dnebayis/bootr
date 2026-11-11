import { describe, expect, it } from 'vitest';

import {
  allocateClaim,
  bpsByKind,
  claimParts,
  classifyRecipient,
  classifySlots,
  clankerV5ProtocolBps,
  clankerV5ProtocolRate,
  clankerV5SlotBps,
  clankerV5SlotWeights,
  DEAD_ADDRESS,
  REWARD_BPS_TOTAL,
  SLOTS_BPS_TOTAL,
  slotsBpsTotal,
  splitFee,
  swapFeePips,
  type LaunchSource,
  type RewardSlot,
} from './fees';

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
    expect(bpsByKind(rewards, kinds)).toEqual({ agent: 450, creator: 5850, burn: 0, platform: 2700, recipient: 0, protocol: 1000 });
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
    // Clanker v5: the pool's fee is 0 and the trader pays the tax as is, Clanker's share inside it.
    expect(swapFeePips('clanker-v5', 0, 15_000)).toBe(15_000);
  });
});

describe('Clanker v5 tax arithmetic (docs/design/clanker-v5-migration.md section 4)', () => {
  it('Clanker keeps 10% of the tax, at least 0.5% and at most 1% of the trade', () => {
    // 1e8 scale: 1.5% tax = 1_500_000; 10% of it (150_000) is under the 0.5% floor.
    expect(clankerV5ProtocolRate(1_500_000)).toBe(500_000);
    expect(clankerV5ProtocolRate(8_000_000)).toBe(800_000);
    expect(clankerV5ProtocolRate(10_000_000)).toBe(1_000_000);
    expect(clankerV5ProtocolRate(20_000_000)).toBe(1_000_000);
    expect(clankerV5ProtocolBps(15_000)).toBe(3333);
    expect(clankerV5ProtocolBps(12_000)).toBe(4166);
    expect(clankerV5ProtocolBps(20_000)).toBe(2500);
    // A policy read from LaunchTaxConfigured replaces the default.
    expect(clankerV5ProtocolBps(15_000, { protocolTaxShare: 20_000_000, minimumProtocolFeeRate: 0, maximumProtocolFeeRate: 1_000_000 })).toBe(2000);
    expect(slotsBpsTotal('clanker-v5', 3333)).toBe(6667);
    expect(slotsBpsTotal('bootr', 1000)).toBe(9000);
    expect(slotsBpsTotal('clanker', 2000)).toBe(10_000);
  });

  it('the launcher’s slot weights: the preset renormalised over the pool left after the burn, the creator takes the gap', () => {
    expect(clankerV5SlotWeights({ agentBps: 500, burnBps: 0, platformBps: 3000 })).toEqual([500, 6500, 3000]);
    expect(clankerV5SlotWeights({ agentBps: 500, burnBps: 1500, platformBps: 3000 })).toEqual([588, 5883, 3529]);
  });

  it('per-kind bps of the tax: the four kinds and Clanker’s share sum to 10000, the platform never above its share', () => {
    // Standard preset at 1.5%: Clanker 3333, slots 6667 split 5 / 65 / 30.
    const std = clankerV5SlotBps([500, 6500, 3000], 0, 3333);
    expect(std).toEqual({ paid: [333, 4334, 2000], burn: 0, dividend: 0 });
    expect(std.paid.reduce((a, b) => a + b, 0) + std.burn + 3333).toBe(REWARD_BPS_TOTAL);
    // Buyback preset: the burn is 15% of the slot pool, in the coin; the paid slots share the other 85%.
    const bb = clankerV5SlotBps([588, 5883, 3529], 1500, 3333);
    expect(bb.burn).toBe(1000);
    expect(bb.paid.reduce((a, b) => a + b, 0) + bb.burn + 3333).toBe(REWARD_BPS_TOTAL);
    expect(bb.paid[2]! / 6667).toBeLessThanOrEqual(0.3);
    expect(bb.paid[0]! / 6667).toBeCloseTo(0.05, 2);
  });
});

describe('a claim is split over the claiming locker’s own path (the 2026-11-08 cross-booking fix)', () => {
  // One wallet (FORK's creator, also a $BOOTR fee recipient) holds WETH balances on both a RWAGMI coin and a
  // Clanker v4 coin; `feeBalance` groups by (recipient, asset) only, so both rows answer a WETH claim.
  const RWAGMI_COIN = '0xb20000000000000000000000000000000000f0cc';
  const BOOTR = '0xb1c3000000000000000000000000000000009565';
  const source: Record<string, LaunchSource> = { [RWAGMI_COIN]: 'bootr', [BOOTR]: 'clanker' };
  const rows = [
    // RWAGMI: 0.00045 WETH settled, not yet claimed.
    { id: `0xw-weth-${RWAGMI_COIN}`, token: RWAGMI_COIN, settled: 450_000_000_000_000n, claimed: 0n },
    // Clanker v4: 0.0012 WETH stored in the fee locker.
    { id: `0xw-weth-${BOOTR}`, token: BOOTR, settled: 1_200_000_000_000_000n, claimed: 0n },
  ];
  const claim = 1_200_000_000_000_000n; // ClankerFeeLocker.ClaimTokens: exactly the $BOOTR balance

  it('reproduces the bug: split over every row of the wallet, the Clanker coin comes out short', () => {
    const naive = allocateClaim(
      rows.map((r) => r.settled - r.claimed),
      claim,
    );
    expect(naive[1]).toBeLessThan(claim);
    expect(claim - naive[1]!).toBeGreaterThan(0n);
    expect(naive[0]).toBeGreaterThan(0n); // booked against a RWAGMI coin the Clanker locker never paid
  });

  it('with the source filter the Clanker claim lands on the Clanker coin in full, and a RWAGMI claim on the RWAGMI coin', () => {
    const v4 = claimParts(rows, (t) => source[t] ?? null, 'clanker', claim);
    expect(v4.map((p) => [p.row.token, p.part])).toEqual([[BOOTR, claim]]);
    const rw = claimParts(rows, (t) => source[t] ?? null, 'bootr', 450_000_000_000_000n);
    expect(rw.map((p) => [p.row.token, p.part])).toEqual([[RWAGMI_COIN, 450_000_000_000_000n]]);
    // A v5 escrow claim never touches either; unknown coins are dropped too.
    expect(claimParts(rows, (t) => source[t] ?? null, 'clanker-v5', claim)).toEqual([]);
    expect(claimParts(rows, () => null, 'clanker', claim)).toEqual([]);
  });

  it('still pro-rates within one path (a creator with several coins of the same locker)', () => {
    const two = [
      { id: 'b', token: '0xbb', settled: 300n, claimed: 0n },
      { id: 'a', token: '0xaa', settled: 100n, claimed: 0n },
    ];
    const parts = claimParts(two, () => 'clanker-v5', 'clanker-v5', 200n);
    expect(parts.map((p) => [p.row.id, p.part])).toEqual([
      ['a', 50n],
      ['b', 150n],
    ]);
  });
});
