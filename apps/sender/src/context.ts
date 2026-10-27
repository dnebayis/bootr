import type { Db } from './db/client.js';
import type { OAuthSettings } from './oauth.js';
import type { XClient } from './x-client.js';

export interface SenderContext {
  db: Db;
  x: XClient;
  oauth: OAuthSettings;
  encryptionKey: Buffer;
  serviceKey: string;
  now: () => Date;
  defaults: { postsPerDay: number; mentionReadIntervalSec: number };
  /** Where /oauth/callback redirects the browser; unset = JSON. */
  oauthReturnUrl?: string;
  /** X request timeout; used to decide when a `pending` row is stale. */
  xTimeoutMs: number;
}

export const nowSec = (ctx: SenderContext): number => Math.floor(ctx.now().getTime() / 1000);
