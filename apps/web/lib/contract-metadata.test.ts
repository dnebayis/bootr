import { describe, expect, it } from 'vitest';
import type { CardToken } from './agent-card';
import { contractUriUrl } from './agent-card';
import { buildContractMetadata } from './contract-metadata';
import { env } from './env';

const DRAFT = '3b241101-e2bb-4255-8caf-4136c566a962';
const none = { website: null, x: null, telegram: null, discord: null };
const coin = { name: 'Quiet Engine', symbol: 'QENG', image: 'https://gateway.pinata.cloud/ipfs/bafy', imageIpfs: 'ipfs://bafy', xHandle: 'qeng_agent', links: none };
const token: CardToken = {
  id: '0xB200000000000000000000123456789abcdef012',
  chainId: 8453,
  name: 'Quiet Engine',
  symbol: 'QENG',
  image: 'https://gateway.pinata.cloud/ipfs/bafy',
  kernel: '0x2000000000000000000000000000000000000002',
  agentId: '7',
  xHandle: 'qeng_agent',
};

describe('ERC-7572 contract metadata', () => {
  it('is hosted per launch id', () => {
    expect(contractUriUrl(DRAFT)).toBe(`${env.siteUrl}/tokens/${DRAFT}.json`);
  });

  it('describes a pending launch from the draft and links the site until the token is indexed', () => {
    const doc = buildContractMetadata({ identity: 'A patient onchain analyst.\nNo hype.', coin }, null);
    expect(doc).toEqual({
      name: 'Quiet Engine',
      symbol: 'QENG',
      description: 'A patient onchain analyst. — an autonomous agent coin launched on Bootr.',
      image: coin.image,
      external_link: env.siteUrl,
      socialMediaUrls: [
        { platform: 'x', url: 'https://x.com/qeng_agent' },
        { platform: 'website', url: env.siteUrl },
      ],
      imageIpfs: 'ipfs://bafy',
    });
  });

  it('links the token page and prefers indexed fields once the launch is indexed', () => {
    const doc = buildContractMetadata({ identity: null, coin: null }, { ...token, name: 'On-chain name', xHandle: null });
    expect(doc.name).toBe('On-chain name');
    expect(doc.external_link).toBe(`${env.siteUrl}/token/${token.id}`);
    expect(doc.description).toBe('On-chain name: an autonomous agent coin launched on Bootr.');
    expect(doc.socialMediaUrls).toEqual([{ platform: 'website', url: env.siteUrl }]);
    expect(doc).not.toHaveProperty('imageIpfs');
  });
  it("uses the coin's own website as external_link and lists its Telegram and Discord", () => {
    const links = { ...none, website: 'https://quiet.engine', telegram: 'https://t.me/quietengine' };
    const doc = buildContractMetadata({ identity: null, coin: { ...coin, links } }, token);
    expect(doc.external_link).toBe('https://quiet.engine');
    expect(doc.socialMediaUrls).toEqual([
      { platform: 'x', url: 'https://x.com/qeng_agent' },
      { platform: 'telegram', url: 'https://t.me/quietengine' },
      { platform: 'website', url: 'https://quiet.engine' },
    ]);
  });

  it("lists the project's X account before the agent's, and once when they are the same account", () => {
    const project = buildContractMetadata({ identity: null, coin: { ...coin, links: { ...none, x: 'https://x.com/quietengine' } } }, token);
    expect(project.socialMediaUrls).toEqual([
      { platform: 'x', url: 'https://x.com/quietengine' },
      { platform: 'x', url: 'https://x.com/qeng_agent' },
      { platform: 'website', url: env.siteUrl },
    ]);
    const same = buildContractMetadata({ identity: null, coin: { ...coin, links: { ...none, x: 'https://x.com/QENG_agent' } } }, token);
    expect(same.socialMediaUrls).toEqual([
      { platform: 'x', url: 'https://x.com/QENG_agent' },
      { platform: 'website', url: env.siteUrl },
    ]);
    const silent = buildContractMetadata({ identity: null, coin: { ...coin, xHandle: null, links: { ...none, x: 'https://x.com/quietengine' } } }, { ...token, xHandle: null });
    expect(silent.socialMediaUrls).toEqual([
      { platform: 'x', url: 'https://x.com/quietengine' },
      { platform: 'website', url: env.siteUrl },
    ]);
  });
});
