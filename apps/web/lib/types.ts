/** Shapes from docs/data-contract.md. Amounts are integer base-unit strings. */
import type { Address, Hex } from 'viem';
import { BOUNTY_DAILY_MAX_MICRO_USDC, BOUNTY_MAX_AMOUNT_MICRO_USDC, BOUNTY_MAX_CONSIDERED, BOUNTY_MAX_COOLDOWN_SECONDS, BOUNTY_MAX_CRITERIA, BOUNTY_MAX_CRITERION_CHARS, BOUNTY_MAX_HOURS_OPEN, BOUNTY_MAX_OPEN_CEILING, BOUNTY_MAX_TASK_CHARS, BOUNTY_MIN_AMOUNT_MICRO_USDC, BOUNTY_MIN_HOURS_OPEN, DEFAULT_BOUNTIES_POLICY } from '@bootr/agent-core';
import type { Runner, RunnerView } from '@bootr/shared/own-agent';
import type { CapabilityKey } from '@bootr/shared/workers';

export type { CapabilityKey };

export type AgentStatus = 'awake' | 'sleeping' | 'paused' | 'dormant' | 'claimed';
export type RecipientKind = 'agent' | 'creator' | 'burn' | 'platform';
/**
 * Which launcher created the coin: Bootr's own (RWAGMI v3 pool and locker), the Clanker v4 wrapper
 * (docs/design/clanker-launch.md) or the Clanker v5 wrapper (docs/design/clanker-v5-migration.md). Helpers in
 * `lib/launch-source.ts`.
 */
export type LaunchSource = 'bootr' | 'clanker' | 'clanker-v5';
export type TokenTab = 'newest' | 'trending' | 'graduated' | 'mcap' | 'active';

export interface Agent {
  id: Address; // kernel
  token: Address;
  status: AgentStatus;
  lastActivityAt: number;
  dormancyPeriod: number;
  dormantSince: number | null;
  /** Kernel USDC only; the x402 spender float is `spenderUsdc`. */
  treasuryUsdc: string;
  treasuryWeth: string;
  treasuryEth: string;
  treasuryOwnToken: string;
  /** The agent's x402 spender EOA (pays inference, topped up from the kernel); null until known. */
  spender: Address | null;
  /** USDC float held by `spender` (base units). */
  spenderUsdc: string;
  /** Kernel balances plus the spender's USDC float, in USD. */
  treasuryUsd: number;
  fuelReceivedUsdc: string;
  feesClaimedUsd: number;
  reputationScore: number | null;
  reputationCount: number;
  lastPostAt: number | null;
  postsCount24h: number;
}

