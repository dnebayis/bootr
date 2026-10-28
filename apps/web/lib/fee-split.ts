/**
 * RWAGMI v3 fee math shared by the token page, the launch preview and the fee panels (no React, no wagmi).
 *
 * The hook takes a static 1% swap fee in WETH: 90% goes to the coin's reward slots, 10% to RWAGMI. Bootr's slots
 * total 9000 bps in the locker (`launchInfo(token).rewards`); RWAGMI's 1000-bps slot is appended after them.
 */
import type { Address } from 'viem';
import type { RecipientKind, Token } from './types';

export type Split = Record<RecipientKind, number>;

/** RWAGMI's hook takes a static 1% swap fee in WETH: 90% to the coin's reward slots, 10% to RWAGMI. */
export const SWAP_FEE_PCT = 1;
export const SLOTS_SHARE = 0.9;
export const RWAGMI_PCT = SWAP_FEE_PCT * (1 - SLOTS_SHARE);
/** Bootr's reward slots total 9000 bps; RWAGMI's 1000 bps slot is appended after them. */
export const SLOTS_BPS = 9000;

/** Percent of trading volume with at least two decimals and no trailing zero past them: 0.045%, 0.27%, 0.10%. */
export function pctLabel(pct: number) {
  const s = pct.toFixed(3);
  return `${s.endsWith('0') ? s.slice(0, -1) : s}%`;
}

/**
 * A split's share of trading volume. Splits are relative: on-chain slot bps (sum 9000) and the launcher's preset
 * bps (sum 10000) both divide the 0.90% that reaches the reward slots.
 */
export function ofVolume(split: Split, k: RecipientKind) {
  const total = split.agent + split.creator + split.burn + split.platform;
  return total > 0 ? (split[k] / total) * SWAP_FEE_PCT * SLOTS_SHARE : 0;
}

function classify(recipient: string, t: Pick<Token, 'kernel' | 'creator' | 'burner'>): RecipientKind {
  const r = recipient.toLowerCase();
  if (r === t.kernel.toLowerCase()) return 'agent';
  if (t.burner && r === t.burner.toLowerCase()) return 'burn';
  if (r === t.creator.toLowerCase()) return 'creator';
  return 'platform';
}

export type Slot = { readonly recipient: Address; readonly bps: number };

/** Bootr's slots (the leading ones that total 9000 bps) classified by recipient; `null` if they don't add up. */
export function splitFromSlots(slots: readonly Slot[], t: Pick<Token, 'kernel' | 'creator' | 'burner'>): Split | null {
  const s: Split = { agent: 0, creator: 0, burn: 0, platform: 0 };
  let sum = 0;
  for (const slot of slots) {
    if (sum >= SLOTS_BPS) break;
    sum += Number(slot.bps);
    s[classify(slot.recipient, t)] += Number(slot.bps);
  }
  return sum === SLOTS_BPS ? s : null;
}

/** The platform slot (the last of Bootr's 9000 bps, BootrLauncher puts it there) or null if the slots don't add up. */
export function platformSlot(slots: readonly Slot[]): Slot | null {
  let sum = 0;
  for (const slot of slots) {
    sum += Number(slot.bps);
    if (sum === SLOTS_BPS) return slot;
    if (sum > SLOTS_BPS) return null;
  }
  return null;
}
