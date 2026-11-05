'use client';

/**
 * Typed client for the Ponder indexer (docs/data-contract.md).
 * GraphQL at `${NEXT_PUBLIC_INDEXER_URL}/graphql`, REST helpers alongside.
 * In mock mode every fetcher resolves from lib/mock.ts instead.
 */
import { useEffect } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { Address } from 'viem';
import { applyCoinImage, type CoinImageMap } from './coin-image';
import { env } from './env';
import { mock, subscribeMock } from './mock';
import { hasFilters, NO_FILTERS, tokenListRequest, type TokenFilters } from './token-filters';
import type {
  Agent,
  AgentActivity,
  AgentApproval,
  AgentApprovalCount,
  AgentApprovals,
  AgentConfig,
  AgentFuel,
  ApprovalDecision,
  AgentPosts,
  AgentWithToken,
  BoardId,
  BoardPeriod,
  CreatorProfile,
  DailyStat,
  FeesByKind,
  FuelEvent,
  Holding,
  Leaderboard,
  PlatformStats,
  StreamHint,
  Token,
  TokenDetail,
  TokenPage,
  TokenTab,
} from './types';

export const PAGE_SIZE = 48;

// ---------------------------------------------------------------- transport

class IndexerError extends Error {}

/**
 * `token.source` (`bootr` | `clanker`) arrived with the Clanker launch path. An indexer built before it rejects the
 * field, so the first such error drops it from every later query (the web then treats every coin as a Bootr coin).
 * TODO(clanker): remove once every deployment's indexer carries `token.source`.
 */
let indexerHasSource = true;
const SOURCE_FIELD = /\bsource\b/g;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const q = indexerHasSource ? query : query.replace(SOURCE_FIELD, '');
  const res = await fetch(`${env.indexerUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q, variables }),
  });
  if (!res.ok) throw new IndexerError(`Indexer responded ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    const message = json.errors.map((e) => e.message).join('; ');
    if (indexerHasSource && /Cannot query field "source"/.test(message)) {
      indexerHasSource = false;
      return gql(query, variables);
    }
    throw new IndexerError(message);
  }
  if (!json.data) throw new IndexerError('Empty indexer response');
  return json.data;
}

async function rest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${env.indexerUrl}${path}`, init);
  if (!res.ok) throw new IndexerError(`Indexer responded ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** Simulated latency so skeletons are visible in mock mode. */
const delay = (ms = 220) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fragments

const TOKEN_FIELDS = /* GraphQL */ `
  id chainId name symbol image creator kernel burner agentId poolId pairedToken lpFeeBps source
  agentBps creatorBps burnBps platformBps workerHash model agentUri metadata xHandle launchedAt launchBlock
  priceUsd marketCapUsd liquidityUsd volume24hUsd volume7dUsd fees24hUsd holders graduated graduatedAt lastTradeAt
  agent { id status }
`;

const AGENT_FIELDS = /* GraphQL */ `
  id token status lastActivityAt dormancyPeriod dormantSince treasuryUsdc treasuryWeth treasuryEth
  treasuryOwnToken spender spenderUsdc treasuryUsd fuelReceivedUsdc feesClaimedUsd reputationScore reputationCount
  lastPostAt postsCount24h
`;

const TRADE_FIELDS = /* GraphQL */ `
  id token trader side amountToken amountPaired priceUsd valueUsd timestamp txHash
`;

const DAILY_FIELDS = /* GraphQL */ `
  id launches volumeUsd feesUsd feesAgentUsd feesCreatorUsd feesBurnUsd feesPlatformUsd
  activeAgents awakeAgents bootBurnedToken bootBurnedUsd
`;

const PLATFORM_FIELDS = /* GraphQL */ `
  tokens agentsAwake volume24hUsd volumeTotalUsd feesTotalUsd bootToken bootPriceUsd bootMarketCapUsd
  bootChange24hPct bootBurnedTotal bootFeesToBurnUsd graduationThresholdUsd updatedAt
`;

