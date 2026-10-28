import type { NextRequest } from 'next/server';
import { isLaunchId, type CardToken } from '@/lib/agent-card';
import { buildContractMetadata } from '@/lib/contract-metadata';
import { readLaunchDraft } from '@/lib/server/launch-drafts';
import { findTokenByLaunchId } from '@/lib/server/token-lookup';

/**
 * GET /tokens/<launchId>.json: the ERC-7572 contract metadata of a Bootr coin. BootrLauncher sets this URL as
 * the B20 token's `contractURI` (the launch form passes it as `LaunchParams.metadata`).
 *
 * Built from the launch draft (name, symbol, image, X handle and the first line of the Identity text, saved by
 * `POST /api/launch/draft`), with the indexed token's on-chain name, symbol and image taking precedence once it
 * is indexed. `external_link` is the token page; until the launch is indexed the address is unknown and it
 * points at the site.
 *
 * - draft or indexed token -> 200
 * - neither                -> 404
 * - indexer unreachable    -> the draft alone, never cached
 */

function json(body: unknown, status: number, cache: string) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' },
  });
}

export async function GET(_req: NextRequest, ctx: RouteContext<'/tokens/[id]'>) {
  const { id: raw } = await ctx.params;
  const id = raw.endsWith('.json') ? raw.slice(0, -5) : raw;
  if (!isLaunchId(id)) return json({ error: 'Unknown coin' }, 404, 'public, max-age=300');

  const draft = await readLaunchDraft(id);
  let token: CardToken | null = null;
  let indexerDown = false;
  try {
    token = await findTokenByLaunchId(id);
  } catch {
    indexerDown = true;
  }
  if (!token && !draft?.coin) {
    return indexerDown ? json({ error: 'Coin registry is temporarily unavailable' }, 503, 'no-store') : json({ error: 'Unknown coin' }, 404, 'public, max-age=10');
  }
  const body = buildContractMetadata({ identity: draft?.identity ?? null, coin: draft?.coin ?? null }, token);
  const cache = indexerDown ? 'no-store' : token ? 'public, max-age=300, s-maxage=300' : 'public, max-age=10, s-maxage=10';
  return json(body, 200, cache);
}
