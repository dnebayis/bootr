/**
 * Fee math shared by the token page, the launch preview and the fee panels (no React, no wagmi).
 *
 * Three launch paths, one fee model (`FeeModel`: where the coin was launched and its pool's fee):
 *
 * - **Bootr** (RWAGMI v3): the hook takes a static 1% swap fee in WETH. 90% goes to the coin's reward slots, 10% to
 *   RWAGMI. Bootr's slots total 9000 bps in the locker (`launchInfo(token).rewards`); RWAGMI's 1000-bps slot is
 *   appended after them.
 * - **Clanker v4** (`clanker`): the LP fee is per coin (`lpFeeBps`, 1e6-based: 10000 = 1%, the platform's own coin
 *   2%). The reward slots share the whole LP fee (10000 bps) and Clanker charges 20% of it on top, so a trader pays
 *   `lpFee × 1.2`. The three WETH slots receive WETH; the burn slot receives the coin itself at the dead address.
 * - **Clanker v5** (`clanker-v5`): `lpFeeBps` is the buy and sell tax (15000 = 1.5%) and the trader pays exactly it.
 *   Clanker's share is inside the tax (`protocolBps` of it: 10% of the tax, at least 0.5% and at most 1% of the trade;
 *   3333 bps at 1.5%), the agent, creator, platform and burn share the rest (`10000 − protocolBps`). The paid slots
 *   receive native ETH; the burn is taken in the coin (docs/design/clanker-v5-migration.md sections 1 and 4).
 */
import type { Address } from 'viem';
import type { LaunchSource, RecipientKind, Token } from './types';

export type Split = Record<RecipientKind, number>;

/**
 * Where the coin was launched and its pool's fee (1e6-based, 10000 = 1%). `protocolBps`: Clanker's share of the v5
 * tax in bps of it, when known (else derived from the tax with `clankerV5ProtocolBps`); unused on the other paths.
 */
export type FeeModel = { source: LaunchSource; lpFeeBps: number; protocolBps?: number };

/** The pool fee when the indexer gives none: 1%. */
export const DEFAULT_LP_FEE_BPS = 10_000;

export const BOOTR_FEE: FeeModel = { source: 'bootr', lpFeeBps: DEFAULT_LP_FEE_BPS };

/**
 * Clanker v5's tax policy as read on Base on 2026-11-10 (`taxPolicy().protocolFeeConfiguration`): Clanker keeps 10% of
 * the tax, never under 0.5% nor over 1% of the trade. Clanker can change it for new launches; a coin's own share
 * comes from its indexed slots when there are any (`feeModelOf`).
 */
export const CLANKER_V5_POLICY = { protocolTaxShare: 0.1, minProtocolPct: 0.5, maxProtocolPct: 1 } as const;

/** The v5 tax the launch form shows until the launcher's own preset is read (`TAX_BPS` of the deploy script: 1.5%). */
export const CLANKER_V5_DEFAULT_TAX_BPS = 15_000;

/** Clanker's share of a v5 tax (1e6-based) in bps of the tax, as the indexer stores it: `floor(protocolRate / tax × 10000)`. */
export function clankerV5ProtocolBps(taxBps: number): number {
  const taxPct = taxBps / 10_000;
  if (!(taxPct > 0)) return 0;
  const protocolPct = Math.min(Math.max(taxPct * CLANKER_V5_POLICY.protocolTaxShare, CLANKER_V5_POLICY.minProtocolPct), CLANKER_V5_POLICY.maxProtocolPct, taxPct);
  return Math.floor((protocolPct / taxPct) * 10_000 + 1e-9);
}

type FeeFields = Pick<Token, 'source' | 'lpFeeBps' | 'agentBps' | 'creatorBps' | 'burnBps' | 'platformBps'>;

/**
 * The fee model of a token (or a partial one); a missing `source` means the Bootr path, a missing fee 1% (1.5% on v5).
 * On v5 Clanker's share comes from the coin's slots (the indexer stores them so that they sum to `10000 − protocolBps`).
 */