export interface Token {
  id: Address;
  chainId: number;
  name: string;
  symbol: string;
  /** What Bootr shows: the creator's off-chain choice when there is one (`lib/coin-image.ts`), else the on-chain image. */
  image: string;
  /** The on-chain image, present only when `image` is an override. */
  imageOnChain?: string;
  creator: Address;
  kernel: Address;
  burner: Address | null;
  /** Who receives the platform share; a wallet can hold it and the creator share of the same coin. */
  platformRecipient?: Address;
  agentId: string;
  poolId: Hex;
  pairedToken: Address;
  /**
   * The pool's swap fee, 1e6-based (10000 = 1%). Fixed at 1% on the Bootr path; per coin on the Clanker v4 path (the
   * trader pays it plus Clanker's 20%); on Clanker v5 the buy and sell tax itself (15000 = 1.5%, paid as is).
   */
  lpFeeBps: number;
  /** `bootr` (default; older indexers omit the field), `clanker` (v4) or `clanker-v5` (whose `pairedToken` is the zero address: native ETH). */
  source?: LaunchSource;
  agentBps: number;
  creatorBps: number;
  burnBps: number;
  platformBps: number;
  workerHash: Hex;
  model: string;
  agentUri: string;
  /** ERC-7572 contract URI set at launch (the site's `/tokens/<launchId>.json` for coins launched on bootr.fun). */
  metadata: string;
  xHandle: string | null;
  launchedAt: number;
  launchBlock: string;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volume7dUsd: number;
  fees24hUsd: number;
  holders: number;
  graduated: boolean;
  graduatedAt: number | null;
  /** Unix seconds of the last buy or sell; null until the first trade. Drives the bump order of the home grid. */
  lastTradeAt?: number | null;
  /** Not in the table; optional 24h price change if the indexer provides it. */
  change24hPct?: number | null;
  agent?: Pick<Agent, 'id' | 'status'> | null;
  /**
   * The indexer's token-row fields for a Clanker v5 coin launched with creator-set settings (BootrClankerLauncherV5
   * `launch(p, s)`, docs/design/clanker-v5-token-settings.md section 5); null or absent on every other coin. The one
   * place the web names them; `v5SettingsOf` in lib/token-settings.ts reads them into `V5TokenSettings`.
   */
  /** The paired asset's symbol and decimals (`pairedToken` is its address: `0x0` for ETH). */
  pairedSymbol?: string | null;
  pairedDecimals?: number | null;
  /** The coin's price in the paired asset. */
  priceQuote?: number | null;
  /** Each side's tax, 1e6-based (15000 = 1.5%). `lpFeeBps` carries the buy tax. */
  buyTaxBps?: number | null;
  sellTaxBps?: number | null;
  /**
   * The creator's extra reward rows together, and the holder dividends. Like `agentBps`, `creatorBps` (the creator's own
   * row), `burnBps` and `platformBps` on a v5 coin, these are bps of the buy tax with Clanker's share inside it:
   * `agent + creator + rewards + burn + dividend + platform = 10000 - protocolBps`.
   */
  rewardsBps?: number | null;
  dividendBps?: number | null;
  /** Clanker's share of a v5 coin's tax, in bps of it (3333 at 1.5%). */
  protocolBps?: number | null;
  /** Raw coin units (18 decimals) a holder needs for dividends. */
  minDividendHolding?: string | null;
  /** The coin's dividend tracker, and the dividends paid so far in USD. */
  dividendContract?: Address | null;
  dividendsTotalUsd?: number | null;
  antiSnipe?: boolean | null;
  /** The image and metadata can still change (false once locked), the creator's one-way lock, and the last edit. */
  metadataEditable?: boolean | null;
  metadataLocked?: boolean | null;
  metadataUpdatedAt?: number | null;
  /**
   * Not from the indexer: what the token row does not carry, which mock mode fills in (the reward rows, in bps of creator
   * funds, and the metadata JSON). Live, the coin page reads both from the chain.
   */
  v5Extras?: { rewards?: V5TokenSettings['rewards']; metadataJson?: string | null } | null;
}

/**
 * A v5 coin launched with settings, as the web reads it (`v5SettingsOf` in lib/token-settings.ts, from the token row's
 * fields above). `pairedToken` on the token row is the quote (`0x0` for native ETH, USDC's address for USDC).
 */
export interface V5TokenSettings {
  /** Each side's tax, 1e6-based (15000 = 1.5%). `lpFeeBps` on the token row carries the buy tax. */
  buyTaxBps: number;
  sellTaxBps: number;
  /**
   * Shares of the tax pool after Clanker's cut, bps of 10000: the locked floors and the creator's choices, creator funds
   * being the creator's own row and the extra rows together. All 0 when `splitKnown` is false: the indexer's row did not
   * add up, and the web shows the split as unknown rather than guess one.
   */
  splitKnown: boolean;
  agentShareBps: number;
  creatorFundsBps: number;
  platformShareBps: number;
  burnBps: number;
  dividendBps: number;
  /** Raw coin units (18 decimals) a holder needs for dividends; "0" without dividends. */
  minDividendHolding: string;
  /**
   * The creator funds' rows in slot order (the creator's own first), `bps` of creator funds (sum 10000). The token row
   * does not carry them: empty unless read from the hook's `poolFeeSlots` (the coin page does) or set by mock mode.
   */
  rewards: { recipient: Address; admin: Address; bps: number }[];
  antiSnipe: boolean;
  /** The image and metadata can still change (the indexer turns it off once locked). */
  metadataEditable: boolean;
  /** The launcher's one-way lock (`lockMetadata`): an editable coin whose creator locked it can no longer change. */
  metadataLocked: boolean;
  /** The token's `metadata` extra-metadata key as last set (Clanker's JSON: description, socialMediaUrls, auditUrls). */
  metadataJson?: string | null;
}

