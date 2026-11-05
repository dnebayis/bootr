import { z } from 'zod';

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte 0x-prefixed hex key');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte address');
/** Empty strings in .env are treated as unset. */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
const optionalHexKey = z.preprocess((v) => (v === '' ? undefined : v), hexKey.optional());
const optionalAddress = z.preprocess((v) => (v === '' ? undefined : v), address.optional());
const addressWithDefault = (def: string) => z.preprocess((v) => (v === '' || v === undefined ? def : v), address);
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
    /**
     * Optional ERC-7677 paymaster URL. Unset (the default) = self-funded gas: the kernel pays every userOp's prefund
     * from its EntryPoint deposit and its own ETH. The creator deposits the first gas (launch form or token page) and
     * the fee policy unwraps the kernel's WETH fees into ETH whenever gas drops under `GAS_MIN_WEI` (gas.ts).
     */
    PAYMASTER_URL: optionalUrl,
    /** Gas (EntryPoint deposit + kernel ETH, wei) under which the fee policy unwraps WETH into ETH (default 0.0002 ETH). */
    GAS_MIN_WEI: z.preprocess((v) => (v === '' || v === undefined ? '200000000000000' : v), z.string().regex(/^\d+$/)),
    /** ...up to this much gas (wei), bounded by the kernel's WETH (default 0.001 ETH). */
    GAS_TARGET_WEI: z.preprocess((v) => (v === '' || v === undefined ? '1000000000000000' : v), z.string().regex(/^\d+$/)),
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
    /** Max wei the admin deposits into the EntryPoint for a kernel's prefund before a self-bundled op (default 0.005 ETH). */
    ENABLE_MODE_MAX_PREFUND_WEI: z.preprocess((v) => (v === '' || v === undefined ? '5000000000000000' : v), z.string().regex(/^\d+$/)),
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
    /**
     * `BootrClankerLauncher` (docs/design/clanker-launch.md): the second launcher the poller follows. Its
     * `AgentLaunched` events register agents with `sv_agents.source = 'clanker'`, whose fees sit in Clanker's
     * lockers instead of the RWAGMI one. Unset = Bootr launches only.
     */
    BOOTR_CLANKER_LAUNCHER_ADDRESS: optionalAddress,
    /**
     * Clanker v4 lockers on Base mainnet (verified 2026-11-04, docs/design/clanker-launch.md section 1).
     * `ClankerLpLockerFeeConversion`: holds the LP positions; `collectRewards(token)` (permissionless) moves the
     * accrued fees into the fee locker. The address the Clanker README lists (`0x63D2DfEA…`) is NOT enabled.
     */
    CLANKER_LOCKER_ADDRESS: addressWithDefault('0xffA37784D619F228D8B379d287a4D7282e500762'),
    /** `ClankerFeeLocker`: per-recipient balances; `availableFees(kernel, WETH)` is read, `claim(kernel, WETH)` always pays the kernel. */
    CLANKER_FEE_LOCKER_ADDRESS: addressWithDefault('0xF3622742b1E446D92e45E22923Ef11C2fcD55D68'),
    /**
     * RWAGMI v3 stack (docs/rwagmi-migration.md). Defaults are the Base mainnet deployment; there is no deployment on
     * Base Sepolia (services are tested with fixtures and, end to end, on mainnet with a test coin).
     * `RwagmiB20LauncherV3`: `deploymentInfo(token).primaryPoolId` is the coin's fee pool.
     */
    RWAGMI_LAUNCHER_V3_ADDRESS: addressWithDefault('0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20'),
    /** `RwagmiLpLockerV3`: the kernel's WETH fee ledger (`pendingQuote` / `claimableQuote`) and the session key's only claim target. */
    RWAGMI_LOCKER_V3_ADDRESS: addressWithDefault('0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20'),
    /** Launches whose creator is the platform treasury run as the platform's own voice (`config.platform`). */
    PLATFORM_TREASURY_ADDRESS: optionalAddress,
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
    /** The public site, for the coin page links the agents' `read_coin` tool hands out. */
    SITE_URL: z.preprocess((v) => (v === '' || v === undefined ? 'https://bootr.fun' : v), z.string().url()),
    SUPERVISOR_TICK_MS: int(60_000, 1000),
    MAX_AGENTS_PER_TICK: int(10, 1),
    /**
     * Platform posting rhythm (rhythm.ts): at most this many original posts across every Bootr agent per 10-minute
     * window. An agent whose post is due but finds the window full waits for a later tick; its slot is not lost.
     */
    PLATFORM_POST_SLOTS_PER_10M: int(3, 1),
    /**
     * Quiet hours in UTC as `HH-HH` (`02-06`: from 02:00 up to 06:00; `22-06` wraps midnight). Original posts wait
     * until the window ends; replies still go out. Unset (the default) = no quiet hours.
     */
    PLATFORM_QUIET_HOURS_UTC: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^([01]?\d|2[0-4])-([01]?\d|2[0-4])$/, 'expected quiet hours as HH-HH in UTC, e.g. 02-06')
        .refine((v) => Number(v.split('-')[0]) % 24 !== Number(v.split('-')[1]) % 24, { message: 'quiet hours must not start and end at the same hour' })
        .optional(),
    ),
    /**
     * When the platform's own agent posts its "this week on Bootr" digest (weekly-digest.ts): `<day>:<hour>` in UTC,
     * `sun:16` = Sunday 16:00 UTC (the default). Once per ISO week; held by quiet hours and slots like any post.
     */
    PLATFORM_DIGEST_AT: z.preprocess(
      (v) => (v === '' || v === undefined ? 'sun:16' : v),
      z
        .string()
        .regex(/^(mon|tue|wed|thu|fri|sat|sun):([01]?\d|2[0-3])$/i, 'expected the digest slot as <day>:<hour> in UTC, e.g. sun:16')
        .transform((v) => v.toLowerCase()),
    ),
    /**
     * When the platform's own agent posts its daily numbers (platform-numbers.ts): the hour in UTC (`HH`, default
     * `15`). Once per UTC day; held by quiet hours and slots like any post.
     */
    PLATFORM_NUMBERS_AT: z.preprocess(
      (v) => (v === '' || v === undefined ? '15' : v),
      z
        .string()
        .regex(/^([01]?\d|2[0-3])$/, 'expected the numbers hour as HH in UTC, e.g. 15')
        .transform((v) => String(Number(v))),
    ),
    /**
     * X accounts the platform's own agent follows (watchlist.ts): comma-separated handles, with or without `@`.
     * Their latest posts of the week are read through the sender (one read per handle per 6 h) and handed to the
     * agent as a `watchlist` section. Empty = the default list (`base,jessepollak,clanker_world`).
     */
    PLATFORM_WATCHLIST: z.preprocess((v) => (v === '' || v === undefined ? 'base,jessepollak,clanker_world' : v), z.string().max(2000)),
    MAX_TOOL_STEPS: int(8, 1),
    /** Closes mentions the sender would refuse for lack of a verified badge before a turn's first step (mention-close.ts). */
    MENTION_AUTO_CLOSE_ENABLED: bool('true'),
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
    /**
     * UserOps a session key may send over its whole life (`count` of ZeroDev's plain RateLimitPolicy, which never
     * resets, whatever its `interval`): $BOOTR's key stopped for good after 60, with PolicyFailed(2). Each use also
     * moves the policy's `validAfter` by an hour from 0, so the count must stay below now / 3600 (about 498k). The
     * policy with reset (`0x6a06...`) reads TIMESTAMP during validation and the bundler refuses it. The real limits are
     * the call policy, GasPolicy and the key's validity; keys are rotated before they expire, which resets this too.
     */
    SESSION_USEROP_LIMIT: int(100_000, 1),
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
  .refine((c) => !c.ENABLE_MODE_SELF_BUNDLE || !!c.ADMIN_PRIVATE_KEY, { message: 'ENABLE_MODE_SELF_BUNDLE=true requires ADMIN_PRIVATE_KEY (the admin signer sends handleOps)' })
  .refine((c) => BigInt(c.GAS_TARGET_WEI) >= BigInt(c.GAS_MIN_WEI), { message: 'GAS_TARGET_WEI must be >= GAS_MIN_WEI' })
  .refine((c) => !c.BOOTR_CLANKER_LAUNCHER_ADDRESS || c.BOOTR_CLANKER_LAUNCHER_ADDRESS.toLowerCase() !== c.BOOTR_LAUNCHER_ADDRESS.toLowerCase(), { message: 'BOOTR_CLANKER_LAUNCHER_ADDRESS must differ from BOOTR_LAUNCHER_ADDRESS (the launch source is decided by the emitting launcher)' });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}
