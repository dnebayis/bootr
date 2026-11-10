/**
 * "Market details" for a paired asset on the launch form (docs/design/clanker-v5-token-settings.md, the owner's answer
 * 9): the asset's price and liquidity from clanker.world's quote-market API, the API Clanker's own deploy form reads, and
 * the opening market cap from Clanker's start tick for that asset (`factory.quoteConfig(asset)`).
 *
 * The endpoint (read 2026-11-10): `GET https://www.clanker.world/api/tax/quote-market?chainId=8453` answers
 * `{prices: [{quote, priceUsd, liquidityUsd?, totalSupply?, sourceAt?, receivedAt?}]}`, one row per quote Clanker v5
 * accepts (337 on Base that day: native ETH as `0x0…0`, USDC and the other ERC-20s, the B20 real-world assets). ETH's row
 * carries no liquidity; USDC's does.
 *
 * Called from this server only, never from the browser, with a timeout and a short cache. When the API does not answer
 * (or has no row for the asset), the figures come from Bootr's own arithmetic: the start tick from the chain (or the
 * value read on 2026-11-10), a stablecoin at $1, and no dollar figure for ETH. `source` says which.
 */
import { getAddress, isAddress, type Address } from 'viem';
import { clankerV5FactoryAbi } from '@/lib/clanker-v5';
import { openingCapInAsset, type PairedAsset } from '@/lib/token-settings';

if (typeof window !== 'undefined') throw new Error('lib/server/quote-market must not be imported in the browser');

export const QUOTE_MARKET_URL = 'https://www.clanker.world/api/tax/quote-market?chainId=8453';
/** The API is one Vercel function; past this the form shows Bootr's own figures instead of waiting. */
export const QUOTE_MARKET_TIMEOUT_MS = 3_500;
/** Prices move; a minute is what Clanker's own form tolerates between refreshes. */
export const QUOTE_MARKET_CACHE_MS = 60_000;
/** A failed call is not retried for this long, so a dead API costs one timeout per half minute, not one per visitor. */
const FAILURE_CACHE_MS = 30_000;

export type QuoteMarketRow = { quote: Address; priceUsd: number; liquidityUsd: number | null };

/** The upstream body into rows; rows without a usable address or price are skipped, a body without `prices` is null. */
export function parseQuoteMarket(body: unknown): QuoteMarketRow[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { prices?: unknown }).prices)) return null;
  const rows: QuoteMarketRow[] = [];
  for (const p of (body as { prices: unknown[] }).prices) {
    if (!p || typeof p !== 'object') continue;
    const { quote, priceUsd, liquidityUsd } = p as Record<string, unknown>;
    if (typeof quote !== 'string' || !isAddress(quote, { strict: false })) continue;
    if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    rows.push({ quote: getAddress(quote), priceUsd, liquidityUsd: typeof liquidityUsd === 'number' && Number.isFinite(liquidityUsd) && liquidityUsd >= 0 ? liquidityUsd : null });
  }
  return rows;
}

type Cached = { at: number; rows: QuoteMarketRow[] | null };
let cache: Cached | null = null;
let inflight: Promise<QuoteMarketRow[] | null> | null = null;

/** Test hook: forget the cache. */
export function resetQuoteMarketCache() {
  cache = null;
  inflight = null;
}

/** The API's rows, from the cache when fresh; null when the API failed (and stays null for the failure window). */
export async function fetchQuoteMarket(opts: { fetchImpl?: typeof fetch; now?: number; url?: string } = {}): Promise<QuoteMarketRow[] | null> {
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < (cache.rows ? QUOTE_MARKET_CACHE_MS : FAILURE_CACHE_MS)) return cache.rows;
  if (inflight) return inflight;
  const doFetch = opts.fetchImpl ?? fetch;
  inflight = (async () => {
    let rows: QuoteMarketRow[] | null = null;
    try {
      const res = await doFetch(opts.url ?? QUOTE_MARKET_URL, { signal: AbortSignal.timeout(QUOTE_MARKET_TIMEOUT_MS), headers: { accept: 'application/json' }, cache: 'no-store' });
      if (res.ok) rows = parseQuoteMarket(await res.json());
    } catch {
      rows = null;
    }
    cache = { at: now, rows };
    inflight = null;
    return rows;
  })();
  return inflight;
}

export type MarketDetails = {
  asset: string;
  quote: Address;
  decimals: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** Clanker's opening tick for this asset and where it came from. */
  startTick: number;
  startTickSource: 'chain' | 'fallback';
  /** The opening market cap in the asset itself, and in dollars when a price is known. */
  openingCap: number;
  openingCapUsd: number | null;
  /** Where the price and liquidity come from: clanker.world's API, or Bootr's own arithmetic when it did not answer. */
  source: 'clanker.world' | 'bootr';
  readAt: number;
};

type ChainReader = { readContract: (args: { address: Address; abi: typeof clankerV5FactoryAbi; functionName: 'quoteConfig'; args: [Address] }) => Promise<readonly [boolean, number, number]> };

/** Clanker's start tick for the asset from the factory; the value of 2026-11-10 when the chain cannot be read. */
export async function readStartTick(asset: PairedAsset, client: ChainReader | null, factory: Address | null): Promise<{ tick: number; source: 'chain' | 'fallback' }> {
  if (client && factory) {
    try {
      const [registered, , tick] = await Promise.race([
        client.readContract({ address: factory, abi: clankerV5FactoryAbi, functionName: 'quoteConfig', args: [asset.address] }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), QUOTE_MARKET_TIMEOUT_MS)),
      ]);
      if (registered) return { tick: Number(tick), source: 'chain' };
    } catch {
      /* the fallback below */
    }
  }
  return { tick: asset.fallbackStartTick, source: 'fallback' };
}

/** The market details of one asset, from the API's rows (null: the API failed) and the start tick. */
export function marketDetailsFrom(asset: PairedAsset, rows: QuoteMarketRow[] | null, start: { tick: number; source: 'chain' | 'fallback' }, now = Date.now()): MarketDetails {
  const row = rows?.find((r) => r.quote.toLowerCase() === asset.address.toLowerCase()) ?? null;
  const priceUsd = row ? row.priceUsd : (asset.stableUsd ?? null);
  const openingCap = openingCapInAsset(start.tick, asset.decimals);
  return {
    asset: asset.symbol,
    quote: asset.address,
    decimals: asset.decimals,
    priceUsd,
    liquidityUsd: row?.liquidityUsd ?? null,
    startTick: start.tick,
    startTickSource: start.source,
    openingCap,
    openingCapUsd: priceUsd !== null ? openingCap * priceUsd : null,
    source: row ? 'clanker.world' : 'bootr',
    readAt: Math.floor(now / 1000),
  };
}
