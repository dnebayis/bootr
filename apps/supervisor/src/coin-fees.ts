/**
 * One coin's locked fee split, in plain percentages, from the indexer's token fields (`source`, `lpFeeBps`, `agentBps`,
 * `creatorBps`, `burnBps`, `platformBps`, `protocolBps`; apps/indexer/src/lib/fees.ts has the math). A coin's trades pay
 * into that coin's own slots, so these figures say nothing about any other coin or about Bootr as a whole.
 *
 * Two users: the `coinFees` section of every agent's first observation (its own coin, from the market snapshot the tick
 * already read: no extra read) and `read_coin` (any coin). Null when a field is missing: an agent without the number does
 * not state it.
 *
 * - bootr (RWAGMI): a trade pays the swap fee; RWAGMI's `protocolBps` slot is inside it, the coin's slots share the rest.
 * - clanker: the coin's slots share the whole swap fee; Clanker's `protocolBps` comes on top, so a trade pays more.
 * - clanker-v5: every buy and every sell pays a tax (`lpFeeBps`, 15_000 = 1.5%); Clanker's share (`protocolBps`, bps of
 *   the tax: 3333 at 1.5%, i.e. 0.5% of the trade) is inside it and the coin's slots share the rest, the burn taken in
 *   the coin (docs/design/clanker-v5-migration.md sections 1 and 4). Same arithmetic as RWAGMI, but a tax on both
 *   sides rather than a pool fee, which the line says.
 */
import type { AgentConfig } from '@bootr/agent-core';

const BPS = 10_000;
/** `lpFeeBps` is 1e6-based: 10000 is 1%. */
const LP_FEE_PER_PCT = 10_000;

export type FeeRecipient = 'agent' | 'creator' | 'burn' | 'platform';

export interface CoinFeeSplit {
  launchedThrough: 'RWAGMI' | 'Clanker' | 'Clanker v5';
  /** Of each trade's value. */
  traderPaysPct: number;
  /** Of each trade's value: the launcher's part of `traderPaysPct`. */
  launcherTakesPct: number;
  /** Of what reaches the coin's recipients. These are the shares the creator picked at launch. */
  recipientsPct: Record<FeeRecipient, number>;
  /** Of each trade's value. */
  ofEachTradePct: Record<FeeRecipient, number>;
  /** False when the creator did not choose a burn at launch. */
  hasBurn: boolean;
  /** Clanker v5 only: the fee is a tax every buy and every sell pays (this percentage of the trade, = `traderPaysPct`). */
  taxPct?: number;
}

const RECIPIENTS: readonly FeeRecipient[] = ['agent', 'creator', 'burn', 'platform'];

const count = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const pct = (x: number): number => Math.round(x * 1000) / 1000;

/** The split of an indexer token row or market snapshot, or null when it does not carry one. */
export function coinFeeSplit(row: Record<string, unknown> | null | undefined): CoinFeeSplit | null {
  if (!row) return null;
  const lpFee = count(row.lpFeeBps);
  const protocol = count(row.protocolBps);
  const slots = { agent: count(row.agentBps), creator: count(row.creatorBps), burn: count(row.burnBps), platform: count(row.platformBps) };
  if (!lpFee || protocol === null || RECIPIENTS.some((k) => slots[k] === null)) return null;
  const bps = slots as Record<FeeRecipient, number>;
  const total = bps.agent + bps.creator + bps.burn + bps.platform;
  if (total <= 0) return null;
  const clanker = row.source === 'clanker';
  const v5 = row.source === 'clanker-v5';
  // RWAGMI and Clanker v5: the launcher's share is inside the fee (the tax on v5). Clanker v4: on top of it.
  const swapFee = lpFee / LP_FEE_PER_PCT;
  const launcher = (swapFee * protocol) / BPS;
  const each = <T>(value: (k: FeeRecipient) => T) => Object.fromEntries(RECIPIENTS.map((k) => [k, value(k)])) as Record<FeeRecipient, T>;
  return {
    launchedThrough: v5 ? 'Clanker v5' : clanker ? 'Clanker' : 'RWAGMI',
    traderPaysPct: pct(clanker ? swapFee + launcher : swapFee),
    launcherTakesPct: pct(launcher),
    recipientsPct: each((k) => pct((bps[k] / total) * 100)),
    ofEachTradePct: each((k) => pct((swapFee * bps[k]) / BPS)),
    hasBurn: bps.burn > 0,
    ...(v5 ? { taxPct: pct(swapFee) } : {}),
  };
}

/** The `read_coin` line. */
export function feeSplitLine(split: CoinFeeSplit): string {
  const shares = RECIPIENTS.filter((k) => split.recipientsPct[k] > 0).map((k) => `${k} ${split.recipientsPct[k]}%`);
  const tail = ` The rest goes to ${shares.join(', ')}.${split.hasBurn ? '' : ' No burn on this coin.'}`;
  if (split.taxPct !== undefined) {
    return `Fee split (locked at launch, this coin's trades only): launched through Clanker v5, every buy and every sell pays a ${split.taxPct}% tax, of which Clanker takes ${split.launcherTakesPct}% of the trade.${tail}`;
  }
  return `Fee split (locked at launch, this coin's trades only): a trade pays ${split.traderPaysPct}%, of which ${split.launchedThrough} takes ${split.launcherTakesPct}%.${tail}`;
}

export const COIN_FEES_MEANING =
  "How a trade of your own coin pays its fee, locked at launch and true of this coin's trades only: traderPaysPct, launcherTakesPct and ofEachTradePct are percentages of a trade's value, recipientsPct is each recipient's share of what reaches them. When taxPct is present the coin was launched through Clanker v5: the fee is a tax that every buy and every sell pays, and Clanker's share is inside it. Other coins have their own splits and some have no burn; read_coin shows them.";

/** The `coinFees` section of the first observation; empty when the snapshot has no split (an unreachable indexer). */
export function coinFeesSection(config: Pick<AgentConfig, 'token'>, market: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const split = coinFeeSplit(market);
  return split ? { coinFees: { instructionAuthority: false, meaning: COIN_FEES_MEANING, coin: config.token.symbol, ...split } } : {};
}
