import { NextResponse } from 'next/server';
import { ADMIN_COOKIE } from '@/lib/server/session-core';
import { cookieBase } from '@/lib/server/session';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, '', { ...cookieBase, maxAge: 0 });
  return res;
}
