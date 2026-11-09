import { NextResponse, type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { fetchTokenCreator } from '@/lib/server/sender';
import { getAgentBounties, SupervisorError, SupervisorUnavailable } from '@/lib/server/supervisor';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string, message: string) {
  return NextResponse.json({ error, message }, { status, headers: NO_STORE });
}

/**
 * GET /api/agent/:kernel/bounties -> {jobs: BountyJob[]} (jobs in motion first, then newest first)
 * Public read of the jobs the agent posted with the Bounties power: task, criteria, amount, window, status, entry
 * counts, the verdict and the payment (lib/types BountyJob). Proxied to the agent service and re-shaped on the way, so
 * no author, reply text or non-winner address ever reaches the page. Same conventions as `/activity`: no store, no
 * limiter beyond the platform's. An unknown agent answers an empty list.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/bounties'>) {
  const { kernel } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', 'kernel must be an address');
  if (env.useMock) return NextResponse.json(mock.agentBounties(kernel), { headers: NO_STORE });
  try {
    const token = await fetchTokenCreator(kernel);
    if (!token) return fail(404, 'unknown_coin', 'No indexed coin has that treasury.');
    return NextResponse.json(await getAgentBounties(token.agentId), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof SupervisorError) return fail(err.status, err.code, err.message);
    if (err instanceof SupervisorUnavailable) return fail(503, 'supervisor_unavailable', 'The agent service is unavailable right now.');
    console.warn('agent bounties: failed', (err as Error).message);
    return fail(502, 'upstream_failed', 'Could not reach the indexer.');
  }
}
