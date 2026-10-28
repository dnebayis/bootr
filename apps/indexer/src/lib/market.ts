/**
 * Swap and transfer application, shared by the live event handlers and by the launch handler
 * (which replays the launch transaction's dev-buy swap and initial transfers from its receipt,
 * because those logs precede `AgentLaunched` and therefore the token/pool rows).
 */
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { getEthUsd, getPlatformConfig, bumpDaily, bumpPlatform, DEAD_ADDRESS, graduationFields, lc, marketFields, recordTradeBucket, windowFields, ZERO_ADDRESS, type Ctx, type TokenRow } from './store';
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

export async function applySwap(context: Ctx, t: TokenRow, s: SwapArgs, m: LogMeta) {
  const id = `${m.txHash}-${m.logIndex}`;
  if (await context.db.find(schema.trade, { id })) return;

  const ethUsd = await getEthUsd(context, m.blockNumber);
  const view = interpretSwap(s.amount0, s.amount1, t.coinIsToken0);
  const next: TokenRow = { ...t, sqrtPriceX96: s.sqrtPriceX96, poolLiquidity: s.liquidity, tick: s.tick };
  const market = marketFields(next, ethUsd);
  const valueUsd = usd(toUnits(view.amountPaired, 18) * ethUsd);
  // Swap fee in pips (1e6 = 100%): the native LP fee (0 on RWAGMI pools) plus the hook's fee, which
  // RWAGMI takes in WETH and splits over the reward slots (exact amounts come from PoolFeeTakenV3).
  const feeUsd = usd((valueUsd * (s.fee + t.lpFeeBps)) / 1e6);

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
    txHash: m.txHash,
  });

  const buckets = await recordTradeBucket(context, t.id, m.timestamp, valueUsd, feeUsd, market.priceUsd);
  const cfg = await getPlatformConfig(context);
  await context.db.update(schema.token, { id: t.id }).set((row) => ({
    sqrtPriceX96: s.sqrtPriceX96,
    tick: s.tick,
    poolLiquidity: s.liquidity,
    ...market,
    ...windowFields(buckets, m.timestamp, market.priceUsd),
    volumeTotalUsd: usd(row.volumeTotalUsd + valueUsd),
    lastTradeAt: m.timestamp,
    ...graduationFields(row, market.marketCapUsd, cfg.graduationThresholdUsd, m.timestamp),
  }));
  await bumpDaily(context, m.timestamp, { volumeUsd: valueUsd, trades: 1 });
  await bumpPlatform(context, m.timestamp, { volumeTotalUsd: valueUsd });
}

const counts = (holder: string) => holder !== ZERO_ADDRESS && holder !== DEAD_ADDRESS;

/** Update the two balances and the coin's holder count. */
export async function applyTransfer(context: Ctx, token: Hex, from: Address, to: Address, value: bigint, ts: number) {
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
    await context.db.update(schema.token, { id: token }).set((r) => ({ holders: Math.max(0, r.holders + holderDelta) }));
  }
}
