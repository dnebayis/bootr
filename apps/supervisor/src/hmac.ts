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

/** What can be said of the header alone, before the body: that it is there, has the shape and names a time inside the window. */
export function checkHeader(header: string | undefined, nowSec: number): { ok: true; ts: string; sig: string } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: 'missing_authorization' };
  const m = /^HMAC (\d{1,12}):([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return { ok: false, reason: 'malformed_authorization' };
  const ts = m[1] as string;
  if (Math.abs(nowSec - Number(ts)) > MAX_SKEW_SEC) return { ok: false, reason: 'stale_timestamp' };
  return { ok: true, ts, sig: (m[2] as string).toLowerCase() };
}

export function verifyRequest(key: string, header: string | undefined, method: string, path: string, body: string, nowSec: number): VerifyResult {
  const head = checkHeader(header, nowSec);
  if (!head.ok) return head;
  const expected = hmacHex(key, signingString(head.ts, method, path, body));
  if (!safeEqualHex(expected, head.sig)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

export type AuthEnv = { Variables: { rawBody: string } };

/**
 * The largest body an internal route takes: the web's 8 MB picture upload (apps/web/lib/server/own-agent.ts,
 * `UPLOAD_BODY_BYTES`) with the few bytes the web adds to it. Every other internal body is a few kilobytes.
 */
export const INTERNAL_BODY_MAX_BYTES = 8 * 1024 * 1024 + 64 * 1024;

const TOO_LARGE = { error: 'payload_too_large', message: 'The request body is too large.' } as const;

/** The body's bytes, read no further than `maxBytes`; null when there are more. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * Hono middleware verifying `Authorization: HMAC <ts>:<hex>` the way the sender does. The signature covers the body,
 * so the body has to be read before it can be checked; what can be refused first is refused first: a header that is
 * missing, malformed or out of the time window is answered before a byte of the body is read, a declared length over
 * `maxBodyBytes` likewise, and the read itself stops at `maxBodyBytes` whatever was declared.
 */
export function hmacAuth(key: string, nowSec: () => number = () => Math.floor(Date.now() / 1000), maxBodyBytes = INTERNAL_BODY_MAX_BYTES): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname + url.search;
    const header = c.req.header('authorization');
    const head = checkHeader(header, nowSec());
    if (!head.ok) return c.json({ error: 'unauthorized', reason: head.reason }, 401);
    let body = '';
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (Number(c.req.header('content-length') ?? 0) > maxBodyBytes) return c.json(TOO_LARGE, 413);
      const bytes = await readCapped(c.req.raw.body, maxBodyBytes);
      if (bytes === null) return c.json(TOO_LARGE, 413);
      // Decoded as `Request.text()` decodes it, and left where Hono keeps a body it has read (as the promise `text()`
      // itself would have left there), so a handler's `c.req.json()` or `c.req.text()` gets this text and nobody reads
      // the stream a second time.
      body = new TextDecoder().decode(bytes);
      (c.req.bodyCache as { text?: Promise<string> }).text = Promise.resolve(body);
    }
    const res = verifyRequest(key, header, c.req.method, path, body, nowSec());
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
