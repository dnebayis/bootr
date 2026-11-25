/**
 * Parity check for swaps read from receipts (src/lib/swaps.ts) against the `trade` rows of a running indexer that
 * still reads `PoolManager.Swap` directly. Not part of CI: it reads a public indexer and a public RPC.
 *
 *   pnpm --filter indexer exec tsx scripts/swap-parity.ts [--per-coin 150] [--recent 0] [--coins BOOTR,OWL] [--standalone 40]
 *
 * The sample per coin: its newest `--recent` trades plus `--per-coin` trades spread evenly over its whole history.
 *
 *   INDEXER_URL   the indexer to compare against (default https://indexer.bootr.fun)
 *   PARITY_RPC    a Base RPC without a key in it (default https://mainnet.base.org); never printed
 *
 * For every sampled transaction it fetches the receipt and walks it the way the handlers do: the sync points in log
 * order, `dueSwaps` before and after each (lib/swap-sync.ts), `swapFigures` and `tradeRow` for every swap applied
 * that is not a fee conversion. It then compares, per transaction, the rows it built with every `trade` row the
 * indexer holds for that transaction hash, field by field, and checks that
 * - every swap of a Bootr pool in the receipt was applied exactly once, in log order (a swap with no sync point in
 *   its transaction would be missed by the new indexer),
 * - every sync point saw exactly the swaps with a lower log index (the old handler order),
 * - a swap whose sender is the Clanker fee conversion locker produced no row.
 * A coin's launch transaction is left out: its dev buy is replayed by the launch handler from the launch receipt, now
 * as before, and the live handlers skip it (the script counts those rows and does not compare them).
 * ETH/USD is not on the receipt: it is taken from the indexer's own `priceUsd` of the row (`priceUsd / priceQuote`,
 * rounded to the 6 decimals the indexer stores), and `valueUsd` and `feeUsd` are then recomputed with it.
 */
import type { Address, Hex } from 'viem';

import { CLANKER_V4, CLANKER_V5 } from '../src/lib/env';
import { coinPriceInQuote, usd } from '../src/lib/price';
import { dueSwaps, isFeeConversionSwap, poolManagerSwaps, swapFigures, syncCandidates, tradeRow, type PoolSwap, type ReceiptLog, type SwapCoin } from '../src/lib/swaps';

const INDEXER = (process.env.INDEXER_URL ?? 'https://indexer.bootr.fun').replace(/\/$/, '');
const RPC = process.env.PARITY_RPC ?? 'https://mainnet.base.org';
// Base mainnet: the v4 PoolManager and the Clanker stacks the indexer uses by default (src/lib/env.ts).
const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const CLANKER_LOCKER = CLANKER_V4[8453]!.locker.toLowerCase();
const V5_HOOK = CLANKER_V5[8453]!.hook.toLowerCase();

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const PER_COIN = Number(arg('per-coin', '150'));
const RECENT = Number(arg('recent', '0'));
const ONLY = arg('coins', '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const STANDALONE = Number(arg('standalone', '40'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post<T>(url: string, body: unknown, what: string): Promise<T> {
  let lastError = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'swap-parity/1.0' }, body: JSON.stringify(body) });
      if (res.ok) {
        const json = (await res.json()) as { data?: T; result?: T; error?: { message: string }; errors?: { message: string }[] };
        if (json.errors?.length) throw new Error(json.errors[0]!.message);
        if (json.error) lastError = json.error.message;
        else return (json.data ?? json.result) as T;
      } else lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await sleep(500 * 2 ** attempt);
  }
  // The url is left out on purpose: an RPC url may hold a key.
  throw new Error(`${what} failed: ${lastError}`);
}

const gql = <T>(query: string) => post<T>(`${INDEXER}/graphql`, { query }, 'indexer query');
const rpc = <T>(method: string, params: unknown[]) => post<T>(RPC, { jsonrpc: '2.0', id: 1, method, params }, method);

type Coin = SwapCoin & { id: Hex; symbol: string; poolId: Hex; launchTx: Hex };
type ProdTrade = {
  id: string;
  token: Hex;
  trader: Hex;
  sender: Hex;
  side: string;
  amountToken: string;
  amountPaired: string;
  priceUsd: number;
  valueUsd: number;
  feeUsd: number;
  timestamp: number;
  blockNumber: string;
  logIndex: number;
  txHash: Hex;
};
const TRADE_FIELDS = 'id token trader sender side amountToken amountPaired priceUsd valueUsd feeUsd timestamp blockNumber logIndex txHash';

