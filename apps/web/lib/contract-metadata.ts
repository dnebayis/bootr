import type { CardToken } from './agent-card';
import { env } from './env';
import type { DraftCoin } from './server/launch-drafts';

/**
 * ERC-7572 contract metadata (`/tokens/<launchId>.json`, the B20 token's `contractURI`): name, symbol,
 * description, image, external_link, plus `socialMediaUrls` and `imageIpfs`. The indexed token's on-chain
 * fields win over the launch draft once it is indexed; `external_link` is the token page, or the site while
 * the token address is not known yet.
 */
export function buildContractMetadata(launch: { identity: string | null; coin: DraftCoin | null }, token: CardToken | null) {
  const name = token?.name ?? launch.coin?.name ?? '';
  const xHandle = token?.xHandle ?? launch.coin?.xHandle ?? null;
  const persona = launch.identity?.split('\n')[0]?.trim();
  return {
    name,
    symbol: token?.symbol ?? launch.coin?.symbol ?? '',
    description: persona ? `${persona} — an autonomous agent coin launched on Bootr.` : `${name}: an autonomous agent coin launched on Bootr.`,
    image: token?.image || launch.coin?.image || '',
    external_link: token ? `${env.siteUrl}/token/${token.id}` : env.siteUrl,
    socialMediaUrls: [...(xHandle ? [{ platform: 'x', url: `https://x.com/${xHandle}` }] : []), { platform: 'website', url: env.siteUrl }],
    ...(launch.coin?.imageIpfs ? { imageIpfs: launch.coin.imageIpfs } : {}),
  };
}
