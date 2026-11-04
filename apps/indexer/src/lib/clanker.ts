/**
 * Pure helpers of the Clanker launch path (docs/design/clanker-launch.md): the launch facts a
 * `BootrClankerLauncher` receipt carries, the pool key Clanker builds, and how a locker collection
 * (`ClankerLpLockerFeeConversion.ClaimedRewards`) maps onto the coin's reward slots.
 */
import { toEventSelector, type Address, type Hex } from 'viem';

import { ClankerAbi } from '../../abis/Clanker';
import { ClankerFeeLockerAbi } from '../../abis/ClankerFeeLocker';
import { ClankerLpLockerFeeConversionAbi } from '../../abis/ClankerLpLockerFeeConversion';
import { DEAD_ADDRESS, type RecipientKind, type RewardSlot } from './fees';
import { positionTicks, TICK_SPACING, type PoolKey } from './pool';

/** Uniswap v4 `LPFeeLibrary.DYNAMIC_FEE_FLAG`: Clanker pools are dynamic-fee pools, the hook sets the LP fee. */
export const DYNAMIC_FEE_FLAG = 0x800000;
/** `Clanker.TOKEN_SUPPLY`: every Clanker v4 token mints exactly this. */
export const CLANKER_TOKEN_SUPPLY = 100_000_000_000n * 10n ** 18n;

/** `ClankerLpLockerFeeConversion.FeeIn`: what a reward slot receives its share in. */
export const FEE_IN = { Both: 0, Paired: 1, Clanker: 2 } as const;

const lc = <T extends string>(a: T) => a.toLowerCase() as T;

/** The pool key Clanker builds for a coin paired with WETH on one of its hooks (`TokenRewardAdded.poolKey`). */
export function clankerPoolKey(token: Address, paired: Address, hook: Address, tickSpacing = TICK_SPACING): PoolKey {
  const coinIsToken0 = BigInt(token) < BigInt(paired);
  return {
    currency0: coinIsToken0 ? token : paired,
    currency1: coinIsToken0 ? paired : token,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing,
    hooks: hook,
  };
}

/** `ClankerLaunched` as decoded from the wrapper (startingTick is `tickIfToken0IsClanker`, not flipped). */
export type ClankerLaunchedArgs = {
  token: Address;
  poolId: Hex;
  hook: Address;
  locker: Address;
  mevModule: Address;
  startingTick: number;
  lpFeeBps: number;
};

/** The locker's `TokenRewardAdded` (same tx as the launch) or `tokenRewards(token)`: slots and the LP position. */
export type ClankerRewardInfo = {
  poolKey: PoolKey;
  rewardBps: readonly number[];
  rewardAdmins: readonly Address[];
  rewardRecipients: readonly Address[];
  /** Only `TokenRewardAdded` carries these (one entry per position); `tokenRewards` does not. */
  tickLower?: readonly number[];
  tickUpper?: readonly number[];
  poolSupply?: bigint;
};

/** Reward slots in locker order, lowercased, from either shape of locker data. */
export function clankerSlots(info: Pick<ClankerRewardInfo, 'rewardBps' | 'rewardAdmins' | 'rewardRecipients'>): RewardSlot[] {
  return info.rewardBps.map((bps, i) => ({
    admin: lc(info.rewardAdmins[i] ?? '0x0000000000000000000000000000000000000000'),
    recipient: lc(info.rewardRecipients[i] ?? '0x0000000000000000000000000000000000000000'),
    bps: Number(bps),
  }));
}

/**
 * The LP position's range for the pool row: the first position of `TokenRewardAdded` when present (the
 * `Standard` layout is one position), else the expected launch range flipped for the coin's side.
 */
export function clankerPositionTicks(info: Pick<ClankerRewardInfo, 'tickLower' | 'tickUpper'> | null, coinIsToken0: boolean, startingTick: number) {
  const lower = info?.tickLower?.[0];
  const upper = info?.tickUpper?.[0];
  if (lower !== undefined && upper !== undefined) return { tickLower: Number(lower), tickUpper: Number(upper) };
  const std = positionTicks(coinIsToken0);
  // `tickIfToken0IsClanker` is the position's lower bound when the coin is token0 (mirrored otherwise).
  return coinIsToken0 ? { tickLower: startingTick, tickUpper: std.tickUpper } : { tickLower: std.tickLower, tickUpper: -startingTick };
}

export type CollectionRow = {
  slot: number;
  recipient: Address;
  recipientKind: RecipientKind;
  asset: Address;
  /** 0 = currency0, 1 = currency1 (the `ClaimedRewards` array the amount came from). */
  side: 0 | 1;
  amount: bigint;
};

/**
 * One row per (reward slot, side) with a non-zero amount of a locker collection
 * (`ClaimedRewards(token, amount0, amount1, rewards0[], rewards1[])`): index `i` of each array is slot `i`
 * of the coin, amounts are after fee-preference conversion (WETH for `Paired` slots, the coin for the
 * `Clanker` burn slot; a `Both` slot gets a row per side). Slots without a known kind are skipped.
 */
export function collectionRows(
  args: { rewards0: readonly bigint[]; rewards1: readonly bigint[] },
  slots: readonly { slot: number; recipient: Address; recipientKind: string }[],
  pool: { currency0: Address; currency1: Address },
): CollectionRow[] {
  const out: CollectionRow[] = [];
  const bySlot = new Map(slots.map((s) => [s.slot, s]));
  const n = Math.max(args.rewards0.length, args.rewards1.length);
  for (let i = 0; i < n; i++) {
    const s = bySlot.get(i);
    if (!s || s.recipientKind === 'protocol') continue;
    const kind = s.recipientKind as RecipientKind;
    for (const [side, asset, amount] of [
      [0, pool.currency0, args.rewards0[i] ?? 0n],
      [1, pool.currency1, args.rewards1[i] ?? 0n],
    ] as const) {
      if (amount === 0n) continue;
      out.push({ slot: i, recipient: lc(s.recipient), recipientKind: kind, asset: lc(asset), side, amount });
    }
  }
  return out;
}

/** A fee-locker claim that takes the coin itself out of circulation: the burn slot (dead address) claiming the coin. */
export function isBurnClaim(claim: { recipientKind: string; recipient: string; asset: string; token: string }): boolean {
  return claim.recipientKind === 'burn' && lc(claim.recipient) === DEAD_ADDRESS && lc(claim.asset) === lc(claim.token);
}

/** topic0 of the Clanker events the indexer consumes, from the vendored ABIs (pinned by clanker.test.ts). */
export const CLANKER_TOPICS = {
  TokenCreated: toEventSelector(ClankerAbi.find((i) => i.type === 'event' && i.name === 'TokenCreated')!),
  TokenRewardAdded: toEventSelector(ClankerLpLockerFeeConversionAbi.find((i) => i.type === 'event' && i.name === 'TokenRewardAdded')!),
  ClaimedRewards: toEventSelector(ClankerLpLockerFeeConversionAbi.find((i) => i.type === 'event' && i.name === 'ClaimedRewards')!),
  ClaimTokens: toEventSelector(ClankerFeeLockerAbi.find((i) => i.type === 'event' && i.name === 'ClaimTokens')!),
  StoreTokens: toEventSelector(ClankerFeeLockerAbi.find((i) => i.type === 'event' && i.name === 'StoreTokens')!),
} as const;