type Paged<T> = { items: T[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } };

// ---------------------------------------------------------------- coin images

const COIN_IMAGES_TTL_MS = 30_000;
let coinImagesMemo: { at: number; images: Promise<CoinImageMap> } | null = null;

/** The creators' off-chain images. If they cannot be read, coins show their on-chain image: never an error. */
function coinImages(): Promise<CoinImageMap> {
  if (env.useMock) return Promise.resolve(mock.coinImages());
  if (coinImagesMemo && Date.now() - coinImagesMemo.at < COIN_IMAGES_TTL_MS) return coinImagesMemo.images;
  const images = fetch('/api/coin-images')
    .then((r) => (r.ok ? (r.json() as Promise<{ images?: CoinImageMap }>) : {}))
    .then((j: { images?: CoinImageMap }) => j.images ?? {})
    .catch((): CoinImageMap => ({}));
  coinImagesMemo = { at: Date.now(), images };
  return images;
}

/** After the creator saved: the next fetch reads the new images. */
export function forgetCoinImages() {
  coinImagesMemo = null;
}

async function withImages<T extends { id: string; image: string }>(tokens: T[]): Promise<(T & { imageOnChain?: string })[]> {
  const images = await coinImages();
  return tokens.map((t) => applyCoinImage(t, images));
}

// ---------------------------------------------------------------- fetchers

const ORDER: Record<Exclude<TokenTab, 'trending'>, { orderBy: string; where?: Record<string, unknown> }> = {
  newest: { orderBy: 'launchedAt' },
  graduated: { orderBy: 'graduatedAt', where: { graduated: true } },
  mcap: { orderBy: 'marketCapUsd' },
  active: { orderBy: 'volume24hUsd' },
};

export async function fetchTokens(tab: TokenTab, after: string | null = null, limit = PAGE_SIZE, filters: TokenFilters = NO_FILTERS): Promise<TokenPage> {
  const page = await readTokens(tab, after, limit, filters);
  return { ...page, items: await withImages(page.items) };
}

async function readTokens(tab: TokenTab, after: string | null, limit: number, filters: TokenFilters): Promise<TokenPage> {
  if (env.useMock) {
    await delay();
    return mock.tokenList(tab, filters, after, limit);
  }
  if (tab === 'trending' || hasFilters(filters)) {
    const { path, params } = tokenListRequest(tab, filters);
    params.set('limit', String(limit));
    if (after) params.set('after', after);
    return rest<TokenPage>(`${path}?${params}`);
  }
  if (tab === 'newest') {
    // Bump order (last trade, else launch): Ponder's GraphQL cannot sort on coalesce(), the indexer's REST route can.
    const qs = new URLSearchParams({ limit: String(limit) });
    if (after) qs.set('after', after);
    return rest<TokenPage>(`/tokens/bumped?${qs}`);
  }
  const { orderBy, where: baseWhere } = ORDER[tab];
  let where: Record<string, unknown> | undefined = baseWhere;
  if (tab === 'active') {
    // Ponder GraphQL cannot filter on relation fields: resolve awake agents first.
    const awake = await gql<{ agents: Paged<{ token: Address }> }>(
      `query Awake { agents(where: { status: "awake" }, limit: 1000) { items { token } } }`,
    );
    where = { id_in: awake.agents.items.map((a) => a.token) };
  }
  const data = await gql<{ tokens: Paged<Token> }>(
    `query Tokens($where: tokenFilter, $orderBy: String, $after: String, $limit: Int) {
      tokens(where: $where, orderBy: $orderBy, orderDirection: "desc", after: $after, limit: $limit) {
        items { ${TOKEN_FIELDS} }
        pageInfo { endCursor hasNextPage }
      }
    }`,
    { where, orderBy, after, limit },
  );
  return data.tokens;
}