export interface Trade {
  id: string;
  token: Address;
  trader: Address;
  side: 'buy' | 'sell';
  amountToken: string;
  amountPaired: string;
  priceUsd: number;
  valueUsd: number;
  timestamp: number;
  txHash: Hex;
}

export interface FeesByKind {
  /** `claimedUsd` is null when a wallet holding this kind and another has claims that could not be told apart. */
  byKind: Record<RecipientKind, { accruedUsd: number; claimedUsd: number | null }>;
}

export interface DailyStat {
  id: string; // YYYY-MM-DD
  launches: number;
  volumeUsd: number;
  feesUsd: number;
  feesAgentUsd: number;
  feesCreatorUsd: number;
  feesBurnUsd: number;
  feesPlatformUsd: number;
  activeAgents: number;
  awakeAgents: number;
  bootBurnedToken: string;
  bootBurnedUsd: number;
}

export interface PlatformStats {
  tokens: number;
  agentsAwake: number;
  volume24hUsd: number;
  volumeTotalUsd: number;
  feesTotalUsd: number;
  bootToken: Address | null;
  bootPriceUsd: number;
  bootMarketCapUsd: number;
  bootChange24hPct: number;
  bootBurnedTotal: string;
  bootFeesToBurnUsd: number;
  graduationThresholdUsd: number;
  updatedAt: number;
}

