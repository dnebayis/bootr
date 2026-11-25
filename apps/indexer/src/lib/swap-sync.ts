/**
 * Applies the swaps of Bootr pools from a transaction's receipt, once each and in log order (the rules are in
 * lib/swaps.ts). Called by the handlers of a transaction's sync points; no `ponder.on` registrations here.
 */
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { enabledSources, indexerEnv } from './env';
import { applySwap } from './market';
import { rpcClient } from './rpc';
import { lc, sourceOf, type Ctx } from './store';
import { dueSwaps, poolManagerSwaps, syncCandidates, type PoolSwap, type ReceiptLog } from './swaps';

/** Where the calling handler's own log sits. */
export type SyncAt = { txHash: Hex; logIndex: number; blockNumber: bigint; blockHash: Hex; timestamp: number };

export function syncAt(event: { transaction: { hash: Hex }; log: { logIndex: number }; block: { number: bigint; hash: Hex; timestamp: bigint } }): SyncAt {
  return {
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
    timestamp: Number(event.block.timestamp),
  };
}

type TxPlan = {
  key: string;
  /** The transaction's sender: the trader of its swaps. */
  from: Address;
  /** The swaps of Bootr pools, in log order, each with its coin. */
  swaps: (PoolSwap & { token: Hex })[];
  /** Log indexes of the transaction's sync points. */
  syncPoints: number[];
};

/**
 * The last transaction's plan. A transaction's sync points come one after another, and what the plan is built from
 * cannot change between them: the receipt is final for its block, and a coin launched in this very transaction is left
 * out with or without its rows (the launch handler replays the launch transaction).
 */
let last: TxPlan | null = null;

type Receipt = { blockHash: Hex; from: Address; logs: readonly ReceiptLog[] };

/**
 * The transaction's receipt through Ponder's client, which stores `eth_getTransactionReceipt` in its RPC cache (a
 * re-read of the chain costs no request; `eth_getLogs` is not among the methods it stores). The cache is keyed by the
 * hash alone, so a receipt stored before a reorg moved the transaction is read again from the indexer's own client.
 */
async function receiptOf(context: Ctx, at: SyncAt): Promise<Receipt> {
  const cached = (await context.client.getTransactionReceipt({ hash: at.txHash })) as unknown as Receipt;
  if (lc(cached.blockHash) === lc(at.blockHash)) return cached;
  const fresh = (await rpcClient().getTransactionReceipt({ hash: at.txHash })) as unknown as Receipt;
  if (lc(fresh.blockHash) !== lc(at.blockHash)) {
    throw new Error(`[indexer] receipt of ${at.txHash} is in block ${fresh.blockHash}, the event in ${at.blockHash}`);
  }
  return fresh;
}

async function planOf(context: Ctx, at: SyncAt): Promise<TxPlan> {
  const key = `${at.txHash}-${at.blockHash}`;
  if (last?.key === key) return last;
  const env = indexerEnv();
  const enabled = enabledSources(env);
  const receipt = await receiptOf(context, at);
  const poolManager = env.addresses.uniswap.poolManager;

  const swaps: TxPlan['swaps'] = [];
  for (const s of poolManagerSwaps(receipt.logs, poolManager)) {
    const p = await context.db.find(schema.pool, { id: s.poolId });
    if (!p) continue; // another pool of the PoolManager
    const t = await context.db.find(schema.token, { id: p.token });
    if (!t || t.launchTx === at.txHash) continue; // launch tx is replayed by AgentLaunched
    swaps.push({ ...s, token: t.id });
  }

  // Each test below is the one the log's own handler makes before it settles swaps (src/market.ts, src/fees.ts).
  const syncPoints: number[] = [];
  if (swaps.length > 0) {
    const candidates = syncCandidates(receipt.logs, {
      poolManager,
      clankerLocker: enabled.ClankerLpLocker ? (env.clanker?.locker ?? null) : null,
      v5Hook: enabled.ClankerV5Hook ? (env.clankerV5?.hook ?? null) : null,
    });
    for (const c of candidates) {
      if (c.kind === 'v5credit') {
        const p = await context.db.find(schema.pool, { id: c.poolId });
        const t = p ? await context.db.find(schema.token, { id: p.token }) : null;
        if (t && sourceOf(t) === 'clanker-v5' && t.launchTx !== at.txHash) syncPoints.push(c.logIndex);
        continue;
      }
      const t = await context.db.find(schema.token, { id: c.token });
      if (!t) continue;
      if (c.kind === 'transfer' ? t.launchTx !== at.txHash : sourceOf(t) === 'clanker') syncPoints.push(c.logIndex);
    }
  }
  last = { key, from: receipt.from, swaps, syncPoints };
  return last;
}

async function settle(context: Ctx, at: SyncAt, phase: 'before' | 'after') {
  const plan = await planOf(context, at);
  if (plan.swaps.length === 0) return;
  const row = await context.db.find(schema.swapSync, { id: at.txHash });
  const due = dueSwaps(plan.swaps, plan.syncPoints, at.logIndex, row?.through ?? -1, phase);
  if (due.length === 0) return;
  for (const s of due) {
    // Read again for every swap: the one before it moved the coin's price and totals.
    const t = await context.db.find(schema.token, { id: s.token });
    if (!t) continue;
    await applySwap(
      context,
      t,
      { amount0: s.amount0, amount1: s.amount1, sqrtPriceX96: s.sqrtPriceX96, liquidity: s.liquidity, tick: s.tick, fee: s.fee, sender: s.sender },
      { txHash: at.txHash, logIndex: s.logIndex, blockNumber: at.blockNumber, timestamp: at.timestamp, from: plan.from },
    );
  }
  const through = due[due.length - 1]!.logIndex;
  await context.db.insert(schema.swapSync).values({ id: at.txHash, through, blockNumber: at.blockNumber }).onConflictDoUpdate({ through });
}

/**
 * Applies the transaction's swaps of Bootr pools that come before the caller's log and are not applied yet. Any
 * handler that reads a coin's price or pool state calls it first; read the coin's row after it, not before.
 */
export function swapsBefore(context: Ctx, at: SyncAt): Promise<void> {
  return settle(context, at, 'before');
}

/**
 * Applies the rest of the transaction's swaps when no later sync point exists to take them. Only the handlers of sync
 * points call it, after their own work (`planOf` counts exactly their logs as sync points).
 */
export function swapsAfter(context: Ctx, at: SyncAt): Promise<void> {
  return settle(context, at, 'after');
}

/** Test hook: forget the remembered plan. */
export function resetSwapSync(): void {
  last = null;
}
