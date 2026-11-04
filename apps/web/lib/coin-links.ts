import { useQuery } from '@tanstack/react-query';
import { env } from './env';
import { mock } from './mock';
import { xHandleOfUrl } from './x-link';

/**
 * The coin's own links as the token page shows them (all optional). `x` is the project's X account, never the
 * agent's handle (the page shows that on its own line).
 */
export type CoinPageLinks = { website: string | null; x: string | null; telegram: string | null; discord: string | null };

export const NO_COIN_LINKS: CoinPageLinks = { website: null, x: null, telegram: null, discord: null };

/** Only contract URIs this site hosts (`/tokens/<launchId>.json`) are fetched; anything else is never requested. */
export function ownContractUri(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  const site = env.siteUrl.replace(/\/$/, '');
  const m = /^(?:https?:\/\/[^/]+)?(\/tokens\/[0-9a-f-]{36}(?:\.json)?)$/i.exec(metadata);
  if (!m) return null;
  if (/^https?:\/\//i.test(metadata) && !metadata.toLowerCase().startsWith(`${site.toLowerCase()}/`)) return null;
  return m[1]!;
}

/**
 * The links in a hosted contract URI document (`lib/contract-metadata.ts`). `socialMediaUrls` lists the project's
 * X account and the agent's under the same `x` platform (project first); the agent's entry, the only one coins
 * launched before the field existed carry, is skipped by `agentXHandle`.
 */
export function pickCoinLinks(json: unknown, agentXHandle: string | null | undefined): CoinPageLinks {
  if (!json || typeof json !== 'object') return NO_COIN_LINKS;
  const o = json as { external_link?: unknown; socialMediaUrls?: unknown };
  const urls = Array.isArray(o.socialMediaUrls) ? (o.socialMediaUrls as { platform?: unknown; url?: unknown }[]) : [];
  const site = env.siteUrl.replace(/\/$/, '').toLowerCase();
  const https = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/[^\s"<>]+$/.test(v) && v.length <= 200 ? v : null);
  const of = (platform: string) => https(urls.find((u) => u.platform === platform)?.url);
  // `external_link` is the coin's website when the creator gave one, else this site's token page: not a link to show.
  const external = https(o.external_link);
  const website = external && !external.toLowerCase().startsWith(`${site}/`) && external.toLowerCase() !== site ? external : null;
  const agent = (agentXHandle ?? '').toLowerCase();
  const x =
    urls
      .filter((u) => u.platform === 'x')
      .map((u) => https(u.url))
      .find((url): url is string => {
        const handle = url ? xHandleOfUrl(url) : null;
        return !!handle && handle.toLowerCase() !== agent;
      }) ?? null;
  return { website, x, telegram: of('telegram'), discord: of('discord') };
}

/**
 * The coin's website, X account, Telegram and Discord, read from its hosted ERC-7572 contract URI (set in the
 * launch form, `lib/contract-metadata.ts`). `agentXHandle` is the agent's own handle, kept out of `x`. Coins
 * whose contract URI is not hosted here (or none at all) show no links. Mock mode reads the mock store instead.
 */
export function useCoinLinks(metadata: string | null | undefined, agentXHandle: string | null | undefined) {
  const path = env.useMock ? null : ownContractUri(metadata);
  const mockKey = env.useMock && metadata ? metadata : null;
  return useQuery({
    queryKey: ['coin-links', path ?? mockKey, agentXHandle ?? null],
    queryFn: async (): Promise<CoinPageLinks> => {
      if (mockKey) return mock.coinLinks(mockKey);
      const res = await fetch(path!, { cache: 'no-store' });
      if (!res.ok) return NO_COIN_LINKS;
      return pickCoinLinks(await res.json().catch(() => null), agentXHandle);
    },
    enabled: !!path || !!mockKey,
    staleTime: 5 * 60_000,
    placeholderData: NO_COIN_LINKS,
  });
}
