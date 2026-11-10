import { describe, expect, it } from 'vitest';
import { descriptionOf, withDescription } from './v5-metadata';

describe('v5 metadata JSON', () => {
  it('reads the description of Clanker’s JSON, and nothing from anything else', () => {
    expect(descriptionOf('{"description":" A coin. ","socialMediaUrls":[]}')).toBe('A coin.');
    expect(descriptionOf('https://bootr.fun/tokens/x.json')).toBeNull();
    expect(descriptionOf(null)).toBeNull();
  });

  it('replaces the description and keeps the links, audits and Bootr’s contractUri', () => {
    const before = JSON.stringify({ description: 'old', socialMediaUrls: [{ platform: 'x', url: 'https://x.com/a' }], auditUrls: [], contractUri: 'https://bootr.fun/tokens/1.json' });
    expect(JSON.parse(withDescription(before, 'new'))).toEqual({ description: 'new', socialMediaUrls: [{ platform: 'x', url: 'https://x.com/a' }], auditUrls: [], contractUri: 'https://bootr.fun/tokens/1.json' });
    expect(JSON.parse(withDescription('not json', 'new'))).toEqual({ socialMediaUrls: [], auditUrls: [], description: 'new' });
  });
});
