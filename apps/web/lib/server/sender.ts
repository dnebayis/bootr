/**
 * Server-side client for apps/sender. Web Crypto only.
 *
 *   internal API: `Authorization: HMAC <ts>:<hex>` where
 *     hex = HMAC-SHA256(SENDER_SERVICE_KEY, ts + "\n" + METHOD + "\n" + path(+query) + "\n" + hex(sha256(body)))
 *   /oauth/start: `sig` = HMAC-SHA256(SENDER_SERVICE_KEY, "oauth-start\n" + agentId + "\n" + state + "\n" + ts)
 * (apps/sender/src/auth.ts and src/oauth.ts are the reference implementations.)
 */
import { senderEnv } from './env';
import { hmacHex } from './session-core';

const enc = new TextEncoder();

/** Launch-form draft ids are `crypto.randomUUID()`; only those may be bound from the browser (never a numeric ERC-8004 id). */
export function isDraftId(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
}

/** Opaque client state echoed back by the sender; URL-safe, ≤ 128 chars. */
export function isClientState(v: string): boolean {
  return /^[\w.~-]{1,128}$/.test(v);
}

async function sha256Hex(data: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(data)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signSenderRequest(key: string, method: string, path: string, body = '', nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const ts = String(nowSec);
  const canonical = `${ts}\n${method.toUpperCase()}\n${path}\n${await sha256Hex(body)}`;
  return `HMAC ${ts}:${await hmacHex(key, canonical)}`;
}

export function oauthStartSignature(key: string, agentId: string, state: string, ts: string): Promise<string> {
  return hmacHex(key, `oauth-start\n${agentId}\n${state}\n${ts}`);
}

/** Signed `/oauth/start` URL on the browser-facing sender origin; `redirect=1` makes the sender 302 to X. */
export async function oauthStartUrl(agentId: string, state: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string | null> {
  const { serviceKey, publicUrl } = senderEnv();
  if (!serviceKey || !publicUrl) return null;
  const ts = String(nowSec);
  const sig = await oauthStartSignature(serviceKey, agentId, state, ts);
  const q = new URLSearchParams({ agentId, state, ts, sig, redirect: '1' });
  return `${publicUrl}/oauth/start?${q.toString()}`;
}

export type SenderAccountView = { connected: boolean; handle: string | null };

export class SenderUnavailable extends Error {}

/** GET /internal/account/:agentId, reduced to what the browser may see. */
export async function senderAccount(agentId: string): Promise<SenderAccountView> {
  const { serviceKey, internalUrl } = senderEnv();
  if (!serviceKey || !internalUrl) throw new SenderUnavailable('sender is not configured');
  const path = `/internal/account/${encodeURIComponent(agentId)}`;
  const res = await fetch(`${internalUrl}${path}`, {
    method: 'GET',
    headers: { authorization: await signSenderRequest(serviceKey, 'GET', path) },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new SenderUnavailable(`sender responded ${res.status}`);
  const a = (await res.json()) as { connected?: unknown; revoked?: unknown; handle?: unknown };
  const handle = typeof a.handle === 'string' && a.handle ? a.handle : null;
  const connected = a.connected === true && a.revoked !== true && !!handle;
  return { connected, handle: connected ? handle : null };
}
