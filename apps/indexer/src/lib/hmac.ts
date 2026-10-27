import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Service-to-service HMAC, byte-compatible with apps/sender/src/auth.ts:
 *   Authorization: HMAC <ts>:<hex(HMAC-SHA256(SENDER_SERVICE_KEY, signingString))>
 *   signingString = ts + "\n" + METHOD + "\n" + path(+?query) + "\n" + hex(sha256(body))
 */
export const MAX_SKEW_SEC = 5 * 60;

export const sha256Hex = (data: string) => createHash('sha256').update(data).digest('hex');
export const hmacHex = (key: string, data: string) => createHmac('sha256', key).update(data).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function signingString(ts: string, method: string, path: string, body: string): string {
  return `${ts}\n${method.toUpperCase()}\n${path}\n${sha256Hex(body)}`;
}

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
  header: string | undefined | null,
  method: string,
  path: string,
  body: string,
  nowSec: number,
): VerifyResult {
  if (!key) return { ok: false, reason: 'not_configured' };
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

/**
 * Headers for `GET ${ADMIN_CONFIG_URL}`. Sends both the sender scheme (`Authorization`) and the
 * scheme apps/web/app/api/admin/config/route.ts verifies:
 *   x-bootr-timestamp: ts, x-bootr-signature: hex(HMAC-SHA256(key, `${ts}.GET.${pathname}`))
 */
export function adminConfigHeaders(key: string, url: string, nowSec = Math.floor(Date.now() / 1000)) {
  const u = new URL(url);
  const ts = String(nowSec);
  return {
    authorization: signRequest(key, 'GET', u.pathname + u.search, '', nowSec),
    'x-bootr-timestamp': ts,
    'x-bootr-signature': hmacHex(key, `${ts}.GET.${u.pathname}`),
  };
}
