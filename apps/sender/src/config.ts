import { z } from 'zod';
import { DEFAULT_SITE_URL } from './api-page.js';

/** Treat `VAR=` (empty) as unset so defaults apply. */
const blank = (v: unknown) => (v === '' ? undefined : v);
const optionalUrl = z.preprocess(blank, z.string().url().optional());
const num = (schema: z.ZodNumber, def: number) => z.preprocess(blank, schema.default(def));

export const configSchema = z.object({
  PORT: num(z.coerce.number().int().positive(), 3002),
  X_CLIENT_ID: z.string().min(1),
  X_CLIENT_SECRET: z.string().min(1),
  X_REDIRECT_URI: z.string().url(),
  /**
   * HMAC key for the internal API, the `/oauth/start` signature, OAuth state and receipts. Held by the
   * supervisor and the web app only (never by the indexer). At least 32 characters; no fallback.
   */
  SENDER_SERVICE_KEY: z
    .string({ required_error: 'SENDER_SERVICE_KEY is required' })
    .min(32, 'SENDER_SERVICE_KEY must be at least 32 characters (use `openssl rand -hex 32`)'),
  SENDER_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'SENDER_ENCRYPTION_KEY must be 32 bytes of hex (64 chars)'),
  DATABASE_URL: z.string().min(1),
  /** Where the browser is sent after /oauth/callback. Unset = JSON response. */
  SENDER_OAUTH_RETURN_URL: optionalUrl,
  /** The web app; the page at `GET /` lists the APIs from `<this>/api/catalog`. Never taken from a request. */
  SENDER_SITE_URL: z.preprocess(
    blank,
    z
      .string()
      .url()
      .refine((v) => /^https?:\/\//i.test(v), 'must be an http(s) URL')
      .default(DEFAULT_SITE_URL),
  ),
  /** Reconciliation tick; 0 disables the in-process worker. */
  SENDER_RECONCILE_INTERVAL_MS: num(z.coerce.number().int().nonnegative(), 60_000),
  X_API_BASE_URL: z.preprocess(blank, z.string().url().default('https://api.x.com')),
  X_AUTHORIZE_URL: z.preprocess(
    blank,
    z.string().url().default('https://x.com/i/oauth2/authorize'),
  ),
  X_TIMEOUT_MS: num(z.coerce.number().int().positive(), 15_000),
  SENDER_DEFAULT_POSTS_PER_DAY: num(z.coerce.number().int().nonnegative(), 24),
  SENDER_DEFAULT_MENTION_INTERVAL_SEC: num(z.coerce.number().int().nonnegative(), 300),
  /** Requests per minute per client IP on the public read API (`GET /public/posts/:agentId`); 0 = off. */
  SENDER_PUBLIC_RATE_LIMIT_PER_MIN: num(z.coerce.number().int().nonnegative(), 120),
  /** `1`/`true`: rate-limit by the right-most X-Forwarded-For entry (one trusted proxy in front). */
  SENDER_TRUST_PROXY: z.preprocess(
    blank,
    z
      .enum(['0', '1', 'true', 'false'])
      .default('0')
      .transform((v) => v === '1' || v === 'true'),
  ),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}

/** One readable line per invalid variable, e.g. for a startup error log. Never echoes values. */
export function describeConfigError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}
