import type { Address } from 'viem';

export type RecipientKind = 'agent' | 'creator' | 'burn' | 'platform';
export const RECIPIENT_KINDS: readonly RecipientKind[] = ['agent', 'creator', 'burn', 'platform'];
/** A reward slot's owner: one of Bootr's parties, or RWAGMI's protocol slot. */
export type SlotKind = RecipientKind | 'protocol';

/** RWAGMI reward slots split the whole swap fee in bps: Bootr's slots total 9000, RWAGMI appends 1000. */
export const REWARD_BPS_TOTAL = 10_000;

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
 * win over creator/platform if an address ever coincides (e.g. an admin launching for itself).
 */
export function classifyRecipient(recipient: Address, t: TokenParties): RecipientKind | null {
  if (eq(recipient, t.kernel)) return 'agent';
  if (t.burner && eq(recipient, t.burner)) return 'burn';
  if (eq(recipient, t.creator)) return 'creator';
  if (eq(recipient, t.platformRecipient)) return 'platform';
  return null;
}

/**
 * Classify `launchInfo(token).rewards`. BootrLauncher writes the slots in a fixed order
 * [kernel, creator, (burner), platform] and RWAGMI appends its protocol slot last, so a slot that
 * holds the expected party at its index takes that kind (this keeps creator and platform apart when
 * they are the same address). Other slots are classified by address; an unknown last slot is RWAGMI's.
 */
export function classifySlots(rewards: readonly RewardSlot[], t: TokenParties): (SlotKind | null)[] {
  const expected: [Address, RecipientKind][] = [
    [t.kernel, 'agent'],
    [t.creator, 'creator'],
    ...(t.burner ? ([[t.burner, 'burn']] as [Address, RecipientKind][]) : []),
    [t.platformRecipient, 'platform'],
  ];
  return rewards.map((r, i) => {
    const e = expected[i];
    if (e && eq(r.recipient, e[0])) return e[1];
    if (i >= expected.length && i === rewards.length - 1) return 'protocol';
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
 * `RwagmiLpLockerV3.claimQuote` / `settleAndClaim` pay out a recipient's whole settled balance in a
 * currency, which can be the sum of fees from several Bootr coins (a creator with several coins, the
 * platform recipient) and from non-Bootr RWAGMI launches. Split `claimed` across the per-coin claimable
 * balances: each coin gets its balance when the claim covers everything (any excess came from non-Bootr
 * sources and is ignored), otherwise pro-rata with the rounding remainder on the last entry.
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