export function feeModelOf(t: Partial<FeeFields> | null | undefined): FeeModel {
  const source: LaunchSource = t?.source === 'clanker' || t?.source === 'clanker-v5' ? t.source : 'bootr';
  const given = t?.lpFeeBps != null && Number.isFinite(Number(t.lpFeeBps)) && Number(t.lpFeeBps) > 0 ? Number(t.lpFeeBps) : null;
  const lpFeeBps = given ?? (source === 'clanker-v5' ? CLANKER_V5_DEFAULT_TAX_BPS : DEFAULT_LP_FEE_BPS);
  if (source !== 'clanker-v5') return { source, lpFeeBps };
  const slots = [t?.agentBps, t?.creatorBps, t?.burnBps, t?.platformBps].reduce<number>((sum, v) => sum + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
  const protocolBps = slots > 0 && slots < 10_000 ? 10_000 - slots : clankerV5ProtocolBps(lpFeeBps);
  return { source, lpFeeBps, protocolBps };
}

/** Clanker's share of a v5 tax, in bps of the tax. */
function v5ProtocolBps(m: FeeModel): number {
  return m.protocolBps ?? clankerV5ProtocolBps(m.lpFeeBps);
}

/** The pool's fee as a percent of trading volume: 1% on the Bootr path, per coin on Clanker v4, the tax on Clanker v5. */
export function swapFeePct(m: FeeModel = BOOTR_FEE): number {
  return m.lpFeeBps / 10_000;
}

/** The share of the fee that reaches the coin's reward slots: 90% on the Bootr path, all of it on v4, the tax less Clanker's share on v5. */
export function slotsShare(m: FeeModel = BOOTR_FEE): number {
  if (m.source === 'clanker-v5') return (10_000 - v5ProtocolBps(m)) / 10_000;
  return m.source === 'clanker' ? 1 : 0.9;
}

/** What the launcher takes, as a percent of volume: RWAGMI's 10% within the fee, Clanker's 20% on top of it (v4), or Clanker's share inside the tax (v5). */
export function launcherPct(m: FeeModel = BOOTR_FEE): number {
  if (m.source === 'clanker-v5') return (swapFeePct(m) * v5ProtocolBps(m)) / 10_000;
  return m.source === 'clanker' ? swapFeePct(m) * 0.2 : swapFeePct(m) * 0.1;
}

/** What a trader pays per swap, as a percent of volume: the fee (Bootr), the fee plus 20% on top (Clanker v4), the tax (Clanker v5). */
export function traderPaysPct(m: FeeModel = BOOTR_FEE): number {
  return m.source === 'clanker' ? swapFeePct(m) * 1.2 : swapFeePct(m);
}

/** What the coin's reward slots total: 9000 bps (Bootr, RWAGMI's 1000 appended), 10000 (Clanker v4), 10000 − Clanker's share (v5). */
export function slotsBps(m: FeeModel = BOOTR_FEE): number {
  if (m.source === 'clanker-v5') return 10_000 - v5ProtocolBps(m);
  return m.source === 'clanker' ? 10_000 : 9_000;
}

/** The launcher's name, for the legend. */
export function launcherName(m: FeeModel = BOOTR_FEE): string {
  return m.source === 'bootr' ? 'RWAGMI' : 'Clanker';
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
 * A split's share of trading volume. Splits are relative: on-chain slot bps (sum 9000, 10000 or the v5 slot pool)
 * and the launcher's preset bps (sum 10000) both divide what reaches the reward slots (0.90% on the Bootr path, the
 * whole fee on Clanker v4, the tax less Clanker's share on v5).
 */
export function ofVolume(split: Split, k: RecipientKind, m: FeeModel = BOOTR_FEE) {
  const total = split.agent + split.creator + split.burn + split.platform;
  return total > 0 ? (split[k] / total) * swapFeePct(m) * slotsShare(m) : 0;
}

/** The burn slot's recipient on the Clanker paths: the coins Clanker takes for the burn are sent here. */
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
