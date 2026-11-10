import { encodeAbiParameters, encodeEventTopics, toEventSelector, type Abi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { ClankerV5LaunchedFixedEvent } from '../../abis/BootrClankerLauncherV5';
import { ClankerV5FactoryAbi, ClankerV5HookAbi, PoolManagerLaunchAbi } from '../../abis/ClankerV5';

import {
  CLANKER_TOKEN_SUPPLY,
  CLANKER_TOPICS,
  CLANKER_V5_SUPPLY,
  CLANKER_V5_TOPICS,
  clankerV5LaunchFacts,
  clankerV5PoolKey,
  clankerV5PositionTicks,
  clankerV5Slots,
  pickV5Slot,
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
  // Clanker's frame (as if the coin were currency0); the locker mirrors it for this currency1 coin.
  tickLower: [-230_400],
  tickUpper: [-120_000],
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

  it('takes the LP position range from TokenRewardAdded (mirrored for a currency1 coin), else mirrors tickIfToken0IsClanker', () => {
    expect(clankerPositionTicks(rewardAdded, false, -230_400)).toEqual({ tickLower: 120_000, tickUpper: 230_400 });
    expect(clankerPositionTicks(rewardAdded, true, -230_400)).toEqual({ tickLower: -230_400, tickUpper: -120_000 });
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

// ------------------------------------------------------------------ Clanker v5

describe('a Clanker v5 launch (docs/design/clanker-v5-migration.md section 6)', () => {
  const NATIVE = '0x0000000000000000000000000000000000000000';
  const V5_COIN = '0x5eed00000000000000000000000000000000cccc';
  const V5_HOOK = '0x5e320ea6278107968c119942e57d876c5f922acc';
  const ESCROW = '0x5dd237d1f716c65426ccd2fae82b95109825fa61';
  const FACTORY = '0x572e88d3cd7f23e4241eb6cedd96667271bf09a0';
  const PM = '0x498581ff718922c3f8e6a244956af099b2652b2b';
  const V5_LAUNCHER = '0x00000000000000000000000000000000000000e5';
  const key = clankerV5PoolKey(V5_COIN, NATIVE, V5_HOOK, 200);
  const poolId = poolIdOf(key);
  const log = <A extends Abi>(address: string, abi: A, eventName: string, args: Record<string, unknown>) => {
    const ev = (abi as readonly { type: string; name?: string; inputs?: readonly { name: string; type: string; indexed?: boolean; components?: unknown }[] }[]).find(
      (i) => i.type === 'event' && i.name === eventName,
    )!;
    const topics = encodeEventTopics({ abi: [ev] as Abi, eventName, args: args as never }) as Hex[];
    const plain = ev.inputs!.filter((i) => !i.indexed);
    const data = encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never);
    return { address, topics, data };
  };
  const slotsIn = [
    { recipient: parties.kernel, weightBps: 588 },
    { recipient: parties.creator, weightBps: 5883 },
    { recipient: parties.platformRecipient, weightBps: 3529 },
  ];
  const receipt = [
    // the PoolManager first initialises the pool at Clanker's native start tick (coin = currency1: +201000)
    log(PM, PoolManagerLaunchAbi, 'Initialize', { id: poolId, currency0: NATIVE, currency1: V5_COIN, fee: 0, tickSpacing: 200, hooks: V5_HOOK, sqrtPriceX96: 1n, tick: 201_000 }),
    ...slotsIn.map((s, i) =>
      log(V5_HOOK, ClankerV5HookAbi, 'FeeSlotCreated', { poolId, slotIndex: BigInt(i), recipient: s.recipient, admin: V5_LAUNCHER, weightBps: s.weightBps, isCreator: false }),
    ),
    log(PM, PoolManagerLaunchAbi, 'ModifyLiquidity', { id: poolId, sender: V5_HOOK, tickLower: -887_200, tickUpper: 201_000, liquidityDelta: 123_456n, salt: `0x${'0'.repeat(64)}` }),
    // another pool's slot in the same receipt is ignored
    log(V5_HOOK, ClankerV5HookAbi, 'FeeSlotCreated', { poolId: `0x${'1'.repeat(64)}`, slotIndex: 0n, recipient: parties.kernel, admin: V5_LAUNCHER, weightBps: 10_000, isCreator: false }),
    log(FACTORY, ClankerV5FactoryAbi, 'LaunchTaxConfigured', {
      poolId,
      token: V5_COIN,
      configVersion: 23n,
      admittedPolicy: {
        taxFeeBounds: { minimumBuyTaxRate: 1_000_000, maximumBuyTaxRate: 10_000_000, minimumSellTaxRate: 1_000_000, maximumSellTaxRate: 10_000_000 },
        protocolFeeConfiguration: { protocolTaxShare: 10_000_000, minimumProtocolFeeRate: 500_000, maximumProtocolFeeRate: 1_000_000, protocolFeeRecipient: NATIVE },
        antiSnipeConfiguration: { startTotalFeeRate: 99_000_000, windowSeconds: 20 },
        minimumDividendHoldingRequirement: 10n ** 22n,
      },
      taxConfiguration: {
        buyTaxRate: 1_500_000,
        sellTaxRate: 1_500_000,
        creatorAllocationShare: 85_000_000,
        burnAllocationShare: 15_000_000,
        dividendAllocationShare: 0,
        integratorAllocationShare: 0,
        minimumDividendHolding: 0n,
      },
      integratorFeeRecipient: NATIVE,
      antiSnipeEnabled: true,
    }),
    log(FACTORY, ClankerV5FactoryAbi, 'Launched', { token: V5_COIN, poolId, originalCreator: V5_LAUNCHER, quoteToken: NATIVE, launchSupply: CLANKER_V5_SUPPLY, tickSpacing: 200 }),
    log(V5_LAUNCHER, [ClankerV5LaunchedFixedEvent], 'ClankerV5Launched', { token: V5_COIN, poolId, hook: V5_HOOK, feeEscrow: ESCROW, quoteToken: NATIVE, tickSpacing: 200, taxBps: 15_000, antiSnipe: true }),
  ];

  it('pins the v5 event topics of the vendored verified ABIs (CreatorTaxCredited, FeeSlotCreated and Claimed seen on Base 2026-11-10)', () => {
    expect(CLANKER_V5_TOPICS).toMatchObject({
      ClankerV5LaunchedFixed: toEventSelector('ClankerV5Launched(address,bytes32,address,address,address,int24,uint24,bool)'),
      CreatorTaxCredited: toEventSelector('CreatorTaxCredited(bytes32,address,address,uint256)'),
      BurnTaxCredited: toEventSelector('BurnTaxCredited(bytes32,address,address,uint256)'),
      FeeSlotCreated: toEventSelector('FeeSlotCreated(bytes32,uint256,address,address,uint16,bool)'),
      Claimed: toEventSelector('Claimed(address,address,address,uint256)'),
      Launched: toEventSelector('Launched(address,bytes32,address,address,uint256,int24)'),
    });
  });

  it('builds the native-ETH pool key: ETH is currency0, fee 0, the shared hook', () => {
    expect(key).toEqual({ currency0: NATIVE, currency1: V5_COIN, fee: 0, tickSpacing: 200, hooks: V5_HOOK });
  });

  it('reads the launch facts from the receipt: the wrapper’s event, the slots of this pool, the policy, the supply, the tick and the band', () => {
    const f = clankerV5LaunchFacts(receipt, { token: V5_COIN, launcher: V5_LAUNCHER, poolManager: PM, factory: FACTORY });
    // The fixed launcher's event (never deployed) still decodes: one tax for both sides, no settings.
    expect(f.launched).toEqual({
      token: V5_COIN,
      poolId,
      hook: V5_HOOK,
      feeEscrow: ESCROW,
      quoteToken: NATIVE,
      tickSpacing: 200,
      taxBps: 15_000,
      buyTaxBps: 15_000,
      sellTaxBps: 15_000,
      burnBps: null,
      dividendBps: null,
      antiSnipe: true,
      metadataEditable: null,
      layout: 'fixed',
    });
    expect(f.slots.map((s) => [s.slot, s.recipient, s.weightBps])).toEqual(slotsIn.map((s, i) => [i, s.recipient, s.weightBps]));
    expect(f.policy).toEqual({ protocolTaxShare: 10_000_000, minimumProtocolFeeRate: 500_000, maximumProtocolFeeRate: 1_000_000 });
    expect(f.taxRate).toBe(1_500_000);
    expect(f.burnBps).toBe(1500);
    expect(f.launchSupply).toBe(CLANKER_V5_SUPPLY);
    expect(f.startingTick).toBe(201_000);
    expect(f.position).toEqual({ tickLower: -887_200, tickUpper: 201_000, liquidity: 123_456n });
    // A v4 receipt (no ClankerV5Launched from this launcher) is not a v5 launch.
    expect(clankerV5LaunchFacts(receipt, { token: V5_COIN, launcher: LAUNCHER, poolManager: PM, factory: FACTORY }).launched).toBeNull();
    // Without the band the seeded range runs from the opening tick to the far edge on the coin's side.
    expect(clankerV5PositionTicks(201_000, false, 200)).toEqual({ tickLower: -887_200, tickUpper: 201_000 });
  });

  it('stores the paid slots in bps of the tax plus a synthetic burn slot; with Clanker’s share they sum to 10000', () => {
    const f = clankerV5LaunchFacts(receipt, { token: V5_COIN, launcher: V5_LAUNCHER, poolManager: PM, factory: FACTORY });
    const defaults = { agentBps: 500, burnBps: 1500, platformBps: 3000, platformRecipient: parties.platformRecipient };
    const { rewards, kinds, burnSlot, protocolBps } = clankerV5Slots(f, { launcher: V5_LAUNCHER, kernel: parties.kernel, creator: parties.creator, taxBps: 15_000, burnBps: f.burnBps!, defaults });
    expect(protocolBps).toBe(3333);
    expect(burnSlot).toBe(3);
    expect(rewards.map((r) => r.recipient)).toEqual([parties.kernel, parties.creator, parties.platformRecipient, DEAD_ADDRESS]);
    expect(kinds).toEqual(['agent', 'creator', 'platform', 'burn']);
    expect(kinds.slice(0, 3)).toEqual(classifySlots(rewards.slice(0, 3), { ...parties, burner: null }, 'clanker-v5'));
    const bps = bpsByKind(rewards, kinds);
    expect(bps.agent + bps.creator + bps.burn + bps.platform + protocolBps).toBe(10_000);
    expect(bps.burn).toBe(1000);
    // Same answer from the preset alone (no FeeSlotCreated, no LaunchTaxConfigured).
    const fallback = clankerV5Slots({ slots: [], policy: null }, { launcher: V5_LAUNCHER, kernel: parties.kernel, creator: parties.creator, taxBps: 15_000, burnBps: 1500, defaults });
    expect(fallback.rewards.map((r) => [r.recipient, r.bps])).toEqual(rewards.map((r) => [r.recipient, r.bps]));
    // The standard preset has no burn slot.
    const std = clankerV5Slots({ slots: [], policy: null }, { launcher: V5_LAUNCHER, kernel: parties.kernel, creator: parties.creator, taxBps: 15_000, burnBps: 0, defaults: { ...defaults, agentBps: 500, burnBps: 0 } });
    expect(std.burnSlot).toBeNull();
    expect(std.rewards).toHaveLength(3);
  });

  it('a hook credit names the recipient, not the slot: one wallet with two slots takes them in turn', () => {
    const slots = [
      { slot: 0, recipient: parties.kernel, recipientKind: 'agent' },
      { slot: 1, recipient: parties.platformRecipient, recipientKind: 'creator' },
      { slot: 2, recipient: parties.platformRecipient, recipientKind: 'platform' },
      { slot: 3, recipient: DEAD_ADDRESS, recipientKind: 'burn' },
    ];
    expect(pickV5Slot(slots, parties.kernel.toUpperCase().replace('0X', '0x'), 0)?.slot).toBe(0);
    expect([0, 1, 2, 3].map((n) => pickV5Slot(slots, parties.platformRecipient, n)?.slot)).toEqual([1, 2, 1, 2]);
    // The burn slot is never a CreatorTaxCredited target; strangers hold no slot.
    expect(pickV5Slot(slots, DEAD_ADDRESS, 0)).toBeNull();
    expect(pickV5Slot(slots, '0x0000000000000000000000000000000000000999', 0)).toBeNull();
  });

  it('the dead address claiming the coin from the escrow is the v5 burn; its ETH would not be', () => {
    expect(isBurnClaim({ recipientKind: 'burn', recipient: DEAD_ADDRESS, asset: V5_COIN, token: V5_COIN })).toBe(true);
    expect(isBurnClaim({ recipientKind: 'burn', recipient: DEAD_ADDRESS, asset: NATIVE, token: V5_COIN })).toBe(false);
  });
});
