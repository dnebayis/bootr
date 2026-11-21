/**
 * Swap and transfer application, shared by the live event handlers and by the launch handler
 * (which replays the launch transaction's dev-buy swap and initial transfers from its receipt,
 * because those logs precede `AgentLaunched` and therefore the token/pool rows).
 */
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { swapFeeUsd, v5SideTaxPips } from './fees';
import { bookGrossFee } from './ledger';
import { indexerEnv } from './env';
import { getEthUsd, getPlatformConfig, bumpDaily, bumpPlatform, bumpSource, DEAD_ADDRESS, graduationFields, lc, marketFields, recordPoolMoveBucket, recordTradeBucket, sourceOf, windowFields, ZERO_ADDRESS, type Ctx, type TokenRow } from './store';
import { holderMilestones, milestoneId, swapMilestones, type MilestoneEvent } from './milestones';
import { interpretSwap, usd } from './price';
import { quoteValueUsd } from './quote';

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

/**
 * Whether a PoolManager swap is Clanker v4's fee conversion rather than a trade. On a Clanker v4 coin the hook has
 * `ClankerLpLockerFeeConversion` collect the pool's LP fees before every swap (anyone may also call it), and the
 * locker converts each slot's share to its preferred asset by swapping in the same pool, in the same transaction
 * (tx 0x454d41e8…68110: one $BOOTR buy and two locker swaps before it). `Swap.sender` is then the locker itself,
 * a router never is.
 */
export function isFeeConversionSwap(sender: string, locker: string | null | undefined): boolean {
  return !!locker && sender.toLowerCase() === locker.toLowerCase();
}

export async function applySwap(context: Ctx, t: TokenRow, s: SwapArgs, m: LogMeta) {
  const id = `${m.txHash}-${m.logIndex}`;
  if (await context.db.find(schema.trade, { id })) return;

  const ethUsd = await getEthUsd(context, m.blockNumber);
  const view = interpretSwap(s.amount0, s.amount1, t.coinIsToken0);
  const next: TokenRow = { ...t, sqrtPriceX96: s.sqrtPriceX96, poolLiquidity: s.liquidity, tick: s.tick };
  const market = marketFields(next, ethUsd);
  // The paired side in its own decimals and USD (WETH / ETH at ETH/USD, USDC at $1: lib/quote.ts).
  const valueUsd = quoteValueUsd(t, view.amountPaired, ethUsd);
  // What the trader paid, from `Swap.fee` and the coin's own `lpFeeBps` (lib/fees.ts `swapFeePips`): bootr
  // native fee (0) + hook fee; clanker the LP fee × 1.2 (Clanker's share on top); clanker-v5 the tax of the trade's
  // side as is (the token settings' buy and sell tax may differ).
  const source = sourceOf(t);
  const feePips = source === 'clanker-v5' ? v5SideTaxPips(t, view.side) : t.lpFeeBps;
  const feeUsd = usd(swapFeeUsd(source, valueUsd, s.fee, feePips));
  if (isFeeConversionSwap(s.sender, indexerEnv().clanker?.locker)) {
    await applyFeeConversionSwap(context, t, s, m, market, feeUsd);
    return;
  }

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
async function applyFeeConversionSwap(context: Ctx, t: TokenRow, s: SwapArgs, m: LogMeta, market: ReturnType<typeof marketFields>, feeUsd: number) {
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
