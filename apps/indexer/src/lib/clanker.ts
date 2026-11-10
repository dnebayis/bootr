/**
 * Pure helpers of the Clanker launch paths: v4 (docs/design/clanker-launch.md) — the launch facts a
 * `BootrClankerLauncher` receipt carries, the pool key Clanker builds, and how a locker collection
 * (`ClankerLpLockerFeeConversion.ClaimedRewards`) maps onto the coin's reward slots — and v5
 * (docs/design/clanker-v5-migration.md section 6) — the facts of a `BootrClankerLauncherV5` receipt and which fee
 * slot a `TaxLaunchHook` credit belongs to.
 */
import { decodeEventLog, toEventSelector, type Address, type Hex } from 'viem';

import { ClankerV5LaunchedEvent, ClankerV5LaunchedFixedEvent, ClankerV5MetadataEvents } from '../../abis/BootrClankerLauncherV5';
import { ClankerAbi } from '../../abis/Clanker';
import { ClankerFeeLockerAbi } from '../../abis/ClankerFeeLocker';
import { ClankerLpLockerFeeConversionAbi } from '../../abis/ClankerLpLockerFeeConversion';
import { ClankerV5FactoryAbi, ClankerV5FeeEscrowAbi, ClankerV5HookAbi, ClankerV5TokenAbi, PoolManagerLaunchAbi } from '../../abis/ClankerV5';
import {
  CLANKER_V5_SCALE,
  CLANKER_V5_TAX_RATE_MULTIPLIER,
  classifyV5Slots,
  clankerV5ProtocolBps,
  clankerV5SlotBps,
  clankerV5SlotWeights,
  DEAD_ADDRESS,
  REWARD_BPS_TOTAL,
  settingsSlotWeights,
  type ClankerV5ProtocolPolicy,
  type ClankerV5SlotLayout,
  type RecipientKind,
  type RewardSlot,
  type SlotKind,
} from './fees';
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

/**
 * `ClankerV5Launched` as decoded from the v5 wrapper (`decodeClankerV5Launched`). `layout` says which launcher emitted
 * it: `settings` (the token-settings launcher: its own buy and sell tax, burn, dividends, editable metadata) or `fixed`
 * (the fixed launcher, one tax for both sides, never deployed). `taxBps` is the buy tax (the coin's `lpFeeBps`).
 */