async function coins(): Promise<Coin[]> {
  const data = await gql<{ tokens: { items: Record<string, unknown>[] } }>(
    `{ tokens(limit: 1000) { items { id symbol source poolId launchTx coinIsToken0 lpFeeBps buyTaxBps sellTaxBps pairedSymbol pairedDecimals
       totalSupply deadBalance positionLiquidity poolLiquidity tickLower tickUpper sqrtPriceX96 } } }`,
  );
  return data.tokens.items.map((t) => ({
    ...(t as unknown as Coin),
    totalSupply: BigInt(t.totalSupply as string),
    deadBalance: BigInt(t.deadBalance as string),
    positionLiquidity: BigInt(t.positionLiquidity as string),
    poolLiquidity: BigInt(t.poolLiquidity as string),
    sqrtPriceX96: BigInt(t.sqrtPriceX96 as string),
  }));
}

/** Every trade of a coin, newest first (the indexer pages by cursor). */
async function tradesOf(token: Hex): Promise<ProdTrade[]> {
  const out: ProdTrade[] = [];
  let after: string | null = null;
  for (;;) {
    const page: { trades: { items: ProdTrade[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } } } = await gql(
      `{ trades(where: { token: "${token}" }, limit: 1000, orderBy: "blockNumber", orderDirection: "desc"${after ? `, after: "${after}"` : ''}) {
         items { ${TRADE_FIELDS} } pageInfo { endCursor hasNextPage } } }`,
    );
    out.push(...page.trades.items);
    if (!page.trades.pageInfo.hasNextPage || !page.trades.pageInfo.endCursor) return out;
    after = page.trades.pageInfo.endCursor;
  }
}

async function tradesOfTxs(txs: readonly Hex[]): Promise<Map<Hex, ProdTrade[]>> {
  const out = new Map<Hex, ProdTrade[]>(txs.map((h) => [h, []]));
  for (let i = 0; i < txs.length; i += 50) {
    const chunk = txs.slice(i, i + 50);
    const data = await gql<{ trades: { items: ProdTrade[] } }>(
      `{ trades(where: { txHash_in: [${chunk.map((h) => `"${h}"`).join(',')}] }, limit: 1000) { items { ${TRADE_FIELDS} } } }`,
    );
    for (const t of data.trades.items) out.get(t.txHash)?.push(t);
  }
  return out;
}

/** Transactions with a Clanker v4 collection (`feeCredit`) of a coin, newest first, up to `pages` thousand credits. */
async function collectionTxs(token: Hex, pages: number): Promise<Hex[]> {
  const seen = new Set<Hex>();
  let after: string | null = null;
  for (let p = 0; p < pages; p++) {
    const page: { feeCredits: { items: { txHash: Hex }[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } } } = await gql(
      `{ feeCredits(where: { token: "${token}" }, limit: 1000, orderBy: "blockNumber", orderDirection: "desc"${after ? `, after: "${after}"` : ''}) {
         items { txHash } pageInfo { endCursor hasNextPage } } }`,
    );
    for (const c of page.feeCredits.items) seen.add(c.txHash);
    if (!page.feeCredits.pageInfo.hasNextPage || !page.feeCredits.pageInfo.endCursor) break;
    after = page.feeCredits.pageInfo.endCursor;
  }
  return [...seen];
}

/** `n` items spread evenly over a list (all of it when it is shorter). */
function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]!);
  return out;
}

type RawReceipt = { blockHash: Hex; blockNumber: Hex; from: Address; logs: { address: Address; topics: Hex[]; data: Hex; logIndex: Hex }[] };
const blockTime = new Map<string, number>();

async function timestampOf(blockNumber: Hex): Promise<number> {
  const known = blockTime.get(blockNumber);
  if (known !== undefined) return known;
  const block = await rpc<{ timestamp: Hex }>('eth_getBlockByNumber', [blockNumber, false]);
  const ts = Number(BigInt(block.timestamp));
  blockTime.set(blockNumber, ts);
  return ts;
}

type TxResult = {
  txHash: Hex;
  rows: ReturnType<typeof tradeRow>[];
  swaps: number;
  conversions: number;
  otherPoolSwaps: number;
  problems: string[];
};

