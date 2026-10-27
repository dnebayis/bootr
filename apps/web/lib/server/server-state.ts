/**
 * In-process, short-lived security state (L-3 / M-3):
 *  - SIWE nonces: issued by /api/siwe/nonce, consumed once by /api/siwe/verify (10 min TTL);
 *  - revoked admin session ids: written by /api/siwe/logout, checked by the console page and the
 *    admin API until the session would have expired anyway.
 *
 * Kept on `globalThis` so every route bundle in the server process shares one copy. This assumes a
 * single web instance (the admin config is a local file for the same reason). A restart forgets
 * revocations, so a logged-out token becomes usable again until its expiry (at most SESSION_TTL_S);
 * rotate SESSION_SECRET to revoke every session at once.
 */
if (typeof window !== 'undefined') throw new Error('lib/server/server-state must not be imported in the browser');

type State = { nonces: Map<string, number>; revoked: Map<string, number> };
const KEY = Symbol.for('bootr.web.server-state');
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (g[KEY] ??= { nonces: new Map(), revoked: new Map() });

const MAX_ENTRIES = 10_000;

function prune(map: Map<string, number>, nowMs: number) {
  for (const [k, exp] of map) if (exp <= nowMs) map.delete(k);
  // Bound memory under a nonce flood: drop the oldest entries.
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
}

export function rememberNonce(nonce: string, expiresAtMs: number, nowMs = Date.now()): void {
  prune(state.nonces, nowMs);
  state.nonces.set(nonce, expiresAtMs);
}

/** True exactly once per issued, unexpired nonce. */
export function consumeNonce(nonce: string, nowMs = Date.now()): boolean {
  const exp = state.nonces.get(nonce);
  state.nonces.delete(nonce);
  return exp !== undefined && exp > nowMs;
}

export function revokeSession(sid: string, expiresAtMs: number, nowMs = Date.now()): void {
  prune(state.revoked, nowMs);
  state.revoked.set(sid, expiresAtMs);
}

export function isSessionRevoked(sid: string, nowMs = Date.now()): boolean {
  const exp = state.revoked.get(sid);
  return exp !== undefined && exp > nowMs;
}
