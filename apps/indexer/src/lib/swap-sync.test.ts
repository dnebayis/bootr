import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEventLog, type Address, type Hex } from 'viem';

import { ClankerLpLockerFeeConversionAbi } from '../../abis/ClankerLpLockerFeeConversion';
import { ClankerV5HookAbi } from '../../abis/ClankerV5';
import { Erc20Abi } from '../../abis/Erc20';
import bcatBrianbrain from '../../test/fixtures/bcat-sell-brianbrain-buy.json';
import bootrPrepaidSell from '../../test/fixtures/bootr-prepaid-sell.json';
import cbbLateTransfer from '../../test/fixtures/cbb-v5-sell-late-transfer.json';
import coins from '../../test/fixtures/coins.json';
import owlOtherPool from '../../test/fixtures/owl-sell-other-pool.json';
import type { Handler, Row } from '../../test/fake-ponder';
import { coinPriceInQuote, toUnits, usd } from './price';
import { poolManagerSwaps, swapFigures, type ReceiptLog, type SwapCoin } from './swaps';

// The real handlers of src/market.ts and src/fees.ts run here, against receipts saved from Base mainnet on 2026-11-25
// (test/fixtures, each with the production indexer's `trade` rows of that transaction, written by the old
// `PoolManager:Swap` handler). Ponder's modules are stand-ins (test/fake-ponder.ts).
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock('ponder:schema', async () => (await import('../../test/fake-ponder')).schemaMock());
vi.mock('ponder', async () => (await import('../../test/fake-ponder')).ponderMock());
vi.mock('ponder:registry', async () => (await import('../../test/fake-ponder')).registryMock(handlers));
const ownClient = vi.hoisted(() => ({ getTransactionReceipt: vi.fn() }));
vi.mock('./rpc', () => ({ rpcClient: () => ownClient }));

const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const WETH = '0x4200000000000000000000000000000000000006';
const NATIVE = '0x0000000000000000000000000000000000000000';
const LOCKER = '0xffa37784d619f228d8b379d287a4d7282e500762';
const V5_HOOK = '0x5e320ea6278107968c119942e57d876c5f922acc';
const DEAD = '0x000000000000000000000000000000000000dead';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

type Fixture = {
  txHash: string;
  blockHash: string;
  blockNumber: number;
  timestamp: number;
  from: string;
  logs: { address: string; topics: string[]; data: string; logIndex: number }[];
  trades: Record<string, unknown>[];
};
type CoinFixture = (typeof coins)[number];
const coinBySymbol = (symbol: string) => coins.find((c) => c.symbol === symbol)!;
const coinById = new Map(coins.map((c) => [c.id, c]));
const coinByPool = new Map(coins.map((c) => [c.poolId, c]));

function swapCoin(c: CoinFixture): SwapCoin {
  return {
    ...c,
    sqrtPriceX96: 0n,
    totalSupply: BigInt(c.totalSupply),
    deadBalance: BigInt(c.deadBalance),
    positionLiquidity: BigInt(c.positionLiquidity),
    poolLiquidity: BigInt(c.poolLiquidity),
  };
}

function tokenRow(c: CoinFixture): Row {
  return {
    ...swapCoin(c),
    id: c.id,
    kernel: c.kernel,
    launchTx: c.launchTx,
    poolId: c.poolId,
    tick: 0,
    priceWeth: 0,
    priceQuote: 0,
    priceUsd: 0,
    marketCapUsd: 0,
    liquidityUsd: 0,
    volume24hUsd: 0,
    volume7dUsd: 0,
    fees24hUsd: 0,
    change24hPct: null,
    trades24h: 0,
    volumeTotalUsd: 0,
    feesTotalUsd: 0,
    burnedTotal: 0n,
    lastTradeAt: 0,
    holders: 0,
    graduated: true,
    graduatedAt: 1,
    dividendContract: null,
    dividendsTotalUsd: 0,
    dividendsRedirectedUsd: 0,
  };
}

/** ETH/USD as the production indexer had it for a fixture: `priceUsd / priceQuote` of one of its trades, to 6 dp. */
function ethUsdOf(f: Fixture): number {
  const trade = f.trades.find((t) => coinById.get(t.token as string)!.pairedSymbol !== 'USDC')!;
  const coin = coinById.get(trade.token as string)!;
  const swap = poolManagerSwaps(f.logs as ReceiptLog[], POOL_MANAGER).find((s) => s.logIndex === trade.logIndex)!;
  return usd((trade.priceUsd as number) / coinPriceInQuote(swap.sqrtPriceX96, coin.coinIsToken0, coin.pairedDecimals));
}

