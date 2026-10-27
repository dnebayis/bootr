/**
 * Server-side client for apps/sender. Web Crypto only.
 *
 *   internal API: `Authorization: HMAC <ts>:<hex>` where
 *     hex = HMAC-SHA256(SENDER_SERVICE_KEY, ts + "\n" + METHOD + "\n" + path(+query) + "\n" + hex(sha256(body)))
 *   /oauth/start: `sig` = HMAC-SHA256(SENDER_SERVICE_KEY, "oauth-start\n" + agentId + "\n" + state + "\n" + ts [+ "\nreconnect=1"])
 * (apps/sender/src/auth.ts and src/oauth.ts are the reference implementations.)
 *
 * Draft ownership: a launch draft id may only be connected from the browser that registered it
 * (`POST /api/x/draft`), which receives an HttpOnly, SameSite=Strict cookie with an HMAC tag per draft.
 * A link to `/api/x/start` sent by someone else therefore cannot bind the victim's X account to the
 * sender's draft (consent phishing), and `reconnect=1` is only honoured for a draft this browser owns.
 */
import { senderEnv } from './env';
import { hmacHex, safeEqual } from './session-core';

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

export function oauthStartSignature(key: string, agentId: string, state: string, ts: string, reconnect = false): Promise<string> {
  return hmacHex(key, `oauth-start\n${agentId}\n${state}\n${ts}${reconnect ? '\nreconnect=1' : ''}`);
}

/**
 * Signed `/oauth/start` URL on the browser-facing sender origin; `redirect=1` makes the sender 302 to X.
 * `reconnect` (signed) lets the sender replace the draft's current X account; only set it when the
 * form is replacing the handle it shows.
 */
export async function oauthStartUrl(agentId: string, state: string, opts: { reconnect?: boolean; nowSec?: number } = {}): Promise<string | null> {
  const { serviceKey, publicUrl } = senderEnv();
  if (!serviceKey || !publicUrl) return null;
  const ts = String(opts.nowSec ?? Math.floor(Date.now() / 1000));
  const sig = await oauthStartSignature(serviceKey, agentId, state, ts, opts.reconnect);
  const q = new URLSearchParams({ agentId, state, ts, sig, ...(opts.reconnect ? { reconnect: '1' } : {}), redirect: '1' });
  return `${publicUrl}/oauth/start?${q.toString()}`;
}

// ------------------------------------------------------------------ draft ownership cookie

export const DRAFT_COOKIE = 'bootr_x_drafts';
export const DRAFT_COOKIE_PATH = '/api/x';
export const DRAFT_TTL_S = 24 * 60 * 60;
/** Drafts remembered per browser (one per open launch tab is plenty). */
const MAX_DRAFTS = 4;

function draftTag(key: string, draftId: string): Promise<string> {
  return hmacHex(key, `x-draft\n${draftId}`).then((h) => h.slice(0, 32));
}

function parseDraftCookie(value: string | undefined): { id: string; tag: string }[] {
  return (value ?? '')
    .split('~')
    .map((p) => {
      const [id, tag] = p.split('.');
      return { id: id ?? '', tag: tag ?? '' };
    })
    .filter((d) => isDraftId(d.id) && /^[0-9a-f]{32}$/.test(d.tag));
}

/** Cookie value after registering `draftId` (most recent first, at most MAX_DRAFTS). Null when unconfigured. */
export async function registerDraft(current: string | undefined, draftId: string): Promise<string | null> {
  const { serviceKey } = senderEnv();
  if (!serviceKey) return null;
  const entry = { id: draftId, tag: await draftTag(serviceKey, draftId) };
  const rest = parseDraftCookie(current).filter((d) => d.id !== draftId);
  return [entry, ...rest]
    .slice(0, MAX_DRAFTS)
    .map((d) => `${d.id}.${d.tag}`)
    .join('~');
}

/** True when this browser registered `draftId` (valid HMAC tag in its draft cookie). */
export async function ownsDraft(cookie: string | undefined, draftId: string): Promise<boolean> {
  const { serviceKey } = senderEnv();
  if (!serviceKey) return false;
  const expected = await draftTag(serviceKey, draftId);
  return parseDraftCookie(cookie).some((d) => d.id === draftId && safeEqual(d.tag, expected));
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
