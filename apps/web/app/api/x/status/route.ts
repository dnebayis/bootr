import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { isDraftId, senderAccount, SenderUnavailable } from '@/lib/server/sender';
import { senderEnv } from '@/lib/server/env';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Fake handle returned in mock mode (NEXT_PUBLIC_USE_MOCK). */
const MOCK_HANDLE = 'mock_agent';

/**
 * GET /api/x/status?agentId=<launch draft uuid> -> { connected, handle }
 * Server-side HMAC call to the sender's internal `GET /internal/account/:agentId`; scopes and token
 * expiry are not exposed.
 */
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agentId') ?? '';
  if (!isDraftId(agentId)) return NextResponse.json({ error: 'invalid_request', message: 'agentId must be a draft uuid' }, { status: 400, headers: NO_STORE });
  if (env.useMock) return NextResponse.json({ connected: true, handle: MOCK_HANDLE }, { headers: NO_STORE });
  const cfg = senderEnv();
  if (!cfg.serviceKey || !cfg.internalUrl) {
    return NextResponse.json({ error: 'x_connect_unavailable', message: 'X connection is not configured.' }, { status: 503, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await senderAccount(agentId), { headers: NO_STORE });
  } catch (err) {
    if (!(err instanceof SenderUnavailable)) console.warn('x status: sender call failed', (err as Error).message);
    return NextResponse.json({ error: 'sender_unavailable' }, { status: 502, headers: NO_STORE });
  }
}
