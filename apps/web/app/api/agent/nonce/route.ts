import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { rateLimitMessage } from '@/lib/server/refusals';
import { issueNonce, NONCE_TTL_S } from '@/lib/server/siwe-verify';

/** Nonces per minute per IP: one call per signed request is the pattern, and the launch route takes 5 a minute. */
const PER_MINUTE = 30;
const limiter = new RateLimiter(PER_MINUTE, 60_000);
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/agent/nonce -> {nonce, expiresIn}
 * A single-use SIWE nonce for the agent API (`/api/agent/launch`, `/api/agent/x-connect`). Unlike the
 * site's own sign-in it is not bound to a browser cookie: the caller is a program with a wallet, and the
 * signature binds the nonce to that wallet. Valid for 10 minutes, consumed by the first verification.
 * 30 calls per minute per IP (429 `rate_limited`): the nonce store is bounded, and a flood of nonces would
 * push out the ones real callers are about to sign.
 */
export async function POST(req: NextRequest) {
  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) {
    return NextResponse.json({ error: 'rate_limited', message: rateLimitMessage(PER_MINUTE, retryAfter) }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(retryAfter) } });
  }
  const { nonce } = issueNonce();
  return NextResponse.json({ nonce, expiresIn: NONCE_TTL_S }, { headers: NO_STORE });
}
