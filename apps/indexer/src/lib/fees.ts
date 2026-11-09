import type { Address } from 'viem';

export type RecipientKind = 'agent' | 'creator' | 'burn' | 'platform';
export const RECIPIENT_KINDS: readonly RecipientKind[] = ['agent', 'creator', 'burn', 'platform'];
/** A reward slot's owner: one of Bootr's parties, or RWAGMI's protocol slot. */
export type SlotKind = RecipientKind | 'protocol';

/**
 * Which launch path a coin came through (`token.source`): `bootr` (RWAGMI v3 through BootrLauncher), `clanker`
 * (Clanker v4 through BootrClankerLauncher) or `clanker-v5` (Clanker v5 through BootrClankerLauncherV5,
 * docs/design/clanker-v5-migration.md).
 */
export type LaunchSource = 'bootr' | 'clanker' | 'clanker-v5';
export const LAUNCH_SOURCES: readonly LaunchSource[] = ['bootr', 'clanker', 'clanker-v5'];

export function isLaunchSource(v: unknown): v is LaunchSource {
  return typeof v === 'string' && (LAUNCH_SOURCES as readonly string[]).includes(v);
}

/** `token.source` as the typed union (the column is text; anything unknown is the Bootr path). */
export function parseLaunchSource(v: string | null | undefined): LaunchSource {
  return isLaunchSource(v) ? v : 'bootr';
}

/** Reward slots split the LP fee in bps of 10_000. */
export const REWARD_BPS_TOTAL = 10_000;
/**
 * What Bootr's own slots (agent + creator + burn + platform) sum to: on the Bootr path RWAGMI appends a 1000-bps
 * protocol slot inside the fee (9000 left for Bootr); on the Clanker v4 path the slots take the whole LP fee and
 * Clanker's protocol share comes on top of it instead. On Clanker v5 the total depends on the tax: Clanker's share
 * is inside it (`slotsBpsTotal`).
 */
export const SLOTS_BPS_TOTAL: Record<Exclude<LaunchSource, 'clanker-v5'>, number> = { bootr: 9000, clanker: 10_000 };

/** The slots' total for a coin: `10_000 - protocolBps` on v5 (Clanker's share is inside the tax), fixed otherwise. */
export function slotsBpsTotal(source: LaunchSource, protocolBps: number): number {
  return source === 'clanker-v5' ? REWARD_BPS_TOTAL - protocolBps : SLOTS_BPS_TOTAL[source];
}

/** `ClankerHookStaticFeeV2.PROTOCOL_FEE_NUMERATOR` (verified on Base 2026-11-04): 20% of the LP fee, on top. */
export const CLANKER_PROTOCOL_FEE_NUMERATOR = 200_000;
/** Fee denominator of Uniswap v4 fees and the Clanker hook (1e6 = 100%). */
export const FEE_DENOMINATOR = 1_000_000;
/** Clanker's protocol share expressed like `protocolBps`: bps of the LP fee (charged on top of it). */
export const CLANKER_PROTOCOL_BPS = (CLANKER_PROTOCOL_FEE_NUMERATOR * REWARD_BPS_TOTAL) / FEE_DENOMINATOR;
/** The burn slot's recipient on the Clanker paths: the coin is sent here (v4: swapped by the locker; v5: the hook's burn share). */
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

/**
 * Clanker v5's protocol policy (`TaxPolicy.protocolFeeConfiguration`, live policy read 2026-11-10, frozen per pool
 * at launch and carried by the factory's `LaunchTaxConfigured`): Clanker keeps `protocolTaxShare` of the tax, at
 * least `minimumProtocolFeeRate` and at most `maximumProtocolFeeRate` of the trade. Rates and shares on Clanker's
 * 1e8 scale (1e8 = 100%).
 */
export type ClankerV5ProtocolPolicy = { protocolTaxShare: number; minimumProtocolFeeRate: number; maximumProtocolFeeRate: number };
export const CLANKER_V5_SCALE = 100_000_000;
export const CLANKER_V5_DEFAULT_POLICY: ClankerV5ProtocolPolicy = {
  protocolTaxShare: 10_000_000,
  minimumProtocolFeeRate: 500_000,
  maximumProtocolFeeRate: 1_000_000,
};
/** `lpFeeBps` (hundredths of a bip, 1e6 = 100%) to Clanker's 1e8 rate scale (the launcher's `TAX_RATE_MULTIPLIER`). */
export const CLANKER_V5_TAX_RATE_MULTIPLIER = 100;

/** Clanker's cut of a v5 trade on its 1e8 scale, for a tax rate on the same scale (`clamp(tax × share, min, max)`). */
export function clankerV5ProtocolRate(taxRate: number, policy: ClankerV5ProtocolPolicy = CLANKER_V5_DEFAULT_POLICY): number {
  if (taxRate <= 0) return 0;
  const share = Math.floor((taxRate * policy.protocolTaxShare) / CLANKER_V5_SCALE);
  return Math.min(Math.max(share, policy.minimumProtocolFeeRate), policy.maximumProtocolFeeRate);
}

