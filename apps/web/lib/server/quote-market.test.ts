import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { fetchQuoteMarket, marketDetailsFrom, parseQuoteMarket, QUOTE_MARKET_CACHE_MS, QUOTE_MARKET_URL, readStartTick, resetQuoteMarketCache } from './quote-market';
import { pairedAssetBySymbol } from '@/lib/token-settings';

const ETH = pairedAssetBySymbol('ETH')!;
const USDC = pairedAssetBySymbol('USDC')!;

/** The shape clanker.world answered on 2026-11-10 (two of its 337 rows, plus junk the parser must skip). */
const BODY = {
  prices: [
    { quote: '0x0000000000000000000000000000000000000000', priceUsd: 2092.03107574, sourceAt: 1794310079000, receivedAt: 1794310079710 },
    { quote: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', priceUsd: 0.99976144797, liquidityUsd: 74914261 },
    { quote: 'not an address', priceUsd: 1 },
    { quote: '0x0000000000000000000000000000000000000001', priceUsd: -1 },
  ],
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed like fetch so the calls can be read back
const ok = (body: unknown) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

afterEach(() => resetQuoteMarketCache());

describe('clanker.world quote market', () => {
  it('parses the rows it can use', () => {
    const rows = parseQuoteMarket(BODY)!;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ quote: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', priceUsd: 0.99976144797, liquidityUsd: 74914261 });
    expect(rows[0]!.liquidityUsd).toBeNull();
    expect(parseQuoteMarket({ nope: [] })).toBeNull();
  });

  it('calls the endpoint once a minute and serves the cache in between', async () => {
    const fetchImpl = ok(BODY);
    await fetchQuoteMarket({ fetchImpl, now: 1_000 });
    await fetchQuoteMarket({ fetchImpl, now: 1_000 + QUOTE_MARKET_CACHE_MS - 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(QUOTE_MARKET_URL);
    await fetchQuoteMarket({ fetchImpl, now: 1_000 + QUOTE_MARKET_CACHE_MS + 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a failing API gives null (Bootr’s own figures), not an error', async () => {
    expect(await fetchQuoteMarket({ fetchImpl: vi.fn(async () => new Response('busy', { status: 503 })), now: 1 })).toBeNull();
    resetQuoteMarketCache();
    expect(await fetchQuoteMarket({ fetchImpl: vi.fn(async () => Promise.reject(new Error('timeout'))), now: 1 })).toBeNull();
    resetQuoteMarketCache();
    expect(await fetchQuoteMarket({ fetchImpl: ok({ html: true }), now: 1 })).toBeNull();
  });

  it('market details: API figures when it answers, Bootr’s arithmetic when not', () => {
    const rows = parseQuoteMarket(BODY);
    const usdc = marketDetailsFrom(USDC, rows, { tick: -400_600, source: 'chain' }, 0);
    expect(usdc).toMatchObject({ asset: 'USDC', source: 'clanker.world', priceUsd: 0.99976144797, liquidityUsd: 74914261, startTickSource: 'chain' });
    expect(usdc.openingCap).toBeGreaterThan(3_900);
    const eth = marketDetailsFrom(ETH, rows, { tick: -201_000, source: 'fallback' }, 0);
    expect(eth.openingCapUsd).toBeCloseTo(eth.openingCap * 2092.03107574, 6);

    const ethDown = marketDetailsFrom(ETH, null, { tick: -201_000, source: 'fallback' }, 0);
    expect(ethDown).toMatchObject({ source: 'bootr', priceUsd: null, liquidityUsd: null, openingCapUsd: null });
    const usdcDown = marketDetailsFrom(USDC, null, { tick: -400_600, source: 'fallback' }, 0);
    expect(usdcDown).toMatchObject({ source: 'bootr', priceUsd: 1 });
  });

  it('reads the start tick from the factory, and falls back when it is not registered or not readable', async () => {
    const factory = '0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0' as Address;
    const live = { readContract: vi.fn(async () => [true, 6, -400_000] as const) };
    expect(await readStartTick(USDC, live, factory)).toEqual({ tick: -400_000, source: 'chain' });
    const unregistered = { readContract: vi.fn(async () => [false, 0, 0] as const) };
    expect(await readStartTick(USDC, unregistered, factory)).toEqual({ tick: USDC.fallbackStartTick, source: 'fallback' });
    const broken = { readContract: vi.fn(async () => Promise.reject(new Error('rpc'))) };
    expect(await readStartTick(ETH, broken, factory)).toEqual({ tick: ETH.fallbackStartTick, source: 'fallback' });
    expect(await readStartTick(ETH, null, null)).toEqual({ tick: ETH.fallbackStartTick, source: 'fallback' });
  });
});
