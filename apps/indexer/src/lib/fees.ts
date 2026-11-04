import type { Address } from 'viem';

export type RecipientKind = 'agent' | 'creator' | 'burn' | 'platform';
export const RECIPIENT_KINDS: readonly RecipientKind[] = ['agent', 'creator', 'burn', 'platform'];
/** A reward slot's owner: one of Bootr's parties, or RWAGMI's protocol slot. */
export type SlotKind = RecipientKind | 'protocol';

/** Which launch path a coin came through (`token.source`). */
export type LaunchSource = 'bootr' | 'clanker';
export const LAUNCH_SOURCES: readonly LaunchSource[] = ['bootr', 'clanker'];

/** Reward slots split the LP fee in bps of 10_000. */
export const REWARD_BPS_TOTAL = 10_000;
/**
 * What Bootr's own slots (agent + creator + burn + platform) sum to: on the Bootr path RWAGMI appends a 1000-bps
 * protocol slot inside the fee (9000 left for Bootr); on the Clanker path the slots take the whole LP fee and
 * Clanker's protocol share comes on top of it instead.
 */
export const SLOTS_BPS_TOTAL: Record<LaunchSource, number> = { bootr: 9000, clanker: 10_000 };
/** `ClankerHookStaticFeeV2.PROTOCOL_FEE_NUMERATOR` (verified on Base 2026-11-04): 20% of the LP fee, on top. */
export const CLANKER_PROTOCOL_FEE_NUMERATOR = 200_000;
/** Fee denominator of Uniswap v4 fees and the Clanker hook (1e6 = 100%). */
export const FEE_DENOMINATOR = 1_000_000;
/** Clanker's protocol share expressed like `protocolBps`: bps of the LP fee (charged on top of it). */
export const CLANKER_PROTOCOL_BPS = (CLANKER_PROTOCOL_FEE_NUMERATOR * REWARD_BPS_TOTAL) / FEE_DENOMINATOR;
/** The burn slot's recipient on the Clanker path: the coin is swapped and sent here by the locker. */
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

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
 * RWAGMI appends its protocol slot last, so an unknown last slot is RWAGMI's; the Clanker locker holds only the
 * slots the wrapper passed, so there an unknown slot stays unclassified.
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
 *   carries 0), and the hook charges 20% of it on top for Clanker, so the trader pays `lpFee × 1.2`.
 */
export function swapFeePips(source: LaunchSource, swapFee: number, lpFeeBps: number): number {
  if (source === 'clanker') {
    const lp = swapFee > 0 ? swapFee : lpFeeBps;
    return lp + (lp * CLANKER_PROTOCOL_FEE_NUMERATOR) / FEE_DENOMINATOR;
  }
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
