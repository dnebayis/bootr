import { NextResponse, type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { kernelMessage, rateLimitMessage } from '@/lib/server/refusals';
import { fetchTokenCreator } from '@/lib/server/sender';
import { getAgentLedger, LEDGER_CURSOR_RE, LEDGER_LIMIT_DEFAULT, LEDGER_LIMIT_MAX, SupervisorError, SupervisorUnavailable } from '@/lib/server/supervisor';

const NO_STORE = { 'Cache-Control': 'no-store' };
/** A page reads several tables and the indexer: 30 a minute per IP is a person paging, not a scraper. */
const PER_MINUTE = 30;
const limiter = new RateLimiter(PER_MINUTE, 60_000);

function fail(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message }, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * GET /api/agent/:kernel/ledger?limit=50&cursor=<next> -> AgentLedger (lib/types)
 * Public read of the agent's money ledger, newest first: fee claims, money sent to it, fuel and gas top-ups, swaps,
 * thinking paid per day, paid services, bounties. Every row was written by code when it happened and is rebuilt here
 * field by field (`sanitizeLedger`). The first page (no cursor) also carries the totals of the last seven UTC days.
 * `cursor` is the `next` of the page before; `limit` 1 to 100. 30 requests per minute per IP. An unknown coin is 404.
 */
export async function GET(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/ledger'>) {
  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) return fail(429, 'rate_limited', rateLimitMessage(PER_MINUTE, retryAfter), { 'Retry-After': String(retryAfter) });
  const { kernel } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', kernelMessage(kernel));
  const n = Number(req.nextUrl.searchParams.get('limit') ?? LEDGER_LIMIT_DEFAULT);
  const limit = Number.isFinite(n) ? Math.min(LEDGER_LIMIT_MAX, Math.max(1, Math.trunc(n))) : LEDGER_LIMIT_DEFAULT;
  const cursor = req.nextUrl.searchParams.get('cursor');
  if (cursor !== null && !LEDGER_CURSOR_RE.test(cursor)) return fail(400, 'invalid_request', 'cursor must be the next of a ledger page.');

  if (env.useMock) return NextResponse.json(mock.agentLedger(kernel, { limit, cursor }), { headers: NO_STORE });
  try {
    const token = await fetchTokenCreator(kernel);
    if (!token) return fail(404, 'unknown_coin', 'No indexed coin has that treasury.');
    return NextResponse.json(await getAgentLedger(token.agentId, { limit, ...(cursor ? { cursor } : {}) }), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof SupervisorError) return fail(err.status, err.code, err.message);
    if (err instanceof SupervisorUnavailable) return fail(503, 'supervisor_unavailable', 'The agent service is unavailable right now.');
    console.warn('agent ledger: failed', (err as Error).message);
    return fail(502, 'upstream_failed', 'Could not reach the indexer.');
  }
}
