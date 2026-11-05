import { loadConfig, type Config } from './config.js';
import type { SenderContext } from './context.js';
import { parseKey } from './crypto.js';
import { createDb } from './db/client.js';
import { XClient } from './x-client.js';

export function buildContext(config: Config = loadConfig()): {
  ctx: SenderContext;
  config: Config;
  close: () => Promise<void>;
} {
  const { db, close } = createDb(config.DATABASE_URL);
  const encryptionKey = parseKey(config.SENDER_ENCRYPTION_KEY);
  const ctx: SenderContext = {
    db,
    x: new XClient({ baseUrl: config.X_API_BASE_URL, timeoutMs: config.X_TIMEOUT_MS }),
    oauth: {
      clientId: config.X_CLIENT_ID,
      clientSecret: config.X_CLIENT_SECRET,
      redirectUri: config.X_REDIRECT_URI,
      authorizeUrl: config.X_AUTHORIZE_URL,
      tokenUrl: `${config.X_API_BASE_URL.replace(/\/$/, '')}/2/oauth2/token`,
      serviceKey: config.SENDER_SERVICE_KEY,
      encryptionKey,
      timeoutMs: config.X_TIMEOUT_MS,
    },
    encryptionKey,
    serviceKey: config.SENDER_SERVICE_KEY,
    now: () => new Date(),
    defaults: {
      postsPerDay: config.SENDER_DEFAULT_POSTS_PER_DAY,
      mentionReadIntervalSec: config.SENDER_DEFAULT_MENTION_INTERVAL_SEC,
    },
    oauthReturnUrl: config.SENDER_OAUTH_RETURN_URL,
    xTimeoutMs: config.X_TIMEOUT_MS,
    publicApi: {
      ratePerMinute: config.SENDER_PUBLIC_RATE_LIMIT_PER_MIN,
      trustProxy: config.SENDER_TRUST_PROXY,
    },
    apiPage: { siteUrl: config.SENDER_SITE_URL },
  };
  return { ctx, config, close };
}
