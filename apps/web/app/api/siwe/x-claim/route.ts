import { NextResponse, type NextRequest } from 'next/server';
import { NONCE_COOKIE, verifyToken, type NonceToken } from '@/lib/server/session-core';
import { isAllowedOrigin } from '@/lib/server/env';
import { cookieBase } from '@/lib/server/session';
import { DRAFT_COOKIE, DRAFT_COOKIE_PATH, DRAFT_TTL_S, fetchTokenCreator, isAgentId, registerDraft } from '@/lib/server/sender';
import { verifySiwe } from '@/lib/server/siwe-verify';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The statement the coin page asks the creator to sign; the agent id and the kernel are read back from it. */
export const X_CLAIM_STATEMENT = /^Connect the X account of Bootr agent #(\d{1,20}) \((0x[0-9a-fA-F]{40})\)\.$/;

function fail(status: number, error: string) {
  const res = NextResponse.json({ error }, { status, headers: NO_STORE });
  res.cookies.set(NONCE_COOKIE, '', { ...cookieBase, path: '/api/siwe', maxAge: 0 });
  return res;
}

/**
 * POST /api/siwe/x-claim {message, signature}: a coin's creator proves wallet ownership with a SIWE message
 * whose statement names the agent id and its kernel, the indexer confirms that wallet created the coin, and
 * this browser is then registered for the agent id exactly like a launch draft (`POST /api/x/draft`), so
 * `/api/x/start` and `/api/x/status` serve it. Lives under /api/siwe so the nonce cookie reaches it. No
 * session is created: the registration cookie is the only thing granted, and only for that agent.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!origin || !isAllowedOrigin(origin)) return fail(403, 'cross-origin request rejected');
  const nonce = await verifyToken<NonceToken>(req.cookies.get(NONCE_COOKIE)?.value, 'nonce');
  if (!nonce) return fail(401, 'Sign-in expired. Request a new nonce.');
  let body: { message?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  const v = await verifySiwe(body, { expectedNonce: nonce.n, statement: X_CLAIM_STATEMENT });
  if (!v.ok) return fail(v.status, v.error);
  const [, agentId, kernel] = X_CLAIM_STATEMENT.exec(v.msg.statement ?? '')!;
  if (!isAgentId(agentId)) return fail(400, 'Invalid agent id');

  // The indexer is the source of truth for who created the coin whose agent this is.
  const token = await fetchTokenCreator(kernel);
  if (!token) return fail(404, 'Unknown coin');
  if (token.agentId !== agentId || token.creator.toLowerCase() !== v.address.toLowerCase()) {
    return fail(403, 'Only the coin’s creator can connect its agent’s X account');
  }

  const value = await registerDraft(req.cookies.get(DRAFT_COOKIE)?.value, agentId);
  if (!value) return fail(503, 'X connection is not configured.');
  const res = NextResponse.json({ ok: true, agentId }, { headers: NO_STORE });
  res.cookies.set(NONCE_COOKIE, '', { ...cookieBase, path: '/api/siwe', maxAge: 0 });
  res.cookies.set(DRAFT_COOKIE, value, { ...cookieBase, path: DRAFT_COOKIE_PATH, maxAge: DRAFT_TTL_S });
  return res;
}