/** Walks one receipt as the handlers do and builds its trade rows. `ethUsdOf` gives ETH/USD for a swap's row id. */
function walk(
  txHash: Hex,
  receipt: { from: Address; logs: ReceiptLog[] },
  meta: { blockNumber: bigint; timestamp: number },
  byPool: Map<string, Coin>,
  byId: Map<string, Coin>,
  ethUsdOf: (id: string, coin: Coin, s: PoolSwap) => number,
): TxResult {
  const problems: string[] = [];
  const all = poolManagerSwaps(receipt.logs, POOL_MANAGER);
  const ours = all.filter((s) => {
    const c = byPool.get(s.poolId);
    return !!c && c.launchTx !== txHash;
  });
  const syncPoints = syncCandidates(receipt.logs, { poolManager: POOL_MANAGER, clankerLocker: CLANKER_LOCKER, v5Hook: V5_HOOK })
    .filter((c) => {
      if (c.kind === 'v5credit') {
        const coin = byPool.get(c.poolId);
        return !!coin && coin.source === 'clanker-v5' && coin.launchTx !== txHash;
      }
      const coin = byId.get(c.token);
      if (!coin) return false;
      return c.kind === 'transfer' ? coin.launchTx !== txHash : coin.source === 'clanker';
    })
    .map((c) => c.logIndex)
    .sort((a, b) => a - b);

  const applied: PoolSwap[] = [];
  let through = -1;
  const apply = (due: PoolSwap[]) => {
    for (const s of due) applied.push(s);
    if (due.length) through = due[due.length - 1]!.logIndex;
  };
  for (const at of syncPoints) {
    apply(dueSwaps(ours, syncPoints, at, through, 'before'));
    // The sync point's own work happens here: it must have seen exactly the swaps below it.
    const seen = applied.length;
    const below = ours.filter((s) => s.logIndex < at).length;
    if (seen !== below) problems.push(`sync point ${at} saw ${seen} swaps, the old order gives ${below}`);
    apply(dueSwaps(ours, syncPoints, at, through, 'after'));
  }
  if (applied.length !== ours.length) {
    const missed = ours.filter((s) => !applied.includes(s)).map((s) => s.logIndex);
    problems.push(`swaps never applied (no sync point): log ${missed.join(', ')}`);
  }
  if (applied.some((s, i) => i > 0 && applied[i - 1]!.logIndex >= s.logIndex)) problems.push('swaps applied out of log order');

  const rows: TxResult['rows'] = [];
  let conversions = 0;
  for (const s of applied) {
    if (isFeeConversionSwap(s.sender, CLANKER_LOCKER)) {
      conversions += 1;
      continue;
    }
    const coin = byPool.get(s.poolId)!;
    const m = { txHash, logIndex: s.logIndex, blockNumber: meta.blockNumber, timestamp: meta.timestamp, from: receipt.from };
    const ethUsd = ethUsdOf(`${txHash}-${s.logIndex}`, coin, s);
    rows.push(tradeRow(coin.id, s, m, swapFigures(coin, s, ethUsd)));
  }
  return { txHash, rows, swaps: applied.length, conversions, otherPoolSwaps: all.length - ours.length, problems };
}

