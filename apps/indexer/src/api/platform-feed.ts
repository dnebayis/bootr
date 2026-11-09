/**
 * `GET /platform/feed` body, composed from the rows the route reads (api/index.ts). Pure, so the shape is
 * testable without Ponder: timestamps are unix seconds, lists are newest first and capped at FEED_LIMIT,
 * and nothing here carries a price or a market cap (the platform agent must not talk about them).
 */
import { usd } from '../lib/price';
import type { AgentSocial } from '../lib/social-store';

export const FEED_LIMIT = 50;
/** The window never reaches further back than this. */
export const FEED_MAX_AGE_SEC = 7 * 86_400;

export type FeedSocial = Pick<AgentSocial, 'kernel' | 'xHandle' | 'lastPostAt' | 'firstPostAt' | 'postsCount24h'>;

export interface FeedInput {
  now: number;
  since: number;
  stats?: { tokens: number; agentsTotal: number; agentsAwake: number; volume24hUsd: number; fees24hUsd: number; updatedAt: number } | undefined;
  /** Sum of every coin's rolling 7-day volume. */
  volume7dUsd: number;
  social: ReadonlyMap<string, FeedSocial>;
  /** `source`: the launch path (`bootr` | `clanker` | `clanker-v5`); `lpFeeBps`: the coin's own LP fee or v5 tax (10000 = 1%). */
  launches: { token: string; kernel: string; name: string; symbol: string; creator: string; launchedAt: number; xHandle: string | null; source: string; lpFeeBps: number }[];
  statusChanges: { kernel: string; token: string; status: string; at: number }[];
  claims: { token: string; recipient: string; amountUsd: number; at: number; txHash: string }[];
  milestones: { token: string; kernel: string; kind: string; value: number; timestamp: number; txHash: string | null }[];
  /** Symbol / handle of the coins the other rows refer to by address (`feedNameRefs` says which are needed). */
  named: { id: string; kernel: string; symbol: string; xHandle: string | null }[];
}

/** `since` for the route: the query value clamped to the last FEED_MAX_AGE_SEC. */
export function feedWindow(now: number, sinceQuery: string | undefined): { now: number; since: number } {
  const floor = now - FEED_MAX_AGE_SEC;
  const raw = Number(sinceQuery);
  return { now, since: Number.isFinite(raw) && raw > floor ? Math.floor(raw) : floor };
}

const byTime = <T>(at: (x: T) => number) => (a: T, b: T) => at(b) - at(a);

/** Agents that posted in the window (by last post) and agents whose first ever post fell in the window. */
export function socialRows(social: ReadonlyMap<string, FeedSocial>, since: number) {
  const all = [...social.values()];
  const posted = all.filter((s) => s.lastPostAt !== null && s.lastPostAt >= since).sort(byTime((s) => s.lastPostAt!)).slice(0, FEED_LIMIT);
  const firstPosts = all.filter((s) => s.firstPostAt !== null && s.firstPostAt >= since).sort(byTime((s) => s.firstPostAt!)).slice(0, FEED_LIMIT);
  return { posted, firstPosts };
}

/** Which kernels and token ids the composer needs a symbol for. */
export function feedNameRefs(input: Pick<FeedInput, 'statusChanges' | 'claims' | 'milestones' | 'social' | 'since'>): { kernels: string[]; tokenIds: string[] } {
  const { posted, firstPosts } = socialRows(input.social, input.since);
  const kernels = new Set<string>([...input.statusChanges.map((r) => r.kernel), ...posted.map((p) => p.kernel), ...firstPosts.map((p) => p.kernel)]);
  const tokenIds = new Set<string>([...input.claims.map((r) => r.token), ...input.milestones.map((r) => r.token)]);
  return { kernels: [...kernels], tokenIds: [...tokenIds] };
}

export function composePlatformFeed(input: FeedInput) {
  const { now, since, stats, social } = input;
  const { posted, firstPosts } = socialRows(social, since);
  const byKernel = new Map(input.named.map((t) => [t.kernel, t]));
  const byToken = new Map(input.named.map((t) => [t.id, t]));
  const handle = (kernel: string, fallback: string | null | undefined) => social.get(kernel)?.xHandle ?? fallback ?? null;
  const cap = <T>(rows: T[]) => rows.slice(0, FEED_LIMIT);
  return {
    now,
    since,
    totals: {
      tokens: stats?.tokens ?? 0,
      agentsTotal: stats?.agentsTotal ?? 0,
      agentsAwake: stats?.agentsAwake ?? 0,
      volume24hUsd: stats?.volume24hUsd ?? 0,
      volume7dUsd: usd(Number.isFinite(input.volume7dUsd) ? input.volume7dUsd : 0),
      fees24hUsd: stats?.fees24hUsd ?? 0,
      updatedAt: stats?.updatedAt ?? null,
    },
    launches: cap([...input.launches].sort(byTime((t) => t.launchedAt))).map((t) => ({ ...t, xHandle: handle(t.kernel, t.xHandle) })),
    statusChanges: cap([...input.statusChanges].sort(byTime((r) => r.at))).map((r) => ({
      ...r,
      symbol: byKernel.get(r.kernel)?.symbol ?? null,
      xHandle: handle(r.kernel, byKernel.get(r.kernel)?.xHandle),
    })),
    posts: posted.map((p) => ({
      kernel: p.kernel,
      token: byKernel.get(p.kernel)?.id ?? null,
      symbol: byKernel.get(p.kernel)?.symbol ?? null,
      xHandle: p.xHandle,
      lastPostAt: p.lastPostAt,
      postsCount24h: p.postsCount24h,
    })),
    firstPosts: firstPosts.map((p) => ({
      kernel: p.kernel,
      token: byKernel.get(p.kernel)?.id ?? null,
      symbol: byKernel.get(p.kernel)?.symbol ?? null,
      xHandle: p.xHandle,
      firstPostAt: p.firstPostAt,
      lastPostAt: p.lastPostAt,
      postsCount24h: p.postsCount24h,
    })),
    claims: cap([...input.claims].sort(byTime((r) => r.at))).map((r) => ({
      ...r,
      kernel: byToken.get(r.token)?.kernel ?? r.recipient,
      symbol: byToken.get(r.token)?.symbol ?? null,
    })),
    milestones: cap([...input.milestones].sort(byTime((r) => r.timestamp))).map((r) => ({
      token: r.token,
      kernel: r.kernel,
      symbol: byToken.get(r.token)?.symbol ?? null,
      kind: r.kind,
      value: r.value,
      at: r.timestamp,
      txHash: r.txHash,
    })),
  };
}

export type PlatformFeedBody = ReturnType<typeof composePlatformFeed>;
