import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

// The handlers' helpers read and write through `context.db`; the tables are only keys here, an in-memory store
// stands in for Ponder's (find / insert … onConflict / update … set, by `id`).
vi.mock('ponder:schema', () => {
  const names = ['balance', 'dailyStat', 'milestone', 'platformConfig', 'platformStats', 'priceFeed', 'sourceStats', 'token', 'tokenWindow', 'trade'];
  return Object.fromEntries(names.map((name) => [name, { name }]));
});
vi.mock('ponder', () => ({ and: () => null, eq: () => null }));

type Row = Record<string, unknown> & { id: string };
type Table = { name: string };

function fakeDb() {
  const tables = new Map<string, Map<string, Row>>();
  const rows = (t: Table) => {
    let m = tables.get(t.name);
    if (!m) tables.set(t.name, (m = new Map()));
    return m;
  };
  const put = (t: Table, v: Row) => {
    const row = { ...v };
    rows(t).set(v.id, row);
    return row;
  };
  const db = {
    find: async (t: Table, k: { id: string }) => rows(t).get(k.id) ?? null,
    insert: (t: Table) => ({
      values: (v: Row) => ({
        then: (ok: (r: Row) => void, fail: (e: unknown) => void) =>
          rows(t).has(v.id) ? fail(new Error(`duplicate ${t.name} ${v.id}`)) : ok(put(t, v)),
        onConflictDoNothing: async () => (rows(t).has(v.id) ? null : put(t, v)),
        onConflictDoUpdate: async (u: Partial<Row> | ((r: Row) => Partial<Row>)) => {
          const prev = rows(t).get(v.id);
          if (!prev) return put(t, v);
          return put(t, { ...prev, ...(typeof u === 'function' ? u(prev) : u) });
        },
      }),
    }),
    update: (t: Table, k: { id: string }) => ({
      set: async (u: Partial<Row> | ((r: Row) => Partial<Row>)) => {
        const prev = rows(t).get(k.id);
        if (!prev) throw new Error(`no ${t.name} ${k.id}`);
        return put(t, { ...prev, ...(typeof u === 'function' ? u(prev) : u) });
      },
    }),
  };
  return { db, rows: (name: string) => [...(tables.get(name)?.values() ?? [])] };
}

// $BOOTR (Clanker v4, WETH is currency0) and tx 0x454d41e8…68110 at block 60453045: one $96.69 buy through a router
// (logIndex 104) after the two swaps of the fee conversion locker the hook ran before it (77, 90). Values as on chain.
const BOOTR = '0xb1c3a6ac90e324c4072ad4b2a71c5d9382f9565c' as Hex;
const LOCKER = '0xffA37784D619F228D8B379d287a4D7282e500762' as Address;
const ROUTER = '0x8f10b468b06c6fd214b65f87778827f7d113f996' as Address;
const TX = '0x454d41e87b18b365126858e1bde543ec495cf86937623a356bf1a4abf9f68110' as Hex;
const FROM = '0xbdbebd58cc8153ce74530bb342427579315915b2' as Address;
const BLOCK = 60_453_045n;
const TS = 1_795_280_984;
const ETH_USD = 1682.81;
const LIQ = 997_519_511_065_749_950_282_714n;
const SWAPS = [
  { logIndex: 77, sender: LOCKER, amount0: -44_334_836_758n, amount1: 215_967_159_824_954_142_019n, sqrtPriceX96: 5_585_831_706_224_275_761_316_223_279_604_068n, tick: 223_279 },
  { logIndex: 90, sender: LOCKER, amount0: 45_986_159_369_681n, amount1: -233_248_576_596_707_188_927_878n, sqrtPriceX96: 5_585_849_861_517_289_347_840_391_719_642_137n, tick: 223_279 },
  { logIndex: 104, sender: ROUTER, amount0: -57_459_957_993_476_264n, amount1: 278_795_449_721_214_914_469_184_652n, sqrtPriceX96: 5_563_706_483_915_431_190_923_657_542_155_942n, tick: 223_200 },
] as const;

function bootrRow(over: Record<string, unknown> = {}) {
  return {
    id: BOOTR,
    kernel: '0xf44f324cfd3a4dc910d34951a854f485b3dbe664',
    source: 'clanker',
    launchTx: '0x253a001c203da169a3e38b527556bcda8143445fc8944496fe6a8aab5d677367',
    coinIsToken0: false,
    pairedSymbol: 'WETH',
    pairedDecimals: 18,
    totalSupply: 10n ** 29n,
    sqrtPriceX96: 0n,
    tick: 0,
    poolLiquidity: LIQ,
    positionLiquidity: 997_519_511_067_017_711_976_448n,
    tickLower: 120_000,
    tickUpper: 230_400,
    lpFeeBps: 20_000,
    buyTaxBps: null,
    sellTaxBps: null,
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
    lastTradeAt: 1_795_270_000,
    holders: 0,
    graduated: true,
    graduatedAt: 1_793_797_743,
    ...over,
  };
}

let market: typeof import('./market');

beforeAll(async () => {
  vi.stubEnv('CHAIN_ID', '8453');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  market = await import('./market');
});

