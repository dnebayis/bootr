import { signedFetch } from './hmac.js';

export interface SocialStats {
  xHandle?: string;
  lastPostAt?: number | null;
  postsCount24h?: number;
  status?: 'awake' | 'sleeping' | 'paused' | 'dormant' | 'claimed';
  /** The agent's x402 spender EOA (`sv_agents.spender`), or null until derived. The indexer reads its USDC float. */
  spender?: string | null;
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

  /** `GET /platform/feed?since=<unix s>`: launches, agent status changes, posts, agent fee claims and totals (platform-feed.ts), or null. */
  platformFeed(sinceSec: number) {
    return this.get(`/platform/feed?since=${Math.max(0, Math.floor(sinceSec))}`);
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
