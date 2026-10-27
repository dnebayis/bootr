import { cookies, headers } from 'next/headers';
import { ADMIN_COOKIE, CONSOLE_HEADER, consoleSlug, verifyAdminCookie, type AdminSession } from './session-core';

export async function getAdminSession(): Promise<AdminSession | null> {
  const jar = await cookies();
  return verifyAdminCookie(jar.get(ADMIN_COOKIE)?.value);
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
