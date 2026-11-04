/**
 * The project's X account, as a coin link. Shared by the launch form, the draft store and the agent launch API
 * so every path accepts the same spellings and stores the same URL. No imports: safe on the client and the server.
 */

/** An X handle: 1 to 15 letters, digits or underscores (X's own rule). */
export const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** The handle inside an `https://x.com/<handle>` or `https://twitter.com/<handle>` profile URL, else null. */
export function xHandleOfUrl(url: string): string | null {
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i.exec(url.trim());
  return m ? m[1]! : null;
}

/**
 * One optional X link as typed: `https://x.com/<handle>`, `https://twitter.com/<handle>`, `@handle` or `handle`.
 * Null when absent or empty, undefined when present but not an X profile, else the canonical `https://x.com/<handle>`.
 */
export function normalizeXLink(v: unknown): string | null | undefined {
  if (v == null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return null;
  if (s.length > 200) return undefined;
  const handle = /^https?:\/\//i.test(s) ? xHandleOfUrl(s) : /^@?[A-Za-z0-9_]{1,15}$/.test(s) ? s.replace(/^@/, '') : null;
  return handle && X_HANDLE.test(handle) ? `https://x.com/${handle}` : undefined;
}
