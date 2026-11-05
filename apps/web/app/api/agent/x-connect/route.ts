import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { creatorRefusal, NEW_NONCE, rateLimitMessage, readJsonObject, unknownCoinMessage } from '@/lib/server/refusals';
import { fetchTokenCreator, isAgentId, oauthStartUrl } from '@/lib/server/sender';
import { verifySiwe } from '@/lib/server/siwe-verify';

const NO_STORE = { 'Cache-Control': 'no-store' };
const limiter = new RateLimiter(10, 60_000);
const STATEMENT = /^Connect the X account of Bootr agent #(\d{1,20}) \((0x[0-9a-fA-F]{40})\)\.$/;

function fail(status: number, error: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
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
  if (retryAfter) return fail(429, 'rate_limited', rateLimitMessage(10, retryAfter), {}, { 'Retry-After': String(retryAfter) });
  const body = await readJsonObject<{ message?: unknown; signature?: unknown }>(req);
  if (!body) return fail(400, 'invalid_json', 'Body must be a JSON object: {message, signature}.');
  const v = await verifySiwe(body, { statement: STATEMENT, statementText: 'Connect the X account of Bootr agent #<agentId> (<kernel>).' });
  if (!v.ok) return fail(v.status, 'siwe_rejected', v.error, { reason: v.reason });
  const [, agentId, kernel] = STATEMENT.exec(v.msg.statement ?? '')!;
  if (!isAgentId(agentId)) return fail(400, 'invalid_request', `Agent id #${agentId} is not valid: use agentId from the indexer (a number with no leading zero). ${NEW_NONCE}`, { field: 'statement' });
  if (env.useMock) return NextResponse.json({ url: `${env.siteUrl}/mock/x-oauth?agentId=${agentId}`, expiresIn: 300, mock: true }, { headers: NO_STORE });
  let token: Awaited<ReturnType<typeof fetchTokenCreator>>;
  try {
    token = await fetchTokenCreator(kernel);
  } catch (err) {
    console.warn('x connect: indexer failed', (err as Error).message);
    return fail(502, 'upstream_failed', `Could not reach the indexer. Try again in a moment. ${NEW_NONCE}`);
  }
  if (!token) return fail(404, 'unknown_coin', `${unknownCoinMessage(kernel)} ${NEW_NONCE}`);
  if (token.agentId !== agentId || token.creator.toLowerCase() !== v.address.toLowerCase()) {
    return fail(403, 'not_creator', creatorRefusal('connect its agent’s X account', v.address, token, agentId));
  }
  const state = crypto.randomUUID();
  const url = await oauthStartUrl(agentId, state);
  if (!url) return fail(503, 'x_connect_unavailable', `X connection is not configured on this deployment, so the agent cannot be connected right now. ${NEW_NONCE}`);
  return NextResponse.json({ url, expiresIn: 300, agentId }, { headers: NO_STORE });
}