let fake: typeof import('../../test/fake-ponder');
let sync: typeof import('./swap-sync');

beforeAll(async () => {
  vi.stubEnv('CHAIN_ID', '8453');
  vi.stubEnv('BOOTR_LAUNCHERS', '0x01f290cc00000000000000000000000000000001@53219209');
  vi.stubEnv('BOOTR_CLANKER_LAUNCHERS', '0x01f290cc00000000000000000000000000000002@53400000');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fake = await import('../../test/fake-ponder');
  sync = await import('./swap-sync');
  await import('../market');
  await import('../fees');
});

beforeEach(() => {
  sync.resetSwapSync();
  ownClient.getTransactionReceipt.mockReset();
});

/** Seeds the coins, their pools and fee slots, and plays a receipt's logs through the handlers in log order. */
async function setup(f: Fixture, receiptOver: Record<string, unknown> = {}) {
  const { db, rows } = fake.fakeDb();
  const receipt = { blockHash: f.blockHash, from: f.from, logs: f.logs, ...receiptOver };
  const client = { getTransactionReceipt: vi.fn(async () => receipt) };
  const context = { db, client };
  await db.insert({ name: 'priceFeed' }).values({ id: 'ETH/USD', priceUsd: ethUsdOf(f), oracleUpdatedAt: f.timestamp, blockNumber: BigInt(f.blockNumber) });
  for (const c of coins) {
    await db.insert({ name: 'token' }).values(tokenRow(c));
    const quote = c.pairedSymbol === 'ETH' ? NATIVE : WETH;
    await db.insert({ name: 'pool' }).values({ id: c.poolId, token: c.id, currency0: c.coinIsToken0 ? c.id : quote, currency1: c.coinIsToken0 ? quote : c.id });
    // Clanker's slot order on $BOOTR: agent, creator, burn (the dead address, paid in the coin), platform.
    const kinds = ['agent', 'creator', 'burn', 'platform'];
    for (let slot = 0; slot < kinds.length; slot++) {
      const recipient = kinds[slot] === 'burn' ? DEAD : `0x${String(slot + 1).padStart(40, '0')}`;
      await db.insert({ name: 'feeSlot' }).values({ id: `${c.id}-${slot}`, token: c.id, slot, recipient, recipientKind: kinds[slot], bps: 2500 });
    }
  }
  const eventOf = (l: Fixture['logs'][number], args: Record<string, unknown>) => ({
    args,
    log: { address: l.address as Address, logIndex: l.logIndex },
    transaction: { hash: f.txHash as Hex, from: f.from as Address },
    block: { number: BigInt(f.blockNumber), hash: f.blockHash as Hex, timestamp: BigInt(f.timestamp) },
  });
  /** What Ponder would deliver for one log, or nothing when no source of ours matches it. */
  const deliver = async (l: Fixture['logs'][number]) => {
    const address = l.address.toLowerCase();
    const topics = l.topics as [Hex, ...Hex[]];
    if (coinById.has(address) && l.topics[0] === TRANSFER) {
      const ev = decodeEventLog({ abi: Erc20Abi, data: l.data as Hex, topics });
      await handlers.get('BootrToken:Transfer')!({ event: eventOf(l, ev.args as Record<string, unknown>), context });
    } else if (address === LOCKER) {
      const ev = decodeEventLog({ abi: ClankerLpLockerFeeConversionAbi, data: l.data as Hex, topics, strict: false }) as { eventName: string; args: Record<string, unknown> };
      if (ev.eventName === 'ClaimedRewards') await handlers.get('ClankerLpLocker:ClaimedRewards')!({ event: eventOf(l, ev.args), context });
    } else if (address === V5_HOOK) {
      const ev = decodeEventLog({ abi: ClankerV5HookAbi, data: l.data as Hex, topics, strict: false }) as { eventName: string; args: Record<string, unknown> };
      const handler = handlers.get(`ClankerV5Hook:${ev.eventName}`);
      if (handler) await handler({ event: eventOf(l, ev.args), context });
    }
  };
  const play = async () => {
    for (const l of f.logs) await deliver(l);
  };
  const token = async (symbol: string) => (await db.find({ name: 'token' }, { id: coinBySymbol(symbol).id }))!;
  return { db, rows, client, play, deliver, token };
}

/** The production rows of a fixture in the shape the handlers write (GraphQL sends big integers as strings). */
function productionTrades(f: Fixture) {
  return f.trades
    .map((t): Row => ({ ...t, id: t.id, amountToken: BigInt(t.amountToken as string), amountPaired: BigInt(t.amountPaired as string), blockNumber: BigInt(t.blockNumber as string) }))
    .sort((a, b) => (a.logIndex as number) - (b.logIndex as number));
}
const byLogIndex = (rows: Row[]) => [...rows].sort((a, b) => (a.logIndex as number) - (b.logIndex as number));