export async function fetchLeaderboard(board: BoardId, period: BoardPeriod): Promise<Leaderboard> {
  let read: Leaderboard;
  if (env.useMock) {
    await delay();
    read = mock.leaderboard(board, period);
  } else {
    read = await rest<Leaderboard>(`/leaderboards/${board}?period=${period}`);
  }
  const images = await coinImages();
  return { ...read, items: read.items.map((r) => ({ ...r, token: applyCoinImage(r.token, images) })) };
}

export async function fetchCreatorProfile(address: string): Promise<CreatorProfile> {
  let read: CreatorProfile;
  if (env.useMock) {
    await delay();
    read = mock.creatorProfile(address);
  } else {
    read = await rest<CreatorProfile>(`/creator/${address.toLowerCase()}`);
  }
  return { ...read, coins: await withImages(read.coins) };
}

export async function fetchToken(id: string): Promise<TokenDetail | null> {
  if (env.useMock) {
    await delay();
    const t = mock.token(id);
    return t ? applyCoinImage(t, await coinImages()) : null;
  }
  const data = await gql<{ token: (Token & { agent: Agent | null }) | null; trades: Paged<TokenDetail['trades'][number]> }>(
    `query Token($id: String!) {
      token(id: $id) { ${TOKEN_FIELDS.replace('agent { id status }', `agent { ${AGENT_FIELDS} }`)} }
      trades(where: { token: $id }, orderBy: "timestamp", orderDirection: "desc", limit: 20) { items { ${TRADE_FIELDS} } }
    }`,
    { id: id.toLowerCase() },
  );
  if (!data.token) return null;
  return applyCoinImage({ ...data.token, agent: data.token.agent ?? null, trades: data.trades.items }, await coinImages());
}

export async function fetchAgent(kernel: string): Promise<Agent | null> {
  if (env.useMock) {
    await delay();
    return mock.agent(kernel);
  }
  const data = await gql<{ agent: Agent | null }>(`query Agent($id: String!) { agent(id: $id) { ${AGENT_FIELDS} } }`, {
    id: kernel.toLowerCase(),
  });
  return data.agent;
}

export async function fetchAgents(): Promise<AgentWithToken[]> {
  const [agents, images] = await Promise.all([readAgents(), coinImages()]);
  return agents.map((a) => ({ ...a, tokenInfo: a.tokenInfo ? applyCoinImage(a.tokenInfo, images) : null }));
}

async function readAgents(): Promise<AgentWithToken[]> {
  if (env.useMock) {
    await delay();
    return mock.agents();
  }
  // TODO(indexer): assumes a Ponder relation `agent.tokenRef -> token` (the `token` column is the FK).
  const data = await gql<{ agents: Paged<Agent & { tokenRef: AgentWithToken['tokenInfo'] }> }>(
    `query Agents { agents(limit: 1000, orderBy: "treasuryUsd", orderDirection: "desc") {
      items { ${AGENT_FIELDS} tokenRef { id name symbol image creator xHandle source lpFeeBps } }
    } }`,
  );
  return data.agents.items.map(({ tokenRef, ...a }) => ({ ...a, tokenInfo: tokenRef ?? null }));
}

export async function fetchFees(id: string): Promise<FeesByKind> {
  if (env.useMock) {
    await delay();
    return mock.fees(id);
  }
  return rest<FeesByKind>(`/token/${id.toLowerCase()}/fees`);
}

export async function fetchDailyStats(): Promise<DailyStat[]> {
  if (env.useMock) {
    await delay();
    return mock.daily();
  }
  const data = await gql<{ dailyStats: Paged<DailyStat> }>(
    `query Daily { dailyStats(orderBy: "id", orderDirection: "desc", limit: 90) { items { ${DAILY_FIELDS} } } }`,
  );
  return [...data.dailyStats.items].reverse();
}

export async function fetchPlatformStats(): Promise<PlatformStats | null> {
  if (env.useMock) {
    await delay(120);
    return mock.platform();
  }
  const data = await gql<{ platformStats: PlatformStats | null }>(
    `query Platform { platformStats(id: "global") { ${PLATFORM_FIELDS} } }`,
  );
  return data.platformStats;
}

