import { OWN_DEFAULTS } from '@bootr/shared/own-agent';
import { z } from 'zod';

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte 0x-prefixed hex key');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte address');
/** Empty strings in .env are treated as unset. */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
const optionalHexKey = z.preprocess((v) => (v === '' ? undefined : v), hexKey.optional());
const optionalAddress = z.preprocess((v) => (v === '' ? undefined : v), address.optional());
/** BlockRun's treasury on Base, as its 402 named it on 2026-11-06. */
export const BLOCKRUN_DEFAULT_PAYTO = '0xe9030014F5DAe217d0A152f02A043567b16c1aBf';

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
     * `BootrClankerLauncherV5` (docs/design/clanker-v5-migration.md): the third launcher the poller follows, from the
     * same cursor. Its `AgentLaunched` events register agents with `sv_agents.source = 'clanker-v5'`, whose fees are
     * native ETH in Clanker v5's `FeeEscrow` (`owed(kernel, 0x0)`, claimed with one `claimFor(kernel, 0x0)`), and
     * whose session keys get the v5 rule layout (version 5, one claim rule). Unset = v5 off: nothing changes for the
     * Bootr and Clanker v4 launchers or their agents.
     */
    BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: optionalAddress,
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
    /**
     * Direct mode (blockrun.ts): the agent's spender pays BlockRun over x402 instead of paying the relay. `off` is the
     * default; `agents` turns it on for the ids in BLOCKRUN_DIRECT_AGENTS; `all` for every agent. Anything direct mode
     * cannot pay for before a signature exists goes to the relay, so the relay must stay deployed.
     */
    BLOCKRUN_DIRECT_MODE: z.preprocess((v) => (v === '' || v === undefined ? 'off' : v), z.enum(['off', 'agents', 'all'])),
    BLOCKRUN_DIRECT_AGENTS: z.string().default(''),
    BLOCKRUN_BASE_URL: z.preprocess((v) => (v === '' || v === undefined ? 'https://blockrun.ai/api/v1' : v), z.string().url()),
    /** The only address direct mode ever signs for; a 402 naming another one is refused and goes to the relay. */
    BLOCKRUN_PAYTO_ADDRESS: addressWithDefault(BLOCKRUN_DEFAULT_PAYTO),
    /** Pay with `exact` where `upto` is not offered: every non-Claude model. Its fixed quote is at or under the relay's at real thought sizes. */
    BLOCKRUN_ALLOW_EXACT: bool('true'),
    /**
     * Whether a call BlockRun cannot serve may go to the relay. Off by default: a relay with no OpenRouter credit takes the
     * payment and cannot answer. Turn on only while OpenRouter is funded; with it off, an outage means waiting, unpaid.
     */
    BLOCKRUN_RELAY_FALLBACK: bool('false'),
    /**
     * Where a picture is bought while direct mode is on. `relay` (the default): pictures stay on the relay (OpenRouter
     * behind it), paid from the spender as before, under the relay's model names and the relay's prices, so OpenRouter
     * must stay funded for them. `direct`: BlockRun's image API. Thoughts and chat never read this, and the relay
     * fallback above is about thoughts only.
     */
    BLOCKRUN_IMAGE_ROUTE: z.preprocess((v) => (v === '' || v === undefined ? 'relay' : v), z.enum(['relay', 'direct'])),
    /** Ask for prompt caching on Claude models (`prompt_cache`), which `upto` should bill at the cache rates. */
    BLOCKRUN_PROMPT_CACHE: bool('true'),
    /** Above BlockRun's own 120 s upstream limit, so its 504 arrives before we give up on it. */
    BLOCKRUN_TIMEOUT_MS: int(150_000, 1000),
    /** After a direct failure: on the relay this long with the fallback on; with it off, no new signature this long after money was lost. */
    BLOCKRUN_HOLD_MS: int(1_800_000, 0),
    /** Between polls of a slow picture; 0 polls once and leaves the rest to the reconcile. */
    BLOCKRUN_IMAGE_POLL_MS: int(3_000, 0),
    /** `max_tokens` for the one retry after a tool call was cut off at INFERENCE_MAX_OUTPUT_TOKENS. */
    INFERENCE_RETRY_OUTPUT_TOKENS: int(4096, 16),
    INDEXER_URL: z.string().url(),
    /** The public site, for the coin page links the agents' `read_coin` tool hands out. */
    SITE_URL: z.preprocess((v) => (v === '' || v === undefined ? 'https://bootr.fun' : v), z.string().url()),
    SUPERVISOR_TICK_MS: int(60_000, 1000),
    /** Awake runtimes (waiting, held, running) processed per tick, ordered by `nextAt`. */
    MAX_AGENTS_PER_TICK: int(10, 1),
    /**
     * How often a sleeping or paused agent's chain state (refuel, guardian unpause) is read; every tick otherwise.
     * A creator who refuels waits at most this long for the agent to wake. One RPC call per read (tick.ts).
     */
    REST_CHECK_MS: int(300_000, 0),
    /**
     * How often an agent with the treasury turn on (roles.ts `treasuryTurnOn`) gets one: every interval, or earlier
     * on a pending treasury note or a closed bounty job, never closer than a quarter of it to the last one.
     */
    TREASURY_TURN_INTERVAL_MS: int(3_600_000, 60_000),
    /**
     * Sleeping runtimes checked per tick, in their own sweep (tick.ts): one treasury read each, least recently checked
     * first, so refuelling is noticed without sleeping coins ever taking an awake agent's slot. Empty = MAX_AGENTS_PER_TICK.
     */
    MAX_SLEEPING_PER_TICK: z.preprocess((v) => (v === '' || v === undefined ? undefined : v), z.coerce.number().int().min(0).optional()),
    /**
     * Hard ceiling on one agent tool call (broker/index.ts). Agents run one at a time, so a tool that never answers
     * would stall every agent; past this a read tool fails and a write or money tool ends `unknown`, to be settled by
     * reconciliation. Above the longest legitimate tool: a treasury op waits USER_OP_RECEIPT_TIMEOUT_MS for its receipt.
     */
    TOOL_TIMEOUT_MS: int(180_000, 1000),
    /** The same ceiling for read tools (web, X, chain, indexer reads), which have nothing to reconcile. */
    TOOL_READ_TIMEOUT_MS: int(60_000, 1000),
    /**
     * Platform posting rhythm (rhythm.ts): at most this many original posts across every Bootr agent per 10-minute
     * window. An agent whose post is due but finds the window full waits for a later tick; its slot is not lost.
     */
    PLATFORM_POST_SLOTS_PER_10M: int(3, 1),
    /**
     * Posting, round two (docs/design/agent-tools-2.md section 13). A piece is switched off by its limit: with
     * `THREAD_MAX_PARTS` under 2 or `THREADS_PER_DAY` at 0 there are no threads, with `COMMENT_POSTS_PER_DAY` at 0 no
     * comments (the field's sentence leaves `publish_post`), with `OPEN_REPLIES_PER_DAY` at 0 no reply outside the
     * verified audience, and `MENTION_AUDIENCE=anyone` is the mention rule as it was. The count of posts with a link
     * (`LINK_POSTS_PER_DAY`) is the sender's.
     */
    /** Posts in a thread, the first included; 4 at most (the tool takes no more). */
    THREAD_MAX_PARTS: z.preprocess((v) => (v === '' || v === undefined ? 4 : v), z.coerce.number().int().min(0).max(4)),
    /** Characters of every part of a thread, for every account; 280 at most (the tool takes no more). */
    THREAD_PART_MAX_CHARS: z.preprocess((v) => (v === '' || v === undefined ? 280 : v), z.coerce.number().int().min(1).max(280)),
    /** Threads per coin per rolling 24 hours. */
    THREADS_PER_DAY: int(2, 0),
    /** Parts of one thread that may carry a link. */
    THREAD_MAX_LINK_PARTS: int(1, 0),
    /** Comments (an original post about a post the agent read, `publish_post {about}`) per coin per rolling 24 hours. */
    COMMENT_POSTS_PER_DAY: int(3, 0),
    /** Comments on one author's posts, per rolling 24 hours and per rolling 7 days. */
    COMMENT_PER_AUTHOR_PER_DAY: int(1, 0),
    COMMENT_PER_AUTHOR_PER_WEEK: int(3, 0),
    /** How old the post commented on may be. */
    COMMENT_SOURCE_MAX_AGE_MS: int(72 * 3_600_000, 0),
    /** Whether a comment may link the post it is about (a link is priced many times a plain post, and may count as a quote). */
    COMMENT_LINK: bool('false'),
    /** X author ids or handles nobody's agent comments on, comma-separated (an account that asked Bootr to be left alone). */
    PLATFORM_NEVER_COMMENT: z.preprocess((v) => (v === '' || v === undefined ? '' : v), z.string().max(8000)),
    /**
     * Who an original post may @mention: `engaged` = other Bootr agents, @bootrfun, accounts that wrote to the agent
     * within `ENGAGED_WINDOW_MS` and the creator's reply list (X: no unsolicited @mentions); `anyone` = any active
     * account with a source credit, as before.
     */
    MENTION_AUDIENCE: z.preprocess((v) => (v === '' || v === undefined ? 'engaged' : v), z.enum(['engaged', 'anyone'])),
    /** How long "wrote to the agent" lasts. */
    ENGAGED_WINDOW_MS: int(30 * 24 * 3_600_000, 0),
    /**
     * The reply audience of a coin that set none (`config.replyAudience`): `verified` = verified accounts (a blue or a
     * business badge), the creator's list and other Bootr agents, plus questions from anyone while
     * `REPLY_QUESTIONS_FROM_ANYONE` is on; `own_threads` = also a direct reply to one of the agent's own posts from
     * anybody, question or not. X asks for its approval before AI-written replies are widened, so the default stays
     * `verified` until that is on file.
     */
    REPLY_AUDIENCE_DEFAULT: z.preprocess((v) => (v === '' || v === undefined ? 'verified' : v), z.enum(['verified', 'own_threads'])),
    /**
     * Questions from anyone (the owner's decision of 2026-11-13): an account without a verified badge that wrote to
     * the agent (mentioned it, or replied to it) and asks a question in that post is answered, on every coin and
     * whatever its reply audience. `false` = the verified audience alone, as before. Bounded by `OPEN_REPLIES_PER_DAY`.
     */
    REPLY_QUESTIONS_FROM_ANYONE: bool('true'),
    /**
     * Replies per coin per rolling 24 hours to accounts outside the verified audience: one count for questions from
     * anyone and for the replies of `own_threads`. Past it such a mention is closed unanswered. The same number bounds
     * the turns a day such mentions may wake an agent for (agent-directory.ts `wakeViews`). 0 switches both off.
     */
    OPEN_REPLIES_PER_DAY: int(10, 0),
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
     * agent as a `watchlist` section. Empty = the default list (`bootrfun,base,jessepollak,clanker_world`).
     */
    PLATFORM_WATCHLIST: z.preprocess((v) => (v === '' || v === undefined ? 'bootrfun,base,jessepollak,clanker_world' : v), z.string().max(2000)),
    MAX_TOOL_STEPS: int(8, 1),
    /**
     * Scheduled posts (scheduled.ts; docs/design/agent-tools-2.md sections 5 and 13): the agent decides a post now and
     * the tick sends it at its time. Each value is a limit; `SCHEDULED_MAX_WAITING=0` (or a furthest time of 0) switches
     * the whole piece off: the tools are not offered, nothing is asked of the queue and the tick's sweep does nothing.
     * `SCHEDULED_POSTS_HOSTED=false` keeps the tools from the Bootr agent and leaves them to own agents.
     */
    SCHEDULED_POSTS_HOSTED: bool('true'),
    /** Posts that may wait per coin, the ones in the creator's review included. */
    SCHEDULED_MAX_WAITING: int(6, 0),
    /** The nearest and the furthest time a post may be scheduled for, from now. */
    SCHEDULE_MIN_AHEAD_MS: int(600_000, 0),
    SCHEDULE_MAX_AHEAD_MS: int(129_600_000, 0),
    /** How late a scheduled post may still go out; past it the post is missed, never sent late. */
    SCHEDULE_GRACE_MS: int(3_600_000, 0),
    /** Scheduled posts one tick sends, over all coins; 0 sends none. */
    SCHEDULED_SENDS_PER_TICK: int(5, 0),
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
    /**
     * The x402 service catalogue `discover_services` reads (CDP's Bazaar discovery API, public, no key): `/search` and
     * `/resources` under this base. Listings are third-party text shown to the model as data.
     */
    X402_DISCOVERY_URL: z.preprocess((v) => (v === '' || v === undefined ? 'https://api.cdp.coinbase.com/platform/v2/x402/discovery' : v), z.string().url()),
    /** How long one paid service call may take, asking and paying together (services.ts). */
    SERVICES_TIMEOUT_MS: int(30_000, 1000),
    /** Optional web search API (Exa or Brave). Without it `search_web` is hidden from the model. */
    SEARCH_API_URL: optionalUrl,
    SEARCH_API_KEY: optionalString,
    /**
     * What the agent learns and is told (docs/design/agent-tools-2.md sections 6, 7 and 13). A limit of 0 switches its
     * piece off: `LEARN_WINDOW_DAYS` 0 leaves the `postPerformance` section and the per-batch memory note as they were
     * before the facts existed; `WHAT_WORKS_MAX_CHARS` 0 takes `note_what_works` away; `COIN_BRIEF_MAX_CHARS` 0 drops
     * `coinToday`.
     */
    /** The facts look this many days back over the agent's measured posts (post-performance.ts). */
    LEARN_WINDOW_DAYS: int(28, 0),
    /** Under this many measured originals in the window the facts say only that there are too few. */
    LEARN_MIN_POSTS: int(20, 1),
    /** A line of the facts needs at least this many posts on both of its sides. */
    LEARN_MIN_SAMPLE: int(8, 1),
    /** One side's median must be at least this many times the other's, or the line says "no clear difference". */
    LEARN_MIN_RATIO: num(1.5, 1),
    /** The most lines the facts carry. */
    LEARN_MAX_FACTS: int(8, 0),
    /** The most characters of the agent's note on what works (what-works.ts); never above the tool's own 600. */
    WHAT_WORKS_MAX_CHARS: int(600, 0),
    /** The note is revised no sooner than this after it was last written... */
    WHAT_WORKS_MIN_INTERVAL_MS: int(7 * 24 * 3_600_000, 0),
    /** ...and only once this many more posts were measured. */
    WHAT_WORKS_MIN_NEW_POSTS: int(10, 0),
    /** Versions of the note kept per agent; older ones are deleted. */
    WHAT_WORKS_KEEP: int(5, 1),
    /** The most characters of the `coinToday` brief (coin-today.ts). */
    COIN_BRIEF_MAX_CHARS: int(900, 0),
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
    /** Telegram bot for creator notifications (notifications.ts, telegram.ts). Unset: only the console inbox works. Held by the supervisor alone. */
    TELEGRAM_BOT_TOKEN: optionalString,
    /** How often the notifier looks at agents and sends what is due. Runs apart from the tick. */
    NOTIFY_SWEEP_MS: int(60_000, 1000),
    /** How long one agent may go between health checks (each reads its balances and the X account once). */
    NOTIFY_CHECK_MS: int(300_000, 1000),
    /**
     * Own agents (docs/design/byo-agent.md section 13.2). The one flag: `true` offers the feature's surfaces (the connect
     * and run routes) and lets a coin become own. It never decides how a coin is run: a coin whose stored config says
     * `runner: 'own'` is an own coin with the flag on or off (own/registry.ts `isOwn`), silent while the flag is off.
     */
    OWN_AGENT_ENABLED: bool('false'),
    /** An own turn with no call for this long is closed by the server (a continuation note, no checkpoint). */
    OWN_TURN_IDLE_MS: int(OWN_DEFAULTS.OWN_TURN_IDLE_MS, 1000),
    /** An own turn open for this long is closed the same way, whatever its last call. */
    OWN_TURN_MAX_MS: int(OWN_DEFAULTS.OWN_TURN_MAX_MS, 1000),
    /** Social turns a day (UTC) the creator may open with `reason: 'creator_asked'` while nothing is due. */
    OWN_FORCED_TURNS_PER_DAY: int(OWN_DEFAULTS.OWN_FORCED_TURNS_PER_DAY, 0),
    /** The floor of `nextCheckAt` in the due view; the web applies the same interval to the due route. */
    OWN_DUE_MIN_INTERVAL_MS: int(OWN_DEFAULTS.OWN_DUE_MIN_INTERVAL_MS, 0),
    /** X read units a day the sender allows an own coin (own/quota.ts); 0 leaves the sender's default. */
    OWN_READS_PER_DAY: int(OWN_DEFAULTS.OWN_READS_PER_DAY, 0),
    /** `search_web` calls per rolling 24 hours for an own coin (broker). */
    OWN_SEARCH_PER_DAY: int(OWN_DEFAULTS.OWN_SEARCH_PER_DAY, 0),
    /** `read_url` calls per rolling 24 hours for an own coin (broker). */
    OWN_READ_URL_PER_DAY: int(OWN_DEFAULTS.OWN_READ_URL_PER_DAY, 0),
    /** How long a client's credential lasts. */
    OWN_CLIENT_TTL_DAYS: int(OWN_DEFAULTS.OWN_CLIENT_TTL_DAYS, 1),
    /** Live clients one coin (or one launch draft) may have. */
    OWN_CLIENTS_PER_AGENT: int(OWN_DEFAULTS.OWN_CLIENTS_PER_AGENT, 1),
    /** How long a bounty job of an own coin waits for its ruling before it closes with no winner (bounties.ts). */
    OWN_JUDGE_WAIT_MS: int(OWN_DEFAULTS.OWN_JUDGE_WAIT_MS, 0),
    /** Mentions older than this are closed unanswered when an own agent returns after at least as long away. */
    OWN_STALE_MENTION_MS: int(OWN_DEFAULTS.OWN_STALE_MENTION_MS, 0),
    /** The byte budget of the first observation handed to a client (clients cap a tool result well under 120 KB). */
    OWN_OBSERVATION_BYTES: int(OWN_DEFAULTS.OWN_OBSERVATION_BYTES, 4000),
    /** Turns one own coin's clients may open per rolling 24 hours (own/budget.ts); fuel bounded a hosted agent, nothing else bounds an own one. */
    OWN_TURNS_PER_DAY: int(OWN_DEFAULTS.OWN_TURNS_PER_DAY, 0),
    /** Tool calls of an own coin per rolling 24 hours, a refused `finish` included (own/budget.ts). */
    OWN_STEPS_PER_DAY: int(OWN_DEFAULTS.OWN_STEPS_PER_DAY, 0),
    /** `remember` calls per rolling 24 hours for an own coin (broker). */
    OWN_REMEMBER_PER_DAY: int(OWN_DEFAULTS.OWN_REMEMBER_PER_DAY, 0),
    /** `treasury_prepare` calls per rolling 24 hours for an own coin (broker). */
    OWN_TREASURY_PREPARE_PER_DAY: int(OWN_DEFAULTS.OWN_TREASURY_PREPARE_PER_DAY, 0),
    /** `treasury_execute` calls per rolling 24 hours for an own coin (broker). */
    OWN_TREASURY_EXECUTE_PER_DAY: int(OWN_DEFAULTS.OWN_TREASURY_EXECUTE_PER_DAY, 0),
    /** `x402_fetch` and `discover_services` calls together per rolling 24 hours for an own coin (broker). */
    OWN_SERVICE_CALLS_PER_DAY: int(OWN_DEFAULTS.OWN_SERVICE_CALLS_PER_DAY, 0),
    /** Picture uploads an own coin may try per rolling 24 hours, kept or refused (own/pictures.ts). */
    OWN_UPLOAD_ATTEMPTS_PER_DAY: int(OWN_DEFAULTS.OWN_UPLOAD_ATTEMPTS_PER_DAY, 0),
    /** How long a run call waits for the runtime lease (the tick or another call holds it) before it answers busy. */
    OWN_LEASE_WAIT_MS: int(4000, 0),
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
  .refine((c) => !c.BOOTR_CLANKER_LAUNCHER_ADDRESS || c.BOOTR_CLANKER_LAUNCHER_ADDRESS.toLowerCase() !== c.BOOTR_LAUNCHER_ADDRESS.toLowerCase(), { message: 'BOOTR_CLANKER_LAUNCHER_ADDRESS must differ from BOOTR_LAUNCHER_ADDRESS (the launch source is decided by the emitting launcher)' })
  .refine(
    (c) => {
      const v5 = c.BOOTR_CLANKER_V5_LAUNCHER_ADDRESS?.toLowerCase();
      return !v5 || (v5 !== c.BOOTR_LAUNCHER_ADDRESS.toLowerCase() && v5 !== c.BOOTR_CLANKER_LAUNCHER_ADDRESS?.toLowerCase());
    },
    { message: 'BOOTR_CLANKER_V5_LAUNCHER_ADDRESS must differ from BOOTR_LAUNCHER_ADDRESS and BOOTR_CLANKER_LAUNCHER_ADDRESS (the launch source is decided by the emitting launcher)' },
  );

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}