export type ClankerV5LaunchedArgs = {
  token: Address;
  poolId: Hex;
  hook: Address;
  feeEscrow: Address;
  quoteToken: Address;
  tickSpacing: number;
  taxBps: number;
  buyTaxBps: number;
  sellTaxBps: number;
  /** bps of the post-Clanker pool; null on the fixed launcher (the preset's `defaults.burnBps` then). */
  burnBps: number | null;
  dividendBps: number | null;
  antiSnipe: boolean;
  /** null on the fixed launcher (its coins were not editable). */
  metadataEditable: boolean | null;
  layout: ClankerV5SlotLayout;
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
  /** `buyTaxRate` (1e8 scale). */
  taxRate: number | null;
  /** `sellTaxRate` (1e8 scale). */
  sellTaxRate: number | null;
  /** `burnAllocationShare` in bps of the slot pool (1e8 scale / 1e4). */
  burnBps: number | null;
  /** `dividendAllocationShare` in bps of the slot pool. */
  dividendBps: number | null;
  /** `minimumDividendHolding` (raw token units). */
  minDividendHolding: bigint | null;
  /** `LaunchTaxConfigured.antiSnipeEnabled`. */
  antiSnipe: boolean | null;
  /** `Launched.launchSupply`. */
  launchSupply: bigint | null;
  /** `Launched.quoteToken` (native ETH = the zero address). */
  quoteToken: Address | null;
  /** `Initialize.tick`: the pool's opening tick, in the pool's own frame. */
  startingTick: number | null;
  /** The seeded position: the first `ModifyLiquidity` range of the pool and the liquidity added in the receipt. */
  position: { tickLower: number; tickUpper: number; liquidity: bigint } | null;
  /** The coin's genesis `ExtraMetadataUpdated(factory, key, value)`: `image`, `metadata`, `context`. */
  extraMetadata: Record<string, string>;
  /** The coin's `DividendInitialized(dividendContract)`: its holder-dividend tracker, null without dividends. */
  dividendContract: Address | null;
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
 * The one decoder of the launcher's `ClankerV5Launched` (both shapes, abis/BootrClankerLauncherV5.ts): the
 * token-settings shape first, the fixed launcher's as the fallback. Null for any other log.
 */
export function decodeClankerV5Launched(l: AnyLog): ClankerV5LaunchedArgs | null {
  const v2 = decode([ClankerV5LaunchedEvent], l);
  if (v2?.eventName === 'ClankerV5Launched') {
    const x = v2.args;
    return {
      token: lc(x.token as Address),
      poolId: lc(x.poolId as Hex),
      hook: lc(x.hook as Address),
      feeEscrow: lc(x.feeEscrow as Address),
      quoteToken: lc(x.quoteToken as Address),
      tickSpacing: Number(x.tickSpacing),
      taxBps: Number(x.buyTaxBps),
      buyTaxBps: Number(x.buyTaxBps),
      sellTaxBps: Number(x.sellTaxBps),
      burnBps: Number(x.burnBps),
      dividendBps: Number(x.dividendBps),
      antiSnipe: Boolean(x.antiSnipe),
      metadataEditable: Boolean(x.metadataEditable),
      layout: 'settings',
    };
  }
  const v1 = decode([ClankerV5LaunchedFixedEvent], l);
  if (v1?.eventName === 'ClankerV5Launched') {
    const x = v1.args;
    return {
      token: lc(x.token as Address),
      poolId: lc(x.poolId as Hex),
      hook: lc(x.hook as Address),
      feeEscrow: lc(x.feeEscrow as Address),
      quoteToken: lc(x.quoteToken as Address),
      tickSpacing: Number(x.tickSpacing),
      taxBps: Number(x.taxBps),
      buyTaxBps: Number(x.taxBps),
      sellTaxBps: Number(x.taxBps),
      burnBps: null,
      dividendBps: null,
      antiSnipe: Boolean(x.antiSnipe),
      metadataEditable: null,
      layout: 'fixed',
    };
  }
  return null;
}

/** 1e8-scale share to bps of 10_000 (Clanker's `*AllocationShare` / 1e4). */
const shareBps = (share: unknown) => Math.round((Number(share) * REWARD_BPS_TOTAL) / CLANKER_V5_SCALE);

/**
 * Read a v5 launch receipt: the wrapper's `ClankerV5Launched` (from `launcher`), the hook's `FeeSlotCreated`, the
 * factory's `LaunchTaxConfigured` and `Launched`, the PoolManager's `Initialize` and `ModifyLiquidity`, the coin's
 * genesis `ExtraMetadataUpdated` and `DividendInitialized`, all for `token` and its pool. Logs of other emitters and
 * other pools are ignored.
 */
export function clankerV5LaunchFacts(
  logs: readonly AnyLog[],
  a: { token: Address; launcher: Address; poolManager: Address; factory: Address | null },
): ClankerV5LaunchFacts {
  const token = lc(a.token);
  const out: ClankerV5LaunchFacts = {
    launched: null,
    slots: [],
    policy: null,
    taxRate: null,
    sellTaxRate: null,
    burnBps: null,
    dividendBps: null,
    minDividendHolding: null,
    antiSnipe: null,
    launchSupply: null,
    quoteToken: null,
    startingTick: null,
    position: null,
    extraMetadata: {},
    dividendContract: null,
  };
  for (const l of logs) {
    if (lc(l.address) !== lc(a.launcher)) continue;
    const ev = decodeClankerV5Launched(l);
    if (ev && ev.token === token) out.launched = ev;
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
    } else if (addr === token) {
      const ev = decode(ClankerV5TokenAbi, l);
      if (ev?.eventName === 'ExtraMetadataUpdated') out.extraMetadata[ev.args.metadataKey as string] = ev.args.metadataValue as string;
      else if (ev?.eventName === 'DividendInitialized') out.dividendContract = lc(ev.args.dividendContract as Address);
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
        out.sellTaxRate = Number(cfg.sellTaxRate);
        out.burnBps = shareBps(cfg.burnAllocationShare);
        out.dividendBps = shareBps(cfg.dividendAllocationShare);
        out.minDividendHolding = cfg.minimumDividendHolding as bigint;
        out.antiSnipe = Boolean(ev.args.antiSnipeEnabled);
      } else if (ev?.eventName === 'Launched' && lc(ev.args.token as Address) === token) {
        out.launchSupply = ev.args.launchSupply as bigint;
        out.quoteToken = lc(ev.args.quoteToken as Address);
      }
    }
  }
  if (out.position) out.position.liquidity = liquidity;
  out.slots.sort((x, y) => x.slot - y.slot);
  return out;
}

