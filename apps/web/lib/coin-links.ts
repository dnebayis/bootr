import { useQuery } from '@tanstack/react-query';
import { env } from './env';

/** The coin's own links as the token page shows them (all optional). */
export type CoinPageLinks = { website: string | null; telegram: string | null; discord: string | null };

const NONE: CoinPageLinks = { website: null, telegram: null, discord: null };

/** Only contract URIs this site hosts (`/tokens/<launchId>.json`) are fetched; anything else is never requested. */
export function ownContractUri(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  const site = env.siteUrl.replace(/\/$/, '');
  const m = /^(?:https?:\/\/[^/]+)?(\/tokens\/[0-9a-f-]{36}(?:\.json)?)$/i.exec(metadata);
  if (!m) return null;
  if (/^https?:\/\//i.test(metadata) && !metadata.toLowerCase().startsWith(`${site.toLowerCase()}/`)) return null;
  return m[1]!;
}

function pick(json: unknown): CoinPageLinks {
  if (!json || typeof json !== 'object') return NONE;
  const o = json as { external_link?: unknown; socialMediaUrls?: unknown };
  const urls = Array.isArray(o.socialMediaUrls) ? (o.socialMediaUrls as { platform?: unknown; url?: unknown }[]) : [];
  const site = env.siteUrl.replace(/\/$/, '').toLowerCase();
  const https = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/[^\s"<>]+$/.test(v) && v.length <= 200 ? v : null);
  const of = (platform: string) => https(urls.find((u) => u.platform === platform)?.url);
  // `external_link` is the coin's website when the creator gave one, else this site's token page: not a link to show.
  const external = https(o.external_link);
  const website = external && !external.toLowerCase().startsWith(`${site}/`) && external.toLowerCase() !== site ? external : null;
  return { website, telegram: of('telegram'), discord: of('discord') };
}

/**
 * The coin's website, Telegram and Discord, read from its hosted ERC-7572 contract URI (set in the launch form,
 * `lib/contract-metadata.ts`). Coins whose contract URI is not hosted here (or none at all) show no links.
 */
export function useCoinLinks(metadata: string | null | undefined) {
  const path = env.useMock ? null : ownContractUri(metadata);
  return useQuery({
    queryKey: ['coin-links', path],
    queryFn: async (): Promise<CoinPageLinks> => {
      const res = await fetch(path!, { cache: 'no-store' });
      if (!res.ok) return NONE;
      return pick(await res.json().catch(() => null));
    },
    enabled: !!path,
    staleTime: 5 * 60_000,
    placeholderData: NONE,
  });
}
