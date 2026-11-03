/**
 * Shared by the review-queue routes (`/approvals/list`, `/approvals/decide`): the creator proves who they are once
 * with a SIWE message whose statement is `Review the posts of Bootr coin $SYMBOL (#agentId, kernel).`; the answer
 * carries a short-lived review token (HMAC with SESSION_SECRET, like the admin session) that the console sends
 * instead of a new signature for the rest of the session. Nothing here runs in the browser.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isAddress, type Address } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { isAllowedOrigin } from '@/lib/server/env';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { fetchTokenCreator } from '@/lib/server/sender';
import { hmacHex, safeEqual, sessionSecret } from '@/lib/server/session-core';
import { verifySiwe } from '@/lib/server/siwe-verify';
import { SupervisorError, SupervisorUnavailable } from '@/lib/server/supervisor';

export const REVIEW_STATEMENT = /^Review the posts of Bootr coin \$([A-Za-z0-9_]{1,16}) \(#(\d{1,20}), (0x[0-9a-fA-F]{40})\)\.$/;
/** How long one signature keeps the queue open. */
export const REVIEW_TTL_S = 30 * 60;
const NO_STORE = { 'Cache-Control': 'no-store' };
const E2E_WALLET = '0x00000000000000000000000000000000000e2e01';
const limiter = new RateLimiter(30, 60_000);

export type ReviewSession = { k: 'review'; a: string; kernel: string; agentId: string; e: number };

export function fail(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message }, { status, headers: { ...NO_STORE, ...headers } });
}

export function ok(body: unknown) {
  return NextResponse.json(body, { headers: NO_STORE });
}

export function relay(err: unknown) {
  if (err instanceof SupervisorError) return fail(err.status, err.code, err.message);
  if (err instanceof SupervisorUnavailable) return fail(503, 'supervisor_unavailable', 'The agent service is unavailable right now.');
  console.warn('agent approvals: failed', (err as Error).message);
  return fail(502, 'upstream_failed', 'Could not reach the indexer.');
}

function sameHost(origin: string, host: string | null): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): string {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return decodeURIComponent(escape(atob(pad)));
}

export async function signReviewToken(session: ReviewSession): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error('SESSION_SECRET is not configured (min 16 chars)');
  const body = b64url(JSON.stringify(session));
  return `${body}.${await hmacHex(secret, `review:${body}`)}`;
}

export async function verifyReviewToken(token: unknown, kernel: string, now = Date.now()): Promise<ReviewSession | null> {
  const secret = sessionSecret();
  if (!secret || typeof token !== 'string' || token.length > 2048) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    if (!safeEqual(sig, await hmacHex(secret, `review:${body}`))) return null;
    const s = JSON.parse(fromB64url(body)) as ReviewSession;
    if (s.k !== 'review' || typeof s.e !== 'number' || s.e * 1000 < now) return null;
    if (typeof s.kernel !== 'string' || s.kernel.toLowerCase() !== kernel.toLowerCase()) return null;
    if (typeof s.a !== 'string' || !isAddress(s.a) || typeof s.agentId !== 'string') return null;
    return s;
  } catch {
    return null;
  }
}

export type ReviewAuth = { ok: true; address: Address; agentId: string; token: string } | { ok: false; response: NextResponse };

/**
 * Same-origin and rate-limited; then either a valid review token for this kernel, or a SIWE message + signature
 * from the wallet that launched the coin (checked against the indexer), which earns a token. In mock mode the
 * signature is not checked: `message` may be the address, everyone is the creator.
 */
export async function authorizeReview(req: NextRequest, kernel: string, body: { message?: unknown; signature?: unknown; token?: unknown }): Promise<ReviewAuth> {
  const origin = req.headers.get('origin');
  if (!origin || !(isAllowedOrigin(origin) || sameHost(origin, req.headers.get('host')))) return { ok: false, response: fail(403, 'forbidden', 'cross-origin request rejected') };
  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) return { ok: false, response: fail(429, 'rate_limited', 'Too many requests. Try again in a minute.', { 'Retry-After': String(retryAfter) }) };
  if (!isAddress(kernel, { strict: false })) return { ok: false, response: fail(400, 'invalid_request', 'kernel must be an address') };

  if (env.useMock) {
    const address = (typeof body.message === 'string' && isAddress(body.message) ? body.message : E2E_WALLET) as Address;
    return { ok: true, address, agentId: mock.agentConfig(kernel).agentId, token: 'mock-review-token' };
  }

  if (body.token !== undefined) {
    const s = await verifyReviewToken(body.token, kernel);
    if (!s) return { ok: false, response: fail(401, 'review_expired', 'The review session expired. Sign again.') };
    return { ok: true, address: s.a as Address, agentId: s.agentId, token: body.token as string };
  }

  const v = await verifySiwe(body, { statement: REVIEW_STATEMENT });
  if (!v.ok) return { ok: false, response: fail(v.status, 'siwe_rejected', v.error) };
  const [, , agentId, statementKernel] = REVIEW_STATEMENT.exec(v.msg.statement ?? '')!;
  if (statementKernel!.toLowerCase() !== kernel.toLowerCase()) return { ok: false, response: fail(400, 'invalid_request', 'The signed message names another coin.') };
  let token;
  try {
    token = await fetchTokenCreator(kernel);
  } catch (err) {
    return { ok: false, response: relay(err) };
  }
  if (!token) return { ok: false, response: fail(404, 'unknown_coin', 'No indexed coin has that treasury.') };
  if (token.agentId !== agentId || token.creator.toLowerCase() !== v.address.toLowerCase()) {
    return { ok: false, response: fail(403, 'not_creator', 'Only the wallet that launched the coin can review its posts.') };
  }
  const session: ReviewSession = { k: 'review', a: v.address, kernel: kernel.toLowerCase(), agentId: agentId!, e: Math.floor(Date.now() / 1000) + REVIEW_TTL_S };
  return { ok: true, address: v.address, agentId: agentId!, token: await signReviewToken(session) };
}

/** The JSON body of a review request, bounded. */
export async function readBody<T extends object>(req: NextRequest): Promise<T | NextResponse> {
  if (Number(req.headers.get('content-length') ?? 0) > 16_384) return fail(413, 'payload_too_large', 'Body too large.');
  try {
    const body = (await req.json()) as T;
    if (!body || typeof body !== 'object') return fail(400, 'invalid_json', 'Body is not a JSON object.');
    return body;
  } catch {
    return fail(400, 'invalid_json', 'Body is not valid JSON.');
  }
}
