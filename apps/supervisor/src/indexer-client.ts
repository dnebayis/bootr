import { signedFetch } from './hmac.js';

export interface SocialStats {
  xHandle?: string;
  lastPostAt?: number | null;
  /** When the agent's first ever post or reply went out (unix s); the indexer keeps the earliest value it ever saw. */
  firstPostAt?: number | null;
  postsCount24h?: number;
  status?: 'awake' | 'sleeping' | 'paused' | 'dormant' | 'claimed';
  /** The agent's x402 spender EOA (`sv_agents.spender`), or null until derived. The indexer reads its USDC float. */
  spender?: string | null;
  /** The model the agent runs on now (config.model); the coin page shows it instead of the launch-time one. */
  model?: string;
}

/** Read-side client for the Ponder indexer REST helpers (docs/data-contract.md). Every read is best effort. */
export class IndexerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async get(path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.fetchImpl(new URL(path, this.baseUrl).toString(), { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** `GET /market/:token` compact snapshot, or null when the indexer is unavailable. */
  market(token: string) {
    return this.get(`/market/${token}`);
  }

  /** `GET /treasury/:kernel` compact snapshot, or null. */
  treasury(kernel: string) {
    return this.get(`/treasury/${kernel}`);
  }

  /** `GET /platform/feed?since=<unix s>`: launches, milestones, agent status changes, posts, first posts, agent fee claims and totals (platform-feed.ts), or null. */
  platformFeed(sinceSec: number) {
    return this.get(`/platform/feed?since=${Math.max(0, Math.floor(sinceSec))}`);
  }

  /**
   * `POST /graphql` (Ponder's public GraphQL): the `data` object, or null when the indexer is unavailable,
   * answers with errors, or the body is not an object. Variables are the caller's; nothing is interpolated
   * into the query text.
   */
  async graphql(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.fetchImpl(new URL('/graphql', this.baseUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: unknown; errors?: unknown[] };
      if (!body || typeof body !== 'object' || (Array.isArray(body.errors) && body.errors.length > 0)) return null;
      return body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** `POST /internal/agent/:kernel/social` (HMAC). Failures are logged by the caller, never fatal. */
  async postSocial(kernel: string, stats: SocialStats): Promise<boolean> {
    try {
      const res = await signedFetch(this.fetchImpl, this.key, this.baseUrl, 'POST', `/internal/agent/${kernel}/social`, stats, 10_000);
      return res.ok;
    } catch {
      return false;
    }
  }
}
