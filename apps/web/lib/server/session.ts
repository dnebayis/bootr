import { cookies, headers } from 'next/headers';
import { isSessionRevoked } from './server-state';
import { ADMIN_COOKIE, CONSOLE_HEADER, CONSOLE_PARAM, consoleSlug, verifyAdminCookie, type AdminSession } from './session-core';

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
export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * True when the request came through proxy.ts for the configured slug: the proxy puts the slug in the
 * rewritten URL (`searchParams`, works on the standalone server) and in a request header (`next start`).
 * Either channel is enough; a direct request to the literal `/console-admin` route carries neither.
 */
export async function consoleRequestIsValid(searchParams?: SearchParams): Promise<boolean> {
  const slug = consoleSlug();
  if (!slug) return false;
  const param = searchParams?.[CONSOLE_PARAM];
  if (typeof param === 'string' && param === slug) return true;
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
