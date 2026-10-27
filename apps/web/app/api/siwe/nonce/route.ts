import { NextResponse } from 'next/server';
import { NONCE_COOKIE, sessionSecret, signToken } from '@/lib/server/session-core';
import { cookieBase } from '@/lib/server/session';

/** Issues a one-time SIWE nonce, bound to the browser by a signed httpOnly cookie (10 min). */
export async function POST() {
  if (!sessionSecret()) return NextResponse.json({ error: 'Sign-in is not configured' }, { status: 503 });
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const token = await signToken({ k: 'nonce', n: nonce, e: Math.floor(Date.now() / 1000) + 600 });
  const res = NextResponse.json({ nonce });
  res.cookies.set(NONCE_COOKIE, token, { ...cookieBase, path: '/api/siwe', maxAge: 600 });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
