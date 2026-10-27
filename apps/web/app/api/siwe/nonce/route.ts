import { NextResponse } from 'next/server';
import { rememberNonce } from '@/lib/server/server-state';
import { NONCE_COOKIE, sessionSecret, signToken } from '@/lib/server/session-core';
import { cookieBase } from '@/lib/server/session';

const NONCE_TTL_S = 600;

/**
 * Issues a one-time SIWE nonce (10 min): recorded server-side (consumed once by /api/siwe/verify) and
 * bound to the browser by a signed httpOnly cookie.
 */
export async function POST() {
  if (!sessionSecret()) return NextResponse.json({ error: 'Sign-in is not configured' }, { status: 503 });
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const exp = Math.floor(Date.now() / 1000) + NONCE_TTL_S;
  rememberNonce(nonce, exp * 1000);
  const token = await signToken({ k: 'nonce', n: nonce, e: exp });
  const res = NextResponse.json({ nonce });
  res.cookies.set(NONCE_COOKIE, token, { ...cookieBase, path: '/api/siwe', maxAge: NONCE_TTL_S });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
