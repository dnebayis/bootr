import { NextResponse, type NextRequest } from 'next/server';
import { securityHeaders } from '@/lib/server/security-headers';
import { ADMIN_COOKIE, CONSOLE_HEADER, consoleSlug, verifyAdminCookie } from '@/lib/server/session-core';

/**
 * 1. Security headers (CSP, X-Frame-Options, Referrer-Policy, ...) on every page and API response.
 * 2. Hidden admin console gate.
 *
 * Next.js only treats whole-segment brackets as dynamic, so the console lives at the literal
 * route `app/console-[slug]` and this proxy maps `/console-<slug>[/signin]` onto it:
 *   - slug unset or wrong          -> 404
 *   - /console-<slug>/signin       -> sign-in page (SIWE)
 *   - /console-<slug> w/o session  -> 404 (the console does not reveal itself)
 *   - /console-<slug> with session -> console, slug forwarded in a request header the page re-checks
 * Any client-supplied copy of that header is overwritten.
 */
function withHeaders(res: NextResponse, pathname: string): NextResponse {
  for (const [k, v] of Object.entries(securityHeaders(pathname))) res.headers.set(k, v);
  return res;
}

function notFound(req: NextRequest) {
  return withHeaders(NextResponse.rewrite(new URL('/__bootr_not_found', req.url)), req.nextUrl.pathname);
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith('/console')) {
    // Strip any client-supplied console header on every other route as well.
    const headers = new Headers(req.headers);
    headers.delete(CONSOLE_HEADER);
    return withHeaders(NextResponse.next({ request: { headers } }), pathname);
  }

  const m = /^\/console-([^/]+)(\/signin)?\/?$/.exec(pathname);
  const slug = consoleSlug();
  if (!m || !slug) return notFound(req);

  let given: string;
  try {
    given = decodeURIComponent(m[1]!);
  } catch {
    return notFound(req);
  }
  if (given !== slug) return notFound(req);

  const signin = !!m[2];
  if (!signin) {
    const session = await verifyAdminCookie(req.cookies.get(ADMIN_COOKIE)?.value);
    if (!session) return notFound(req);
  }

  const headers = new Headers(req.headers);
  headers.set(CONSOLE_HEADER, slug);
  const target = new URL(signin ? '/console-[slug]/signin' : '/console-[slug]', req.url);
  target.search = req.nextUrl.search;
  const res = NextResponse.rewrite(target, { request: { headers } });
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  res.headers.set('Cache-Control', 'no-store');
  return withHeaders(res, pathname);
}

export const config = {
  // Everything except build assets; prefetches still get the headers (they are cheap to compute).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
