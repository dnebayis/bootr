import { describe, expect, it } from 'vitest';

import {
  CLANKER_TOKEN_SUPPLY,
  CLANKER_TOPICS,
  clankerPoolKey,
  clankerPositionTicks,
  clankerSlots,
  collectionRows,
  DYNAMIC_FEE_FLAG,
  isBurnClaim,
  type ClankerRewardInfo,
} from './clanker';
import { allocateClaim, bpsByKind, classifyRecipient, classifySlots, CLANKER_PROTOCOL_BPS, DEAD_ADDRESS, splitFee, swapFeeUsd } from './fees';
import { poolIdOf } from './pool';

const WETH = '0x4200000000000000000000000000000000000006';
/** A Clanker token address above WETH, so the coin is currency1 (Clanker's `tickIfToken0IsClanker` is mirrored). */
const COIN = '0xb07c0000000000000000000000000000000000c1';
const HOOK = '0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC';
const LAUNCHER = '0x00000000000000000000000000000000000000ee';
const parties = {
  kernel: '0x00000000000000000000000000000000000000a1',
  creator: '0x00000000000000000000000000000000000000c1',
  burner: DEAD_ADDRESS,
  platformRecipient: '0x00000000000000000000000000000000000000f1',
} as const;

/** `TokenRewardAdded` of a buyback-preset launch, as the wrapper configures the locker (section 2 of the design note). */
const rewardAdded: ClankerRewardInfo = {
  poolKey: { currency0: WETH, currency1: COIN, fee: DYNAMIC_FEE_FLAG, tickSpacing: 200, hooks: HOOK },
  rewardBps: [500, 5000, 1500, 3000],
  rewardAdmins: [LAUNCHER, LAUNCHER, LAUNCHER, LAUNCHER],
  rewardRecipients: [parties.kernel, parties.creator, DEAD_ADDRESS, parties.platformRecipient],
  tickLower: [120_000],
  tickUpper: [230_400],
  poolSupply: CLANKER_TOKEN_SUPPLY,
};

describe('Clanker event signatures', () => {
  it('pins the vendored ABIs to the topics seen on Base mainnet (locker 0xffA3…, fee locker 0xF362…, factory 0xE85A…; 2026-11-04)', () => {
    expect(CLANKER_TOPICS).toEqual({
      TokenCreated: '0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67',
      TokenRewardAdded: '0xc9b03d1b68674b3ca5738b69c14e4dbcfcb7f474303edd540b1d7dfa785d27ff',
      ClaimedRewards: '0x21d15f71483b597e8f0009e83b90b2117f6f98c185d7173857dddcae5eb8546a',
      ClaimTokens: '0xf98eaa9c1f790e5c18b1f227bd5bade62600f9f3e3587c7644b90c50b9bf13c5',
      StoreTokens: '0xadf5da7301d0edbace5767201c524369b56f4040e2eafc873897493fc466e35d',
    });
  });
});

