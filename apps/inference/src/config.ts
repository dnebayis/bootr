import { isAddress, type Address } from 'viem';
import { z } from 'zod';

export const BASE_SEPOLIA = 'eip155:84532';
export const BASE_MAINNET = 'eip155:8453';

export const TESTNET_FACILITATOR_URL = 'https://x402.org/facilitator';
export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

export const configSchema = z
  .object({
    INFERENCE_PORT: z.coerce.number().int().positive().default(3003),
    DATABASE_URL: z.string().min(1),
    OPENROUTER_API_KEY: z.string().min(1),
    X402_NETWORK: z.enum([BASE_SEPOLIA, BASE_MAINNET]).default(BASE_SEPOLIA),
    X402_FACILITATOR_URL: optionalString.pipe(z.string().url().optional()),
    CDP_API_KEY_ID: optionalString,
    CDP_API_KEY_SECRET: optionalString,
    INFERENCE_PAYTO_ADDRESS: z
      .string()
      .refine((v) => isAddress(v), 'INFERENCE_PAYTO_ADDRESS must be an EVM address')
      .transform((v) => v as Address),
    /** Comma-separated x402 schemes to advertise, in preference order. */
    INFERENCE_X402_SCHEMES: z
      .string()
      .default('exact')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(['exact', 'upto'])).min(1)),
    INFERENCE_PRICE_TABLE_JSON: optionalString,
    /** Optional Base RPC used to reconcile `unknown` rows via USDC `authorizationState`. */
    INFERENCE_RPC_URL: optionalString.pipe(z.string().url().optional()),
    INFERENCE_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    /** x402 `maxTimeoutSeconds`: lifetime of the client's EIP-3009 authorization. */
    INFERENCE_PAYMENT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  })
  .superRefine((cfg, ctx) => {
    // Upstream + settlement must finish before the client's authorization expires.
    if (cfg.INFERENCE_UPSTREAM_TIMEOUT_MS + 30_000 > cfg.INFERENCE_PAYMENT_TIMEOUT_SECONDS * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['INFERENCE_PAYMENT_TIMEOUT_SECONDS'],
        message:
          'INFERENCE_PAYMENT_TIMEOUT_SECONDS must exceed INFERENCE_UPSTREAM_TIMEOUT_MS by at least 30s',
      });
    }
    const facilitator = resolveFacilitatorUrl(cfg.X402_NETWORK, cfg.X402_FACILITATOR_URL);
    if (isCdpFacilitator(facilitator) && (!cfg.CDP_API_KEY_ID || !cfg.CDP_API_KEY_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CDP_API_KEY_ID'],
        message: 'CDP_API_KEY_ID and CDP_API_KEY_SECRET are required for the CDP facilitator',
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

export function resolveFacilitatorUrl(network: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  return network === BASE_MAINNET ? CDP_FACILITATOR_URL : TESTNET_FACILITATOR_URL;
}

export function isCdpFacilitator(url: string): boolean {
  try {
    return new URL(url).hostname === 'api.cdp.coinbase.com';
  } catch {
    return false;
  }
}

/** Empty values (e.g. copied from .env.example) count as unset so defaults apply. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  return configSchema.parse(cleaned);
}
