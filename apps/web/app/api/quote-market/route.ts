import { connection, NextResponse, type NextRequest } from 'next/server';
import type { Address } from 'viem';
import { env } from '@/lib/env';
import { contracts } from '@/lib/contracts';
import { serverPublicClient } from '@/lib/server/chain';
import { fetchQuoteMarket, marketDetailsFrom, readStartTick } from '@/lib/server/quote-market';
import { pairedAssetBySymbol, pairedAssetsFor } from '@/lib/token-settings';

/**
 * GET /api/quote-market?asset=ETH|USDC -> MarketDetails (lib/server/quote-market.ts)
 * The launch form's "Market details" for a paired asset: price and liquidity from clanker.world's quote-market API
 * (fetched here, cached a minute, never from the browser), the opening market cap from Clanker's start tick for the
 * asset; Bootr's own figures when the API does not answer, with `source` saying which. Only the assets the form offers.
 */
export async function GET(req: NextRequest) {
  await connection();
  const asset = pairedAssetBySymbol(req.nextUrl.searchParams.get('asset') ?? 'ETH');
  if (!asset) {
    const offered = [...new Set([...pairedAssetsFor('agent'), ...pairedAssetsFor('plain')].map((a) => a.symbol))];
    return NextResponse.json({ error: 'invalid_request', message: `asset must be one of ${offered.join(', ')}.` }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const factory = (contracts.clankerV5?.factory ?? null) as Address | null;
  // Clanker v5 lives on Base mainnet; mock mode and Base Sepolia use the start ticks read on 2026-11-10.
  const client = !env.useMock && env.chainId === 8453 ? serverPublicClient(8453) : null;
  const [rows, start] = await Promise.all([fetchQuoteMarket(), readStartTick(asset, client, factory)]);
  return NextResponse.json(marketDetailsFrom(asset, rows, start), { headers: { 'Cache-Control': 'public, max-age=30' } });
}
