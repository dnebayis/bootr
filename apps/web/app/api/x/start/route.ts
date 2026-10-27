import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { isClientState, isDraftId, oauthStartUrl } from '@/lib/server/sender';

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/**
 * GET /api/x/start?agentId=<launch draft uuid>&state=<client state>
 * Signs the sender's `/oauth/start` server-side (SENDER_SERVICE_KEY never reaches the browser) and
 * redirects the popup there; the sender then redirects to X's consent screen.
 */
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agentId') ?? '';
  const state = req.nextUrl.searchParams.get('state') ?? '';
  if (!isDraftId(agentId) || !isClientState(state)) {
    return NextResponse.json({ error: 'invalid_request', message: 'agentId must be a draft uuid and state ≤ 128 URL-safe chars' }, { status: 400, headers: NO_STORE });
  }
  if (env.useMock) return NextResponse.json({ mock: true, agentId }, { headers: NO_STORE });
  const url = await oauthStartUrl(agentId, state);
  if (!url) {
    return NextResponse.json(
      { error: 'x_connect_unavailable', message: 'X connection is not configured (SENDER_SERVICE_KEY / sender URL missing).' },
      { status: 503, headers: NO_STORE },
    );
  }
  return NextResponse.redirect(url, { status: 302, headers: NO_STORE });
}
