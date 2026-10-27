/**
 * Response security headers (L-7), applied by proxy.ts to every page and API response.
 *
 * The CSP has no nonces: pages are prerendered (Cache Components / partial prefetching), so inline
 * scripts are allowed with 'unsafe-inline' (Next's documented "without nonces" policy). It still
 * blocks framing, plugins, base-tag and form hijacking, and limits frames to DexScreener charts and
 * the wallet providers' verification iframes.
 *
 * Pure Web APIs (no Node imports): proxy.ts may bundle it separately from route handlers.
 */
import { env } from '@/lib/env';

/** Frames we embed: DexScreener charts, WalletConnect verify/secure iframes, Coinbase wallet. */
const FRAME_SRC = [
  'https://dexscreener.com',
  'https://*.dexscreener.com',
  'https://verify.walletconnect.org',
  'https://verify.walletconnect.com',
  'https://secure.walletconnect.org',
  'https://secure.walletconnect.com',
  'https://keys.coinbase.com',
];

function origin(url: string): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(isDev = process.env.NODE_ENV === 'development'): string {
  // Wallet RPCs, WalletConnect relays and the indexer/inference APIs are https/wss; explicit origins
  // cover plain-http local services (e.g. an indexer on localhost).
  const connect = new Set(["'self'", 'https:', 'wss:']);
  for (const u of [env.indexerUrl, env.inferenceUrl, env.senderPublicUrl, env.rpcUrl]) {
    const o = origin(u);
    if (o?.startsWith('http:')) {
      connect.add(o);
      connect.add(o.replace(/^http:/, 'ws:'));
    }
  }
  if (isDev) ['http://localhost:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'ws://127.0.0.1:*'].forEach((o) => connect.add(o));
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    // Token images are creator-supplied https URLs or data: URLs.
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': [...connect],
    'frame-src': FRAME_SRC,
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

export function securityHeaders(pathname: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': contentSecurityPolicy(),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  // The X connect routes set `no-referrer` themselves (the sender URL carries a signed query).
  if (!pathname.startsWith('/api/x/')) headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
  if (process.env.NODE_ENV === 'production' && env.siteUrl.startsWith('https:')) {
    headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  }
  return headers;
}
