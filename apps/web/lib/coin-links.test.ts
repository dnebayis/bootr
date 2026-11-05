import { describe, expect, it } from 'vitest';
import { NO_COIN_LINKS, ownContractUri, pickCoinLinks } from './coin-links';
import { env } from './env';

const DRAFT = '3b241101-e2bb-4255-8caf-4136c566a962';

describe('coin page links from the hosted contract URI', () => {
  it('only reads contract URIs this site hosts', () => {
    expect(ownContractUri(`${env.siteUrl}/tokens/${DRAFT}.json`)).toBe(`/tokens/${DRAFT}.json`);
    expect(ownContractUri(`/tokens/${DRAFT}`)).toBe(`/tokens/${DRAFT}`);
    expect(ownContractUri(`https://elsewhere.example/tokens/${DRAFT}.json`)).toBeNull();
    expect(ownContractUri('ipfs://bafy')).toBeNull();
    expect(ownContractUri(null)).toBeNull();
  });

  it('finds the hosted document inside a Clanker token\'s JSON metadata, under the same rules', () => {
    const json = (contractUri: unknown) => JSON.stringify({ description: 'd', socialMediaUrls: [], contractUri });
    expect(ownContractUri(json(`${env.siteUrl}/tokens/${DRAFT}.json`))).toBe(`/tokens/${DRAFT}.json`);
    expect(ownContractUri(json(`https://elsewhere.example/tokens/${DRAFT}.json`))).toBeNull();
    expect(ownContractUri(json(json(`${env.siteUrl}/tokens/${DRAFT}.json`)))).toBeNull();
    expect(ownContractUri(json(7))).toBeNull();
    expect(ownContractUri('{"description":"a coin launched elsewhere"}')).toBeNull();
    expect(ownContractUri('{not json')).toBeNull();
  });

  it("shows the project's X account and keeps the agent's own handle out", () => {
    const doc = {
      external_link: 'https://quiet.engine',
      socialMediaUrls: [
        { platform: 'x', url: 'https://x.com/quietengine' },
        { platform: 'x', url: 'https://x.com/qeng_agent' },
        { platform: 'telegram', url: 'https://t.me/quietengine' },
        { platform: 'website', url: 'https://quiet.engine' },
      ],
    };
    expect(pickCoinLinks(doc, 'QENG_agent')).toEqual({ website: 'https://quiet.engine', x: 'https://x.com/quietengine', telegram: 'https://t.me/quietengine', discord: null });
    // Launched before the project X field existed: the agent's entry alone is not a project link.
    const older = { external_link: `${env.siteUrl}/token/0xabc`, socialMediaUrls: [{ platform: 'x', url: 'https://x.com/qeng_agent' }, { platform: 'website', url: env.siteUrl }] };
    expect(pickCoinLinks(older, 'qeng_agent')).toEqual(NO_COIN_LINKS);
    // A silent agent: the only X entry is the project's.
    expect(pickCoinLinks(older, null)).toEqual({ ...NO_COIN_LINKS, x: 'https://x.com/qeng_agent' });
  });

  it('ignores anything that is not an https profile link', () => {
    const doc = { socialMediaUrls: [{ platform: 'x', url: 'javascript:alert(1)' }, { platform: 'x', url: 'https://x.com/quietengine/status/1' }, { platform: 'discord', url: 'http://discord.gg/abc' }] };
    expect(pickCoinLinks(doc, null)).toEqual(NO_COIN_LINKS);
    expect(pickCoinLinks(null, null)).toEqual(NO_COIN_LINKS);
    expect(pickCoinLinks('nope', null)).toEqual(NO_COIN_LINKS);
  });
});
