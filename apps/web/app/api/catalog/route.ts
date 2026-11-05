import { connection, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { buildCatalog } from '@/lib/server/catalog';
import { currentModels } from '@/lib/server/relay-models';

/**
 * GET /api/catalog -> Catalog (lib/server/catalog.ts)
 * What Bootr offers, for programs: the public endpoints, what an agent can do and the model prices. Public and
 * cacheable, any origin may read it. Prices are live (`/api/models`), hence `connection()`: not prerendered at build.
 */
export async function GET() {
  await connection();
  const body = buildCatalog({ siteUrl: env.siteUrl, indexerUrl: env.indexerUrl, chainId: env.chainId, models: await currentModels() });
  return NextResponse.json(body, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60', 'Access-Control-Allow-Origin': '*' } });
}