export async function fetchSearch(q: string): Promise<Token[]> {
  if (!q.trim()) return [];
  if (env.useMock) {
    await delay(80);
    return withImages(mock.search(q));
  }
  const res = await rest<Token[] | { items: Token[] }>(`/search?q=${encodeURIComponent(q.trim())}`);
  return withImages(Array.isArray(res) ? res : res.items);
}

export async function fetchTokensByCreator(creator: string): Promise<Token[]> {
  if (env.useMock) {
    await delay();
    return withImages(mock.tokensByCreator(creator));
  }
  const data = await gql<{ tokens: Paged<Token> }>(
    `query ByCreator($creator: String!) {
      tokens(where: { creator: $creator }, orderBy: "launchedAt", orderDirection: "desc", limit: 100) { items { ${TOKEN_FIELDS} } }
    }`,
    { creator: creator.toLowerCase() },
  );
  return withImages(data.tokens.items);
}

/**
 * TODO(indexer): `GET /holdings/:owner` is not in the data contract yet. Proposed shape: Holding[].
 * Returns [] until the endpoint exists.
 */
export async function fetchHoldings(owner: string): Promise<Holding[]> {
  const [holdings, images] = await Promise.all([readHoldings(owner), coinImages()]);
  return holdings.map((h) => ({ ...h, token: applyCoinImage(h.token, images) }));
}

async function readHoldings(owner: string): Promise<Holding[]> {
  if (env.useMock) {
    await delay();
    return mock.holdings();
  }
  try {
    return await rest<Holding[]>(`/holdings/${owner.toLowerCase()}`);
  } catch {
    return [];
  }
}

/**
 * TODO(indexer): `GET /fuel/:from` (USDC transfers from an address to any Bootr kernel) is not in the
 * data contract yet. Proposed shape: FuelEvent[]. Returns [] until the endpoint exists.
 */
export async function fetchFuelHistory(from: string): Promise<FuelEvent[]> {
  if (env.useMock) {
    await delay();
    return mock.fuelHistory();
  }
  try {
    return await rest<FuelEvent[]>(`/fuel/${from.toLowerCase()}`);
  } catch {
    return [];
  }
}

/**
 * Latest posts of an agent (by ERC-8004 agent id) through this app's `/api/agents/:id/posts`, which
 * proxies the internal sender. 404 = the sender never saw the agent (no X account). Null when the
 * posts cannot be loaded (sender unset or down).
 */
