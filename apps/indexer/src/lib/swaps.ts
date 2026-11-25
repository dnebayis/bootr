/**
 * Swaps of Bootr pools, read from transaction receipts (no Ponder imports here: the parity script runs this file as is).
 *
 * The indexer has no `PoolManager` source. Ponder 0.18 cannot filter `Swap` by a pool id list that grows with every
 * launch, so that source delivered every Uniswap v4 swap on Base (8,973,021 logs of 79,001 pools on 2026-11-25, 35,944
 * of them in Bootr's 16 pools). A swap in a coin's pool moves the coin into or out of the PoolManager, and the coin's
 * `Transfer` is already followed (`BootrToken`), so a `Transfer` with the PoolManager on one side is the signal: the
 * handler reads that transaction's receipt and takes the pool's `Swap` logs from it.
 *
 * Order. The old handler ran each swap at its own log index. A swap is now applied by the next "sync point" of its
 * transaction, which is a log whose handler calls `swapsBefore` and `swapsAfter` (src/lib/swap-sync.ts):
 * - a coin `Transfer` to or from the PoolManager,
 * - `ClaimedRewards` of a Clanker v4 coin (it values the burn slot's coins at the coin's price),
 * - a Clanker v5 hook credit of a v5 coin (`BurnTaxCredited` is in the coin too).
 * Before its own work a sync point applies every pending swap with a lower log index, in log order; after it, when no
 * later sync point exists in the receipt, it applies the rest. So every sync point sees the pool exactly as it did
 * under the old handler, and no swap is left behind (a sell that pays the PoolManager before it swaps has no transfer
 * after its `Swap`: tx 0x7e97633e52…, where the last sync point is the hook's `ClaimedRewards` one log before it).
 */
import { decodeEventLog, toEventSelector, type Address, type Hex } from 'viem';

import { ClankerLpLockerFeeConversionAbi } from '../../abis/ClankerLpLockerFeeConversion';
import { ClankerV5HookAbi } from '../../abis/ClankerV5';
import { Erc20Abi } from '../../abis/Erc20';
import { PoolManagerAbi } from '../../abis/PoolManager';
import { decodeV5HookCredit } from './clanker';
import { parseLaunchSource, swapFeeUsd, v5SideTaxPips } from './fees';
import { interpretSwap, usd, type SwapView } from './price';
import { marketFields, quoteValueUsd, type MarketInput } from './quote';

const lc = <T extends string>(s: T): T => s.toLowerCase() as T;

/** A receipt log as viem returns it (only the fields read here). */
export type ReceiptLog = { address: Address; topics: readonly Hex[] | [Hex, ...Hex[]] | []; data: Hex; logIndex: number };

export const SWAP_TOPIC = toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
export const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)');
const CLAIMED_REWARDS_TOPIC = toEventSelector('ClaimedRewards(address,uint256,uint256,uint256[],uint256[])');

/** One PoolManager `Swap` log, decoded. */
export type PoolSwap = {
  logIndex: number;
  poolId: Hex;
  sender: Address;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
};