export interface TokenPage {
  items: Token[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
}

/** A coin on a creator's public page: the token row, its agent and what was booked to the creator. */
export interface CreatorCoin extends Token {
  creatorFees: {
    earnedUsd: number;
    /** The creator share alone. Null when the wallet also holds another share of the coin and the two could not be told apart. */
    claimedUsd: number | null;
    /** Wei of WETH, as strings. Older indexers omit them and `otherShares`. */
    earnedWeth?: string;
    claimedWeth?: string | null;
    /** Other shares this wallet holds on this coin, kept out of the figures above. */
    otherShares?: { kind: RecipientKind; earnedUsd: number; claimedUsd: number | null }[];
  };
}

/** `GET /creator/:address`. */
export interface CreatorProfile {
  address: Address;
  readAt: number;
  indexedAt: number | null;
  totals: { coins: number; agents: number; earnedUsd: number; claimedUsd: number | null; earnedWeth?: string; claimedWeth?: string | null };
  coins: CreatorCoin[];
}

export type BoardId = 'agent-fees' | 'agent-activity' | 'volume' | 'holders' | 'burned';
export type BoardPeriod = '24h' | '7d' | 'all' | 'now';

/** One ranked row of `GET /leaderboards/:board`. `kernel` is null for a coin launched without an agent. */
export interface LeaderboardRow {
  rank: number;
  value: number;
  detail?: { lastPostAt?: number | null; amountToken?: string };
  token: Pick<Token, 'id' | 'name' | 'symbol' | 'image' | 'creator' | 'source' | 'xHandle'> & { kernel: Address | null; agentId: string | null };
  agent: Pick<Agent, 'id' | 'status'> | null;
}

export interface Leaderboard {
  board: BoardId;
  period: BoardPeriod;
  periods: BoardPeriod[];
  unit: 'usd' | 'count' | 'percent';
  /** When this board was read, unix s. */
  readAt: number;
  /** When market figures were last refreshed, unix s; null before the first refresh. */
  indexedAt: number | null;
  /** Rows with a value, of which `items` is the top. */
  ranked: number;
  /** Rows nobody knows a value for: counted, never ranked. */
  unknown: number;
  items: LeaderboardRow[];
}

export interface TokenDetail extends Token {
  agent: Agent | null;
  trades: Trade[];
}

export interface AgentWithToken extends Agent {
  tokenInfo: Pick<Token, 'id' | 'name' | 'symbol' | 'image' | 'creator' | 'xHandle' | 'source' | 'lpFeeBps'> | null;
}

export interface FuelEvent {
  txHash: Hex;
  kernel: Address;
  token: Address;
  symbol: string;
  amountUsdc: string;
  timestamp: number;
}

export interface Holding {
  token: Pick<Token, 'id' | 'name' | 'symbol' | 'image' | 'imageOnChain' | 'priceUsd' | 'marketCapUsd'>;
  balance: string; // base units, 18 decimals
  valueUsd: number;
}

/** A post or reply the agent published on X (sender `GET /public/posts/:agentId`, via /api/agents/:id/posts). */
export interface AgentPost {
  id: string;
  kind: 'post' | 'reply';
  text: string;
  postId: string;
  url: string;
  /** Unix seconds. */
  createdAt: number;
}

export interface AgentPosts {
  /** Connected X handle; null when the agent has no (or a revoked) X account. */
  handle: string | null;
  items: AgentPost[];
}

export type StreamHint = { type: 'launch' | 'trade' | 'agent'; tokenId?: string };

// ---------------------------------------------------------------- agent config and activity (supervisor, via /api/agent/[kernel]/*)

export type WorkerKind = 'trader' | 'researcher' | 'community' | 'custom';

/** The agent's current worker configuration as the supervisor holds it (docs/design/agent-launch-v2.md). */
export interface AgentWorkerConfig {
  kind: WorkerKind;
  capabilities: Record<CapabilityKey, boolean>;
  /** Minimum spacing between original posts, in milliseconds. */
  postIntervalMs: number;
  jobLines: string[];
}

/** `GET /api/agent/[kernel]/config` (the supervisor's `GET /internal/agents/:id/config`). */
export interface AgentConfig {
  agentId: string;
  kernel: Address;
  creator: Address;
  model: string;
  instructions: string;
  worker: AgentWorkerConfig;
  workerHash: Hex;
  /**
   * The creator's daily budget of posts and replies together, over a rolling day (the posting service's quota;
   * `POSTS_PER_DAY` in `@bootr/shared/workers`). Setting it also sets `worker.postIntervalMs` (`postIntervalForPostsPerDay`).
   */
  postsPerDay: number;
  /** Posts and replies wait in the review queue until the creator approves them (default on for the platform's agent). */
  requireApproval: boolean;
  /** Economy mode: the cheaper model a turn starts on for reading and deciding; null = the whole turn runs on `model`. */
  routing: { decideModel: string | null };
  /** The image model in force for `generate_image` (one of `/api/models?kind=image`). */
  imageModel: string;
  /** How its pictures look: a public https reference picture (the coin's image by default) and the creator's notes. */
  imageStyle: AgentImageStyle;
  /** The money bounds of the Paid services power, whether or not it is on: the daily cap is the most it can cost in a day. */
  services: AgentServicesPolicy;
  /** The bounds of the Bounties power, whether or not it is on. */
  bounties: AgentBountiesPolicy;
  /** Starts at 0; every creator edit bumps it ("edited n times"). */
  revision: number;
  /** ISO 8601. */
  updatedAt: string;
  /**
   * A hold X put on the account's posting, while it lasts (today only the 403 "not permitted" hold); null when the
   * account may post. The coin page shows the creator a panel with the way out (`lib/x-hold.ts`).
   */
  xHold: AgentXHold | null;
  /**
   * The X connection as the posting service holds it: `connected`, `revoked` (X dropped it; the creator must connect the
   * same account again) or `none` (no account). Null when the service could not be asked: the page shows nothing new.
   */
  xConnection: AgentXConnection | null;
  /**
   * Who runs the agent: `hosted`, the Bootr agent, or `own`, the creator's own AI client (docs/design/byo-agent.md).
   * Read from the stored config, so it says the same whether own agents are switched on or off on the deployment.
   */
  runner: Runner;
  /** For an own agent: when its client last finished a turn (ISO, null = never) and how many clients are connected. Null for the Bootr agent. */
  own: RunnerView['own'];
}

export type { Runner, RunnerView };

export type AgentXConnection = 'connected' | 'revoked' | 'none';

export interface AgentXHold {
  reason: 'forbidden';
  /** ISO 8601: when the hold ends on its own. */
  until: string;
  /** Refusals in a row (6 h, 12 h, then a day). */
  strikes: number;
}

export interface AgentImageStyle {
  reference: string | null;
  notes: string;
}

/** Caps of the Paid services power in micro-USDC (6 dp), and host patterns (`api.example.com`, `*.example.com`). */
export interface AgentServicesPolicy {
  perCallMicroUsdc: number;
  dailyMicroUsdc: number;
  allow: string[];
  deny: string[];
}

/** Hard ceilings of the services caps (`SERVICES_*_MAX_MICRO_USDC` in packages/agent-core). */
export const SERVICES_PER_CALL_MAX_MICRO_USDC = 5_000_000;
export const SERVICES_DAILY_MAX_MICRO_USDC = 50_000_000;
export const SERVICES_DEFAULTS: AgentServicesPolicy = { perCallMicroUsdc: 50_000, dailyMicroUsdc: 1_000_000, allow: [], deny: [] };

/**
 * The creator's bounds of the Bounties power (docs/design/agent-capabilities.md section 3.3). The amount of one job is
 * the agent's choice, 0.1 to 1 USDC; the console sets only these. `review` routes every job text through the review
 * queue before it is posted.
 */
export interface AgentBountiesPolicy {
  /** The most the agent may promise in a day, in micro-USDC; charged when a job opens. */
  dailyCapMicroUsdc: number;
  /** Open jobs at a time. */
  maxOpen: number;
  /** How long after a win the same address may win again; 0 allows repeats. */
  cooldownSeconds: number;
  /** How long a job takes entries when the agent names no window, in hours. */
  defaultHoursOpen: number;
  review: boolean;
}

/** Ceilings and floors of the bounties bounds, the agent service's own constants (`BOUNTY_*` in packages/agent-core). */
export const BOUNTIES_BOUNDS = {
  dailyCapMaxMicroUsdc: BOUNTY_DAILY_MAX_MICRO_USDC,
  maxOpenMax: BOUNTY_MAX_OPEN_CEILING,
  /** A year: long enough to mean "never twice" in practice. */
  cooldownMaxSeconds: BOUNTY_MAX_COOLDOWN_SECONDS,
  hoursOpenMin: BOUNTY_MIN_HOURS_OPEN,
  hoursOpenMax: BOUNTY_MAX_HOURS_OPEN,
  /** What one job may pay, chosen by the agent inside these. */
  amountMinMicroUsdc: BOUNTY_MIN_AMOUNT_MICRO_USDC,
  amountMaxMicroUsdc: BOUNTY_MAX_AMOUNT_MICRO_USDC,
  /** Entries the judge sees at most, criteria per job, and the text lengths the service accepts. */
  maxConsidered: BOUNTY_MAX_CONSIDERED,
  maxCriteria: BOUNTY_MAX_CRITERIA,
  maxTaskChars: BOUNTY_MAX_TASK_CHARS,
  maxCriterionChars: BOUNTY_MAX_CRITERION_CHARS,
} as const;
export const BOUNTIES_DEFAULTS: AgentBountiesPolicy = { ...DEFAULT_BOUNTIES_POLICY };

/** What the creator may change from the coin page; only the fields present are applied. */
export interface AgentConfigChanges {
  instructions?: string;
  model?: string;
  worker?: {
    capabilities?: Partial<Record<CapabilityKey, boolean>>;
    postIntervalMs?: number;
    jobLines?: string[];
  };
  /** Posts and replies per rolling day (2..48); the cadence follows it, overriding `worker.postIntervalMs` in the same request. */
  postsPerDay?: number;
  requireApproval?: boolean;
  imageModel?: string;
  /** Partial: a missing field keeps its stored value; `reference: null` removes the picture. */
  imageStyle?: Partial<AgentImageStyle>;
  routing?: { decideModel: string | null };
  /** Partial: a missing field keeps its stored value. */
  services?: Partial<AgentServicesPolicy>;
  /** Partial: a missing field keeps its stored value. */
  bounties?: Partial<AgentBountiesPolicy>;
}

// ---------------------------------------------------------------- bounties (supervisor, via /api/agent/[kernel]/bounties)

/**
 * Where a job stands (the agent service's `bountyJobStatuses`): a draft waiting to be posted (the creator's review, or a
 * posting slot), taking entries, being judged, a payment proposed to the creator, paid, closed with no winner,
 * cancelled, expired unpaid, or failed (the post did not go through).
 */
export type BountyStatus = 'draft' | 'open' | 'judging' | 'proposed' | 'paid' | 'no_winner' | 'cancelled' | 'expired' | 'failed';
export type CriterionMark = 'pass' | 'fail' | 'insufficient_evidence';

/**
 * One job the agent posted, as the coin page shows it (`GET /api/agent/[kernel]/bounties`; the agent service's
 * `BountyJobView`). Public by design: no author ids, no reply text, and no address of anyone but the payee ever appear.
 */
export interface BountyJob {
  /** 0x hex, 32 bytes: the job's id as the agent service names it. */
  id: string;
  /** `0x` and the first 16 hex characters of the id: what the job post links and the page anchor (`#bounty-<shortId>`) carry. */
  shortId: string;
  status: BountyStatus;
  task: string;
  /** Numbered as written at post time; the judge marks each one. */
  criteria: string[];
  deliverable: 'image' | 'link';
  /** USDC as a decimal string ("0.5"), and the same in micro-USDC. */
  amountUsdc: string;
  amountMicroUsdc: string;
  /** ISO 8601: when the agent asked for the job, when the post went out (null for a draft), when entries stop. */
  createdAt: string;
  postedAt: string | null;
  closesAt: string;
  /** The job post on X, the job's own anchor on the coin page, and the post's text. */
  postUrl: string | null;
  pageUrl: string | null;
  pageText: string;
  /** Replies seen, those that could be judged, those actually judged (the first 12), and why the rest were not, by reason. */
  entries: { received: number; eligible: number; considered: number; ineligible: Record<string, number> };
  /**
   * Only on a job of an own-agent coin that waits for its creator's agent to judge: `ruleBy` is the ISO time by which
   * it must rule; after that the job closes with no winner. Absent on every other job.
   */
  ownJudge?: { ruleBy: string } | null;
  verdict: {
    /** 1-based number of the winning entry among those considered; null when nothing met the job. */
    winner: number | null;
    winningEntryUrl: string | null;
    /** Entry number (as a string key) to its marks, one per criterion. */
    perCriterion: Record<string, CriterionMark[]>;
    reason: string;
    /** Set when the judge's answer was refused in code (out of range, a failing mark, a reason the gate refused). */
    invalid: string | null;
    /** Hashes of what the judge saw and of its reason. */
    deliveryHash: Hex | null;
    reasonHash: Hex | null;
    judgedAt: string | null;
  } | null;
  /** Present once the verdict named a payee: proposed to the creator, then paid with the creator's transaction. */
  payment: {
    status: 'proposed' | 'paid';
    payee: Address;
    amountUsdc: string;
    txHash: Hex | null;
    txUrl: string | null;
    /** The reply on X that announces the payment. */
    replyUrl: string | null;
    paidAt: string | null;
  } | null;
  closedAt: string | null;
  /** The reply under the job post that closed it ("Nothing paid."). */
  closeReplyUrl: string | null;
}

export interface AgentBounties {
  jobs: BountyJob[];
}

/** `GET /api/agent/[kernel]/fuel` (the supervisor's `GET /internal/agents/:id/fuel`): paid thoughts per model over the last `days`. */
export interface AgentFuel {
  days: number;
  /** ISO 8601: the start of the window. */
  since: string;
  /** The earliest paid thought in the window: what a spending rate divides by. Absent when there were none. */
  firstAt?: string;
  /**
   * Most thoughts first; `chargedMicroUsdc` is a decimal string of micro-USDC. `paidFailures`: thoughts charged that
   * returned nothing. `directThoughts`: thoughts the agent paid BlockRun for from its own wallet (absent when none).
   */
  byModel: { model: string; thoughts: number; chargedMicroUsdc: string; paidFailures?: number; directThoughts?: number }[];
  /** Who the agent paid for its thoughts in the window: BlockRun from its own wallet, Bootr's own service, or nobody yet (absent from older readers). */
  paidTo?: 'blockrun' | 'bootr' | null;
  /**
   * Who its pictures are paid to: from the window's picture rows when there are any, else from the route pictures take
   * (Bootr's own service by default, BlockRun only when the platform sends pictures there); null when nothing was paid yet.
   */
  picturesPaidTo?: 'blockrun' | 'bootr' | null;
}

// ---------------------------------------------------------------- post approval queue (supervisor, via /api/agent/[kernel]/approvals/*)

export type ApprovalStatus = 'pending_approval' | 'approved' | 'rejected' | 'failed';
export type ApprovalDecision = 'approve' | 'reject';

/**
 * The `bounty` block of a `bounty_job` or `bounty_payout` approval (the agent service's `bountyApprovalView`): the job
 * and its task and amount; for a payout also the payee the creator pays from their own wallet, the judge's reason and
 * the winning entry, with `txHashRequired` saying the approval needs the paying transaction's hash.
 */
export interface BountyApprovalInfo {
  kind: 'job' | 'payout';
  jobId: string;
  task: string;
  /** USDC as a decimal string ("0.4"); null when the service did not say. */
  amountUsdc: string | null;
  payee: Address | null;
  /** The judge's reason, at most 200 characters. */
  reason: string | null;
  /** The winning entry on X. */
  entryUrl: string | null;
  txHashRequired: boolean;
}

export type ApprovalKind = 'post' | 'reply' | 'bounty_job' | 'bounty_payout';

/**
 * One post or reply the agent wants to send, or one bounty item: a job text waiting to be posted (`bounty_job`, while the
 * creator's review switch is on; approve posts it, reject cancels the job) or a payout the judge proposed
 * (`bounty_payout`; approve takes the creator's paying transaction hash, reject closes the job unpaid). `text` is the
 * post or the job text; `bounty` carries the job and the payment and is null for a post or reply.
 */
export interface AgentApproval {
  id: string;
  kind: ApprovalKind;
  text: string;
  bounty: BountyApprovalInfo | null;
  /** The X post a reply answers. */
  inReplyTo: string | null;
  /** The attached picture; `dataUrl` only while pending (what the creator previews). */
  image: { alt: string; dataUrl?: string } | null;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  decidedBy: string | null;
  note: string | null;
  /** The post on X once approved and sent. */
  url: string | null;
  /** ISO 8601. */
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

/** `POST /api/agent/[kernel]/approvals/list` (creator only); `token` keeps the session without a new signature. */
export interface AgentApprovals {
  items: AgentApproval[];
  pending: number;
  token?: string;
}

/** One line of the creator's private chat with the agent (supervisor chat.ts). */
export interface AgentChatMessage {
  id: string;
  role: 'creator' | 'agent';
  text: string;
  status: 'open' | 'done' | 'failed';
  chargedMicroUsdc: string | null;
  remembered: boolean;
  /** The answer filed a creator request that one of the agent's own turns does or answers (supervisor creator-requests.ts). */
  requested?: boolean;
  at: string;
}

/** What one message costs and whether one may be sent now; `refusalText` says why not, in plain words. */
export interface AgentChatQuote {
  model: string;
  approxMicroUsdc: number | null;
  basis: 'recent_messages' | 'list_price' | null;
  maxMicroUsdc: number;
  refusal: string | null;
  refusalText: string | null;
  limits: { perHour: number; perDay: number; usedHour: number; usedDay: number };
  maxChars: number;
}

/** `POST /api/agent/[kernel]/chat/list`. */
export interface AgentChat {
  messages: AgentChatMessage[];
  quote: AgentChatQuote;
  token?: string;
}

export type NotificationTone = 'info' | 'warning' | 'danger';

/** One thing the creator is told about their agent (supervisor notifications.ts). */
export interface AgentNotification {
  id: string;
  event: string;
  title: string;
  body: string;
  tone: NotificationTone;
  state: 'active' | 'resolved';
  firstAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

/** `POST /api/agent/[kernel]/notifications/list`: the creator's inbox, its per-event switches and the Telegram state. */
export interface AgentNotifications {
  items: AgentNotification[];
  active: number;
  events: { key: string; label: string; enabled: boolean }[];
  telegram: { available: boolean; linked: boolean; linkedAt: string | null };
  token?: string;
}

/** `GET /api/agent/[kernel]/approvals`: the public count. */
export interface AgentApprovalCount {
  pending: number;
}

/** One row of the activity tape: a post, a reply, a treasury op, a runtime status change or a config edit. */
export interface AgentActivityItem {
  /** ISO 8601, newest first. */
  at: string;
  kind: string;
  summary: string;
  txHash?: Hex;
  url?: string;
}

export interface AgentActivity {
  items: AgentActivityItem[];
}
