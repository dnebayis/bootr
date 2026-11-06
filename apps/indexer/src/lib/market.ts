/**
 * Swap and transfer application, shared by the live event handlers and by the launch handler
 * (which replays the launch transaction's dev-buy swap and initial transfers from its receipt,
 * because those logs precede `AgentLaunched` and therefore the token/pool rows).
 */
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { swapFeeUsd } from './fees';
import { bookGrossFee } from './ledger';
import { getEthUsd, getPlatformConfig, bumpDaily, bumpPlatform, bumpSource, DEAD_ADDRESS, graduationFields, lc, marketFields, recordTradeBucket, sourceOf, windowFields, ZERO_ADDRESS, type Ctx, type TokenRow } from './store';
import { holderMilestones, milestoneId, swapMilestones, type MilestoneEvent } from './milestones';
import { interpretSwap, toUnits, usd } from './price';

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
  const view = interpretSwap(s.amount0, s.amount1, t.coinIsToken0);
  const next: TokenRow = { ...t, sqrtPriceX96: s.sqrtPriceX96, poolLiquidity: s.liquidity, tick: s.tick };
  const market = marketFields(next, ethUsd);
  const valueUsd = usd(toUnits(view.amountPaired, 18) * ethUsd);
  // What the trader paid, from `Swap.fee` and the coin's own `lpFeeBps` (lib/fees.ts `swapFeePips`): bootr
  // native fee (0) + hook fee; clanker the LP fee × 1.2 (Clanker's share on top).
  const source = sourceOf(t);
  const feeUsd = usd(swapFeeUsd(source, valueUsd, s.fee, t.lpFeeBps));

  await context.db.insert(schema.trade).values({
    id,
    token: t.id,
    trader: lc(m.from),
    sender: lc(s.sender),
    side: view.side,
    amountToken: view.amountToken,
    amountPaired: view.amountPaired,
    priceUsd: market.priceUsd,
    valueUsd,
    feeUsd,
    timestamp: m.timestamp,
    blockNumber: m.blockNumber,
    logIndex: m.logIndex,
    txHash: m.txHash,
  });

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
  // No hook event names the gross fee on the Clanker path (the RWAGMI hook's PoolFeeTakenV3 does on the Bootr
  // path), so the per-trade figure is the gross fee there; the exact per-slot amounts come at collection.
  if (source === 'clanker') await bookGrossFee(context, updated, feeUsd, m.timestamp);
}

const counts = (holder: string) => holder !== ZERO_ADDRESS && holder !== DEAD_ADDRESS;

/** Update the two balances and the coin's holder count (and the holder milestones it passes). */
export async function applyTransfer(context: Ctx, token: Hex, from: Address, to: Address, value: bigint, ts: number, txHash: Hex | null = null) {
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
  if (holderDelta !== 0) {
    let prevHolders = 0;
    const updated = await context.db.update(schema.token, { id: token }).set((r) => {
      prevHolders = r.holders;
      return { holders: Math.max(0, r.holders + holderDelta) };
    });
    if (holderDelta > 0) {
      await recordMilestones(context, { id: updated.id, kernel: updated.kernel }, holderMilestones(prevHolders, updated.holders), { timestamp: ts, txHash });
    }
  }
}