/**
 * Clanker's cut as `protocolBps`: bps of the tax, rounded down (3333 at 1.5%, 4166 at 1.2%, 2500 at 2% under the
 * live policy). `taxPips` is `lpFeeBps` (15_000 = 1.5%).
 */
export function clankerV5ProtocolBps(taxPips: number, policy: ClankerV5ProtocolPolicy = CLANKER_V5_DEFAULT_POLICY): number {
  if (taxPips <= 0) return 0;
  const taxRate = taxPips * CLANKER_V5_TAX_RATE_MULTIPLIER;
  return Math.floor((clankerV5ProtocolRate(taxRate, policy) * REWARD_BPS_TOTAL) / taxRate);
}

/**
 * The three fee-slot weights (agent, creator, platform; sum 10_000) `BootrClankerLauncherV5._slotWeights` sends to
 * Clanker for a preset: the bps renormalised over the pool left after the burn, agent and platform rounded down,
 * the creator taking the remainder (588 / 5883 / 3529 for the 5 / 50 / 15 / 30 preset). Used when the hook's
 * `FeeSlotCreated` logs and `poolFeeSlots` are both out of reach.
 */
export function clankerV5SlotWeights(d: { agentBps: number; burnBps: number; platformBps: number }): [number, number, number] {
  const pool = REWARD_BPS_TOTAL - d.burnBps;
  const agent = Math.floor((d.agentBps * REWARD_BPS_TOTAL) / pool);
  const platform = Math.floor((d.platformBps * REWARD_BPS_TOTAL) / pool);
  return [agent, REWARD_BPS_TOTAL - agent - platform, platform];
}

/**
 * What each v5 fee slot receives in bps of the tax, so that the four kinds plus `protocolBps` sum to 10_000 like the
 * Bootr path: the slot pool is `10_000 - protocolBps`, the burn takes `burnBps` of it (in the coin), the paid slots
 * split the rest by their hook weights (each rounded down, the rounding gap to the heaviest slot, the creator's).
 */
export function clankerV5SlotBps(weights: readonly number[], burnBps: number, protocolBps: number): { paid: number[]; burn: number } {
  const pool = REWARD_BPS_TOTAL - protocolBps;
  const burn = Math.floor((pool * burnBps) / REWARD_BPS_TOTAL);
  const rest = pool - burn;
  const paid = weights.map((w) => Math.floor((rest * w) / REWARD_BPS_TOTAL));
  if (paid.length > 0) {
    const gap = rest - paid.reduce((a, b) => a + b, 0);
    let heaviest = 0;
    weights.forEach((w, i) => {
      if (w > weights[heaviest]!) heaviest = i;
    });
    paid[heaviest] = paid[heaviest]! + gap;
  }
  return { paid, burn };
}

/**
 * The claim cross-booking fix (2026-11-08). A locker pays one wallet's whole balance of one asset, but only over the
 * coins of its own path: the RWAGMI locker over `bootr` coins, Clanker's v4 fee locker over `clanker` coins, the v5
 * escrow over `clanker-v5` coins. `feeBalance` rows are per (recipient, asset, coin) across every path, so the rows
 * of other paths are dropped before the claim is split (`allocateClaim`, by `settled - claimed`, in id order). Without
 * this a Clanker claim was pro-rated over the wallet's unclaimed RWAGMI WETH too (the $BOOTR claim at block 54656132
 * came out 0.000393 WETH short). Returns each kept row with its part, zero parts included.
 */
export function claimParts<R extends { id: string; token: string; settled: bigint; claimed: bigint }>(
  rows: readonly R[],
  sourceOfToken: (token: string) => LaunchSource | null,
  source: LaunchSource,
  amount: bigint,
): { row: R; part: bigint }[] {
  const kept = rows.filter((r) => sourceOfToken(r.token) === source).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parts = allocateClaim(
    kept.map((r) => r.settled - r.claimed),
    amount,
  );
  return kept.map((row, i) => ({ row, part: parts[i]! }));
}

export type TokenParties = {
  kernel: Address;
  creator: Address;
  burner: Address | null;
  platformRecipient: Address;
};

