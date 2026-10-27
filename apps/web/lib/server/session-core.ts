/**
 * HMAC-signed tokens for the admin session and SIWE nonce cookies.
 * Pure Web Crypto (no Node or Next imports) so it runs in proxy.ts and route handlers alike.
 *
 * token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(SESSION_SECRET, payloadPart))
 */

export const ADMIN_COOKIE = 'bootr_admin';
export const NONCE_COOKIE = 'bootr_siwe_nonce';
export const CONSOLE_HEADER = 'x-bootr-console-slug';
export const SESSION_TTL_S = 8 * 60 * 60;

export type AdminSession = { a: string; e: number; k: 'admin' };
export type NonceToken = { n: string; e: number; k: 'nonce' };

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function sessionSecret(): string | null {
  const s = process.env.SESSION_SECRET ?? '';
  return s.length >= 16 ? s : null;
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(data)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison for equal-length strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signToken(payload: AdminSession | NonceToken): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error('SESSION_SECRET is not configured (min 16 chars)');
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifyToken<T extends AdminSession | NonceToken>(token: string | undefined | null, kind: T['k']): Promise<T | null> {
  const secret = sessionSecret();
  if (!secret || !token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig) as BufferSource, enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
    if (payload.k !== kind || typeof payload.e !== 'number' || payload.e * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function adminAddresses(): string[] {
  return (process.env.ADMIN_ADDRESSES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

export function isAdminAddress(addr: string): boolean {
  return adminAddresses().includes(addr.toLowerCase());
}

/** The console slug; null disables the console entirely. */
export function consoleSlug(): string | null {
  const s = (process.env.ADMIN_CONSOLE_SLUG ?? '').trim();
  return /^[A-Za-z0-9_-]{8,}$/.test(s) ? s : null;
}

export async function verifyAdminCookie(token: string | undefined | null): Promise<AdminSession | null> {
  const s = await verifyToken<AdminSession>(token, 'admin');
  return s && isAdminAddress(s.a) ? s : null;
}
