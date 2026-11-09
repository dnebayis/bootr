import { NextResponse, type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { fetchTokenCreator } from '@/lib/server/sender';
import { BOUNTY_JOB_ID_RE, getAgentBounty, SupervisorError, SupervisorUnavailable } from '@/lib/server/supervisor';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string, message: string) {
  return NextResponse.json({ error, message }, { status, headers: NO_STORE });
}

/**
 * GET /api/agent/:kernel/bounties/:jobId -> {job: BountyJob}
 * One job by its full id (0x hex, 32 bytes) or by the 16-hex prefix the job post and the page anchor carry
 * (`#bounty-<shortId>`), the same shape and the same re-shaping as the list. 404 when the coin, the agent or the job is
 * unknown.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/bounties/[jobId]'>) {
  const { kernel, jobId } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', 'kernel must be an address');
  if (!BOUNTY_JOB_ID_RE.test(jobId)) return fail(400, 'invalid_request', 'jobId must be a 32-byte hex id or its 16-hex prefix');
  if (env.useMock) {
    const job = mock.agentBounty(kernel, jobId);
    return job ? NextResponse.json({ job }, { headers: NO_STORE }) : fail(404, 'unknown_job', 'The agent has no job with that id.');
  }
  try {
    const token = await fetchTokenCreator(kernel);
    if (!token) return fail(404, 'unknown_coin', 'No indexed coin has that treasury.');
    const job = await getAgentBounty(token.agentId, jobId.toLowerCase());
    return job ? NextResponse.json({ job }, { headers: NO_STORE }) : fail(404, 'unknown_job', 'The agent has no job with that id.');
  } catch (err) {
    if (err instanceof SupervisorError) return fail(err.status, err.code, err.message);
    if (err instanceof SupervisorUnavailable) return fail(503, 'supervisor_unavailable', 'The agent service is unavailable right now.');
    console.warn('agent bounty: failed', (err as Error).message);
    return fail(502, 'upstream_failed', 'Could not reach the indexer.');
  }
}