export type RewardSlot = { admin: Address; recipient: Address; bps: number };

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Classify a swap-fee recipient of a Bootr coin. Kernel and burner are unique per coin, so they
 * win over creator/platform if an address ever coincides (e.g. an admin launching for itself). The dead
 * address is always the burn slot (the Clanker path's burner).
 */
export function classifyRecipient(recipient: Address, t: TokenParties): RecipientKind | null {
  if (eq(recipient, t.kernel)) return 'agent';
  if ((t.burner && eq(recipient, t.burner)) || eq(recipient, DEAD_ADDRESS)) return 'burn';
  if (eq(recipient, t.creator)) return 'creator';
  if (eq(recipient, t.platformRecipient)) return 'platform';
  return null;
}

/**
 * Classify the locked reward slots. Both launchers write them in a fixed order [kernel, creator, (burner),
 * platform], so a slot that holds the expected party at its index takes that kind (this keeps creator and
 * platform apart when they are the same address). Other slots are classified by address. On the Bootr path
 * RWAGMI appends its protocol slot last, so an unknown last slot is RWAGMI's; the Clanker locker (v4) and hook (v5)
 * hold only the slots the wrapper passed, so there an unknown slot stays unclassified.
 */
export function classifySlots(rewards: readonly RewardSlot[], t: TokenParties, source: LaunchSource = 'bootr'): (SlotKind | null)[] {
  const expected: [Address, RecipientKind][] = [
    [t.kernel, 'agent'],
    [t.creator, 'creator'],
    ...(t.burner ? ([[t.burner, 'burn']] as [Address, RecipientKind][]) : []),
    [t.platformRecipient, 'platform'],
  ];
  return rewards.map((r, i) => {
    const e = expected[i];
    if (e && eq(r.recipient, e[0])) return e[1];
    if (source === 'bootr' && i >= expected.length && i === rewards.length - 1) return 'protocol';
    return classifyRecipient(r.recipient, t);
  });
}

/** Sum of slot bps per kind (the token row's `agentBps` ... `protocolBps`). */
export function bpsByKind(rewards: readonly RewardSlot[], kinds: readonly (SlotKind | null)[]): Record<SlotKind, number> {
  const out: Record<SlotKind, number> = { agent: 0, creator: 0, burn: 0, platform: 0, protocol: 0 };
  rewards.forEach((r, i) => {
    const k = kinds[i];
    if (k) out[k] += r.bps;
  });
  return out;
}

/** Each slot's share of a fee: `amount * bps / 10_000`, rounded down like the locker's per-slot credit. */
export function splitFee(amount: bigint, bps: readonly number[]): bigint[] {
  return bps.map((b) => (amount * BigInt(b)) / BigInt(REWARD_BPS_TOTAL));
}

/**
 * The swap fee a trader paid on one trade, in pips of its value (1e6 = 100%), from `PoolManager.Swap.fee`
 * and the coin's stored `lpFeeBps` (per token, never a platform-wide 1%):
 * - bootr: the pool's native fee (`Swap.fee`, 0 on RWAGMI pools) plus the hook's fee (`lpFeeBps`), which
 *   RWAGMI takes in WETH and splits over the reward slots (exact amounts come from `PoolFeeTakenV3`);
 * - clanker: `Swap.fee` is the LP fee the hook set (dynamic-fee pool; the stored `lpFeeBps` when the log
 *   carries 0), and the hook charges 20% of it on top for Clanker, so the trader pays `lpFee × 1.2`;
 * - clanker-v5: the pool's fee is 0 and the hook takes the tax (`lpFeeBps`) itself, Clanker's share inside it, so
 *   the trader pays exactly the tax (the anti-snipe surcharge of the first 20 s is not counted).
 */
export function swapFeePips(source: LaunchSource, swapFee: number, lpFeeBps: number): number {
  if (source === 'clanker') {
    const lp = swapFee > 0 ? swapFee : lpFeeBps;
    return lp + (lp * CLANKER_PROTOCOL_FEE_NUMERATOR) / FEE_DENOMINATOR;
  }
  if (source === 'clanker-v5') return lpFeeBps;
  return swapFee + lpFeeBps;
}

/** `valueUsd × swapFeePips / 1e6`, rounded to 6 dp by the caller. */
export function swapFeeUsd(source: LaunchSource, valueUsd: number, swapFee: number, lpFeeBps: number): number {
  return (valueUsd * swapFeePips(source, swapFee, lpFeeBps)) / FEE_DENOMINATOR;
}

/**
 * `RwagmiLpLockerV3.claimQuote` / `settleAndClaim` and `ClankerFeeLocker.claim` pay out a recipient's whole
 * balance in an asset, which can be the sum of fees from several Bootr coins (a creator with several coins, the
 * platform recipient) and from non-Bootr launches on the same locker. Split `claimed` across the per-coin
 * claimable balances: each coin gets its balance when the claim covers everything (any excess came from
 * non-Bootr sources and is ignored), otherwise pro-rata with the rounding remainder on the last entry.
 */
export function allocateClaim(outstanding: readonly bigint[], claimed: bigint): bigint[] {
  const total = outstanding.reduce((a, b) => a + (b > 0n ? b : 0n), 0n);
  if (total === 0n || claimed <= 0n) return outstanding.map(() => 0n);
  if (claimed >= total) return outstanding.map((o) => (o > 0n ? o : 0n));
  const out = outstanding.map((o) => (o > 0n ? (claimed * o) / total : 0n));
  const assigned = out.reduce((a, b) => a + b, 0n);
  let rem = claimed - assigned;
  for (let i = out.length - 1; i >= 0 && rem > 0n; i--) {
    const room = (outstanding[i]! > 0n ? outstanding[i]! : 0n) - out[i]!;
    const add = room < rem ? room : rem;
    out[i] = out[i]! + add;
    rem -= add;
  }
  return out;
}
