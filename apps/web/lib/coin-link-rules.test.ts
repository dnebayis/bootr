import { describe, expect, it } from 'vitest';
import { checkLinks, LINK_ERRORS, NO_LINKS, normalizeLink, normalizeLinks, sameLinks } from './coin-link-rules';

describe('coin link rules', () => {
  it('normalizes each kind the way the launch form does', () => {
    expect(normalizeLink('website', ' https://quiet.engine ')).toBe('https://quiet.engine');
    expect(normalizeLink('website', 'http://quiet.engine')).toBeUndefined();
    expect(normalizeLink('website', '')).toBeNull();
    expect(normalizeLink('website', null)).toBeNull();
    expect(normalizeLink('website', 42)).toBeUndefined();
    expect(normalizeLink('x', '@bootrfun')).toBe('https://x.com/bootrfun');
    expect(normalizeLink('x', 'https://twitter.com/bootrfun')).toBe('https://x.com/bootrfun');
    expect(normalizeLink('x', 'https://example.com/bootrfun')).toBeUndefined();
    expect(normalizeLink('telegram', 'https://t.me/bootr')).toBe('https://t.me/bootr');
    expect(normalizeLink('telegram', 'https://telegram.org/bootr')).toBeUndefined();
    expect(normalizeLink('discord', 'https://discord.gg/abc')).toBe('https://discord.gg/abc');
    expect(normalizeLink('discord', 'https://discord.com/invite/abc')).toBe('https://discord.com/invite/abc');
    expect(normalizeLink('discord', 'https://discord.com/channels/1')).toBeUndefined();
    expect(normalizeLink('website', `https://${'a'.repeat(200)}`)).toBeUndefined();
  });

  it('checks a whole links object and names the first field that is off', () => {
    expect(checkLinks({ website: 'https://quiet.engine', x: '@bootrfun', telegram: '', discord: null })).toEqual({
      ok: true,
      links: { website: 'https://quiet.engine', x: 'https://x.com/bootrfun', telegram: null, discord: null },
    });
    expect(checkLinks(undefined)).toEqual({ ok: true, links: NO_LINKS });
    expect(checkLinks({ website: 'ftp://x', x: 'nope!' })).toEqual({ ok: false, field: 'website', message: LINK_ERRORS.website });
    expect(checkLinks({ x: 'https://facebook.com/bootr' })).toEqual({ ok: false, field: 'x', message: LINK_ERRORS.x });
    expect(normalizeLinks({ discord: 'https://discord.com/channels/1' })).toBeNull();
    expect(normalizeLinks({})).toEqual(NO_LINKS);
  });

  it("takes any X profile as the coin's X, the agent's own account included, and compares link sets", () => {
    // Whatever X account the creator enters is shown; the agent's own handle is no exception.
    expect(checkLinks({ x: '@QENG_agent' })).toEqual({ ok: true, links: { ...NO_LINKS, x: 'https://x.com/QENG_agent' } });
    expect(sameLinks(NO_LINKS, { ...NO_LINKS })).toBe(true);
    expect(sameLinks(NO_LINKS, { ...NO_LINKS, x: 'https://x.com/bootrfun' })).toBe(false);
  });
});
