import { describe, expect, it } from 'vitest';
import type { CardToken } from './agent-card';
import { contractUriUrl } from './agent-card';
import { buildContractMetadata, clankerTokenMetadata, coinDescription } from './contract-metadata';
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
      website: null,
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

describe('a Clanker token\'s on-chain metadata', () => {
  const uri = contractUriUrl(DRAFT);

  it('is the JSON Clanker reads, with the project and agent accounts, the hosted document inside', () => {
    const links = { website: 'https://quiet.engine', x: 'https://x.com/quietengine', telegram: 'https://t.me/quiet', discord: null };
    const doc = JSON.parse(clankerTokenMetadata({ ...coin, xHandle: 'quietbot', links }, uri));
    expect(doc).toEqual({
      description: 'Quiet Engine: an autonomous agent coin launched on Bootr.',
      socialMediaUrls: [
        { platform: 'x', url: 'https://x.com/quietengine' },
        { platform: 'x', url: 'https://x.com/quietbot' },
        { platform: 'telegram', url: 'https://t.me/quiet' },
        { platform: 'website', url: 'https://quiet.engine' },
      ],
      auditUrls: [],
      contractUri: uri,
    });
  });

  it("is the JSON itself in the shape Clanker's deploy form writes, never a link", () => {
    const links = { website: 'https://bootr.fun', x: 'https://x.com/bootrfun', telegram: null, discord: null };
    const raw = clankerTokenMetadata({ ...coin, name: 'Bootr', xHandle: null, links }, uri, 'Runs the Bootr launchpad.\nMore lines.');
    expect(raw.startsWith('{')).toBe(true);
    const doc = JSON.parse(raw) as Record<string, unknown>;
    // Clanker's keys in Clanker's order, our hosted document last (clanker.world keeps the extra key).
    expect(Object.keys(doc)).toEqual(['description', 'socialMediaUrls', 'auditUrls', 'contractUri']);
    expect(doc).toEqual({
      description: 'Runs the Bootr launchpad. — an autonomous agent coin launched on Bootr.',
      socialMediaUrls: [
        { platform: 'x', url: 'https://x.com/bootrfun' },
        { platform: 'website', url: 'https://bootr.fun' },
      ],
      auditUrls: [],
      contractUri: uri,
    });
    for (const s of doc.socialMediaUrls as { platform: string; url: string }[]) {
      expect(['x', 'website', 'telegram', 'discord']).toContain(s.platform);
      expect(s.url).toMatch(/^https:\/\//);
    }
  });

  it('lists Discord under its own platform key and escapes what JSON must', () => {
    const links = { ...none, discord: 'https://discord.gg/quiet' };
    const raw = clankerTokenMetadata({ ...coin, xHandle: null, links }, uri, 'Says "hello" and \\ backslashes, ünïcode 🚀');
    const doc = JSON.parse(raw) as { description: string; socialMediaUrls: unknown[] };
    expect(doc.description).toBe('Says "hello" and \\ backslashes, ünïcode 🚀 — an autonomous agent coin launched on Bootr.');
    expect(doc.socialMediaUrls).toEqual([
      { platform: 'discord', url: 'https://discord.gg/quiet' },
      { platform: 'website', url: env.siteUrl },
    ]);
  });

  it('describes the coin the same way on chain and in the hosted document', () => {
    const identity = 'A patient onchain analyst.\nNo hype.';
    const hosted = buildContractMetadata({ identity, coin }, null);
    expect(JSON.parse(clankerTokenMetadata(coin, uri, identity)).description).toBe(hosted.description);
    // The browser sends the raw text, the server stores it normalized: both give the same line.
    expect(coinDescription('Quiet Engine', '\n  A  patient​ onchain analyst.\r\nNo hype.')).toBe(hosted.description);
    expect(coinDescription('Quiet Engine', null)).toBe('Quiet Engine: an autonomous agent coin launched on Bootr.');
    expect(coinDescription('Quiet Engine', '   ')).toBe('Quiet Engine: an autonomous agent coin launched on Bootr.');
  });

  it('stays small at the longest instructions and links (the fork tests launch a string this size)', () => {
    const long = { website: `https://${'w'.repeat(180)}.example`, x: 'https://x.com/abcdefghijklmno', telegram: `https://t.me/${'t'.repeat(32)}`, discord: `https://discord.gg/${'d'.repeat(32)}` };
    const raw = clankerTokenMetadata({ ...coin, xHandle: 'zyxwvutsrqponml', links: long }, uri, 'a'.repeat(600));
    expect(new TextEncoder().encode(raw).length).toBeLessThan(1_500);
  });

  it('lists one X entry when the accounts are the same, and the site when no website was given', () => {
    const doc = JSON.parse(clankerTokenMetadata({ ...coin, xHandle: 'QuietEngine', links: { ...none, x: 'https://x.com/quietengine' } }, uri));
    expect(doc.socialMediaUrls).toEqual([
      { platform: 'x', url: 'https://x.com/quietengine' },
      { platform: 'website', url: env.siteUrl },
    ]);
  });
});

