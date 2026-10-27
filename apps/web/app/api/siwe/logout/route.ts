import { NextResponse, type NextRequest } from 'next/server';
import { revokeSession } from '@/lib/server/server-state';
import { ADMIN_COOKIE, verifyAdminCookie } from '@/lib/server/session-core';
import { cookieBase } from '@/lib/server/session';

/** Clears the admin cookie and revokes the session server-side, so a copied token stops working. */
export async function POST(req: NextRequest) {
  const session = await verifyAdminCookie(req.cookies.get(ADMIN_COOKIE)?.value);
  if (session) revokeSession(session.s, session.e * 1000);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, '', { ...cookieBase, maxAge: 0 });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
