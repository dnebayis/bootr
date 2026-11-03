import { NextResponse, type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { fetchTokenCreator } from '@/lib/server/sender';
import { ACTIVITY_LIMIT_DEFAULT, ACTIVITY_LIMIT_MAX, getAgentActivity, SupervisorError, SupervisorUnavailable } from '@/lib/server/supervisor';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string, message: string) {
  return NextResponse.json({ error, message }, { status, headers: NO_STORE });
}

/**
 * GET /api/agent/:kernel/activity?limit=50&before=<iso> -> {items: AgentActivityItem[]} (newest first)
 * Public read of the agent's activity tape (posts, replies, fee claims, swaps, gas, sleeps/wakes, config edits),
 * proxied to the supervisor. `before` is the `at` of the last item shown. An unknown agent answers an empty tape.
 */
export async function GET(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/activity'>) {
  const { kernel } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', 'kernel must be an address');
  const n = Number(req.nextUrl.searchParams.get('limit') ?? ACTIVITY_LIMIT_DEFAULT);
  const limit = Number.isFinite(n) ? Math.min(ACTIVITY_LIMIT_MAX, Math.max(1, Math.trunc(n))) : ACTIVITY_LIMIT_DEFAULT;
  const beforeRaw = req.nextUrl.searchParams.get('before');
  const before = beforeRaw && Number.isFinite(Date.parse(beforeRaw)) ? new Date(Date.parse(beforeRaw)).toISOString() : undefined;
  if (beforeRaw && !before) return fail(400, 'invalid_request', 'before must be an ISO date');

  if (env.useMock) return NextResponse.json(mock.agentActivity(kernel, { limit, before }), { headers: NO_STORE });
  try {
    const token = await fetchTokenCreator(kernel);
    if (!token) return fail(404, 'unknown_coin', 'No indexed coin has that treasury.');
    return NextResponse.json(await getAgentActivity(token.agentId, { limit, ...(before ? { before } : {}) }), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof SupervisorError) return fail(err.status, err.code, err.message);
    if (err instanceof SupervisorUnavailable) return fail(503, 'supervisor_unavailable', 'The agent service is unavailable right now.');
    console.warn('agent activity: failed', (err as Error).message);
    return fail(502, 'upstream_failed', 'Could not reach the indexer.');
  }
}
