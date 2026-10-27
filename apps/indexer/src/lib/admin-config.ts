import { getAddress, isAddress, type Address } from 'viem';

import { indexerEnv } from './env';
import { adminConfigHeaders } from './hmac';

export type RemoteConfig = { graduationThresholdUsd?: number; bootToken?: Address | null };

const TTL_MS = 60_000;
let cache: { at: number; value: RemoteConfig | null } | undefined;
let warned = false;

/**
 * `GET ${ADMIN_CONFIG_URL}` (apps/web /api/admin/config), HMAC-signed with INDEXER_SERVICE_KEY (legacy fallback: SENDER_SERVICE_KEY).
 * Cached for 60 s; returns null when unset or unreachable (callers keep the last stored value).
 */
export async function fetchAdminConfig(): Promise<RemoteConfig | null> {
  const env = indexerEnv();
  if (!env.adminConfigUrl || !env.serviceKey) return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value: RemoteConfig | null = null;
  try {
    const res = await fetch(env.adminConfigUrl, {
      headers: adminConfigHeaders(env.serviceKey, env.adminConfigUrl),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    const o = (json.config && typeof json.config === 'object' ? json.config : json) as Record<string, unknown>;
    value = {};
    const th = Number(o.graduationThresholdUsd);
    if (Number.isFinite(th) && th > 0) value.graduationThresholdUsd = th;
    if (typeof o.bootToken === 'string' && isAddress(o.bootToken)) value.bootToken = getAddress(o.bootToken);
    else if (o.bootToken === null) value.bootToken = null;
    warned = false;
  } catch (err) {
    if (!warned) console.warn(`[indexer] admin config fetch failed (${env.adminConfigUrl}): ${(err as Error).message}`);
    warned = true;
  }
  cache = { at: Date.now(), value };
  return value;
}
