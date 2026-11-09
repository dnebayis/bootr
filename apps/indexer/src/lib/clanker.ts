/**
 * Pure helpers of the Clanker launch paths: v4 (docs/design/clanker-launch.md) — the launch facts a
 * `BootrClankerLauncher` receipt carries, the pool key Clanker builds, and how a locker collection
 * (`ClankerLpLockerFeeConversion.ClaimedRewards`) maps onto the coin's reward slots — and v5
 * (docs/design/clanker-v5-migration.md section 6) — the facts of a `BootrClankerLauncherV5` receipt and which fee
 * slot a `TaxLaunchHook` credit belongs to.
 */
import { decodeEventLog, toEventSelector, type Address, type Hex } from 'viem';

import { ClankerV5LaunchedEvent } from '../../abis/BootrClankerLauncherV5';
import { ClankerAbi } from '../../abis/Clanker';
import { ClankerFeeLockerAbi } from '../../abis/ClankerFeeLocker';
import { ClankerLpLockerFeeConversionAbi } from '../../abis/ClankerLpLockerFeeConversion';
import { ClankerV5FactoryAbi, ClankerV5FeeEscrowAbi, ClankerV5HookAbi, PoolManagerLaunchAbi } from '../../abis/ClankerV5';
import { CLANKER_V5_SCALE, clankerV5ProtocolBps, clankerV5SlotBps, clankerV5SlotWeights, DEAD_ADDRESS, REWARD_BPS_TOTAL, type ClankerV5ProtocolPolicy, type RecipientKind, type RewardSlot } from './fees';
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
 *
 * Clanker stores every position as if the coin were currency0 (`tickIfToken0IsClanker` and the locker
 * config's `tickLower`/`tickUpper`); `ClankerLpLockerMultiple` mints the mirrored range `[-upper, -lower]`
 * when the coin is currency1, so the stored ticks are mirrored here too. $BOOTR (currency1) had been given
 * `[-230400, -120000]` from `tokenRewards`, which put its launch liquidity at 4e31 and its liquidity at $4T.
 */
export function clankerPositionTicks(info: Pick<ClankerRewardInfo, 'tickLower' | 'tickUpper'> | null, coinIsToken0: boolean, startingTick: number) {
  const lower = info?.tickLower?.[0];
  const upper = info?.tickUpper?.[0];
  if (lower !== undefined && upper !== undefined) {
    return coinIsToken0 ? { tickLower: Number(lower), tickUpper: Number(upper) } : { tickLower: -Number(upper), tickUpper: -Number(lower) };
  }
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

// ------------------------------------------------------------------ Clanker v5

/** `launchSupply()` of the v5 factory (1,000,000,000 tokens, 18 decimals; read 2026-11-10). */
export const CLANKER_V5_SUPPLY = 10n ** 27n;
/** Uniswap v4's usable tick bounds at Clanker v5's tick spacing of 200 (`TickMath.MIN_TICK` rounded inwards). */
const MAX_TICK = 887_272;

/** `ClankerV5Launched` as decoded from the v5 wrapper. */
export type ClankerV5LaunchedArgs = {
  token: Address;
  poolId: Hex;
  hook: Address;
  feeEscrow: Address;
  quoteToken: Address;
  tickSpacing: number;
  taxBps: number;
  antiSnipe: boolean;
};

/** One fee slot of a v5 pool as the hook registered it (`FeeSlotCreated` / `poolFeeSlots`). */
export type ClankerV5HookSlot = { slot: number; recipient: Address; admin: Address; weightBps: number };

/** What a v5 launch receipt says about the coin, beyond `AgentLaunched`. */
export type ClankerV5LaunchFacts = {
  launched: ClankerV5LaunchedArgs | null;
  /** `FeeSlotCreated` of the coin's pool, in slot order. */
  slots: ClankerV5HookSlot[];
  /** `LaunchTaxConfigured`: the policy admitted for this pool and the coin's tax configuration (1e8 scale). */
  policy: ClankerV5ProtocolPolicy | null;
  taxRate: number | null;
  /** `burnAllocationShare` in bps of the slot pool (1e8 scale / 1e4). */
  burnBps: number | null;
  /** `Launched.launchSupply`. */
  launchSupply: bigint | null;
  /** `Initialize.tick`: the pool's opening tick, in the pool's own frame. */
  startingTick: number | null;
  /** The seeded position: the first `ModifyLiquidity` range of the pool and the liquidity added in the receipt. */
  position: { tickLower: number; tickUpper: number; liquidity: bigint } | null;
};

type AnyLog = { address: string; topics: readonly Hex[]; data: Hex; logIndex?: number | null };

function decode<const A extends readonly unknown[]>(abi: A, l: AnyLog) {
  try {
    return decodeEventLog({ abi: abi as never, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as {
      eventName: string;
      args: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

/**
 * Read a v5 launch receipt: the wrapper's `ClankerV5Launched` (from `launcher`), the hook's `FeeSlotCreated`, the
 * factory's `LaunchTaxConfigured` and `Launched`, the PoolManager's `Initialize` and `ModifyLiquidity`, all for
 * `token` and its pool. Logs of other emitters and other pools are ignored.
 */
export function clankerV5LaunchFacts(
  logs: readonly AnyLog[],
  a: { token: Address; launcher: Address; poolManager: Address; factory: Address | null },
): ClankerV5LaunchFacts {
  const token = lc(a.token);
  const out: ClankerV5LaunchFacts = { launched: null, slots: [], policy: null, taxRate: null, burnBps: null, launchSupply: null, startingTick: null, position: null };
  for (const l of logs) {
    if (lc(l.address) !== lc(a.launcher)) continue;
    const ev = decode([ClankerV5LaunchedEvent], l);
    if (ev?.eventName === 'ClankerV5Launched' && lc(ev.args.token as Address) === token) {
      const x = ev.args;
      out.launched = {
        token: lc(x.token as Address),
        poolId: lc(x.poolId as Hex),
        hook: lc(x.hook as Address),
        feeEscrow: lc(x.feeEscrow as Address),
        quoteToken: lc(x.quoteToken as Address),
        tickSpacing: Number(x.tickSpacing),
        taxBps: Number(x.taxBps),
        antiSnipe: Boolean(x.antiSnipe),
      };
    }
  }
  const launched = out.launched;
  if (!launched) return out;
  const poolId = launched.poolId;
  let liquidity = 0n;
  for (const l of logs) {
    const addr = lc(l.address);
    if (addr === launched.hook) {
      const ev = decode(ClankerV5HookAbi, l);
      if (ev?.eventName === 'FeeSlotCreated' && lc(ev.args.poolId as Hex) === poolId) {
        out.slots.push({
          slot: Number(ev.args.slotIndex),
          recipient: lc(ev.args.recipient as Address),
          admin: lc(ev.args.admin as Address),
          weightBps: Number(ev.args.weightBps),
        });
      }
    } else if (addr === lc(a.poolManager) && l.topics[1] && lc(l.topics[1]) === poolId) {
      const ev = decode(PoolManagerLaunchAbi, l);
      if (ev?.eventName === 'Initialize') out.startingTick = Number(ev.args.tick);
      else if (ev?.eventName === 'ModifyLiquidity') {
        const delta = ev.args.liquidityDelta as bigint;
        if (delta > 0n) {
          if (!out.position) out.position = { tickLower: Number(ev.args.tickLower), tickUpper: Number(ev.args.tickUpper), liquidity: 0n };
          liquidity += delta;
        }
      }
    } else if (!a.factory || addr === lc(a.factory)) {
      const ev = decode(ClankerV5FactoryAbi, l);
      if (ev?.eventName === 'LaunchTaxConfigured' && lc(ev.args.token as Address) === token) {
        const pol = (ev.args.admittedPolicy as { protocolFeeConfiguration: Record<string, unknown> }).protocolFeeConfiguration;
        out.policy = {
          protocolTaxShare: Number(pol.protocolTaxShare),
          minimumProtocolFeeRate: Number(pol.minimumProtocolFeeRate),
          maximumProtocolFeeRate: Number(pol.maximumProtocolFeeRate),
        };
        const cfg = ev.args.taxConfiguration as Record<string, unknown>;
        out.taxRate = Number(cfg.buyTaxRate);
        out.burnBps = Math.round((Number(cfg.burnAllocationShare) * REWARD_BPS_TOTAL) / CLANKER_V5_SCALE);
      } else if (ev?.eventName === 'Launched' && lc(ev.args.token as Address) === token) {
        out.launchSupply = ev.args.launchSupply as bigint;
      }
    }
  }
  if (out.position) out.position.liquidity = liquidity;
  out.slots.sort((x, y) => x.slot - y.slot);
  return out;
}

/** The v4 pool key Clanker v5 builds: currencies sorted (native ETH, `address(0)`, is always currency0), fee 0. */
export function clankerV5PoolKey(token: Address, quote: Address, hook: Address, tickSpacing: number): PoolKey {
  const coinIsToken0 = BigInt(token) < BigInt(quote);
  return {
    currency0: lc(coinIsToken0 ? token : quote),
    currency1: lc(coinIsToken0 ? quote : token),
    fee: 0,
    tickSpacing,
    hooks: lc(hook),
  };
}

/**
 * The seeded range when the receipt carries no `ModifyLiquidity`: Clanker's one band `[0, TAIL]` holds the whole
 * supply single-sided from the opening price upwards (in the coin's price), i.e. from the opening tick to the far
 * end of the usable range on the coin's side.
 */
export function clankerV5PositionTicks(startingTick: number, coinIsToken0: boolean, tickSpacing: number) {
  const edge = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return coinIsToken0 ? { tickLower: startingTick, tickUpper: edge } : { tickLower: -edge, tickUpper: startingTick };
}

/**
 * A v5 coin's reward slots as stored on the token and `feeSlot` rows: the hook's paid slots in their order (kernel,
 * creator, platform; bps of the tax after Clanker's share) and, when the coin burns, a synthetic burn slot
 * (`0x…dEaD`, the hook's `BURN_SINK`) after them. `protocolBps` is Clanker's share of the tax. Without hook slots the
 * weights come from the preset (`clankerV5SlotWeights`) and the recipients from `AgentLaunched`.
 */
export function clankerV5Slots(
  facts: Pick<ClankerV5LaunchFacts, 'slots' | 'policy' | 'taxRate' | 'burnBps'>,
  a: {
    launcher: Address;
    kernel: Address;
    creator: Address;
    taxBps: number;
    defaults: { agentBps: number; burnBps: number; platformBps: number; platformRecipient: Address };
  },
): { rewards: RewardSlot[]; burnSlot: number | null; protocolBps: number } {
  const protocolBps = clankerV5ProtocolBps(a.taxBps, facts.policy ?? undefined);
  const burnShare = facts.burnBps ?? a.defaults.burnBps;
  const hook: ClankerV5HookSlot[] = facts.slots.length
    ? facts.slots
    : clankerV5SlotWeights(a.defaults).map((weightBps, slot) => ({
        slot,
        weightBps,
        admin: lc(a.launcher),
        recipient: lc([a.kernel, a.creator, a.defaults.platformRecipient][slot]!),
      }));
  const { paid, burn } = clankerV5SlotBps(
    hook.map((s) => s.weightBps),
    burnShare,
    protocolBps,
  );
  const rewards: RewardSlot[] = hook.map((s, i) => ({ admin: lc(s.admin), recipient: lc(s.recipient), bps: paid[i]! }));
  if (burnShare === 0) return { rewards, burnSlot: null, protocolBps };
  rewards.push({ admin: lc(a.launcher), recipient: DEAD_ADDRESS, bps: burn });
  return { rewards, burnSlot: rewards.length - 1, protocolBps };
}

/**
 * Which fee slot a `CreatorTaxCredited(poolId, recipient, …)` pays. The event names the recipient, not the slot; the
 * hook credits the slots in order once per swap, so when one wallet holds several slots of a coin (the platform
 * launching its own coin: creator == platform recipient) the n-th credit to that wallet in a transaction is slot
 * `matches[n % matches.length]`. `prior` = credits to that wallet already booked in this transaction for this coin.
 */
export function pickV5Slot<S extends { slot: number; recipient: string; recipientKind: string }>(slots: readonly S[], recipient: string, prior: number): S | null {
  const matches = slots.filter((s) => s.recipientKind !== 'burn' && s.recipientKind !== 'protocol' && lc(s.recipient) === lc(recipient)).sort((x, y) => x.slot - y.slot);
  if (matches.length === 0) return null;
  return matches[prior % matches.length]!;
}

/** topic0 of the Clanker v5 events the indexer consumes, from the vendored verified ABIs (pinned by clanker.test.ts). */
export const CLANKER_V5_TOPICS = {
  ClankerV5Launched: toEventSelector(ClankerV5LaunchedEvent),
  CreatorTaxCredited: toEventSelector(ClankerV5HookAbi.find((i) => i.type === 'event' && i.name === 'CreatorTaxCredited')!),
  BurnTaxCredited: toEventSelector(ClankerV5HookAbi.find((i) => i.type === 'event' && i.name === 'BurnTaxCredited')!),
  FeeSlotCreated: toEventSelector(ClankerV5HookAbi.find((i) => i.type === 'event' && i.name === 'FeeSlotCreated')!),
  Claimed: toEventSelector(ClankerV5FeeEscrowAbi.find((i) => i.type === 'event' && i.name === 'Claimed')!),
  LaunchTaxConfigured: toEventSelector(ClankerV5FactoryAbi.find((i) => i.type === 'event' && i.name === 'LaunchTaxConfigured')!),
  Launched: toEventSelector(ClankerV5FactoryAbi.find((i) => i.type === 'event' && i.name === 'Launched')!),
} as const;
