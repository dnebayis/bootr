/** Shapes from docs/data-contract.md. Amounts are integer base-unit strings. */
import type { Address, Hex } from 'viem';
import type { CapabilityKey } from '@bootr/shared/workers';

export type { CapabilityKey };

export type AgentStatus = 'awake' | 'sleeping' | 'paused' | 'dormant' | 'claimed';
export type RecipientKind = 'agent' | 'creator' | 'burn' | 'platform';
/** Which launcher created the coin: Bootr's own (RWAGMI v3 pool and locker) or the Clanker wrapper (docs/design/clanker-launch.md). */
export type LaunchSource = 'bootr' | 'clanker';
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
  agentId: string;
  poolId: Hex;
  pairedToken: Address;
  /** The pool's swap fee, 1e6-based (10000 = 1%). Fixed at 1% on the Bootr path; per coin on the Clanker path. */
  lpFeeBps: number;
  /** `bootr` (default; older indexers omit the field) or `clanker`. */
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
  byKind: Record<RecipientKind, { accruedUsd: number; claimedUsd: number }>;
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
  creatorFees: { earnedUsd: number; claimedUsd: number };
}

/** `GET /creator/:address`. */
export interface CreatorProfile {
  address: Address;
  readAt: number;
  indexedAt: number | null;
  totals: { coins: number; agents: number; earnedUsd: number; claimedUsd: number };
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
  /** Posts and replies wait in the review queue until the creator approves them (default on for the platform's agent). */
  requireApproval: boolean;
  /** Economy mode: the cheaper model a turn starts on for reading and deciding; null = the whole turn runs on `model`. */
  routing: { decideModel: string | null };
  /** The image model in force for `generate_image` (one of `/api/models?kind=image`). */
  imageModel: string;
  /** How its pictures look: a public https reference picture (the coin's image by default) and the creator's notes. */
  imageStyle: AgentImageStyle;
  /** Starts at 0; every creator edit bumps it ("edited n times"). */
  revision: number;
  /** ISO 8601. */
  updatedAt: string;
}

export interface AgentImageStyle {
  reference: string | null;
  notes: string;
}

/** What the creator may change from the coin page; only the fields present are applied. */
export interface AgentConfigChanges {
  instructions?: string;
  model?: string;
  worker?: {
    capabilities?: Partial<Record<CapabilityKey, boolean>>;
    postIntervalMs?: number;
    jobLines?: string[];
  };
  requireApproval?: boolean;
  imageModel?: string;
  /** Partial: a missing field keeps its stored value; `reference: null` removes the picture. */
  imageStyle?: Partial<AgentImageStyle>;
  routing?: { decideModel: string | null };
}

/** `GET /api/agent/[kernel]/fuel` (the supervisor's `GET /internal/agents/:id/fuel`): paid thoughts per model over the last `days`. */
export interface AgentFuel {
  days: number;
  /** ISO 8601: the start of the window. */
  since: string;
  /** The earliest paid thought in the window: what a spending rate divides by. Absent when there were none. */
  firstAt?: string;
  /** Most thoughts first; `chargedMicroUsdc` is a decimal string of micro-USDC. `paidFailures`: thoughts charged that returned nothing. */
  byModel: { model: string; thoughts: number; chargedMicroUsdc: string; paidFailures?: number }[];
}

// ---------------------------------------------------------------- post approval queue (supervisor, via /api/agent/[kernel]/approvals/*)

export type ApprovalStatus = 'pending_approval' | 'approved' | 'rejected' | 'failed';
export type ApprovalDecision = 'approve' | 'reject';

/** One post or reply the agent wants to send, waiting for (or decided by) the creator. */
export interface AgentApproval {
  id: string;
  kind: 'post' | 'reply';
  text: string;
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
