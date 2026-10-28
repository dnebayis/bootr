import type { NextRequest } from 'next/server';
import { buildRegistration, isLaunchId, pendingRegistration, type CardToken } from '@/lib/agent-card';
import { readDraftIdentity } from '@/lib/server/launch-drafts';
import { findTokenByLaunchId } from '@/lib/server/token-lookup';

/**
 * GET /agents/<launchId>.json: the ERC-8004 registration file a Bootr agent was registered with.
 *
 * - known launch           -> 200, full document incl. the IdentityRegistry binding
 * - valid id, not indexed  -> 200, minimal document with `registrations: []` (right after launch)
 * Both carry the creator's Identity text as `bootr.identity` when the launch form saved one
 * (`POST /api/launch/draft`); the supervisor reads it from here.
 * - malformed id           -> 404
 * - indexer unreachable    -> 503, never cached
 */

function json(body: unknown, status: number, cache: string) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' },
  });
}

export async function GET(_req: NextRequest, ctx: RouteContext<'/agents/[id]'>) {
  const { id: raw } = await ctx.params;
  const id = raw.endsWith('.json') ? raw.slice(0, -5) : raw;
  if (!isLaunchId(id)) return json({ error: 'Unknown agent' }, 404, 'public, max-age=300');

  let token: CardToken | null;
  try {
    token = await findTokenByLaunchId(id);
  } catch {
    return json({ error: 'Agent registry is temporarily unavailable' }, 503, 'no-store');
  }
  const identity = await readDraftIdentity(id);
  if (!token) return json(pendingRegistration(identity), 200, 'public, max-age=10, s-maxage=10');
  return json(buildRegistration(token, identity), 200, 'public, max-age=60, s-maxage=60');
}
