/**
 * Server-only configuration. Read at call time from `process.env` (never inlined into a client bundle:
 * none of these are NEXT_PUBLIC_*). Import only from route handlers / server code.
 */
import { env } from '@/lib/env';

if (typeof window !== 'undefined') throw new Error('lib/server/env must not be imported in the browser');

/** Minimum length of every HMAC service key (H-1). Shorter keys are treated as unset. */
export const MIN_SERVICE_KEY_LENGTH = 32;

function str(v: string | undefined): string {
  return (v ?? '').trim();
}

function serviceKey(name: string): string | null {
  const v = str(process.env[name]);
  return v.length >= MIN_SERVICE_KEY_LENGTH ? v : null;
}

export type SenderServerEnv = {
  /** HMAC key shared with apps/sender (SENDER_SERVICE_KEY, ≥ 32 chars); null when unset or too short. */
  serviceKey: string | null;
  /** Browser-facing sender origin used for the `/oauth/start` redirect. */
  publicUrl: string;
  /** Server-to-server sender origin used for the internal API (SENDER_URL, else the public URL). */
  internalUrl: string;
};

export function senderEnv(): SenderServerEnv {
  const publicUrl = (str(process.env.NEXT_PUBLIC_SENDER_PUBLIC_URL) || str(process.env.SENDER_URL)).replace(/\/$/, '');
  const internalUrl = (str(process.env.SENDER_URL) || publicUrl).replace(/\/$/, '');
  return { serviceKey: serviceKey('SENDER_SERVICE_KEY'), publicUrl, internalUrl };
}

/**
 * Inference relay origin for server-side reads (`/api/models`): INFERENCE_URL (the internal relay
 * address), else NEXT_PUBLIC_INFERENCE_URL. Empty when neither is set.
 */
export function inferenceUrl(): string {
  return (str(process.env.INFERENCE_URL) || str(process.env.NEXT_PUBLIC_INFERENCE_URL)).replace(/\/$/, '');
}

/**
 * Key that authenticates the indexer's signed `GET /api/admin/config` (INDEXER_SERVICE_KEY).
 * Migration only: while INDEXER_SERVICE_KEY is unset, SENDER_SERVICE_KEY is accepted (a warning is
 * logged at startup). An INDEXER_SERVICE_KEY that is set but too short disables service reads.
 */
export function adminConfigReadKey(): { key: string; source: 'INDEXER_SERVICE_KEY' | 'SENDER_SERVICE_KEY' } | null {
  if (str(process.env.INDEXER_SERVICE_KEY)) {
    const key = serviceKey('INDEXER_SERVICE_KEY');
    return key ? { key, source: 'INDEXER_SERVICE_KEY' } : null;
  }
  const fallback = serviceKey('SENDER_SERVICE_KEY');
  return fallback ? { key: fallback, source: 'SENDER_SERVICE_KEY' } : null;
}

export type PinataServerEnv = {
  /** Pinata API JWT (PINATA_JWT, scope `org:files:write`); null when unset. */
  jwt: string | null;
  /**
   * Mock pinning: `/api/upload` returns a deterministic CID computed locally and pins nothing.
   * On with PINATA_MOCK=1, or in app mock mode (NEXT_PUBLIC_USE_MOCK / no indexer) while PINATA_JWT is unset.
   */
  mock: boolean;
};

export function pinataEnv(): PinataServerEnv {
  const jwt = str(process.env.PINATA_JWT) || null;
  return { jwt, mock: str(process.env.PINATA_MOCK) === '1' || (env.useMock && !jwt) };
}

/**
 * Canonical site origin (`NEXT_PUBLIC_SITE_URL`, default https://bootr.fun). SIWE domain/URI and the
 * admin CSRF origin check compare against this, never against `Host` / `X-Forwarded-Host` (M-3).
 */
export function siteOrigin(): URL {
  return new URL(env.siteUrl);
}

/**
 * Origins accepted for SIWE and same-origin checks: the canonical site origin, plus a loopback origin
 * (localhost / 127.0.0.1, any port) under `next dev` only, so local sign-in works without config.
 */
export function isAllowedOrigin(origin: string | URL): boolean {
  let u: URL;
  try {
    u = typeof origin === 'string' ? new URL(origin) : origin;
  } catch {
    return false;
  }
  if (u.origin === siteOrigin().origin) return true;
  return process.env.NODE_ENV === 'development' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

/** Startup report for instrumentation.ts: misconfigured secrets are logged loudly, values never. */
export function configReport(): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const short = (name: string) => {
    const v = str(process.env[name]);
    return v !== '' && v.length < MIN_SERVICE_KEY_LENGTH;
  };
  if (short('SENDER_SERVICE_KEY')) {
    errors.push(`SENDER_SERVICE_KEY is shorter than ${MIN_SERVICE_KEY_LENGTH} characters: X connect (/api/x/*) is disabled.`);
  } else if (!str(process.env.SENDER_SERVICE_KEY) && senderEnv().publicUrl && !env.useMock) {
    errors.push('SENDER_SERVICE_KEY is not set: X connect (/api/x/*) is disabled.');
  }
  if (short('INDEXER_SERVICE_KEY')) {
    errors.push(`INDEXER_SERVICE_KEY is shorter than ${MIN_SERVICE_KEY_LENGTH} characters: signed GET /api/admin/config is disabled.`);
  } else if (!str(process.env.INDEXER_SERVICE_KEY)) {
    if (adminConfigReadKey()) {
      warnings.push(
        'INDEXER_SERVICE_KEY is not set: GET /api/admin/config accepts SENDER_SERVICE_KEY signatures (migration fallback). Set INDEXER_SERVICE_KEY here and in the indexer, then remove this fallback.',
      );
    } else {
      warnings.push('INDEXER_SERVICE_KEY is not set: the indexer cannot read /api/admin/config.');
    }
  }
  if (!pinataEnv().jwt && !pinataEnv().mock) {
    warnings.push('PINATA_JWT is not set: image uploads (/api/upload) answer 503 and coins cannot be launched with an image.');
  }
  const session = str(process.env.SESSION_SECRET);
  if (session && session.length < 32) warnings.push('SESSION_SECRET is shorter than 32 characters; use a long random secret.');
  if (process.env.NODE_ENV === 'production' && !str(process.env.NEXT_PUBLIC_SITE_URL)) {
    warnings.push(`NEXT_PUBLIC_SITE_URL is not set: admin sign-in only accepts ${env.siteUrl}.`);
  }
  return { errors, warnings };
}
