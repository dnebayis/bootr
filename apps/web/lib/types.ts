/** Shapes from docs/data-contract.md. Amounts are integer base-unit strings. */
import type { Address, Hex } from 'viem';

export type AgentStatus = 'awake' | 'sleeping' | 'paused' | 'dormant' | 'claimed';
export type RecipientKind = 'agent' | 'creator' | 'burn' | 'platform';
export type TokenTab = 'newest' | 'graduated' | 'mcap' | 'active';

export interface Agent {
  id: Address; // kernel
  token: Address;
  status: AgentStatus;
  lastActivityAt: number;
  dormancyPeriod: number;
  dormantSince: number | null;
  treasuryUsdc: string;
  treasuryWeth: string;
  treasuryEth: string;
  treasuryOwnToken: string;
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
  image: string;
  creator: Address;
  kernel: Address;
  burner: Address | null;
  agentId: string;
  poolId: Hex;
  pairedToken: Address;
  lpFeeBps: number;
  agentBps: number;
  creatorBps: number;
  burnBps: number;
  platformBps: number;
  workerHash: Hex;
  model: string;
  agentUri: string;
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

export interface TokenDetail extends Token {
  agent: Agent | null;
  trades: Trade[];
}

export interface AgentWithToken extends Agent {
  tokenInfo: Pick<Token, 'id' | 'name' | 'symbol' | 'image' | 'creator' | 'xHandle'> | null;
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
  token: Pick<Token, 'id' | 'name' | 'symbol' | 'image' | 'priceUsd' | 'marketCapUsd'>;
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
