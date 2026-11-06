/**
 * One wallet holding several reward slots of a coin (e.g. the platform wallet launching a coin of its own: creator and
 * platform). The lockers keep one balance per (recipient, asset) and a claim pays all of it, and the ledger's
 * `feeBalance` row is per (recipient, asset, coin) and keeps the kind of the first slot booked, so every such claim is
 * stored under one kind. This file tells the shares apart again at read time, from data the indexer already has, so it
 * needs no reindex:
 *
 * - `feeCredit` holds what each slot was credited, exactly (the locker's own per-slot amounts). A claim pays the whole
 *   balance, so what has been claimed is a prefix of the credit stream, and the share of each slot in it follows from
 *   the credits themselves. Slot bps are no use here: on $BOOTR the platform slot's credit against the creator slot's
 *   moved between 0.6 and 0.9 from one collection to the next, against 0.6 by bps.
 * - The check is exact, in wei: the credits before the last claim must equal the sum of the claims. When they do not (a
 *   claim the ledger could only pro-rate), the split is reported as unknown rather than estimated.
 * - Dollars: each credit is valued at the ETH price of the claim that paid it out, the same price the ledger booked
 *   that claim at.
 *
 * Pure, so it is testable without Ponder; the queries live in the routes.
 */
import type { Address } from 'viem';

import { RECIPIENT_KINDS, type RecipientKind } from '../lib/fees';
import { usd } from '../lib/price';

export type SlotRow = { token: string; recipient: string; slot: number; recipientKind: string };

/** A wallet holding slots of more than one kind on a coin; `slotKinds` maps slot index to kind. */
export type WalletSlots = { token: string; recipient: string; slotKinds: Map<number, RecipientKind> };

const isKind = (k: string): k is RecipientKind => (RECIPIENT_KINDS as readonly string[]).includes(k);

/** The (coin, wallet) pairs whose claims mix shares. A wallet with two slots of one kind, and RWAGMI's protocol slot, do not count. */
export function walletsHoldingSeveralKinds(rows: readonly SlotRow[]): WalletSlots[] {
  const byPair = new Map<string, WalletSlots>();
  for (const r of rows) {
    if (!isKind(r.recipientKind)) continue;
    const key = `${r.token}-${r.recipient}`;
    const entry = byPair.get(key) ?? { token: r.token, recipient: r.recipient, slotKinds: new Map<number, RecipientKind>() };
    entry.slotKinds.set(r.slot, r.recipientKind);
    byPair.set(key, entry);
  }
  return [...byPair.values()].filter((e) => new Set(e.slotKinds.values()).size > 1);
}

/** Where an event sits in the chain: one block has one timestamp on Base, and log indexes count across the whole block. */
export function chainOrder(timestamp: number, logIndex: number): bigint {
  return BigInt(timestamp) * 1_000_000n + BigInt(logIndex);
}

/** `feeClaim` and `feeCredit` ids both start `<txHash>-<logIndex>-`. */
export function logIndexOfId(id: string): number {
  return Number(id.split('-')[1]);
}

export type WalletClaim = { asset: string; timestamp: number; logIndex: number; amount: bigint; amountUsd: number };

/** Credits to one slot in one asset, summed per window: window `k` is what was credited after claim `k - 1` and before claim `k` of that asset. */
export type CreditWindow = { asset: string; window: number; slot: number; amount: bigint };

export type KindShare = { amount: bigint; usd: number };
export type WalletClaimSplit = {
  /** False: the credits do not add up to the claims, so no share may be stated. */
  exact: boolean;
  /** Claimed per kind; every kind the wallet holds is present. Meaningless when not `exact`: callers must check. */
  byKind: Partial<Record<RecipientKind, KindShare>>;
  /** The claims as the ledger booked them, all together. */
  bookedUsd: number;
};

