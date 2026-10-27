import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/** Allowed clock skew between caller and service, in seconds (same as apps/sender). */
export const MAX_SKEW_SEC = 5 * 60;

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Canonical string signed by internal callers (identical to apps/sender/src/auth.ts):
 *   ts + "\n" + METHOD + "\n" + path + "\n" + hex(sha256(body))
 * `ts` is unix seconds; `path` is pathname plus `?query` if any; body is the raw body ("" for GET).
 */
export function signingString(ts: string, method: string, path: string, body: string): string {
  return `${ts}\n${method.toUpperCase()}\n${path}\n${sha256Hex(body)}`;
}

export function signRequest(key: string, method: string, path: string, body = '', nowSec = Math.floor(Date.now() / 1000)): string {
  const ts = String(nowSec);
  return `HMAC ${ts}:${hmacHex(key, signingString(ts, method, path, body))}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyRequest(key: string, header: string | undefined, method: string, path: string, body: string, nowSec: number): VerifyResult {
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

/** Hono middleware verifying `Authorization: HMAC <ts>:<hex>` the way the sender does. */
export function hmacAuth(key: string, nowSec: () => number = () => Math.floor(Date.now() / 1000)): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname + url.search;
    const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? '' : await c.req.text();
    const res = verifyRequest(key, c.req.header('authorization'), c.req.method, path, body, nowSec());
    if (!res.ok) return c.json({ error: 'unauthorized', reason: res.reason }, 401);
    c.set('rawBody', body);
    await next();
  };
}

/** Signed JSON fetch helper for the sender / indexer internal APIs. */
export async function signedFetch(
  fetchImpl: typeof fetch,
  key: string,
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<Response> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = { authorization: signRequest(key, method, path, raw) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetchImpl(new URL(path, baseUrl).toString(), {
    method,
    headers,
    ...(body !== undefined ? { body: raw } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