async function replay(swaps: readonly (typeof SWAPS)[number][]) {
  const { db, rows } = fakeDb();
  const context = { db } as unknown as Parameters<typeof market.applySwap>[0];
  // A fresh ETH/USD row at this block: no Chainlink read.
  await db.insert({ name: 'priceFeed' }).values({ id: 'ETH/USD', priceUsd: ETH_USD, oracleUpdatedAt: TS, blockNumber: BLOCK });
  await db.insert({ name: 'token' }).values(bootrRow());
  for (const s of swaps) {
    const t = (await db.find({ name: 'token' }, { id: BOOTR })) as unknown as Parameters<typeof market.applySwap>[1];
    await market.applySwap(
      context,
      t,
      { amount0: s.amount0, amount1: s.amount1, sqrtPriceX96: s.sqrtPriceX96, liquidity: LIQ, tick: s.tick, fee: 20_000, sender: s.sender },
      { txHash: TX, logIndex: s.logIndex, blockNumber: BLOCK, timestamp: TS, from: FROM },
    );
  }
  const token = (await db.find({ name: 'token' }, { id: BOOTR }))!;
  return { token, rows };
}

describe('Clanker fee conversion swaps', () => {
  it('knows the locker by its address, in any case, and nothing when the chain has no Clanker stack', () => {
    expect(market.isFeeConversionSwap(LOCKER.toLowerCase(), LOCKER)).toBe(true);
    expect(market.isFeeConversionSwap(ROUTER, LOCKER)).toBe(false);
    expect(market.isFeeConversionSwap(LOCKER, null)).toBe(false);
  });

  it('books the one $BOOTR purchase of tx 0x454d…0110 as one trade, the locker’s two swaps as none', async () => {
    const { token, rows } = await replay(SWAPS);
    const trades = rows('trade');
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ id: `${TX}-104`, side: 'buy', sender: ROUTER, trader: FROM });
    expect(trades[0]!.valueUsd).toBeCloseTo(96.69, 2);
    expect(token.trades24h).toBe(1);
    expect(token.volume24hUsd).toBeCloseTo(96.69, 2);
    expect(token.volumeTotalUsd).toBeCloseTo(96.69, 2);
    expect(token.lastTradeAt).toBe(TS);
    const [daily] = rows('dailyStat');
    expect(daily).toMatchObject({ trades: 1 });
    expect(daily!.volumeUsd).toBeCloseTo(96.69, 2);
    expect(rows('platformStats')[0]!.volumeTotalUsd).toBeCloseTo(96.69, 2);
    expect(rows('sourceStats')[0]!.volumeTotalUsd).toBeCloseTo(96.69, 2);
  });

  it('keeps the price with the pool after a locker swap that no trade follows', async () => {
    const { token, rows } = await replay(SWAPS.slice(0, 2));
    expect(rows('trade')).toHaveLength(0);
    expect(token.sqrtPriceX96).toBe(SWAPS[1].sqrtPriceX96);
    expect(token.tick).toBe(SWAPS[1].tick);
    // About $3.385e-7 per coin at tick 223279, the price the indexer stored on the locker's own rows before.
    expect(token.priceUsd).toBeCloseTo(3.3854e-7, 10);
    expect(token.marketCapUsd).toBeCloseTo(33_854, -1);
    expect(token.trades24h).toBe(0);
    expect(token.volume24hUsd).toBe(0);
    expect(token.volumeTotalUsd).toBe(0);
    expect(token.lastTradeAt).toBe(1_795_270_000);
    expect(rows('milestone')).toHaveLength(0);
    expect(rows('dailyStat')[0] ?? { trades: 0, volumeUsd: 0 }).toMatchObject({ trades: 0, volumeUsd: 0 });
    // The hour's price follows the pool, its volume and count do not move.
    const [bucket] = rows('tokenWindow')[0]!.buckets as { v: number; n: number; p: number; f: number }[];
    expect(bucket).toMatchObject({ v: 0, n: 0 });
    expect(bucket!.p).toBe(token.priceUsd);
  });

  it('ends on the buy’s price, and books every swap’s fee once (the locker’s too: it pays the pool fee)', async () => {
    const { token, rows } = await replay(SWAPS);
    expect(token.sqrtPriceX96).toBe(SWAPS[2].sqrtPriceX96);
    expect(token.priceUsd).toBeCloseTo(3.4124e-7, 10);
    // 96.694 × 2.4% = 2.3207 on the buy; 0.0774 × 2.4% = 0.0019 and ~0 on the conversion.
    const fees = 2.320657 + 0.001857 + 0.000002;
    expect(token.feesTotalUsd).toBeCloseTo(fees, 5);
    expect(token.fees24hUsd).toBeCloseTo(fees, 5);
    expect(rows('dailyStat')[0]!.feesUsd).toBeCloseTo(fees, 5);
    expect(rows('platformStats')[0]!.feesTotalUsd).toBeCloseTo(fees, 5);
    expect(rows('sourceStats')[0]!.feesTotalUsd).toBeCloseTo(fees, 5);
    expect(rows('trade')[0]!.feeUsd).toBeCloseTo(2.320657, 5);
  });
});
