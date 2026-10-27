import type { MiddlewareHandler } from 'hono';

/**
 * CORS policy for the indexer API (GraphQL, REST, SSE).
 *
 * Allowed origins come from `INDEXER_CORS_ORIGIN` (comma-separated); the older
 * `NEXT_PUBLIC_WEB_ORIGIN` is still honoured when the new variable is unset. With neither set the
 * production web origin `https://bootr.fun` is used, never `*`. Outside production
 * (`NODE_ENV !== 'production'`) any `http(s)://localhost|127.0.0.1|[::1]` origin is accepted as
 * well, so `pnpm --filter web dev` keeps working against a local indexer. An explicit `*` in
 * `INDEXER_CORS_ORIGIN` opts into any origin.
 *
 * Ponder's own HTTP server wraps the API in `cors({ origin: '*' })` and answers every OPTIONS
 * preflight itself, so a regular `hono/cors` in the API cannot narrow anything: a disallowed origin
 * would still receive `Access-Control-Allow-Origin: *`. `corsMiddleware` therefore rewrites the
 * header on the actual response (set for an allowed origin, removed otherwise); the browser then
 * refuses to expose the response to any other site even though the preflight succeeded.
 */
export const DEFAULT_CORS_ORIGIN = 'https://bootr.fun';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export type CorsPolicy = {
  /** Exact origins (no trailing slash). `['*']` means any origin. */
  origins: string[];
  /** Also accept loopback origins on any port (non-production only). */
  allowLocalhost: boolean;
  /** Which variable the origins came from (for the startup log). */
  source: 'INDEXER_CORS_ORIGIN' | 'NEXT_PUBLIC_WEB_ORIGIN' | 'default';
};

export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function corsPolicy(env: Record<string, string | undefined> = process.env): CorsPolicy {
  const explicit = parseOrigins(env.INDEXER_CORS_ORIGIN);
  const legacy = parseOrigins(env.NEXT_PUBLIC_WEB_ORIGIN);
  const allowLocalhost = (env.NODE_ENV ?? '').trim() !== 'production';
  if (explicit.length) {
    return {
      origins: explicit.includes('*') ? ['*'] : explicit,
      allowLocalhost,
      source: 'INDEXER_CORS_ORIGIN',
    };
  }
  if (legacy.length) return { origins: legacy, allowLocalhost, source: 'NEXT_PUBLIC_WEB_ORIGIN' };
  return { origins: [DEFAULT_CORS_ORIGIN], allowLocalhost, source: 'default' };
}

/**
 * Hono `cors({ origin })` callback: returns the value for `Access-Control-Allow-Origin`, or null
 * (no header, so the browser blocks the response) for an origin that is not allowed.
 */
export function originResolver(policy: CorsPolicy): (origin: string) => string | null {
  if (policy.origins.includes('*')) return () => '*';
  const allowed = new Set(policy.origins.map((o) => o.toLowerCase()));
  return (origin: string) => {
    if (!origin) return null;
    const o = origin.replace(/\/+$/, '');
    if (allowed.has(o.toLowerCase())) return o;
    if (policy.allowLocalhost && LOCAL_ORIGIN.test(o)) return o;
    return null;
  };
}

/** Response-side CORS enforcement for the API app (see the note at the top of this file). */
export function corsMiddleware(policy: CorsPolicy): MiddlewareHandler {
  const resolve = originResolver(policy);
  return async (c, next) => {
    await next();
    const allowed = resolve(c.req.header('origin') ?? '');
    const headers = c.res.headers;
    if (allowed) headers.set('Access-Control-Allow-Origin', allowed);
    else headers.delete('Access-Control-Allow-Origin');
    if (allowed !== '*' && !/(^|,)\s*origin\s*(,|$)/i.test(headers.get('Vary') ?? ''))
      headers.append('Vary', 'Origin');
  };
}
