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
import { env } from './env';
import { mock, subscribeMock } from './mock';
import type {
  Agent,
  AgentPosts,
  AgentWithToken,
  DailyStat,
  FeesByKind,
  FuelEvent,
  Holding,
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

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${env.indexerUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new IndexerError(`Indexer responded ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new IndexerError(json.errors.map((e) => e.message).join('; '));
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
  id chainId name symbol image creator kernel burner agentId poolId pairedToken lpFeeBps
  agentBps creatorBps burnBps platformBps workerHash model agentUri xHandle launchedAt launchBlock
  priceUsd marketCapUsd liquidityUsd volume24hUsd volume7dUsd fees24hUsd holders graduated graduatedAt
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

// ---------------------------------------------------------------- fetchers

const ORDER: Record<TokenTab, { orderBy: string; where?: Record<string, unknown> }> = {
  newest: { orderBy: 'launchedAt' },
  graduated: { orderBy: 'graduatedAt', where: { graduated: true } },
  mcap: { orderBy: 'marketCapUsd' },
  active: { orderBy: 'volume24hUsd' },
};

export async function fetchTokens(tab: TokenTab, after: string | null = null, limit = PAGE_SIZE): Promise<TokenPage> {
  if (env.useMock) {
    await delay();
    return mock.tokens(tab, after, limit);
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

export async function fetchToken(id: string): Promise<TokenDetail | null> {
  if (env.useMock) {
    await delay();
    return mock.token(id);
  }
  const data = await gql<{ token: (Token & { agent: Agent | null }) | null; trades: Paged<TokenDetail['trades'][number]> }>(
    `query Token($id: String!) {
      token(id: $id) { ${TOKEN_FIELDS.replace('agent { id status }', `agent { ${AGENT_FIELDS} }`)} }
      trades(where: { token: $id }, orderBy: "timestamp", orderDirection: "desc", limit: 20) { items { ${TRADE_FIELDS} } }
    }`,
    { id: id.toLowerCase() },
  );
  if (!data.token) return null;
  return { ...data.token, agent: data.token.agent ?? null, trades: data.trades.items };
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
  if (env.useMock) {
    await delay();
    return mock.agents();
  }
  // TODO(indexer): assumes a Ponder relation `agent.tokenRef -> token` (the `token` column is the FK).
  const data = await gql<{ agents: Paged<Agent & { tokenRef: AgentWithToken['tokenInfo'] }> }>(
    `query Agents { agents(limit: 1000, orderBy: "treasuryUsd", orderDirection: "desc") {
      items { ${AGENT_FIELDS} tokenRef { id name symbol image creator xHandle } }
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
    return mock.search(q);
  }
  const res = await rest<Token[] | { items: Token[] }>(`/search?q=${encodeURIComponent(q.trim())}`);
  return Array.isArray(res) ? res : res.items;
}

export async function fetchTokensByCreator(creator: string): Promise<Token[]> {
  if (env.useMock) {
    await delay();
    return mock.tokensByCreator(creator);
  }
  const data = await gql<{ tokens: Paged<Token> }>(
    `query ByCreator($creator: String!) {
      tokens(where: { creator: $creator }, orderBy: "launchedAt", orderDirection: "desc", limit: 100) { items { ${TOKEN_FIELDS} } }
    }`,
    { creator: creator.toLowerCase() },
  );
  return data.tokens.items;
}

/**
 * TODO(indexer): `GET /holdings/:owner` is not in the data contract yet. Proposed shape: Holding[].
 * Returns [] until the endpoint exists.
 */
export async function fetchHoldings(owner: string): Promise<Holding[]> {
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

// ---------------------------------------------------------------- query keys

export const qk = {
  tokens: (tab: TokenTab, after?: string | null) => ['tokens', tab, after ?? null] as const,
  tokenFeed: (tab: TokenTab) => ['tokens', 'feed', tab] as const,
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
export function useTokenFeed(tab: TokenTab) {
  return useInfiniteQuery({
    queryKey: qk.tokenFeed(tab),
    queryFn: ({ pageParam }) => fetchTokens(tab, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? last.pageInfo.endCursor : undefined),
  });
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
