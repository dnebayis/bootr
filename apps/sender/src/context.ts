import type { Db } from './db/client.js';
import type { OAuthSettings } from './oauth.js';
import type { PublicApiOptions } from './public-posts.js';
import type { XClient } from './x-client.js';

export interface SenderContext {
  db: Db;
  x: XClient;
  oauth: OAuthSettings;
  encryptionKey: Buffer;
  serviceKey: string;
  now: () => Date;
  /** `readsPerDay`: X read units per agent per UTC day (src/read-budget.ts); 0 = no budget. */
  defaults: {
    postsPerDay: number;
    mentionReadIntervalSec: number;
    readsPerDay: number;
    /** Posts with a link per agent per rolling 24 h, for a coin's agent and for the platform's own account; absent or 0 = no count. */
    linkPostsPerDay?: number;
    linkPostsPerDayPlatform?: number;
    /** Posts in one thread and the length of each part; absent = agent-core's `THREAD_MAX_PARTS` and `THREAD_PART_MAX_CHARS`. */
    threadMaxParts?: number;
    threadPartMaxChars?: number;
  };
  /** Where /oauth/callback redirects the browser; unset = JSON. */
  oauthReturnUrl?: string;
  /** X request timeout; used to decide when a `pending` row is stale. */
  xTimeoutMs: number;
  /** `/public/*` rate limit and client-IP source; defaults to DEFAULT_PUBLIC_API. */
  publicApi?: PublicApiOptions;
  /** The page at `GET /`: where the catalogue lives; defaults to DEFAULT_SITE_URL and the global fetch. */
  apiPage?: { siteUrl: string; fetch?: typeof fetch };
}

export const nowSec = (ctx: SenderContext): number => Math.floor(ctx.now().getTime() / 1000);
