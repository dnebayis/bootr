import type { NextRequest } from 'next/server';
import { agentCardUrl, buildRegistration, isLaunchId, pendingRegistration, type CardToken } from '@/lib/agent-card';
import { env } from '@/lib/env';
import { mockStore } from '@/lib/mock';

/**
 * GET /agents/<launchId>.json: the ERC-8004 registration file a Bootr agent was registered with.
 *
 * - known launch           -> 200, full document incl. the IdentityRegistry binding
 * - valid id, not indexed  -> 200, minimal document with `registrations: []` (right after launch)
 * - malformed id           -> 404
 * - indexer unreachable    -> 503, never cached
 */

const CARD_FIELDS = 'id chainId name symbol image kernel agentId xHandle';

function json(body: unknown, status: number, cache: string) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' },
  });
}

/** If two launches ever claim the same URI, the earliest one owns the card. */
async function findByAgentUri(uri: string): Promise<CardToken | null> {
  if (env.useMock) {
    return mockStore().tokens.find((t) => t.agentUri === uri) ?? null;
  }
  const res = await fetch(`${env.indexerUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query AgentCard($where: tokenFilter) { tokens(where: $where, orderBy: "launchedAt", orderDirection: "asc", limit: 1) { items { ${CARD_FIELDS} } } }`,
      variables: { where: { agentUri: uri } },
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Indexer responded ${res.status}`);
  const body = (await res.json()) as { data?: { tokens: { items: CardToken[] } }; errors?: { message: string }[] };
  if (body.errors?.length || !body.data) throw new Error(body.errors?.map((e) => e.message).join('; ') || 'Empty indexer response');
  return body.data.tokens.items[0] ?? null;
}

export async function GET(_req: NextRequest, ctx: RouteContext<'/agents/[id]'>) {
  const { id: raw } = await ctx.params;
  const id = raw.endsWith('.json') ? raw.slice(0, -5) : raw;
  if (!isLaunchId(id)) return json({ error: 'Unknown agent' }, 404, 'public, max-age=300');

  let token: CardToken | null;
  try {
    token = await findByAgentUri(agentCardUrl(id));
  } catch {
    return json({ error: 'Agent registry is temporarily unavailable' }, 503, 'no-store');
  }
  if (!token) return json(pendingRegistration(), 200, 'public, max-age=10, s-maxage=10');
  return json(buildRegistration(token), 200, 'public, max-age=60, s-maxage=60');
}