describe('the handlers register without a PoolManager source', () => {
  it('has the coin Transfer, the Clanker collection and the v5 credits, and no PoolManager:Swap', () => {
    expect(handlers.has('BootrToken:Transfer')).toBe(true);
    expect(handlers.has('ClankerLpLocker:ClaimedRewards')).toBe(true);
    expect(handlers.has('ClankerV5Hook:BurnTaxCredited')).toBe(true);
    expect([...handlers.keys()].some((k) => k.startsWith('PoolManager'))).toBe(false);
  });
});

describe('a $BOOTR sell that pays the PoolManager before it swaps (tx 0x7e97633e…b999)', () => {
  // Logs: Transfer in 5 · collection: Transfer out 11, locker Swap 22, Transfer out 24, locker Swap 35, Transfer in 37,
  // ClaimedRewards 47 · the seller's Swap 48, with no coin transfer after it.
  const f = bootrPrepaidSell as Fixture;
  const swaps = poolManagerSwaps(f.logs as ReceiptLog[], POOL_MANAGER);

  it('has three swaps of the pool in its receipt, two of them the locker’s', () => {
    expect(swaps.map((s) => s.logIndex)).toEqual([22, 35, 48]);
    expect(swaps.map((s) => s.sender.toLowerCase() === LOCKER)).toEqual([true, true, false]);
  });

  it('writes exactly production’s one trade row, every field equal, and none for the locker’s swaps', async () => {
    const { rows, play } = await setup(f);
    await play();
    expect(rows('trade')).toEqual(productionTrades(f));
    expect(rows('swapSync')).toEqual([{ id: f.txHash, through: 48, blockNumber: BigInt(f.blockNumber) }]);
  });

  it('reads the receipt once for the transaction’s seven sync points', async () => {
    const { client, play } = await setup(f);
    await play();
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(ownClient.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('applies each swap at the first sync point after it, and the last one after the collection', async () => {
    const { deliver, token, rows } = await setup(f);
    const at = async (logIndex: number) => {
      for (const l of f.logs.filter((x) => x.logIndex <= logIndex)) await deliver(l);
      return (await token('BOOTR')).sqrtPriceX96;
    };
    // Up to the transfer at 11 nothing is applied: every swap is still ahead and later sync points exist.
    expect(await at(11)).toBe(0n);
    // (a fresh store each time would hide a double application, so the same one is played on)
    expect(await at(24)).toBe(swaps[0]!.sqrtPriceX96);
    expect(await at(37)).toBe(swaps[1]!.sqrtPriceX96);
    expect(rows('trade')).toHaveLength(0);
    expect(await at(47)).toBe(swaps[2]!.sqrtPriceX96);
    expect(rows('trade')).toHaveLength(1);
  });

  it('values the collection’s burn share at the price before the seller’s swap, as the old handler order did', async () => {
    const { rows, play } = await setup(f);
    await play();
    const coin = coinBySymbol('BOOTR');
    const burn = rows('feeAccrual').find((r) => r.recipientKind === 'burn' && r.asset === coin.id)!;
    expect(burn.id).toBe(`${f.txHash}-47-2-1`);
    const ethUsd = ethUsdOf(f);
    const before = swapFigures(swapCoin(coin), swaps[1]!, ethUsd).market.priceUsd;
    const after = swapFigures(swapCoin(coin), swaps[2]!, ethUsd).market.priceUsd;
    expect(before).not.toBe(after);
    expect(burn.amountUsd).toBe(usd(toUnits(burn.amount as bigint, 18) * before));
  });

  it('books the fee of all three swaps and moves the price to the last one', async () => {
    const { play, token } = await setup(f);
    await play();
    const t = await token('BOOTR');
    expect(t.sqrtPriceX96).toBe(swaps[2]!.sqrtPriceX96);
    expect(t.trades24h).toBe(1);
    const ethUsd = ethUsdOf(f);
    const fees = swaps.reduce((sum, s) => sum + swapFigures(swapCoin(coinBySymbol('BOOTR')), s, ethUsd).feeUsd, 0);
    expect(t.feesTotalUsd).toBeCloseTo(fees, 5);
  });

  it('applies nothing twice when the coin transfers are delivered again', async () => {
    const { rows, play, deliver, token } = await setup(f);
    await play();
    const fees = (await token('BOOTR')).feesTotalUsd;
    const price = (await token('BOOTR')).sqrtPriceX96;
    for (const l of f.logs.filter((x) => x.address.toLowerCase() === coinBySymbol('BOOTR').id && x.topics[0] === TRANSFER)) await deliver(l);
    expect(rows('trade')).toHaveLength(1);
    expect((await token('BOOTR')).feesTotalUsd).toBe(fees);
    expect((await token('BOOTR')).sqrtPriceX96).toBe(price);
  });
});

describe('an $OWL sell routed on through a pool that is not Bootr’s (tx 0xaa5be14f…b565)', () => {
  const f = owlOtherPool as Fixture;

  it('keeps the $OWL swap and ignores the other pool’s', async () => {
    const all = poolManagerSwaps(f.logs as ReceiptLog[], POOL_MANAGER);
    expect(all.map((s) => s.logIndex)).toEqual([48, 54]);
    expect(coinByPool.has(all[0]!.poolId)).toBe(true);
    expect(coinByPool.has(all[1]!.poolId)).toBe(false);
    const { rows, play } = await setup(f);
    await play();
    expect(rows('trade')).toEqual(productionTrades(f));
    expect(rows('swapSync')).toEqual([{ id: f.txHash, through: 48, blockNumber: BigInt(f.blockNumber) }]);
  });
});

describe('a $BCAT sell and a $BRIANBRAIN buy in one transaction (tx 0x0166bbf3…2e63)', () => {
  const f = bcatBrianbrain as Fixture;

  it('writes production’s two trade rows and none for the locker’s three conversion swaps', async () => {
    const swaps = poolManagerSwaps(f.logs as ReceiptLog[], POOL_MANAGER);
    expect(swaps.map((s) => [coinByPool.get(s.poolId)!.symbol, s.logIndex, s.sender.toLowerCase() === LOCKER])).toEqual([
      ['BCAT', 14, true],
      ['BCAT', 27, false],
      ['BRIANBRAIN', 48, true],
      ['BRIANBRAIN', 61, true],
      ['BRIANBRAIN', 75, false],
    ]);
    const { rows, play, token } = await setup(f);
    await play();
    expect(byLogIndex(rows('trade'))).toEqual(productionTrades(f));
    expect(rows('swapSync')).toEqual([{ id: f.txHash, through: 75, blockNumber: BigInt(f.blockNumber) }]);
    expect((await token('BCAT')).sqrtPriceX96).toBe(swaps[1]!.sqrtPriceX96);
    expect((await token('BRIANBRAIN')).sqrtPriceX96).toBe(swaps[4]!.sqrtPriceX96);
  });
});

describe('a Clanker v5 sell whose coin transfer comes after the swap and its credits (tx 0x19f40935…5a45)', () => {
  // Logs: Swap 17 · the hook's credits 19–27 · Transfer in 28.
  const f = cbbLateTransfer as Fixture;

  it('applies the swap at the first credit, not at the transfer nine logs later', async () => {
    const { deliver, token, rows } = await setup(f);
    const swap = poolManagerSwaps(f.logs as ReceiptLog[], POOL_MANAGER)[0]!;
    const firstCredit = f.logs.find((l) => l.address.toLowerCase() === V5_HOOK && handlers.has(`ClankerV5Hook:${(decodeEventLog({ abi: ClankerV5HookAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]], strict: false }) as { eventName: string }).eventName}`))!;
    expect(firstCredit.logIndex).toBeGreaterThan(swap.logIndex);
    expect(firstCredit.logIndex).toBeLessThan(28);
    await deliver(firstCredit);
    expect((await token('CBB')).sqrtPriceX96).toBe(swap.sqrtPriceX96);
    expect(rows('trade')).toHaveLength(1);
  });

  it('writes production’s trade row', async () => {
    const { rows, play } = await setup(f);
    await play();
    expect(rows('trade')).toEqual(productionTrades(f));
  });
});

describe('a receipt Ponder stored before a reorg moved the transaction', () => {
  const f = owlOtherPool as Fixture;

  it('is read again from the indexer’s own client', async () => {
    ownClient.getTransactionReceipt.mockResolvedValue({ blockHash: f.blockHash, from: f.from, logs: f.logs });
    const { rows, play, client } = await setup(f, { blockHash: `0x${'ab'.repeat(32)}`, logs: [] });
    await play();
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(ownClient.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(rows('trade')).toEqual(productionTrades(f));
  });

  it('stops the handler when the chain has the transaction in another block too', async () => {
    ownClient.getTransactionReceipt.mockResolvedValue({ blockHash: `0x${'cd'.repeat(32)}`, from: f.from, logs: f.logs });
    const { play } = await setup(f, { blockHash: `0x${'ab'.repeat(32)}` });
    await expect(play()).rejects.toThrow(/receipt of 0xaa5be14f/);
  });
});
