import { z } from 'zod';

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte address');
export const privateKeySchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte key');

export const chainIdSchema = z.coerce
  .number()
  .int()
  .refine((id) => id === 8453 || id === 84532, {
    message: 'CHAIN_ID must be 8453 (Base) or 84532 (Base Sepolia)',
  });

/** Env vars shared by most services. */
export const baseEnvSchema = z.object({
  CHAIN_ID: chainIdSchema,
  DATABASE_URL: z.string().min(1),
  BASE_RPC_URL: z.string().url().optional(),
  BASE_SEPOLIA_RPC_URL: z.string().url().optional(),
});

/** Env vars for services that talk to the X (Twitter) API. */
export const xEnvSchema = z.object({
  X_CLIENT_ID: z.string().min(1),
  X_CLIENT_SECRET: z.string().min(1),
  X_REDIRECT_URI: z.string().url(),
});

/** Env vars for the supervisor <-> sender trust boundary and agent runtime. */
export const serviceEnvSchema = z.object({
  SENDER_SERVICE_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  SESSION_SIGNER_PRIVATE_KEY: privateKeySchema,
  INFERENCE_PROVIDER_URL: z.string().url(),
  X402_FACILITATOR_URL: z.string().url(),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type XEnv = z.infer<typeof xEnvSchema>;
export type ServiceEnv = z.infer<typeof serviceEnvSchema>;
