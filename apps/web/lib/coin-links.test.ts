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

  it("shows the website the creator entered, even when it is this site, and not the token page fallback", () => {
    const fallback = `${env.siteUrl}/token/0xabc`;
    expect(pickCoinLinks({ external_link: `${env.siteUrl}/`, website: `${env.siteUrl}/` }).website).toBe(`${env.siteUrl}/`);
    expect(pickCoinLinks({ external_link: fallback, website: null }).website).toBeNull();
    // a document without the field: the old rule
    expect(pickCoinLinks({ external_link: fallback }).website).toBeNull();
    expect(pickCoinLinks({ external_link: 'https://quiet.engine' }).website).toBe('https://quiet.engine');
  });

  it("shows the first X account in the document: the project's when there is one, else the agent's own", () => {
    const doc = {
      external_link: 'https://quiet.engine',
      socialMediaUrls: [
        { platform: 'x', url: 'https://x.com/quietengine' },
        { platform: 'x', url: 'https://x.com/qeng_agent' },
        { platform: 'telegram', url: 'https://t.me/quietengine' },
        { platform: 'website', url: 'https://quiet.engine' },
      ],
    };
    expect(pickCoinLinks(doc)).toEqual({ website: 'https://quiet.engine', x: 'https://x.com/quietengine', telegram: 'https://t.me/quietengine', discord: null });
    // Launched before the project X field existed, so the agent's account is the coin's only X entry: it still gets
    // the X button (the creator entered it; Brian Brain's @BRIANBRAINAI is such a coin).
    const older = { external_link: `${env.siteUrl}/token/0xabc`, socialMediaUrls: [{ platform: 'x', url: 'https://x.com/qeng_agent' }, { platform: 'website', url: env.siteUrl }] };
    expect(pickCoinLinks(older)).toEqual({ ...NO_COIN_LINKS, x: 'https://x.com/qeng_agent' });
    // An X entry that is not a profile link is skipped in favour of the next one.
    const skipped = { socialMediaUrls: [{ platform: 'x', url: 'https://x.com/i/flow/login' }, { platform: 'x', url: 'https://x.com/qeng_agent' }] };
    expect(pickCoinLinks(skipped)).toEqual({ ...NO_COIN_LINKS, x: 'https://x.com/qeng_agent' });
  });

  it('ignores anything that is not an https profile link', () => {
    const doc = { socialMediaUrls: [{ platform: 'x', url: 'javascript:alert(1)' }, { platform: 'x', url: 'https://x.com/quietengine/status/1' }, { platform: 'discord', url: 'http://discord.gg/abc' }] };
    expect(pickCoinLinks(doc)).toEqual(NO_COIN_LINKS);
    expect(pickCoinLinks(null)).toEqual(NO_COIN_LINKS);
    expect(pickCoinLinks('nope')).toEqual(NO_COIN_LINKS);
  });
});
