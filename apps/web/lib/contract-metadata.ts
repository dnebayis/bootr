import type { CardToken } from './agent-card';
import { env } from './env';
import type { DraftCoin } from './server/launch-drafts';
import { xHandleOfUrl } from './x-link';

/**
 * ERC-7572 contract metadata (`/tokens/<launchId>.json`, the B20 token's `contractURI`): name, symbol,
 * description, image, external_link, plus `socialMediaUrls` and `imageIpfs`. The indexed token's on-chain
 * fields win over the launch draft once it is indexed; `external_link` is the coin's own website when the
 * creator gave one, else the token page, or the site while the token address is not known yet. The coin's
 * own X account, Telegram and Discord (launch form) are listed in `socialMediaUrls` next to the agent's X
 * account: the project's X entry comes first, the agent's after it (skipped when they are the same account).
 * Coins launched before the project X field exist carry the agent's entry alone.
 */
export function buildContractMetadata(launch: { identity: string | null; coin: DraftCoin | null }, token: CardToken | null) {
  const name = token?.name ?? launch.coin?.name ?? '';
  const xHandle = token?.xHandle ?? launch.coin?.xHandle ?? null;
  const persona = launch.identity?.split('\n')[0]?.trim();
  const links = launch.coin?.links;
  const projectX = links?.x && xHandleOfUrl(links.x) ? links.x : null;
  const sameAccount = !!projectX && !!xHandle && xHandleOfUrl(projectX)!.toLowerCase() === xHandle.toLowerCase();
  return {
    name,
    symbol: token?.symbol ?? launch.coin?.symbol ?? '',
    description: persona ? `${persona} — an autonomous agent coin launched on Bootr.` : `${name}: an autonomous agent coin launched on Bootr.`,
    image: token?.image || launch.coin?.image || '',
    external_link: links?.website || (token ? `${env.siteUrl}/token/${token.id}` : env.siteUrl),
    socialMediaUrls: [
      ...(projectX ? [{ platform: 'x', url: projectX }] : []),
      ...(xHandle && !sameAccount ? [{ platform: 'x', url: `https://x.com/${xHandle}` }] : []),
      ...(links?.telegram ? [{ platform: 'telegram', url: links.telegram }] : []),
      ...(links?.discord ? [{ platform: 'discord', url: links.discord }] : []),
      { platform: 'website', url: links?.website || env.siteUrl },
    ],
    ...(launch.coin?.imageIpfs ? { imageIpfs: launch.coin.imageIpfs } : {}),
  };
}
