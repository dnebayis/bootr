import type { MiddlewareHandler } from 'hono';
import { hmacHex, safeEqualHex, sha256Hex } from './crypto.js';

/** Allowed clock skew between caller and sender, in seconds. */
export const MAX_SKEW_SEC = 5 * 60;

/**
 * Canonical string signed by internal callers:
 *   ts + "\n" + METHOD + "\n" + path + "\n" + hex(sha256(body))
 * `ts` is unix seconds; `path` is the request target (pathname plus `?query` if any);
 * body is the exact raw request body ("" for GET).
 */
export function signingString(ts: string, method: string, path: string, body: string): string {
  return `${ts}\n${method.toUpperCase()}\n${path}\n${sha256Hex(body)}`;
}

/** Produce an `Authorization` header value. Supervisor-side reference implementation. */
export function signRequest(
  key: string,
  method: string,
  path: string,
  body = '',
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const ts = String(nowSec);
  return `HMAC ${ts}:${hmacHex(key, signingString(ts, method, path, body))}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyRequest(
  key: string,
  header: string | undefined,
  method: string,
  path: string,
  body: string,
  nowSec: number,
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing_authorization' };
  const m = /^HMAC (\d{1,12}):([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return { ok: false, reason: 'malformed_authorization' };
  const ts = m[1] as string;
  const sig = (m[2] as string).toLowerCase();
  if (Math.abs(nowSec - Number(ts)) > MAX_SKEW_SEC) return { ok: false, reason: 'stale_timestamp' };
  const expected = hmacHex(key, signingString(ts, method, path, body));
  if (!safeEqualHex(expected, sig)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

export type AuthEnv = { Variables: { rawBody: string } };

/**
 * Verifies `Authorization: HMAC <ts>:<hex>`. There is deliberately no replay cache: a replay
 * inside the skew window is harmless because publish is idempotent per actionId, resolve/quota
 * are idempotent writes and reads are throttled, while a cache would reject legitimate
 * byte-identical retries signed within the same second.
 */
export function hmacAuth(key: string, nowSec: () => number): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname + url.search;
    const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? '' : await c.req.text();
    const header = c.req.header('authorization');
    const now = nowSec();
    const res = verifyRequest(key, header, c.req.method, path, body, now);
    if (!res.ok) return c.json({ error: 'unauthorized', reason: res.reason }, 401);
    c.set('rawBody', body);
    await next();
  };
}