describe('a Clanker launch', () => {
  it('builds the pool key Clanker uses (dynamic-fee flag, WETH ordering) and the pool id from it', () => {
    const key = clankerPoolKey(COIN, WETH, HOOK);
    expect(key).toEqual(rewardAdded.poolKey);
    expect(poolIdOf(key)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolIdOf(key)).not.toBe(poolIdOf({ ...key, fee: 0 }));
    // A coin below WETH is currency0.
    expect(clankerPoolKey('0x0000000000000000000000000000000000000abc', WETH, HOOK).currency0).toBe('0x0000000000000000000000000000000000000abc');
  });

  it('classifies the four locker slots: agent / creator / burn (dead address) / platform, summing to 10000, no protocol slot', () => {
    const slots = clankerSlots(rewardAdded);
    expect(slots.map((s) => s.bps)).toEqual([500, 5000, 1500, 3000]);
    const kinds = classifySlots(slots, parties, 'clanker');
    expect(kinds).toEqual(['agent', 'creator', 'burn', 'platform']);
    const bps = bpsByKind(slots, kinds);
    expect(bps.agent + bps.creator + bps.burn + bps.platform).toBe(10_000);
    expect(bps.protocol).toBe(0);
    // Clanker's share is 20% of the LP fee on top: the token row stores it as `protocolBps`.
    expect(CLANKER_PROTOCOL_BPS).toBe(2000);
    // The standard preset has no burn slot and the token row no burner.
    const standard = clankerSlots({ ...rewardAdded, rewardBps: [500, 6500, 3000], rewardRecipients: [parties.kernel, parties.creator, parties.platformRecipient] });
    expect(classifySlots(standard, { ...parties, burner: null }, 'clanker')).toEqual(['agent', 'creator', 'platform']);
    // On the Clanker path an unknown trailing slot is not RWAGMI's.
    const extra = [...slots, { admin: LAUNCHER, recipient: '0x0000000000000000000000000000000000000999', bps: 1 } as const];
    expect(classifySlots(extra, parties, 'clanker')[4]).toBeNull();
    expect(classifySlots(extra, parties, 'bootr')[4]).toBe('protocol');
  });

  it('takes the LP position range from TokenRewardAdded, else mirrors tickIfToken0IsClanker for a currency1 coin', () => {
    expect(clankerPositionTicks(rewardAdded, false, -230_400)).toEqual({ tickLower: 120_000, tickUpper: 230_400 });
    expect(clankerPositionTicks(null, false, -230_400)).toEqual({ tickLower: 120_000, tickUpper: 230_400 });
    expect(clankerPositionTicks(null, true, -230_400)).toEqual({ tickLower: -230_400, tickUpper: -120_000 });
    expect(clankerPositionTicks({ tickLower: [], tickUpper: [] }, true, -200_000)).toEqual({ tickLower: -200_000, tickUpper: -120_000 });
  });
});

describe('a swap on a Clanker pool', () => {
  it('charges the per-token LP fee plus Clanker’s 20% on top, read from the stored lpFeeBps', () => {
    // 1% coin: the trader pays 1.2% of the value; the platform's own 2% coin: 2.4%.
    expect(swapFeeUsd('clanker', 1000, 10_000, 10_000)).toBeCloseTo(12, 9);
    expect(swapFeeUsd('clanker', 1000, 20_000, 20_000)).toBeCloseTo(24, 9);
    // `Swap.fee` 0 (a log without the dynamic fee) falls back to the stored value, never to a platform-wide 1%.
    expect(swapFeeUsd('clanker', 1000, 0, 20_000)).toBeCloseTo(24, 9);
    // Bootr pools: native fee 0 plus the hook's fee, nothing on top.
    expect(swapFeeUsd('bootr', 1000, 0, 10_000)).toBeCloseTo(10, 9);
    expect(swapFeeUsd('bootr', 1000, 0, 20_000)).toBeCloseTo(20, 9);
  });
});

