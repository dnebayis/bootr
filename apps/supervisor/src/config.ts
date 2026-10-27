import { z } from 'zod';

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte 0x-prefixed hex key');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte address');
/** Empty strings in .env are treated as unset. */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
const optionalHexKey = z.preprocess((v) => (v === '' ? undefined : v), hexKey.optional());
const int = (def: number, min = 0) => z.preprocess((v) => (v === '' || v === undefined ? def : v), z.coerce.number().int().min(min));
const num = (def: number, min = 0) => z.preprocess((v) => (v === '' || v === undefined ? def : v), z.coerce.number().min(min));
const bool = (def: 'true' | 'false') => z.preprocess((v) => (v === '' || v === undefined ? def : v), z.enum(['true', 'false']).transform((v) => v === 'true'));

export const configSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    CHAIN_ID: z.coerce
      .number()
      .int()
      .refine((id) => id === 8453 || id === 84532, { message: 'CHAIN_ID must be 8453 (Base) or 84532 (Base Sepolia)' }),
    BASE_RPC_URL: optionalUrl,
    BASE_SEPOLIA_RPC_URL: optionalUrl,
    /** ERC-4337 bundler (ZeroDev / Pimlico) JSON-RPC URL. */
    BUNDLER_URL: z.string().url(),
    /** Optional ERC-7677 paymaster URL. Unset = the kernel pays gas from its own ETH / EntryPoint deposit. */
    PAYMASTER_URL: optionalUrl,
    /**
     * Optional bundler for enable-mode userOps (session-key install / rotation). Installing a permission runs the
     * policies' `onInstall` during validation, which strict ERC-7562 bundlers (CDP) reject with an opcode validation
     * error; ZeroDev accepts it. Unset = BUNDLER_URL.
     */
    ENABLE_MODE_BUNDLER_URL: optionalUrl,
    /** Paymaster for enable-mode userOps. Unset = PAYMASTER_URL when ENABLE_MODE_BUNDLER_URL is unset, else none. */
    ENABLE_MODE_PAYMASTER_URL: optionalUrl,
    /**
     * Self-bundle enable-mode userOps: the admin signer (guardian owner EOA) calls `EntryPoint.handleOps([op], admin)`
     * directly instead of going through a bundler, with fixed gas limits and no paymaster (the kernel pays its prefund
     * from its own ETH balance / EntryPoint deposit). Installs are rare (one per agent + a rotation every ~27 days), so
     * this removes the dependency on a lenient bundler. Requires ADMIN_PRIVATE_KEY.
     */
    ENABLE_MODE_SELF_BUNDLE: bool('false'),
    /** Session key that signs every agent userOp (never anything through ERC-1271). */
    SESSION_SIGNER_PRIVATE_KEY: hexKey,
    /**
     * Master secret from which every agent's x402 spender EOA is derived (spender.ts). Must differ from the
     * session signer and the admin key. The spender signs the EIP-3009 payments; the kernel only funds it.
     */
    SPENDER_MASTER_KEY: hexKey,
    /** Guardian owner. Only used by AdminSigner for approveSessionKey / revokeSessionKey transactions. */
    ADMIN_PRIVATE_KEY: optionalHexKey,
    BOOTR_LAUNCHER_ADDRESS: address,
    BOOTR_GUARDIAN_ADDRESS: address,
    /** Block to start scanning AgentLaunched events from when no cursor exists yet. */
    LAUNCHER_START_BLOCK: int(0),
    /** Max block range per eth_getLogs call when scanning AgentLaunched (public Base RPCs allow 200; archive RPCs 2000+). */
    LAUNCH_LOG_CHUNK_BLOCKS: int(2000, 1),
    SENDER_URL: z.string().url(),
    /** HMAC key of apps/sender's internal API (the sender requires 32+ characters). */
    SENDER_SERVICE_KEY: z.string().min(32, 'SENDER_SERVICE_KEY must be at least 32 characters'),
    /** HMAC key for this service's own /internal API. Required and distinct from the other service keys (M-03). */
    SUPERVISOR_SERVICE_KEY: z.string().min(32, 'SUPERVISOR_SERVICE_KEY must be at least 32 characters'),
    /** HMAC key of apps/indexer's internal API (`/internal/agent/:kernel/social`); its own key, not the sender's. */
    INDEXER_SERVICE_KEY: z.string().min(32, 'INDEXER_SERVICE_KEY must be at least 32 characters'),
    INFERENCE_PROVIDER_URL: z.string().url(),
    INFERENCE_PAYTO_ADDRESS: address,
    INFERENCE_TIMEOUT_MS: int(150_000, 1000),
    INFERENCE_MAX_OUTPUT_TOKENS: int(1024, 16),
    INDEXER_URL: z.string().url(),
    SUPERVISOR_TICK_MS: int(60_000, 1000),
    MAX_AGENTS_PER_TICK: int(10, 1),
    MAX_TOOL_STEPS: int(8, 1),
    SUPERVISOR_PORT: int(3004, 1),
    /** Claimable LP fees (USD) above which claim_fees runs automatically. */
    CLAIM_THRESHOLD_USD: num(5),
    /** USDC balance the fee policy tops the treasury up to by swapping WETH. */
    FUEL_TARGET_USDC: num(20),
    /** Max slippage vs Chainlink ETH/USD passed to BootrSwapHelper (its hard cap is 300). */
    SWAP_SLIPPAGE_BPS: int(100, 1),
    /** Chainlink ETH/USD answers older than this are treated as unavailable (no swap, no USD figures). */
    CHAINLINK_MAX_AGE_SECONDS: int(3600, 1),
    /** Optional web search API (Exa or Brave). Without it `search_web` is hidden from the model. */
    SEARCH_API_URL: optionalUrl,
    SEARCH_API_KEY: optionalString,
    /** Session key policy knobs. */
    SESSION_KEY_VALIDITY_DAYS: int(30, 1),
    SESSION_RATE_LIMIT_PER_HOUR: int(60, 1),
    /** Max USDC (6 dp units) the session key may move to the agent's spender per window (BootrCallPolicy SUM_PER_WINDOW). */
    SESSION_USDC_TRANSFER_CAP: int(50_000_000, 1),
    /** Length of that window in seconds (fixed grid anchored at the permission install). */
    SESSION_USDC_WINDOW_SECONDS: int(86_400, 60),
    /** Fund the spender when its USDC balance drops below this (human USDC). */
    SPENDER_MIN_USDC: num(5),
    /** ...up to this balance (human USDC); never more than the remaining window budget. */
    SPENDER_TARGET_USDC: num(20),
    /** Cumulative gas allowance (wei) enforced by GasPolicy. */
    SESSION_GAS_ALLOWANCE_WEI: z.preprocess((v) => (v === '' || v === undefined ? '100000000000000000' : v), z.string().regex(/^\d+$/)),

    /** Rotate a session key this many days before its TimestampPolicy expires. */
    SESSION_ROTATE_BEFORE_DAYS: int(3, 0),
    USER_OP_RECEIPT_TIMEOUT_MS: int(90_000, 1000),
    /**
     * Base Builder Codes (ERC-8021 attribution). Every agent kernel registers its own code at
     * `BUILDER_CODES_URL`; the code is appended as a calldata suffix to every session userOp.
     * `false` disables both the registration and the suffix.
     */
    BUILDER_CODES_ENABLED: bool('true'),
    BUILDER_CODES_URL: z.preprocess((v) => (v === '' || v === undefined ? 'https://api.base.dev/v1/agents/builder-codes' : v), z.string().url()),
    LOG_LEVEL: z.preprocess((v) => (v === '' || v === undefined ? 'info' : v), z.string()),
  })
  .transform((c) => {
    const rpcUrl = c.CHAIN_ID === 84532 ? c.BASE_SEPOLIA_RPC_URL : c.BASE_RPC_URL;
    return { ...c, RPC_URL: rpcUrl };
  })
  .refine((c) => !!c.RPC_URL, { message: 'BASE_SEPOLIA_RPC_URL (84532) or BASE_RPC_URL (8453) is required' })
  .refine((c) => c.SUPERVISOR_SERVICE_KEY !== c.SENDER_SERVICE_KEY && c.SUPERVISOR_SERVICE_KEY !== c.INDEXER_SERVICE_KEY, { message: 'SUPERVISOR_SERVICE_KEY must differ from SENDER_SERVICE_KEY and INDEXER_SERVICE_KEY (every holder of those keys would be a supervisor admin)' })
  .refine((c) => c.SWAP_SLIPPAGE_BPS <= 300, { message: 'SWAP_SLIPPAGE_BPS must be <= 300 (BootrSwapHelper.MAX_SLIPPAGE_BPS)' })
  .refine((c) => c.SPENDER_MASTER_KEY.toLowerCase() !== c.SESSION_SIGNER_PRIVATE_KEY.toLowerCase() && (!c.ADMIN_PRIVATE_KEY || c.SPENDER_MASTER_KEY.toLowerCase() !== c.ADMIN_PRIVATE_KEY.toLowerCase()), { message: 'SPENDER_MASTER_KEY must differ from SESSION_SIGNER_PRIVATE_KEY and ADMIN_PRIVATE_KEY' })
  .refine((c) => c.SPENDER_TARGET_USDC >= c.SPENDER_MIN_USDC, { message: 'SPENDER_TARGET_USDC must be >= SPENDER_MIN_USDC' })
  .refine((c) => !c.ENABLE_MODE_SELF_BUNDLE || !!c.ADMIN_PRIVATE_KEY, { message: 'ENABLE_MODE_SELF_BUNDLE=true requires ADMIN_PRIVATE_KEY (the admin signer sends handleOps)' });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}
