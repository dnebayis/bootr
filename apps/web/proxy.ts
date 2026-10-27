import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_COOKIE, CONSOLE_HEADER, consoleSlug, verifyAdminCookie } from '@/lib/server/session-core';

/**
 * Hidden admin console gate.
 *
 * Next.js only treats whole-segment brackets as dynamic, so the console lives at the literal
 * route `app/console-[slug]` and this proxy maps `/console-<slug>[/signin]` onto it:
 *   - slug unset or wrong          -> 404
 *   - /console-<slug>/signin       -> sign-in page (SIWE)
 *   - /console-<slug> w/o session  -> 404 (the console does not reveal itself)
 *   - /console-<slug> with session -> console, slug forwarded in a request header the page re-checks
 * Any client-supplied copy of that header is overwritten.
 */
function notFound(req: NextRequest) {
  return NextResponse.rewrite(new URL('/__bootr_not_found', req.url));
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
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
  return res;
}

export const config = {
  matcher: ['/(console.*)'],
};