export async function fetchAgentPosts(agentId: string): Promise<AgentPosts | null> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/posts?limit=3`);
  if (res.status === 404) return { handle: null, items: [] };
  if (!res.ok) return null;
  const json = (await res.json()) as Partial<AgentPosts>;
  return { handle: typeof json.handle === 'string' ? json.handle : null, items: Array.isArray(json.items) ? json.items.slice(0, 3) : [] };
}


/**
 * The agent's current configuration (`/api/agent/:kernel/config`, proxied to the supervisor). Null when the
 * supervisor does not know the agent (404); throws when the service is unavailable (503) so the console can say so.
 */
export async function fetchAgentConfig(kernel: string): Promise<AgentConfig | null> {
  const res = await fetch(`/api/agent/${encodeURIComponent(kernel.toLowerCase())}/config`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new IndexerError(`Agent config responded ${res.status}`);
  return (await res.json()) as AgentConfig;
}

export async function fetchAgentFuel(kernel: string): Promise<AgentFuel> {
  const res = await fetch(`/api/agent/${encodeURIComponent(kernel.toLowerCase())}/fuel`, { cache: 'no-store' });
  if (!res.ok) throw new IndexerError(`Agent fuel responded ${res.status}`);
  const json = (await res.json()) as Partial<AgentFuel>;
  return { days: typeof json.days === 'number' ? json.days : 7, since: typeof json.since === 'string' ? json.since : '', ...(typeof json.firstAt === 'string' ? { firstAt: json.firstAt } : {}), byModel: Array.isArray(json.byModel) ? json.byModel : [] };
}

export const ACTIVITY_PAGE = 30;

/** One page of the activity tape (`/api/agent/:kernel/activity`), newest first; `before` pages past the last `at` shown. */
export async function fetchAgentActivity(kernel: string, before: string | null = null): Promise<AgentActivity> {
  const q = new URLSearchParams({ limit: String(ACTIVITY_PAGE) });
  if (before) q.set('before', before);
  const res = await fetch(`/api/agent/${encodeURIComponent(kernel.toLowerCase())}/activity?${q.toString()}`, { cache: 'no-store' });
  if (res.status === 404) return { items: [] };
  if (!res.ok) throw new IndexerError(`Agent activity responded ${res.status}`);
  const json = (await res.json()) as Partial<AgentActivity>;
  return { items: Array.isArray(json.items) ? json.items : [] };
}

/** How many posts wait for the creator's review (`/api/agent/:kernel/approvals`, public). */
export async function fetchApprovalCount(kernel: string): Promise<AgentApprovalCount> {
  const res = await fetch(`/api/agent/${encodeURIComponent(kernel.toLowerCase())}/approvals`, { cache: 'no-store' });
  if (!res.ok) throw new IndexerError(`Approval count responded ${res.status}`);
  const json = (await res.json()) as Partial<AgentApprovalCount>;
  return { pending: typeof json.pending === 'number' ? json.pending : 0 };
}

/** The creator's proof for the review routes: a fresh SIWE signature, or the review token an earlier call returned. */
export type ReviewAuth = { message: string; signature: string } | { token: string };

/** A review route answered with an error; `status` 401 `review_expired` means: sign again. */
export class ReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function reviewCall<T>(kernel: string, path: 'list' | 'decide', body: Record<string, unknown>, query = ''): Promise<T> {
  const res = await fetch(`/api/agent/${encodeURIComponent(kernel.toLowerCase())}/approvals/${path}${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ReviewError(res.status, err.error ?? `http_${res.status}`, err.message ?? `The review request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

/** The review queue (texts, image previews); `token` in the answer keeps the session without another signature. */
export function fetchApprovals(kernel: string, auth: ReviewAuth, status: 'pending' | 'all' = 'pending'): Promise<AgentApprovals> {
  return reviewCall<AgentApprovals>(kernel, 'list', auth, status === 'all' ? '?status=all' : '');
}

/** Approve (sends the post now) or reject (with an optional note the agent reads) one queued item. */
export function decideApproval(kernel: string, auth: ReviewAuth, approvalId: string, decision: ApprovalDecision, note?: string): Promise<AgentApproval> {
  return reviewCall<AgentApproval>(kernel, 'decide', { ...auth, approvalId, decision, ...(note ? { note } : {}) });
}

// ---------------------------------------------------------------- query keys

export const qk = {
  tokens: (tab: TokenTab, after?: string | null) => ['tokens', tab, after ?? null] as const,
  tokenFeed: (tab: TokenTab, filters: TokenFilters = NO_FILTERS) => ['tokens', 'feed', tab, filters] as const,
  leaderboard: (board: BoardId, period: BoardPeriod) => ['leaderboard', board, period] as const,
  creator: (address: string) => ['creator', address.toLowerCase()] as const,
  token: (id: string) => ['token', id.toLowerCase()] as const,
  fees: (id: string) => ['token', id.toLowerCase(), 'fees'] as const,
  agent: (kernel: string) => ['agent', kernel.toLowerCase()] as const,
  agents: () => ['agents'] as const,
  daily: () => ['dailyStats'] as const,
  platform: () => ['platformStats'] as const,
  search: (q: string) => ['search', q.trim().toLowerCase()] as const,
  byCreator: (a: string) => ['profile', a.toLowerCase(), 'tokens'] as const,
  holdings: (a: string) => ['profile', a.toLowerCase(), 'holdings'] as const,
  fuel: (a: string) => ['profile', a.toLowerCase(), 'fuel'] as const,
  posts: (k: string) => ['posts', k.toLowerCase()] as const,
  agentConfig: (kernel: string) => ['agent', kernel.toLowerCase(), 'config'] as const,
  agentActivity: (kernel: string) => ['agent', kernel.toLowerCase(), 'activity'] as const,
  approvalCount: (kernel: string) => ['agent', kernel.toLowerCase(), 'approvals', 'count'] as const,
  agentFuel: (kernel: string) => ['agent', kernel.toLowerCase(), 'fuel'] as const,
};

// ---------------------------------------------------------------- hooks

export function useTokens({ tab, after = null }: { tab: TokenTab; after?: string | null }) {
  return useQuery({
    queryKey: qk.tokens(tab, after),
    queryFn: () => fetchTokens(tab, after),
    placeholderData: keepPreviousData,
  });
}

/** Infinite feed for the home grid. */
export function useTokenFeed(tab: TokenTab, filters: TokenFilters = NO_FILTERS) {
  return useInfiniteQuery({
    queryKey: qk.tokenFeed(tab, filters),
    queryFn: ({ pageParam }) => fetchTokens(tab, pageParam, PAGE_SIZE, filters),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? last.pageInfo.endCursor : undefined),
  });
}

export function useLeaderboard(board: BoardId, period: BoardPeriod) {
  return useQuery({ queryKey: qk.leaderboard(board, period), queryFn: () => fetchLeaderboard(board, period), staleTime: 15_000, refetchInterval: 60_000, retry: 1 });
}

export function useCreatorProfile(address: string | undefined) {
  return useQuery({ queryKey: qk.creator(address ?? ''), queryFn: () => fetchCreatorProfile(address!), enabled: !!address, staleTime: 15_000, retry: 1 });
}

export function useToken(id: string | undefined) {
  return useQuery({
    queryKey: qk.token(id ?? ''),
    queryFn: () => fetchToken(id!),
    enabled: !!id,
  });
}

export function useTokenFees(id: string | undefined) {
  return useQuery({ queryKey: qk.fees(id ?? ''), queryFn: () => fetchFees(id!), enabled: !!id });
}

export function useAgent(kernel: string | undefined) {
  return useQuery({ queryKey: qk.agent(kernel ?? ''), queryFn: () => fetchAgent(kernel!), enabled: !!kernel });
}

export function useAgents(enabled = true) {
  return useQuery({ queryKey: qk.agents(), queryFn: fetchAgents, enabled });
}

export function useDailyStats() {
  return useQuery({ queryKey: qk.daily(), queryFn: fetchDailyStats, staleTime: 60_000 });
}

export function usePlatformStats() {
  return useQuery({ queryKey: qk.platform(), queryFn: fetchPlatformStats });
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: qk.search(q),
    queryFn: () => fetchSearch(q),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function useTokensByCreator(addr: string | undefined) {
  return useQuery({ queryKey: qk.byCreator(addr ?? ''), queryFn: () => fetchTokensByCreator(addr!), enabled: !!addr });
}

export function useHoldings(addr: string | undefined) {
  return useQuery({ queryKey: qk.holdings(addr ?? ''), queryFn: () => fetchHoldings(addr!), enabled: !!addr });
}

export function useFuelHistory(addr: string | undefined) {
  return useQuery({ queryKey: qk.fuel(addr ?? ''), queryFn: () => fetchFuelHistory(addr!), enabled: !!addr });
}

export function useAgentPosts(agentId: string | undefined) {
  return useQuery({ queryKey: qk.posts(agentId ?? ''), queryFn: () => fetchAgentPosts(agentId!), enabled: !!agentId, staleTime: 60_000 });
}


export function useAgentConfig(kernel: string | undefined, enabled = true) {
  return useQuery({ queryKey: qk.agentConfig(kernel ?? ''), queryFn: () => fetchAgentConfig(kernel!), enabled: !!kernel && enabled, staleTime: 30_000, retry: 1 });
}

/** Thoughts per model over the last week (the economy mode line of the creator console). */
export function useAgentFuel(kernel: string | undefined, enabled = true) {
  return useQuery({ queryKey: qk.agentFuel(kernel ?? ''), queryFn: () => fetchAgentFuel(kernel!), enabled: !!kernel && enabled, staleTime: 60_000, retry: 1 });
}

/** The "n pending" badge of the creator console; polled while the page is open. */
export function useApprovalCount(kernel: string | undefined, enabled = true) {
  return useQuery({ queryKey: qk.approvalCount(kernel ?? ''), queryFn: () => fetchApprovalCount(kernel!), enabled: !!kernel && enabled, staleTime: 15_000, refetchInterval: 60_000, retry: 1 });
}

/** Infinite activity tape; the next page starts before the last item's `at`. A short page means the end. */
export function useAgentActivity(kernel: string | undefined) {
  return useInfiniteQuery({
    queryKey: qk.agentActivity(kernel ?? ''),
    queryFn: ({ pageParam }) => fetchAgentActivity(kernel!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.items.length >= ACTIVITY_PAGE ? (last.items[last.items.length - 1]?.at ?? undefined) : undefined),
    enabled: !!kernel,
    staleTime: 30_000,
    retry: 1,
  });
}

// ---------------------------------------------------------------- live stream

function applyHint(client: QueryClient, hint: StreamHint) {
  // Hints only tell us *what* changed. We never apply payload data; we refetch.
  if (hint.type === 'launch') {
    void client.invalidateQueries({ queryKey: ['tokens'] });
    void client.invalidateQueries({ queryKey: qk.platform() });
    return;
  }
  if (hint.tokenId) {
    void client.invalidateQueries({ queryKey: qk.token(hint.tokenId) });
  }
  if (hint.type === 'trade') {
    void client.invalidateQueries({ queryKey: ['tokens'] });
    void client.invalidateQueries({ queryKey: qk.platform() });
  }
  if (hint.type === 'agent') {
    void client.invalidateQueries({ queryKey: ['agent'] });
    void client.invalidateQueries({ queryKey: ['tokens'] });
  }
}

function isHint(v: unknown): v is StreamHint {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  return t === 'launch' || t === 'trade' || t === 'agent';
}

/**
 * Subscribes to `/stream` (SSE) and invalidates affected queries. Bursts are coalesced
 * into one invalidation per animation-friendly window (750ms).
 */
export function useIndexerStream() {
  const client = useQueryClient();
  useEffect(() => {
    let pending: StreamHint[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const enqueue = (h: StreamHint) => {
      pending.push(h);
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        const batch = pending;
        pending = [];
        flushTimer = null;
        const seen = new Set<string>();
        for (const h of batch) {
          const key = `${h.type}:${h.tokenId ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          applyHint(client, h);
        }
      }, 750);
    };

    if (env.useMock) {
      const off = subscribeMock(enqueue);
      return () => {
        off();
        if (flushTimer) clearTimeout(flushTimer);
      };
    }

    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const open = () => {
      es = new EventSource(`${env.indexerUrl}/stream`);
      es.onopen = () => {
        attempts = 0;
      };
      es.onmessage = (ev) => {
        try {
          const parsed: unknown = JSON.parse(ev.data as string);
          if (isHint(parsed)) enqueue({ type: parsed.type, tokenId: typeof parsed.tokenId === 'string' ? parsed.tokenId : undefined });
        } catch {
          /* ignore malformed hints */
        }
      };
      es.onerror = () => {
        es?.close();
        attempts++;
        retry = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempts));
      };
    };
    open();
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [client]);
}
