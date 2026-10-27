import { cookies, headers } from 'next/headers';
import { isSessionRevoked } from './server-state';
import { ADMIN_COOKIE, CONSOLE_HEADER, consoleSlug, verifyAdminCookie, type AdminSession } from './session-core';

/** Signed, unexpired, allowlisted and not revoked at logout. */
export async function verifyAdminSession(token: string | undefined | null): Promise<AdminSession | null> {
  const s = await verifyAdminCookie(token);
  return s && !isSessionRevoked(s.s) ? s : null;
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const jar = await cookies();
  return verifyAdminSession(jar.get(ADMIN_COOKIE)?.value);
}

/** True when the request came through proxy.ts with the correct slug. */
export async function consoleRequestIsValid(): Promise<boolean> {
  const slug = consoleSlug();
  if (!slug) return false;
  const h = await headers();
  const got = h.get(CONSOLE_HEADER);
  return !!got && got === slug;
}

export const cookieBase = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};
