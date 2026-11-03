import { createHash, randomBytes } from 'node:crypto';
import { lt } from 'drizzle-orm';
import type { SenderContext } from './context.js';
import { decrypt, encrypt, hmacHex, safeEqualHex } from './crypto.js';
import { oauthStates } from './db/schema.js';

/** `media.write` is what `POST /2/media/upload` needs; accounts connected before it was requested must reconnect to post images. */
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'] as const;
export const MEDIA_SCOPE = 'media.write';
export const STATE_TTL_SEC = 10 * 60;

export interface OAuthSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  serviceKey: string;
  encryptionKey: Buffer;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string;
}

export type TokenResult =
  | { ok: true; tokens: TokenSet }
  | { ok: false; definite: boolean; status?: number; code: string; message: string };

interface StatePayload {
  /** agentId */
  a: string;
  /** caller (web app) state, echoed back on return */
  s: string;
  /** expiry, unix seconds */
  e: number;
  /** PKCE code_verifier, AES-256-GCM encrypted */
  v: string;
  /** nonce (single-use: recorded in `sender_oauth_states` by the callback) */
  n: string;
  /** base64url(sha256(browser binding secret)); the secret is in an HttpOnly cookie set by /oauth/start */
  h: string;
  /** 1 when the signed start allowed replacing an existing, different connected account */
  r?: 1;
}

/** Name of the per-flow browser binding cookie (one per state nonce, so parallel flows do not clash). */
export const bindingCookieName = (nonce: string) => `bootr_xoauth_${nonce}`;
/** The cookie is only ever sent back to the callback. */
export const BINDING_COOKIE_PATH = '/oauth/callback';

export const bindingHash = (secret: string) =>
  createHash('sha256').update(secret, 'utf8').digest('base64url');

/**
 * Signature the web app attaches to `/oauth/start` redirects:
 *   HMAC(key, "oauth-start\n"+agentId+"\n"+state+"\n"+ts)                  (connect)
 *   HMAC(key, "oauth-start\n"+agentId+"\n"+state+"\n"+ts+"\nreconnect=1")   (replace a connected account)
 */
export function oauthStartSignature(
  serviceKey: string,
  agentId: string,
  state: string,
  ts: string,
  reconnect = false,
): string {
  return hmacHex(
    serviceKey,
    `oauth-start\n${agentId}\n${state}\n${ts}${reconnect ? '\nreconnect=1' : ''}`,
  );
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * The OAuth `state` sent to X is `<base64url(json)>.<hmac>`; the HMAC (SENDER_SERVICE_KEY) makes
 * it tamper-proof and the PKCE verifier inside is encrypted, so no server-side session is needed.
 */
export function signState(settings: OAuthSettings, payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmacHex(settings.serviceKey, `oauth-state\n${body}`)}`;
}

export interface OpenedState {
  agentId: string;
  clientState: string;
  verifier: string;
  nonce: string;
  /** Unix seconds. */
  expiresAt: number;
  bindingHash: string;
  reconnect: boolean;
}

export function openState(
  settings: OAuthSettings,
  state: string,
  nowSec: number,
): OpenedState | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  if (!safeEqualHex(hmacHex(settings.serviceKey, `oauth-state\n${body}`), sig)) return null;
  let p: StatePayload;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    return null;
  }
  if (typeof p.e !== 'number' || p.e < nowSec) return null;
  if (typeof p.n !== 'string' || !/^[\w-]{8,64}$/.test(p.n) || typeof p.h !== 'string') return null;
  try {
    const verifier = decrypt(p.v, settings.encryptionKey, `pkce:${p.a}:${p.n}`);
    return {
      agentId: p.a,
      clientState: p.s,
      verifier,
      nonce: p.n,
      expiresAt: p.e,
      bindingHash: p.h,
      reconnect: p.r === 1,
    };
  } catch {
    return null;
  }
}

export interface AuthorizeStart {
  url: string;
  nonce: string;
  /** Random secret for the HttpOnly binding cookie; only its hash is inside `state`. */
  bindingSecret: string;
}

export function buildAuthorizeUrl(
  settings: OAuthSettings,
  agentId: string,
  clientState: string,
  nowSec: number,
  opts: { reconnect?: boolean } = {},
): AuthorizeStart {
  const { verifier, challenge } = pkcePair();
  const nonce = randomBytes(12).toString('base64url');
  const bindingSecret = randomBytes(32).toString('base64url');
  const state = signState(settings, {
    a: agentId,
    s: clientState,
    e: nowSec + STATE_TTL_SEC,
    v: encrypt(verifier, settings.encryptionKey, `pkce:${agentId}:${nonce}`),
    n: nonce,
    h: bindingHash(bindingSecret),
    ...(opts.reconnect ? { r: 1 as const } : {}),
  });
  const url = new URL(settings.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('redirect_uri', settings.redirectUri);
  url.searchParams.set('scope', X_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), nonce, bindingSecret };
}

async function tokenRequest(
  settings: OAuthSettings,
  form: Record<string, string>,
  nowMs: number,
): Promise<TokenResult> {
  const fetchFn = settings.fetch ?? fetch;
  const basic = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64');
  let res: Response;
  try {
    res = await fetchFn(settings.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ ...form, client_id: settings.clientId }).toString(),
      signal: AbortSignal.timeout(settings.timeoutMs ?? 15_000),
    });
  } catch {
    return {
      ok: false,
      definite: false,
      code: 'network_error',
      message: 'token endpoint unreachable',
    };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    const code = typeof json.error === 'string' ? json.error : `http_${res.status}`;
    return {
      ok: false,
      definite: res.status >= 400 && res.status < 500,
      status: res.status,
      code,
      message: `token endpoint: ${code}`,
    };
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 7200;
  return {
    ok: true,
    tokens: {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      expiresAt: new Date(nowMs + expiresIn * 1000),
      scopes: typeof json.scope === 'string' ? json.scope : X_SCOPES.join(' '),
    },
  };
}

export function exchangeCode(
  settings: OAuthSettings,
  code: string,
  verifier: string,
  nowMs: number,
): Promise<TokenResult> {
  return tokenRequest(
    settings,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: settings.redirectUri,
      code_verifier: verifier,
    },
    nowMs,
  );
}

export function refreshTokens(
  settings: OAuthSettings,
  refreshToken: string,
  nowMs: number,
): Promise<TokenResult> {
  return tokenRequest(
    settings,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    nowMs,
  );
}

/**
 * Marks a state as used. Returns false when it was already consumed (replayed callback URL).
 * Expired rows are purged opportunistically; a purged nonce belongs to an expired state, which
 * `openState` already rejects.
 */
export async function consumeState(
  ctx: SenderContext,
  opened: Pick<OpenedState, 'nonce' | 'agentId' | 'expiresAt'>,
): Promise<boolean> {
  const now = ctx.now();
  const inserted = await ctx.db
    .insert(oauthStates)
    .values({
      nonce: opened.nonce,
      agentId: opened.agentId,
      usedAt: now,
      expiresAt: new Date(opened.expiresAt * 1000),
    })
    .onConflictDoNothing()
    .returning({ nonce: oauthStates.nonce });
  await ctx.db
    .delete(oauthStates)
    .where(lt(oauthStates.expiresAt, new Date(now.getTime() - 60_000)))
    .catch(() => undefined);
  return inserted.length === 1;
}
