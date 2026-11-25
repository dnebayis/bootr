/**
 * Swap and transfer application, shared by the live event handlers and by the launch handler
 * (which replays the launch transaction's dev-buy swap and initial transfers from its receipt,
 * because those logs precede `AgentLaunched` and therefore the token/pool rows).
 */
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { bookGrossFee } from './ledger';
import { indexerEnv } from './env';
import { getEthUsd, getPlatformConfig, bumpDaily, bumpPlatform, bumpSource, DEAD_ADDRESS, graduationFields, lc, recordPoolMoveBucket, recordTradeBucket, sourceOf, windowFields, ZERO_ADDRESS, type Ctx, type TokenRow } from './store';
import { holderMilestones, milestoneId, swapMilestones, type MilestoneEvent } from './milestones';
import { usd } from './price';
import { marketCapUsd } from './quote';
import { isFeeConversionSwap, swapFigures, tradeRow, type SwapFigures } from './swaps';

export { isFeeConversionSwap };

export type SwapArgs = {
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
  sender: Address;
};

export type LogMeta = {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
  from: Address;
};

/** Writes the milestones (lib/milestones.ts) that do not exist yet. Returns how many rows were written. */
export async function recordMilestones(
  context: Ctx,
  coin: { id: Hex; kernel: Hex },
  events: readonly MilestoneEvent[],
  at: { timestamp: number; txHash?: Hex | null },
): Promise<number> {
  let written = 0;
  for (const e of events) {
    const id = milestoneId(coin.id, e.kind, e.value);
    if (await context.db.find(schema.milestone, { id })) continue;
    const row = await context.db
      .insert(schema.milestone)
      .values({ id, token: coin.id, kernel: coin.kernel, kind: e.kind, value: e.value, timestamp: at.timestamp, txHash: at.txHash ?? null })
      .onConflictDoNothing();
    if (row) written += 1;
  }
  return written;
}

export async function applySwap(context: Ctx, t: TokenRow, s: SwapArgs, m: LogMeta) {
  const id = `${m.txHash}-${m.logIndex}`;
  if (await context.db.find(schema.trade, { id })) return;

  const ethUsd = await getEthUsd(context, m.blockNumber);
  // Side, amounts, price, value and fee come from lib/swaps.ts, which the parity script runs against production rows.
  const figures = swapFigures(t, s, ethUsd);
  const { market, valueUsd, feeUsd } = figures;
  const source = sourceOf(t);
  if (isFeeConversionSwap(s.sender, indexerEnv().clanker?.locker)) {
    await applyFeeConversionSwap(context, t, s, m, market, feeUsd);
    return;
  }

  await context.db.insert(schema.trade).values(tradeRow(t.id, s, m, figures));

  const buckets = await recordTradeBucket(context, t.id, m.timestamp, valueUsd, feeUsd, market.priceUsd);
  const cfg = await getPlatformConfig(context);
  let prevVolume24hUsd = t.volume24hUsd;
  const updated = await context.db.update(schema.token, { id: t.id }).set((row) => {
    prevVolume24hUsd = row.volume24hUsd;
    return {
      sqrtPriceX96: s.sqrtPriceX96,
      tick: s.tick,
      poolLiquidity: s.liquidity,
      ...market,
      ...windowFields(buckets, m.timestamp, market.priceUsd),
      volumeTotalUsd: usd(row.volumeTotalUsd + valueUsd),
      lastTradeAt: m.timestamp,
      ...graduationFields(row, market.marketCapUsd, cfg.graduationThresholdUsd, m.timestamp),
    };
  });
  await recordMilestones(
    context,
    { id: t.id, kernel: t.kernel },
    swapMilestones({ txHash: m.txHash, launchTx: t.launchTx, prevVolume24hUsd, nextVolume24hUsd: updated.volume24hUsd }),
    { timestamp: m.timestamp, txHash: m.txHash },
  );
  await bumpDaily(context, m.timestamp, { volumeUsd: valueUsd, trades: 1 });
  await bumpPlatform(context, m.timestamp, { volumeTotalUsd: valueUsd });
  await bumpSource(context, source, m.timestamp, { volumeTotalUsd: valueUsd });
  // No hook event names the gross fee on the Clanker paths the way the RWAGMI hook's PoolFeeTakenV3 does on the
  // Bootr path (v5's `Trade` carries the quote side only), so the per-trade figure is the gross fee there; the
  // exact per-slot amounts come at collection (v4) or with the swap's own credits (v5).
  if (source !== 'bootr') await bookGrossFee(context, updated, feeUsd, m.timestamp);
}