async function main() {
  const allCoins = await coins();
  const byPool = new Map(allCoins.map((c) => [c.poolId.toLowerCase(), c]));
  const byId = new Map(allCoins.map((c) => [c.id.toLowerCase(), c]));

  // The sample: per coin, trades spread over its whole history.
  const picked: ProdTrade[] = [];
  const perCoin: string[] = [];
  for (const c of allCoins) {
    if (ONLY.length && !ONLY.includes(c.symbol.toUpperCase())) continue;
    const trades = await tradesOf(c.id);
    const sample = [...new Set([...trades.slice(0, RECENT), ...spread(trades, PER_COIN)])];
    picked.push(...sample);
    perCoin.push(`${c.symbol} ${sample.length}/${trades.length}`);
  }
  const tradeTxs = [...new Set(picked.map((t) => t.txHash))];

  // Collections with no trade in their transaction: `collectRewards` called on its own, which converts fees by swapping.
  const standalone: Hex[] = [];
  if (STANDALONE > 0) {
    for (const c of allCoins.filter((x) => x.source === 'clanker' && (!ONLY.length || ONLY.includes(x.symbol.toUpperCase())))) {
      const txs = await collectionTxs(c.id, 6);
      const withTrades = await tradesOfTxs(txs);
      standalone.push(...txs.filter((h) => withTrades.get(h)!.length === 0));
    }
  }
  const standaloneTxs = spread([...new Set(standalone)], STANDALONE).filter((h) => !tradeTxs.includes(h));
  const txs = [...tradeTxs, ...standaloneTxs];
  const expected = await tradesOfTxs(txs);
  console.log(`coins (sampled/total trades): ${perCoin.join(', ')}`);
  console.log(`transactions: ${tradeTxs.length} with sampled trades, ${standaloneTxs.length} collections without a trade (of ${new Set(standalone).size} found)`);

  const stats = { txs: 0, swaps: 0, rows: 0, matched: 0, conversions: 0, conversionTxs: 0, otherPoolSwaps: 0, otherPoolTxs: 0, multiSwapTxs: 0, launchRows: 0 };
  const mismatches: string[] = [];
  const ethUsdByBlock = new Map<string, Set<number>>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const txHash = txs[next++];
      if (!txHash) return;
      const raw = await rpc<RawReceipt>('eth_getTransactionReceipt', [txHash]);
      const timestamp = await timestampOf(raw.blockNumber);
      const logs: ReceiptLog[] = raw.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: Number(BigInt(l.logIndex)) }));
      // Rows of a coin's own launch transaction are the launch handler's (see the header).
      const inTx = expected.get(txHash)!;
      const prod = inTx.filter((t) => byId.get(t.token)?.launchTx !== txHash);
      stats.launchRows += inTx.length - prod.length;
      const prodById = new Map(prod.map((t) => [t.id, t]));
      const result = walk(txHash, { from: raw.from, logs }, { blockNumber: BigInt(raw.blockNumber), timestamp }, byPool, byId, (id, coin, s) => {
        const row = prodById.get(id);
        if (!row || coin.pairedSymbol === 'USDC') return 1;
        const priceQuote = coinPriceInQuote(s.sqrtPriceX96, coin.coinIsToken0, coin.pairedDecimals);
        const ethUsd = priceQuote > 0 ? usd(row.priceUsd / priceQuote) : 0;
        let seen = ethUsdByBlock.get(raw.blockNumber);
        if (!seen) ethUsdByBlock.set(raw.blockNumber, (seen = new Set()));
        seen.add(ethUsd);
        return ethUsd;
      });
      stats.txs += 1;
      stats.swaps += result.swaps;
      stats.rows += result.rows.length;
      stats.conversions += result.conversions;
      if (result.conversions) stats.conversionTxs += 1;
      stats.otherPoolSwaps += result.otherPoolSwaps;
      if (result.otherPoolSwaps) stats.otherPoolTxs += 1;
      if (result.swaps > 1) stats.multiSwapTxs += 1;
      for (const p of result.problems) mismatches.push(`${txHash}: ${p}`);
      const built = new Map(result.rows.map((r) => [r.id, r]));
      for (const id of new Set([...built.keys(), ...prodById.keys()])) {
        const mine = built.get(id);
        const theirs = prodById.get(id);
        if (!mine) mismatches.push(`${id}: the indexer has a trade row, the receipt walk built none`);
        else if (!theirs) mismatches.push(`${id}: the receipt walk built a trade row, the indexer has none`);
        else {
          const diff: string[] = [];
          const same = (field: string, a: unknown, b: unknown) => {
            if (String(a).toLowerCase() !== String(b).toLowerCase()) diff.push(`${field} ${String(a)} != ${String(b)}`);
          };
          same('token', mine.token, theirs.token);
          same('trader', mine.trader, theirs.trader);
          same('sender', mine.sender, theirs.sender);
          same('side', mine.side, theirs.side);
          same('amountToken', mine.amountToken, theirs.amountToken);
          same('amountPaired', mine.amountPaired, theirs.amountPaired);
          same('priceUsd', mine.priceUsd, theirs.priceUsd);
          same('valueUsd', mine.valueUsd, theirs.valueUsd);
          same('feeUsd', mine.feeUsd, theirs.feeUsd);
          same('timestamp', mine.timestamp, theirs.timestamp);
          same('blockNumber', mine.blockNumber, theirs.blockNumber);
          same('logIndex', mine.logIndex, theirs.logIndex);
          same('txHash', mine.txHash, theirs.txHash);
          if (diff.length) mismatches.push(`${id}: ${diff.join('; ')}`);
          else stats.matched += 1;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  const splitBlocks = [...ethUsdByBlock.entries()].filter(([, v]) => v.size > 1);
  for (const [block, values] of splitBlocks) mismatches.push(`block ${Number(BigInt(block))}: rows imply different ETH/USD (${[...values].join(', ')})`);
  console.log(`receipts walked: ${stats.txs}`);
  console.log(`swaps of Bootr pools applied: ${stats.swaps} (${stats.multiSwapTxs} transactions with more than one)`);
  console.log(`fee conversion swaps (no row): ${stats.conversions} in ${stats.conversionTxs} transactions`);
  console.log(`swaps of other pools ignored: ${stats.otherPoolSwaps} in ${stats.otherPoolTxs} transactions`);
  console.log(`trade rows built: ${stats.rows}; equal to the indexer's row in every field: ${stats.matched}`);
  console.log(`rows of launch transactions left to the launch handler: ${stats.launchRows}`);
  console.log(`mismatches: ${mismatches.length}`);
  for (const m of mismatches) console.log(`  ${m}`);
  if (mismatches.length) process.exit(1);
}

main().catch((err) => {
  console.error('swap-parity failed:', (err as Error).message);
  process.exit(1);
});