function decode(abi: readonly unknown[], log: ReceiptLog): { eventName: string; args: Record<string, unknown> } | null {
  try {
    return decodeEventLog({ abi: abi as never, data: log.data, topics: log.topics as never }) as unknown as { eventName: string; args: Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Every `Swap` the PoolManager emitted in a receipt, of any pool, in log order. */
export function poolManagerSwaps(logs: readonly ReceiptLog[], poolManager: string): PoolSwap[] {
  const pm = lc(poolManager);
  const out: PoolSwap[] = [];
  for (const l of logs) {
    if (lc(l.address) !== pm || l.topics[0] !== SWAP_TOPIC) continue;
    const ev = decode(PoolManagerAbi, l);
    if (ev?.eventName !== 'Swap') continue;
    const a = ev.args;
    out.push({
      logIndex: l.logIndex,
      poolId: lc(a.id as Hex),
      sender: a.sender as Address,
      amount0: a.amount0 as bigint,
      amount1: a.amount1 as bigint,
      sqrtPriceX96: a.sqrtPriceX96 as bigint,
      liquidity: a.liquidity as bigint,
      tick: Number(a.tick),
      fee: Number(a.fee),
    });
  }
  return out.sort((x, y) => x.logIndex - y.logIndex);
}

/** True when an ERC-20 `Transfer` has the PoolManager on one side: the coin entered or left a v4 pool. */
export function touchesPoolManager(from: string, to: string, poolManager: string): boolean {
  const pm = lc(poolManager);
  return lc(from) === pm || lc(to) === pm;
}

/**
 * A log that may be a sync point, before the caller checks that its coin or pool is ours:
 * `transfer` names the emitting token, `collection` the coin of a v4 `ClaimedRewards`, `v5credit` the pool of a v5
 * hook credit.
 */
export type SyncCandidate =
  | { logIndex: number; kind: 'transfer'; token: Hex }
  | { logIndex: number; kind: 'collection'; token: Hex }
  | { logIndex: number; kind: 'v5credit'; poolId: Hex };

/**
 * The logs of a receipt whose handlers settle swaps, if their coin or pool turns out to be Bootr's. `clankerLocker`
 * and `v5Hook` are null when that source is not registered (then its handler does not run either).
 */
export function syncCandidates(
  logs: readonly ReceiptLog[],
  a: { poolManager: string; clankerLocker: string | null; v5Hook: string | null },
): SyncCandidate[] {
  const locker = a.clankerLocker ? lc(a.clankerLocker) : null;
  const hook = a.v5Hook ? lc(a.v5Hook) : null;
  const out: SyncCandidate[] = [];
  for (const l of logs) {
    const addr = lc(l.address);
    const topic0 = l.topics[0];
    if (locker && addr === locker) {
      if (topic0 !== CLAIMED_REWARDS_TOPIC) continue;
      const ev = decode(ClankerLpLockerFeeConversionAbi, l);
      if (ev?.eventName === 'ClaimedRewards') out.push({ logIndex: l.logIndex, kind: 'collection', token: lc(ev.args.token as Hex) });
    } else if (hook && addr === hook) {
      const ev = decode(ClankerV5HookAbi, l);
      const credit = ev ? decodeV5HookCredit(ev.eventName, ev.args) : null;
      if (credit) out.push({ logIndex: l.logIndex, kind: 'v5credit', poolId: credit.poolId });
    } else if (topic0 === TRANSFER_TOPIC && l.topics.length === 3) {
      const ev = decode(Erc20Abi, l);
      if (ev?.eventName === 'Transfer' && touchesPoolManager(ev.args.from as string, ev.args.to as string, a.poolManager)) {
        out.push({ logIndex: l.logIndex, kind: 'transfer', token: addr as Hex });
      }
    }
  }
  return out;
}

/**
 * Which of a transaction's Bootr swaps a sync point at log index `at` applies. `through` is the log index of the last
 * swap already applied (-1 = none); swaps are applied in log order, so the applied ones are always a prefix.
 * `before` (ahead of the sync point's own work): the pending swaps below `at`. `after`: every pending swap, but only
 * when no later sync point exists, which would otherwise take them in their place.
 */
export function dueSwaps<S extends { logIndex: number }>(
  swaps: readonly S[],
  syncPoints: readonly number[],
  at: number,
  through: number,
  phase: 'before' | 'after',
): S[] {
  const pending = swaps.filter((s) => s.logIndex > through);
  if (phase === 'before') return pending.filter((s) => s.logIndex < at);
  return syncPoints.some((p) => p > at) ? [] : pending;
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

/** The columns of a coin that price one of its swaps. */
export type SwapCoin = MarketInput & {
  source: string;
  lpFeeBps: number;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
};

export type SwapFigures = {
  view: SwapView;
  /** Price-derived fields of the coin at the swap's closing pool state. */
  market: ReturnType<typeof marketFields>;
  /** The paired side in USD (WETH / ETH at ETH/USD, USDC at $1: lib/quote.ts). */
  valueUsd: number;
  /**
   * What the swapper paid, from `Swap.fee` and the coin's own `lpFeeBps` (lib/fees.ts `swapFeePips`): bootr native
   * fee (0) + hook fee; clanker the LP fee × 1.2 (Clanker's share on top); clanker-v5 the tax of the trade's side as
   * is (the token settings' buy and sell tax may differ).
   */
  feeUsd: number;
};

/** Side, amounts, price, value and fee of one swap of a coin's pool. */
export function swapFigures(t: SwapCoin, s: Pick<PoolSwap, 'amount0' | 'amount1' | 'sqrtPriceX96' | 'liquidity' | 'fee'>, ethUsd: number): SwapFigures {
  const view = interpretSwap(s.amount0, s.amount1, t.coinIsToken0);
  const market = marketFields({ ...t, sqrtPriceX96: s.sqrtPriceX96, poolLiquidity: s.liquidity }, ethUsd);
  const valueUsd = quoteValueUsd(t, view.amountPaired, ethUsd);
  const source = parseLaunchSource(t.source);
  const feePips = source === 'clanker-v5' ? v5SideTaxPips(t, view.side) : t.lpFeeBps;
  const feeUsd = usd(swapFeeUsd(source, valueUsd, s.fee, feePips));
  return { view, market, valueUsd, feeUsd };
}

/** Where a swap sits on chain; `from` is the transaction's sender (the trader). */
export type SwapMeta = { txHash: Hex; logIndex: number; blockNumber: bigint; timestamp: number; from: Address };

/** The `trade` row of a swap that is a trade (not a fee conversion). */
export function tradeRow(token: Hex, s: Pick<PoolSwap, 'sender'>, m: SwapMeta, f: SwapFigures) {
  return {
    id: `${m.txHash}-${m.logIndex}`,
    token,
    trader: lc(m.from),
    sender: lc(s.sender),
    side: f.view.side,
    amountToken: f.view.amountToken,
    amountPaired: f.view.amountPaired,
    priceUsd: f.market.priceUsd,
    valueUsd: f.valueUsd,
    feeUsd: f.feeUsd,
    timestamp: m.timestamp,
    blockNumber: m.blockNumber,
    logIndex: m.logIndex,
    txHash: m.txHash,
  };
}
