import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { isAllowedOrigin } from '@/lib/server/env';
import { DRAFT_COOKIE, DRAFT_COOKIE_PATH, DRAFT_TTL_S, isDraftId, registerDraft } from '@/lib/server/sender';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/x/draft {agentId: <launch draft uuid>}
 * Registers the draft to this browser (HttpOnly, SameSite=Strict cookie with an HMAC tag). `/api/x/start`
 * and `/api/x/status` only serve drafts this browser registered. Same-origin requests only, so another
 * site cannot register its draft into a victim's browser.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!origin || !isAllowedOrigin(origin)) {
    return NextResponse.json({ error: 'forbidden', message: 'cross-origin request rejected' }, { status: 403, headers: NO_STORE });
  }
  if (Number(req.headers.get('content-length') ?? 0) > 1024) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  let agentId = '';
  try {
    const body = (await req.json()) as { agentId?: unknown };
    agentId = typeof body.agentId === 'string' ? body.agentId : '';
  } catch {
    /* handled below */
  }
  if (!isDraftId(agentId)) {
    return NextResponse.json({ error: 'invalid_request', message: 'agentId must be a draft uuid' }, { status: 400, headers: NO_STORE });
  }
  if (env.useMock) return NextResponse.json({ ok: true, mock: true }, { headers: NO_STORE });
  const value = await registerDraft(req.cookies.get(DRAFT_COOKIE)?.value, agentId);
  if (!value) {
    return NextResponse.json({ error: 'x_connect_unavailable', message: 'X connection is not configured.' }, { status: 503, headers: NO_STORE });
  }
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  res.cookies.set(DRAFT_COOKIE, value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: DRAFT_COOKIE_PATH,
    maxAge: DRAFT_TTL_S,
  });
  return res;
}