/** Claims of one asset, oldest first, and the thresholds that cut credits into windows. */
export function claimThresholds(claims: readonly WalletClaim[]): bigint[] {
  return claims.map((c) => chainOrder(c.timestamp, c.logIndex)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function splitWalletClaims(slotKinds: ReadonlyMap<number, RecipientKind>, claims: readonly WalletClaim[], windows: readonly CreditWindow[]): WalletClaimSplit {
  const byKind: Partial<Record<RecipientKind, KindShare>> = {};
  for (const kind of slotKinds.values()) byKind[kind] = { amount: 0n, usd: 0 };
  const bookedUsd = usd(claims.reduce((s, c) => s + c.amountUsd, 0));
  let exact = true;

  for (const asset of new Set(claims.map((c) => c.asset))) {
    const ordered = claims.filter((c) => c.asset === asset).sort((a, b) => (chainOrder(a.timestamp, a.logIndex) < chainOrder(b.timestamp, b.logIndex) ? -1 : 1));
    const claimed = ordered.reduce((s, c) => s + c.amount, 0n);
    let paidOut = 0n;
    for (const w of windows) {
      // window === ordered.length is what came after the last claim: credited, not claimed yet.
      if (w.asset !== asset || w.window >= ordered.length) continue;
      const claim = ordered[w.window]!;
      const kind = slotKinds.get(w.slot);
      if (!kind || claim.amount === 0n) {
        exact = false;
        continue;
      }
      paidOut += w.amount;
      const share = byKind[kind]!;
      share.amount += w.amount;
      share.usd += (Number(w.amount) / Number(claim.amount)) * claim.amountUsd;
    }
    if (paidOut !== claimed) exact = false;
  }
  for (const share of Object.values(byKind)) share.usd = usd(share.usd);
  return { exact, byKind, bookedUsd };
}

export type CreatorCoinFees = {
  earnedUsd: number;
  /** Null: this wallet's claims on this coin could not be told apart from its other shares. */
  claimedUsd: number | null;
  earnedWeth: bigint;
  claimedWeth: bigint | null;
  /** The other shares this wallet holds on this coin, kept out of the figures above. Empty for a normal creator. */
  otherShares: { kind: RecipientKind; earnedUsd: number; claimedUsd: number | null }[];
};

type Booked = { usd: number; weth: bigint };

/**
 * `GET /creator/:address` figures per coin. A normal creator keeps what the ledger booked under the creator kind; a
 * wallet holding more slots on a coin gets its creator share from `splits`, and its other shares listed apart.
 */
export function composeCreatorFees(input: {
  ids: readonly string[];
  earned: ReadonlyMap<string, Booked>;
  claimed: ReadonlyMap<string, Booked>;
  /** Coin -> split of the creator wallet's claims on it, only for coins where it holds several kinds. */
  splits: ReadonlyMap<string, WalletClaimSplit>;
  /** Coin -> kind -> earned USD of the creator wallet, for the same coins. */
  earnedByKind: ReadonlyMap<string, Partial<Record<RecipientKind, number>>>;
}) {
  const coins = new Map<string, CreatorCoinFees>();
  for (const id of input.ids) {
    const earned = input.earned.get(id) ?? { usd: 0, weth: 0n };
    const split = input.splits.get(id);
    if (!split) {
      const claimed = input.claimed.get(id) ?? { usd: 0, weth: 0n };
      coins.set(id, { earnedUsd: earned.usd, claimedUsd: claimed.usd, earnedWeth: earned.weth, claimedWeth: claimed.weth, otherShares: [] });
      continue;
    }
    const mine = split.byKind.creator;
    const others = RECIPIENT_KINDS.filter((k) => k !== 'creator' && split.byKind[k]);
    coins.set(id, {
      earnedUsd: earned.usd,
      claimedUsd: split.exact && mine ? mine.usd : null,
      earnedWeth: earned.weth,
      claimedWeth: split.exact && mine ? mine.amount : null,
      otherShares: others.map((kind) => ({
        kind,
        earnedUsd: input.earnedByKind.get(id)?.[kind] ?? 0,
        claimedUsd: split.exact ? split.byKind[kind]!.usd : null,
      })),
    });
  }
  const all = [...coins.values()];
  const known = all.filter((c) => c.claimedUsd !== null);
  return {
    coins,
    totals: {
      earnedUsd: usd(all.reduce((s, c) => s + c.earnedUsd, 0)),
      // Null only when no coin has a figure to add; a partial sum is said so per coin by `otherShares`.
      claimedUsd: all.length > 0 && known.length === 0 ? null : usd(known.reduce((s, c) => s + (c.claimedUsd ?? 0), 0)),
      earnedWeth: all.reduce((s, c) => s + c.earnedWeth, 0n),
      claimedWeth: all.length > 0 && known.length === 0 ? null : known.reduce((s, c) => s + (c.claimedWeth ?? 0n), 0n),
    },
  };
}

export type ClaimByRecipient = { kind: string; recipient: string; usd: number };
export type WalletSplit = { recipient: string; split: WalletClaimSplit };

/**
 * `GET /token/:id/fees` claimed figures per kind. Claims of a wallet holding several kinds are left out of what the
 * ledger booked and come from its split; a kind whose share cannot be told apart answers null, and `sharedWallets` says
 * what was claimed together.
 */
export function composeClaimedByKind(rows: readonly ClaimByRecipient[], splits: readonly WalletSplit[]) {
  const claimed = Object.fromEntries(RECIPIENT_KINDS.map((k) => [k, 0])) as Record<RecipientKind, number | null>;
  const shared = new Set(splits.map((s) => s.recipient));
  for (const r of rows) {
    if (shared.has(r.recipient) || !isKind(r.kind)) continue;
    claimed[r.kind] = (claimed[r.kind] ?? 0) + r.usd;
  }
  for (const { split } of splits) {
    for (const [kind, share] of Object.entries(split.byKind) as [RecipientKind, KindShare][]) {
      claimed[kind] = split.exact && claimed[kind] !== null ? claimed[kind]! + share.usd : null;
    }
  }
  for (const k of RECIPIENT_KINDS) if (claimed[k] !== null) claimed[k] = usd(claimed[k]!);
  return {
    claimed,
    sharedWallets: splits.map((s) => ({
      recipient: s.recipient,
      kinds: Object.keys(s.split.byKind),
      claimedUsd: s.split.bookedUsd,
      toldApart: s.split.exact,
    })),
  };
}

export type RecipientEntry<T> = T & { recipient: Address; recipientKind: RecipientKind; alsoKinds?: RecipientKind[] };

/**
 * `GET /treasury/:kernel` lists what each party can claim, read per address. A wallet holding two slots has one
 * balance, so it gets one row (the first kind, the rest in `alsoKinds`) rather than the same money under two labels.
 */
export function distinctRecipients<T extends { recipient: Address; recipientKind: RecipientKind }>(list: readonly T[]): RecipientEntry<T>[] {
  const out: RecipientEntry<T>[] = [];
  for (const r of list) {
    const first = out.find((x) => x.recipient.toLowerCase() === r.recipient.toLowerCase());
    if (first) first.alsoKinds = [...(first.alsoKinds ?? []), r.recipientKind];
    else out.push({ ...r });
  }
  return out;
}
