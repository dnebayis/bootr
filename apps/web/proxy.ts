import { NextResponse, type NextRequest } from 'next/server';
import { securityHeaders } from '@/lib/server/security-headers';
import { ADMIN_COOKIE, CONSOLE_HEADER, CONSOLE_PARAM, consoleSlug, verifyAdminCookie } from '@/lib/server/session-core';

/**
 * 1. Security headers (CSP, X-Frame-Options, Referrer-Policy, ...) on every page and API response.
 * 2. Hidden admin console gate.
 *
 * The console lives at the literal route `app/console-admin` (a bracket-free name: the standalone
 * server resolves routes from the build manifest, where a bracketed segment compiles into a pattern
 * that never matches) and this proxy maps `/console-<slug>[/signin]` onto it. `/console-admin` itself
 * goes through the same slug check, so the literal route is never reachable directly:
 *   - slug unset or wrong          -> 404
 *   - /console-<slug>/signin       -> sign-in page (SIWE)
 *   - /console-<slug> w/o session  -> 404 (the console does not reveal itself)
 *   - /console-<slug> with session -> console, slug forwarded to the page (query parameter on the
 *     rewritten URL plus a request header; the standalone server only delivers the former)
 * Any client-supplied copy of that header or parameter is overwritten.
 */
function withHeaders(res: NextResponse, pathname: string): NextResponse {
  for (const [k, v] of Object.entries(securityHeaders(pathname))) res.headers.set(k, v);
  return res;
}

/**
 * Rewrite targets are cloned from `req.nextUrl` (Next's own origin for the request). On the standalone
 * server (`node server.js`, the container) a rewrite is served by re-entering this proxy with the
 * rewritten path, so `/console-admin[/signin]` arrives here a second time; the branch at the top of
 * `proxy` recognises that pass by the `CONSOLE_PARAM` the first pass attached. `next start` resolves
 * the same rewrite in-process, which is why the e2e suite never saw the 404.
 */
function rewriteTarget(req: NextRequest, pathname: string, search = ''): URL {
  const target = req.nextUrl.clone();
  target.pathname = pathname;
  target.search = search;
  return target;
}

function notFound(req: NextRequest) {
  return withHeaders(NextResponse.rewrite(rewriteTarget(req, '/__bootr_not_found')), req.nextUrl.pathname);
}

const CONSOLE_ROUTES = new Set(['/console-admin', '/console-admin/signin']);

/** Response headers every console page carries. */
function consoleHeaders(res: NextResponse, pathname: string): NextResponse {
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  res.headers.set('Cache-Control', 'no-store');
  return withHeaders(res, pathname);
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith('/console')) {
    // Strip any client-supplied console header on every other route as well.
    const headers = new Headers(req.headers);
    headers.delete(CONSOLE_HEADER);
    return withHeaders(NextResponse.next({ request: { headers } }), pathname);
  }

  const slug = consoleSlug();
  if (!slug) return notFound(req);

  // Second pass on the literal route (standalone server): only with the parameter the first pass set.
  // A direct request needs the same secret as `/console-<slug>`, and the page re-checks it and the session.
  const literal = pathname.replace(/\/$/, '') || pathname;
  if (CONSOLE_ROUTES.has(literal)) {
    if (req.nextUrl.searchParams.get(CONSOLE_PARAM) !== slug) return notFound(req);
    if (literal === '/console-admin' && !(await verifyAdminCookie(req.cookies.get(ADMIN_COOKIE)?.value))) return notFound(req);
    const headers = new Headers(req.headers);
    headers.set(CONSOLE_HEADER, slug);
    return consoleHeaders(NextResponse.next({ request: { headers } }), pathname);
  }

  const m = /^\/console-([^/]+)(\/signin)?\/?$/.exec(pathname);
  if (!m) return notFound(req);

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
  const target = rewriteTarget(req, signin ? '/console-admin/signin' : '/console-admin', req.nextUrl.search);
  target.searchParams.set(CONSOLE_PARAM, slug);
  return consoleHeaders(NextResponse.rewrite(target, { request: { headers } }), pathname);
}

export const config = {
  // Everything except build assets; prefetches still get the headers (they are cheap to compute).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