/** A v5 coin's token settings as stored on the token row (docs/design/clanker-v5-token-settings.md). */
export type ClankerV5Settings = {
  /** Hundredths of a bip (15_000 = 1.5%), like `lpFeeBps`. */
  buyTaxBps: number;
  sellTaxBps: number;
  /** Shares of the post-Clanker pool in bps (Clanker's allocation shares / 1e4). */
  burnBps: number;
  dividendBps: number;
  /** Raw token units; null when the coin pays no dividends. */
  minDividendHolding: bigint | null;
  antiSnipe: boolean;
  metadataEditable: boolean;
  /** The pool's paired asset (native ETH = the zero address). */
  quoteToken: Address;
  layout: ClankerV5SlotLayout;
};

/**
 * The one place a v5 coin's settings are decided, from the launch facts: the launcher's `ClankerV5Launched` first,
 * then Clanker's own `LaunchTaxConfigured` / `Launched` (verified events of the same receipt), then the launch
 * defaults (`AgentLaunched.defaults`: `lpFeeBps` = buy tax, `burnBps`).
 */
export function clankerV5Settings(
  facts: Pick<ClankerV5LaunchFacts, 'taxRate' | 'sellTaxRate' | 'burnBps' | 'dividendBps' | 'minDividendHolding' | 'antiSnipe' | 'quoteToken'> & {
    launched: ClankerV5LaunchedArgs;
  },
  defaults: { lpFeeBps: number; burnBps: number },
): ClankerV5Settings {
  const l = facts.launched;
  const pips = (rate: number | null) => (rate !== null && rate > 0 ? Math.round(rate / CLANKER_V5_TAX_RATE_MULTIPLIER) : null);
  const buyTaxBps = l.buyTaxBps || pips(facts.taxRate) || defaults.lpFeeBps;
  const sellTaxBps = l.sellTaxBps || pips(facts.sellTaxRate) || buyTaxBps;
  const dividendBps = l.dividendBps ?? facts.dividendBps ?? 0;
  return {
    buyTaxBps,
    sellTaxBps,
    burnBps: l.burnBps ?? facts.burnBps ?? defaults.burnBps,
    dividendBps,
    minDividendHolding: dividendBps > 0 ? (facts.minDividendHolding ?? null) : null,
    antiSnipe: l.antiSnipe,
    metadataEditable: l.metadataEditable ?? false,
    quoteToken: lc(l.quoteToken || facts.quoteToken || '0x0000000000000000000000000000000000000000') as Address,
    layout: l.layout,
  };
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
 * A v5 coin's reward slots as stored on the token and `feeSlot` rows: the hook's paid slots in their order with their
 * kinds (`classifyV5Slots`: by recipient and admin) and their bps of the tax after Clanker's share, and, when the coin
 * burns, a synthetic burn slot (`0x…dEaD`, the hook's `BURN_SINK`) after them. `protocolBps` is Clanker's share of the
 * buy tax; `dividendBps` the holder dividends' part of the tax (no slot: the hook pays the coin's tracker). Without
 * hook slots the weights come from the launch defaults (`clankerV5SlotWeights` / `settingsSlotWeights`) and the
 * recipients from `AgentLaunched`.
 */
export function clankerV5Slots(
  facts: Pick<ClankerV5LaunchFacts, 'slots' | 'policy'>,
  a: {
    launcher: Address;
    kernel: Address;
    creator: Address;
    taxBps: number;
    /** Shares of the post-Clanker pool, as decided by `clankerV5Settings`. */
    burnBps: number;
    dividendBps?: number;
    layout?: ClankerV5SlotLayout;
    defaults: { agentBps: number; burnBps: number; platformBps: number; platformRecipient: Address };
  },
): { rewards: RewardSlot[]; kinds: (SlotKind | null)[]; burnSlot: number | null; protocolBps: number; dividendBps: number } {
  const layout = a.layout ?? 'fixed';
  const dividendShare = a.dividendBps ?? 0;
  const protocolBps = clankerV5ProtocolBps(a.taxBps, facts.policy ?? undefined);
  const launcher = lc(a.launcher);
  const fallback = (): ClankerV5HookSlot[] => {
    if (layout === 'fixed') {
      return clankerV5SlotWeights({ ...a.defaults, burnBps: a.burnBps }).map((weightBps, slot) => ({
        slot,
        weightBps,
        admin: launcher,
        recipient: lc([a.kernel, a.creator, a.defaults.platformRecipient][slot]!),
      }));
    }
    const weights = settingsSlotWeights({ agentBps: a.defaults.agentBps, platformBps: a.defaults.platformBps, burnBps: a.burnBps, dividendBps: dividendShare });
    const who: [Address, Address][] = [
      [a.kernel, launcher],
      [a.defaults.platformRecipient, launcher],
      [a.creator, a.creator],
    ];
    return weights.map((weightBps, slot) => ({ slot, weightBps, recipient: lc(who[slot]![0]), admin: lc(who[slot]![1]) }));
  };
  const hook: ClankerV5HookSlot[] = facts.slots.length ? facts.slots : fallback();
  const kinds = classifyV5Slots(
    hook,
    { launcher, kernel: a.kernel, creator: a.creator, platformRecipient: a.defaults.platformRecipient },
    layout,
  );
  // Settings layout: the rounding gap goes where Clanker puts its wei remainder, the last slot, which is a creator row
  // whenever there is one (never the platform); with only agent and platform, to the agent. Fixed layout: the
  // heaviest slot (the creator's), as before.
  const lastRow = kinds.reduce((last, k, i) => (k === 'creator' || k === 'recipient' ? i : last), -1);
  const gapTo = layout === 'settings' ? (lastRow >= 0 ? lastRow : Math.max(0, kinds.indexOf('agent'))) : undefined;
  const { paid, burn, dividend } = clankerV5SlotBps(
    hook.map((s) => s.weightBps),
    a.burnBps,
    protocolBps,
    dividendShare,
    gapTo,
  );
  const rewards: RewardSlot[] = hook.map((s, i) => ({ admin: lc(s.admin), recipient: lc(s.recipient), bps: paid[i]! }));
  if (a.burnBps === 0) return { rewards, kinds, burnSlot: null, protocolBps, dividendBps: dividend };
  rewards.push({ admin: launcher, recipient: DEAD_ADDRESS, bps: burn });
  kinds.push('burn');
  return { rewards, kinds, burnSlot: rewards.length - 1, protocolBps, dividendBps: dividend };
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

/**
 * One `TaxLaunchHook` credit of a swap, decoded in one place for the live handlers (src/fees.ts) and the launch-tx
 * replay (src/launcher.ts): `slot` (`CreatorTaxCredited`: a fee slot's share, in the quote), `burn` (`BurnTaxCredited`:
 * the burn share, in the coin, for the dead address; taken on buys and sells alike), `dividend`
 * (`DividendTaxCredited`: the holder dividends' share, in the quote, credited to the coin's tracker) and
 * `dividendRedirected` (`DividendTaxRedirected`: the same share sent to Clanker's protocol recipient while no holder
 * qualifies).
 */
export type ClankerV5HookCredit = {
  kind: 'slot' | 'burn' | 'dividend' | 'dividendRedirected';
  poolId: Hex;
  /** The slot's recipient, the burn sink, the dividend tracker or Clanker's protocol recipient. */
  recipient: Address;
  asset: Address;
  amount: bigint;
};

export function decodeV5HookCredit(eventName: string, args: Record<string, unknown>): ClankerV5HookCredit | null {
  if (!['CreatorTaxCredited', 'BurnTaxCredited', 'DividendTaxCredited', 'DividendTaxRedirected'].includes(eventName)) return null;
  const base = { poolId: lc(args.poolId as Hex), amount: args.amount as bigint };
  switch (eventName) {
    case 'CreatorTaxCredited':
      return { ...base, kind: 'slot', recipient: lc(args.recipient as Address), asset: lc(args.currency as Address) };
    case 'BurnTaxCredited':
      return { ...base, kind: 'burn', recipient: lc(args.sink as Address), asset: lc(args.token as Address) };
    case 'DividendTaxCredited':
      return { ...base, kind: 'dividend', recipient: lc(args.dividend as Address), asset: lc(args.currency as Address) };
    case 'DividendTaxRedirected':
      return { ...base, kind: 'dividendRedirected', recipient: lc(args.recipient as Address), asset: lc(args.currency as Address) };
    default:
      return null;
  }
}

/**
 * The token row patch for a dividend credit: the tracker's share adds to `dividendsTotalUsd` (and names the tracker if
 * the launch receipt did not), the redirected share to `dividendsRedirectedUsd`.
 */
export function dividendPatch(
  t: { dividendContract: string | null; dividendsTotalUsd: number; dividendsRedirectedUsd: number },
  c: Pick<ClankerV5HookCredit, 'kind' | 'recipient'>,
  amountUsd: number,
): { dividendsTotalUsd?: number; dividendsRedirectedUsd?: number; dividendContract?: Address } {
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  if (c.kind === 'dividendRedirected') return { dividendsRedirectedUsd: round(t.dividendsRedirectedUsd + amountUsd) };
  return { dividendsTotalUsd: round(t.dividendsTotalUsd + amountUsd), ...(t.dividendContract ? {} : { dividendContract: c.recipient }) };
}

/**
 * A slot admin's change on Clanker's hook (`FeeSlotRecipientUpdated` / `FeeSlotAdminUpdated(poolId, slotIndex, old,
 * new)`): the creator's row and the extra rows may be redirected or handed over by their admins; the agent and
 * platform slots cannot (their admin is the launcher, which never forwards these calls).
 */
export type ClankerV5SlotUpdate = { poolId: Hex; slot: number; field: 'recipient' | 'admin'; from: Address; to: Address };

export function decodeV5SlotUpdate(eventName: string, args: Record<string, unknown>): ClankerV5SlotUpdate | null {
  if (eventName !== 'FeeSlotRecipientUpdated' && eventName !== 'FeeSlotAdminUpdated') return null;
  const base = { poolId: lc(args.poolId as Hex), slot: Number(args.slotIndex) };
  if (eventName === 'FeeSlotRecipientUpdated') {
    return { ...base, field: 'recipient', from: lc(args.oldRecipient as Address), to: lc(args.newRecipient as Address) };
  }
  if (eventName === 'FeeSlotAdminUpdated') return { ...base, field: 'admin', from: lc(args.oldAdmin as Address), to: lc(args.newAdmin as Address) };
  return null;
}

/**
 * The `feeSlot` row patch for a slot update; `stale` when the row did not hold `from` (an update the indexer missed,
 * or a synthetic slot), in which case the hook's new value still wins.
 */
export function slotUpdatePatch(row: { recipient: string; admin: string }, u: ClankerV5SlotUpdate): { patch: { recipient: Address } | { admin: Address }; stale: boolean } {
  if (u.field === 'recipient') return { patch: { recipient: u.to }, stale: lc(row.recipient) !== u.from };
  return { patch: { admin: u.to }, stale: lc(row.admin) !== u.from };
}

/** A creator's metadata edit through the v5 launcher (`ImageUpdated` / `MetadataUpdated` / `MetadataLocked`). */
export type LauncherMetadataEdit = { token: Address; creator: Address; field: 'image' | 'metadata' | 'lock'; value: string | null };

/** The one decoder of the launcher's metadata events (abis/BootrClankerLauncherV5.ts `ClankerV5MetadataEvents`). */
export function decodeLauncherMetadataEdit(eventName: string, args: Record<string, unknown>): LauncherMetadataEdit | null {
  if (eventName !== 'ImageUpdated' && eventName !== 'MetadataUpdated' && eventName !== 'MetadataLocked') return null;
  const base = { token: lc(args.token as Address), creator: lc(args.creator as Address) };
  if (eventName === 'ImageUpdated') return { ...base, field: 'image', value: args.image as string };
  if (eventName === 'MetadataUpdated') return { ...base, field: 'metadata', value: args.metadata as string };
  if (eventName === 'MetadataLocked') return { ...base, field: 'lock', value: null };
  return null;
}

/**
 * The token row patch for a metadata edit: the image or the metadata JSON as the chain now has it (Clanker's
 * `extraMetadata` keys `image` / `metadata`), or the one-way lock. The launcher only emits these for the coin's creator
 * while the coin is editable, so the indexer mirrors them as they come.
 */
export function metadataEditPatch(
  e: LauncherMetadataEdit,
  ts: number,
): { image?: string; metadata?: string; metadataLocked?: boolean; metadataEditable?: boolean; metadataUpdatedAt: number } {
  if (e.field === 'image') return { image: e.value ?? '', metadataUpdatedAt: ts };
  if (e.field === 'metadata') return { metadata: e.value ?? '', metadataUpdatedAt: ts };
  return { metadataLocked: true, metadataEditable: false, metadataUpdatedAt: ts };
}

const v5Topic = (name: string) => toEventSelector(ClankerV5HookAbi.find((i) => i.type === 'event' && i.name === name)! as never);

/** topic0 of the Clanker v5 events the indexer consumes, from the vendored verified ABIs (pinned by clanker.test.ts). */
export const CLANKER_V5_TOPICS = {
  ClankerV5Launched: toEventSelector(ClankerV5LaunchedEvent),
  ClankerV5LaunchedFixed: toEventSelector(ClankerV5LaunchedFixedEvent),
  ImageUpdated: toEventSelector(ClankerV5MetadataEvents[0]),
  MetadataUpdated: toEventSelector(ClankerV5MetadataEvents[1]),
  MetadataLocked: toEventSelector(ClankerV5MetadataEvents[2]),
  DividendTaxCredited: v5Topic('DividendTaxCredited'),
  DividendTaxRedirected: v5Topic('DividendTaxRedirected'),
  FeeSlotRecipientUpdated: v5Topic('FeeSlotRecipientUpdated'),
  FeeSlotAdminUpdated: v5Topic('FeeSlotAdminUpdated'),
  ExtraMetadataUpdated: toEventSelector(ClankerV5TokenAbi[0]),
  DividendInitialized: toEventSelector(ClankerV5TokenAbi[1]),
  CreatorTaxCredited: toEventSelector(ClankerV5HookAbi.find((i) => i.type === 'event' && i.name === 'CreatorTaxCredited')!),
  BurnTaxCredited: toEventSelector(ClankerV5HookAbi.find((i) => i.type === 'event' && i.name === 'BurnTaxCredited')!),
  FeeSlotCreated: toEventSelector(ClankerV5HookAbi.find((i) => i.type === 'event' && i.name === 'FeeSlotCreated')!),
  Claimed: toEventSelector(ClankerV5FeeEscrowAbi.find((i) => i.type === 'event' && i.name === 'Claimed')!),
  LaunchTaxConfigured: toEventSelector(ClankerV5FactoryAbi.find((i) => i.type === 'event' && i.name === 'LaunchTaxConfigured')!),
  Launched: toEventSelector(ClankerV5FactoryAbi.find((i) => i.type === 'event' && i.name === 'Launched')!),
} as const;
