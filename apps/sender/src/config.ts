import { z } from 'zod';

/** Treat `VAR=` (empty) as unset so defaults apply. */
const blank = (v: unknown) => (v === '' ? undefined : v);
const optionalUrl = z.preprocess(blank, z.string().url().optional());
const num = (schema: z.ZodNumber, def: number) => z.preprocess(blank, schema.default(def));

export const configSchema = z.object({
  PORT: num(z.coerce.number().int().positive(), 3002),
  X_CLIENT_ID: z.string().min(1),
  X_CLIENT_SECRET: z.string().min(1),
  X_REDIRECT_URI: z.string().url(),
  SENDER_SERVICE_KEY: z.string().min(1),
  SENDER_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'SENDER_ENCRYPTION_KEY must be 32 bytes of hex (64 chars)'),
  DATABASE_URL: z.string().min(1),
  /** Where the browser is sent after /oauth/callback. Unset = JSON response. */
  SENDER_OAUTH_RETURN_URL: optionalUrl,
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
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}
