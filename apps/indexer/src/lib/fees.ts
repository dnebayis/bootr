import type { Address } from 'viem';

export type RecipientKind = 'agent' | 'creator' | 'burn' | 'platform';
export const RECIPIENT_KINDS: readonly RecipientKind[] = ['agent', 'creator', 'burn', 'platform'];

export type TokenParties = {
  kernel: Address;
  creator: Address;
  burner: Address | null;
  platformRecipient: Address;
};

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Classify an LP-fee recipient of a Bootr coin. Kernel and burner are unique per coin, so they
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
 * `ClankerFeeLocker.claim(feeOwner, asset)` pays out the whole (feeOwner, asset) balance, which can
 * be the sum of fees from several Bootr coins (a creator with several coins, the platform
 * recipient). Split `claimed` across the per-coin outstanding balances: each coin gets its
 * outstanding amount when the claim covers everything (any excess came from non-Bootr sources and
 * is ignored), otherwise pro-rata with the rounding remainder on the last entry.
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
