/**
 * Fee math shared by the token page, the launch preview and the fee panels (no React, no wagmi).
 *
 * Two launch paths, one fee model (`FeeModel`: where the coin was launched and its pool's swap fee):
 *
 * - **Bootr** (RWAGMI v3): the hook takes a static 1% swap fee in WETH. 90% goes to the coin's reward slots, 10% to
 *   RWAGMI. Bootr's slots total 9000 bps in the locker (`launchInfo(token).rewards`); RWAGMI's 1000-bps slot is
 *   appended after them.
 * - **Clanker** (v4): the LP fee is per coin (`lpFeeBps`, 1e6-based: 10000 = 1%, the platform's own coin 2%). The
 *   reward slots share the whole LP fee (10000 bps) and Clanker charges 20% of it on top, so a trader pays
 *   `lpFee × 1.2`. The three WETH slots receive WETH; the burn slot receives the coin itself at the dead address.
 */
import type { Address } from 'viem';
import type { LaunchSource, RecipientKind, Token } from './types';

export type Split = Record<RecipientKind, number>;

/** Where the coin was launched and its pool's swap fee (1e6-based, 10000 = 1%). */
export type FeeModel = { source: LaunchSource; lpFeeBps: number };

/** The pool fee when the indexer gives none: 1%. */
export const DEFAULT_LP_FEE_BPS = 10_000;

export const BOOTR_FEE: FeeModel = { source: 'bootr', lpFeeBps: DEFAULT_LP_FEE_BPS };

/** The fee model of a token (or a partial one); a missing `source` means the Bootr path, a missing fee 1%. */
export function feeModelOf(t: Partial<Pick<Token, 'source' | 'lpFeeBps'>> | null | undefined): FeeModel {
  const lpFeeBps = t?.lpFeeBps != null && Number.isFinite(Number(t.lpFeeBps)) && Number(t.lpFeeBps) > 0 ? Number(t.lpFeeBps) : DEFAULT_LP_FEE_BPS;
  return { source: t?.source === 'clanker' ? 'clanker' : 'bootr', lpFeeBps };
}

/** The pool's swap fee as a percent of trading volume (1% on the Bootr path; per coin on the Clanker path). */
export function swapFeePct(m: FeeModel = BOOTR_FEE): number {
  return m.lpFeeBps / 10_000;
}

/** The share of the swap fee that reaches the coin's reward slots: 90% on the Bootr path, all of it on Clanker. */
export function slotsShare(m: FeeModel = BOOTR_FEE): number {
  return m.source === 'clanker' ? 1 : 0.9;
}

/** What the launcher takes, as a percent of volume: RWAGMI's 10% within the fee, or Clanker's 20% on top of it. */
export function launcherPct(m: FeeModel = BOOTR_FEE): number {
  return m.source === 'clanker' ? swapFeePct(m) * 0.2 : swapFeePct(m) * 0.1;
}

/** What a trader pays per swap, as a percent of volume: the fee (Bootr) or the fee plus 20% on top (Clanker). */
export function traderPaysPct(m: FeeModel = BOOTR_FEE): number {
  return m.source === 'clanker' ? swapFeePct(m) * 1.2 : swapFeePct(m);
}

/** What the coin's reward slots total on-chain: 9000 bps (Bootr, RWAGMI's 1000 appended) or 10000 (Clanker). */
export function slotsBps(m: FeeModel = BOOTR_FEE): number {
  return m.source === 'clanker' ? 10_000 : 9_000;
}

/** The launcher's name, for the legend. */
export function launcherName(m: FeeModel = BOOTR_FEE): string {
  return m.source === 'clanker' ? 'Clanker' : 'RWAGMI';
}

/** RWAGMI's hook takes a static 1% swap fee in WETH: 90% to the coin's reward slots, 10% to RWAGMI. */
export const SWAP_FEE_PCT = swapFeePct(BOOTR_FEE);
export const SLOTS_SHARE = slotsShare(BOOTR_FEE);
export const RWAGMI_PCT = launcherPct(BOOTR_FEE);
/** Bootr's reward slots total 9000 bps; RWAGMI's 1000 bps slot is appended after them. */
export const SLOTS_BPS = slotsBps(BOOTR_FEE);

/** Percent of trading volume with at least two decimals and no trailing zero past them: 0.045%, 0.27%, 0.10%. */
export function pctLabel(pct: number) {
  const s = pct.toFixed(3);
  return `${s.endsWith('0') ? s.slice(0, -1) : s}%`;
}

/**
 * A split's share of trading volume. Splits are relative: on-chain slot bps (sum 9000 or 10000) and the launcher's
 * preset bps (sum 10000) both divide what reaches the reward slots (0.90% on the Bootr path, the whole fee on Clanker).
 */
export function ofVolume(split: Split, k: RecipientKind, m: FeeModel = BOOTR_FEE) {
  const total = split.agent + split.creator + split.burn + split.platform;
  return total > 0 ? (split[k] / total) * swapFeePct(m) * slotsShare(m) : 0;
}

/** The burn slot's recipient on the Clanker path: the locker converts its share into the coin and sends it here. */
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as Address;

function classify(recipient: string, t: Pick<Token, 'kernel' | 'creator' | 'burner'>): RecipientKind {
  const r = recipient.toLowerCase();
  if (r === t.kernel.toLowerCase()) return 'agent';
  if ((t.burner && r === t.burner.toLowerCase()) || r === DEAD_ADDRESS.toLowerCase()) return 'burn';
  if (r === t.creator.toLowerCase()) return 'creator';
  return 'platform';
}

export type Slot = { readonly recipient: Address; readonly bps: number };

/** The coin's slots (the leading ones that total `slotsBps(m)`) classified by recipient; `null` if they don't add up. */
export function splitFromSlots(slots: readonly Slot[], t: Pick<Token, 'kernel' | 'creator' | 'burner'>, m: FeeModel = BOOTR_FEE): Split | null {
  const s: Split = { agent: 0, creator: 0, burn: 0, platform: 0 };
  const total = slotsBps(m);
  let sum = 0;
  for (const slot of slots) {
    if (sum >= total) break;
    sum += Number(slot.bps);
    s[classify(slot.recipient, t)] += Number(slot.bps);
  }
  return sum === total ? s : null;
}

/** The platform slot (the last of the coin's own slots, the launcher puts it there) or null if the slots don't add up. */
export function platformSlot(slots: readonly Slot[], m: FeeModel = BOOTR_FEE): Slot | null {
  const total = slotsBps(m);
  let sum = 0;
  for (const slot of slots) {
    sum += Number(slot.bps);
    if (sum === total) return slot;
    if (sum > total) return null;
  }
  return null;
}
