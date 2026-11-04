import { NextResponse, type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { fetchTokenCreator } from '@/lib/server/sender';
import { getAgentFuel, SupervisorError, SupervisorUnavailable } from '@/lib/server/supervisor';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string, message: string) {
  return NextResponse.json({ error, message }, { status, headers: NO_STORE });
}

/**
 * GET /api/agent/:kernel/fuel?days=7 -> AgentFuel (lib/types)
 * Public read of the agent's paid thoughts per model over the last `days` (1..90, default 7), proxied to the
 * supervisor. With economy mode on this shows the split between the deciding model and the writer. An unknown
 * agent answers an empty list.
 */
export async function GET(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/fuel'>) {
  const { kernel } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', 'kernel must be an address');
  const raw = req.nextUrl.searchParams.get('days');
  const days = raw === null ? 7 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 90) return fail(400, 'invalid_request', 'days must be an integer of 1..90');

  if (env.useMock) return NextResponse.json(mock.agentFuel(kernel, days), { headers: NO_STORE });
  try {
    const token = await fetchTokenCreator(kernel);
    if (!token) return fail(404, 'unknown_coin', 'No indexed coin has that treasury.');
    return NextResponse.json(await getAgentFuel(token.agentId, days), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof SupervisorError) return fail(err.status, err.code, err.message);
    if (err instanceof SupervisorUnavailable) return fail(503, 'supervisor_unavailable', 'The agent service is unavailable right now.');
    console.warn('agent fuel: failed', (err as Error).message);
    return fail(502, 'upstream_failed', 'Could not reach the indexer.');
  }
}