describe('a collection (ClaimedRewards) and the claims that follow', () => {
  const slots = clankerSlots(rewardAdded).map((s, i) => ({ slot: i, recipient: s.recipient, recipientKind: classifySlots([s], parties, 'clanker')[0] ?? 'protocol' }));
  // Coin is currency1: WETH shares land in rewards0, the burn slot's coin share in rewards1.
  const wethFee = 1_000_000_000_000_000n; // 0.001 WETH collected for the Paired slots
  const rewards0 = [50_000_000_000_000n, 500_000_000_000_000n, 0n, 300_000_000_000_000n];
  const rewards1 = [0n, 0n, 123_000_000_000_000_000_000n, 0n];

  it('maps every slot to its post-conversion asset: WETH for agent / creator / platform, the coin for the burn slot', () => {
    const rows = collectionRows({ rewards0, rewards1 }, slots, rewardAdded.poolKey);
    expect(rows).toEqual([
      { slot: 0, recipient: parties.kernel, recipientKind: 'agent', asset: WETH.toLowerCase(), side: 0, amount: rewards0[0] },
      { slot: 1, recipient: parties.creator, recipientKind: 'creator', asset: WETH.toLowerCase(), side: 0, amount: rewards0[1] },
      { slot: 2, recipient: DEAD_ADDRESS, recipientKind: 'burn', asset: COIN.toLowerCase(), side: 1, amount: rewards1[2] },
      { slot: 3, recipient: parties.platformRecipient, recipientKind: 'platform', asset: WETH.toLowerCase(), side: 0, amount: rewards0[3] },
    ]);
    // The three Paired slots split the WETH like the locker (bps of the whole LP fee, nothing kept by a protocol slot).
    const paired = splitFee(wethFee, [500, 5000, 3000]);
    expect(paired).toEqual([rewards0[0], rewards0[1], rewards0[3]]);
    expect(rows.filter((r) => r.asset === WETH.toLowerCase()).reduce((s, r) => s + r.amount, 0n)).toBe(850_000_000_000_000n);
  });

  it('gives a Both-preference slot one row per side, skips zero amounts, unknown slots and protocol slots', () => {
    const rows = collectionRows({ rewards0: [10n, 0n], rewards1: [20n, 30n] }, [slots[0]!, { slot: 1, recipient: '0x0000000000000000000000000000000000000999', recipientKind: 'protocol' }], rewardAdded.poolKey);
    expect(rows.map((r) => [r.slot, r.side, r.amount])).toEqual([
      [0, 0, 10n],
      [0, 1, 20n],
    ]);
    expect(collectionRows({ rewards0: [0n, 0n, 0n, 0n], rewards1: [0n, 0n, 0n, 0n] }, slots, rewardAdded.poolKey)).toEqual([]);
    expect(collectionRows({ rewards0: [1n, 2n, 3n, 4n, 5n], rewards1: [] }, slots, rewardAdded.poolKey)).toHaveLength(4);
  });

  it('a fee-locker claim pays the owner’s whole balance across its coins (settled - claimed), like the RWAGMI locker', () => {
    // The creator has two Clanker coins: 0.0005 WETH outstanding on the first, 0.0002 on the second, 0.0001 already claimed.
    const outstanding = [500_000_000_000_000n, 200_000_000_000_000n - 100_000_000_000_000n];
    expect(allocateClaim(outstanding, 600_000_000_000_000n)).toEqual([500_000_000_000_000n, 100_000_000_000_000n]);
    // A larger payout (fees from a non-Bootr Clanker coin on the same locker) is capped at what we track.
    expect(allocateClaim(outstanding, 900_000_000_000_000n)).toEqual([500_000_000_000_000n, 100_000_000_000_000n]);
    // A partial claim cannot happen on the fee locker (claim pays everything), but the split stays pro-rata.
    expect(allocateClaim(outstanding, 300_000_000_000_000n)).toEqual([250_000_000_000_000n, 50_000_000_000_000n]);
  });

  it('the burn slot’s claim of the coin to the dead address is a burn; its WETH or another slot’s claim is not', () => {
    expect(isBurnClaim({ recipientKind: 'burn', recipient: DEAD_ADDRESS, asset: COIN, token: COIN.toLowerCase() })).toBe(true);
    expect(isBurnClaim({ recipientKind: 'burn', recipient: DEAD_ADDRESS, asset: WETH, token: COIN })).toBe(false);
    expect(isBurnClaim({ recipientKind: 'creator', recipient: parties.creator, asset: COIN, token: COIN })).toBe(false);
    // A BuybackBurner clone (Bootr path) is a burn recipient too, but its burns come from the clone's events.
    expect(isBurnClaim({ recipientKind: 'burn', recipient: '0x00000000000000000000000000000000000000b1', asset: COIN, token: COIN })).toBe(false);
    // The dead address is the burn kind for any coin, with or without a burner on the token row.
    expect(classifyRecipient(DEAD_ADDRESS, { ...parties, burner: null })).toBe('burn');
    expect(classifyRecipient('0x000000000000000000000000000000000000dEaD', parties)).toBe('burn');
  });
});