/**
 * The locker's fee conversion (`isFeeConversionSwap`): no `trade` row, no trade count, volume or milestone, and
 * `lastTradeAt` stays, but the pool moved, so the coin's pool state, price, market cap, 24 h change and graduation
 * follow it like after a trade. It pays the pool's fee like any swap (`Swap.fee`, and the hook's protocol share on
 * top), and that LP fee reaches the slots at the next collection (`ClaimedRewards`), so its gross fee is booked as
 * on a trade, the coin's fee totals and the hour's fee alike, keeping the gross fee at least the slots' accruals.
 */
async function applyFeeConversionSwap(context: Ctx, t: TokenRow, s: SwapArgs, m: LogMeta, market: SwapFigures['market'], feeUsd: number) {
  const buckets = await recordPoolMoveBucket(context, t.id, m.timestamp, feeUsd, market.priceUsd);
  const cfg = await getPlatformConfig(context);
  const updated = await context.db.update(schema.token, { id: t.id }).set((row) => ({
    sqrtPriceX96: s.sqrtPriceX96,
    tick: s.tick,
    poolLiquidity: s.liquidity,
    ...market,
    ...windowFields(buckets, m.timestamp, market.priceUsd),
    ...graduationFields(row, market.marketCapUsd, cfg.graduationThresholdUsd, m.timestamp),
  }));
  if (sourceOf(t) !== 'bootr') await bookGrossFee(context, updated, feeUsd, m.timestamp);
}

const counts = (holder: string) => holder !== ZERO_ADDRESS && holder !== DEAD_ADDRESS;

/**
 * Update the two balances and the coin's holder count (and the holder milestones it passes), and the coin's
 * `deadBalance` and market cap when coins reach or leave 0x…dEaD. With `movesSupply` (a live Transfer, outside the
 * launch transaction whose mint is in the supply read at launch) a mint from or a burn to the zero address moves
 * `totalSupply` too: Clanker v4 coins have `burn`, and the market cap must follow the supply on chain.
 */
export async function applyTransfer(
  context: Ctx,
  token: Hex,
  from: Address,
  to: Address,
  value: bigint,
  ts: number,
  txHash: Hex | null = null,
  movesSupply = false,
) {
  if (value === 0n || lc(from) === lc(to)) return;
  let holderDelta = 0;
  for (const [holder, delta] of [
    [lc(from), -value],
    [lc(to), value],
  ] as const) {
    if (holder === ZERO_ADDRESS) continue;
    const id = `${token}-${holder}`;
    const prev = (await context.db.find(schema.balance, { id }))?.amount ?? 0n;
    const amount = prev + delta;
    await context.db
      .insert(schema.balance)
      .values({ id, token, holder, amount, updatedAt: ts })
      .onConflictDoUpdate({ amount, updatedAt: ts });
    if (counts(holder)) {
      if (prev <= 0n && amount > 0n) holderDelta += 1;
      if (prev > 0n && amount <= 0n) holderDelta -= 1;
    }
  }
  const deadDelta = (lc(to) === DEAD_ADDRESS ? value : 0n) - (lc(from) === DEAD_ADDRESS ? value : 0n);
  const supplyDelta = movesSupply ? (lc(from) === ZERO_ADDRESS ? value : 0n) - (lc(to) === ZERO_ADDRESS ? value : 0n) : 0n;
  if (holderDelta === 0 && deadDelta === 0n && supplyDelta === 0n) return;
  let prevHolders = 0;
  const updated = await context.db.update(schema.token, { id: token }).set((r) => {
    prevHolders = r.holders;
    const supply = { totalSupply: r.totalSupply + supplyDelta, deadBalance: r.deadBalance + deadDelta };
    return {
      holders: Math.max(0, r.holders + holderDelta),
      ...(deadDelta !== 0n || supplyDelta !== 0n ? { ...supply, marketCapUsd: marketCapUsd(r.priceUsd, supply) } : {}),
    };
  });
  if (holderDelta > 0) {
    await recordMilestones(context, { id: updated.id, kernel: updated.kernel }, holderMilestones(prevHolders, updated.holders), { timestamp: ts, txHash });
  }
}
