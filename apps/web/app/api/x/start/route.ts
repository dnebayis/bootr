import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { DRAFT_COOKIE, isClientState, isSubject, oauthStartUrl, ownsDraft } from '@/lib/server/sender';

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/**
 * GET /api/x/start?agentId=<launch draft uuid | agent id>&state=<client state>[&reconnect=1]
 * Signs the sender's `/oauth/start` server-side (SENDER_SERVICE_KEY never reaches the browser) and
 * redirects the popup there; the sender then redirects to X's consent screen. Only for a draft this
 * browser registered with `POST /api/x/draft`, or an agent id its creator claimed with `POST /api/siwe/x-claim`. `reconnect=1` (the form is replacing the handle it
 * shows) is signed so the sender may replace the draft's existing X account.
 */
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agentId') ?? '';
  const state = req.nextUrl.searchParams.get('state') ?? '';
  const reconnect = req.nextUrl.searchParams.get('reconnect');
  if (!isSubject(agentId) || !isClientState(state) || (reconnect !== null && reconnect !== '1')) {
    return NextResponse.json({ error: 'invalid_request', message: 'agentId must be a draft uuid or an agent id and state ≤ 128 URL-safe chars' }, { status: 400, headers: NO_STORE });
  }
  if (env.useMock) return NextResponse.json({ mock: true, agentId }, { headers: NO_STORE });
  if (!(await ownsDraft(req.cookies.get(DRAFT_COOKIE)?.value, agentId))) {
    return NextResponse.json(
      { error: 'draft_not_registered', message: 'Start X connect from the launch form or the coin page in this browser.' },
      { status: 403, headers: NO_STORE },
    );
  }
  const url = await oauthStartUrl(agentId, state, { reconnect: reconnect === '1' });
  if (!url) {
    return NextResponse.json(
      { error: 'x_connect_unavailable', message: 'X connection is not configured (SENDER_SERVICE_KEY / sender URL missing).' },
      { status: 503, headers: NO_STORE },
    );
  }
  return NextResponse.redirect(url, { status: 302, headers: NO_STORE });
}
