import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { fetchTokenCreator, isAgentId, oauthStartUrl } from '@/lib/server/sender';
import { verifySiwe } from '@/lib/server/siwe-verify';

const NO_STORE = { 'Cache-Control': 'no-store' };
const limiter = new RateLimiter(10, 60_000);
const STATEMENT = /^Connect the X account of Bootr agent #(\d{1,20}) \((0x[0-9a-fA-F]{40})\)\.$/;

function fail(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message }, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * POST /api/agent/x-connect {message, signature} -> {url, expiresIn}
 * The agent-API counterpart of the coin page's Connect X: the creator wallet (the one that launched the coin,
 * per the indexer) signs the same SIWE statement as the page, and gets the signed sender `/oauth/start` URL for
 * its agent id. X's consent screen needs a human in a browser logged into the agent's X account, so the agent
 * hands that URL to its operator; it is valid for 5 minutes (the sender's clock-skew window). Once X redirects
 * back, the sender holds the account and the supervisor finishes onboarding on its next pass.
 */
export async function POST(req: NextRequest) {
  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) return fail(429, 'rate_limited', 'Too many requests. Try again in a minute.', { 'Retry-After': String(retryAfter) });
  let body: { message?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400, 'invalid_json', 'Body is not valid JSON.');
  }
  const v = await verifySiwe(body, { statement: STATEMENT });
  if (!v.ok) return fail(v.status, 'siwe_rejected', v.error);
  const [, agentId, kernel] = STATEMENT.exec(v.msg.statement ?? '')!;
  if (!isAgentId(agentId)) return fail(400, 'invalid_request', 'Invalid agent id.');
  if (env.useMock) return NextResponse.json({ url: `${env.siteUrl}/mock/x-oauth?agentId=${agentId}`, expiresIn: 300, mock: true }, { headers: NO_STORE });
  const token = await fetchTokenCreator(kernel);
  if (!token) return fail(404, 'unknown_coin', 'No indexed coin has that treasury yet. Wait for the indexer, then retry.');
  if (token.agentId !== agentId || token.creator.toLowerCase() !== v.address.toLowerCase()) {
    return fail(403, 'not_creator', 'Only the wallet that launched the coin can connect its agent’s X account.');
  }
  const state = crypto.randomUUID();
  const url = await oauthStartUrl(agentId, state);
  if (!url) return fail(503, 'x_connect_unavailable', 'X connection is not configured on this deployment.');
  return NextResponse.json({ url, expiresIn: 300, agentId }, { headers: NO_STORE });
}
