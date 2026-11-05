import { describe, expect, it } from 'vitest';
import { activeFilterCount, dayEndUnix, dayStartUnix, hasFilters, isCreatorAddress, parseTokenFilters, tokenListRequest, tokensPageQuery } from './token-filters';

const addr = `0x${'Ab'.repeat(20)}`;
const parse = (q: string) => parseTokenFilters(new URLSearchParams(q));

describe('parseTokenFilters', () => {
  it('reads a shared view back', () => {
    expect(parse(`creator=${addr}&path=clanker&from=2026-11-01&to=2026-11-05&agent=yes&sort=holders`)).toEqual({
      creator: addr.toLowerCase(),
      path: 'clanker',
      from: '2026-11-01',
      to: '2026-11-05',
      agent: 'yes',
      sort: 'holders',
    });
  });

  it('drops what it cannot read instead of failing', () => {
    expect(parse('creator=nope&path=pump&from=yesterday&to=2026-13-40&agent=maybe&sort=price')).toEqual({});
  });
});

describe('tokensPageQuery', () => {
  it('round-trips through the URL', () => {
    const f = { creator: addr.toLowerCase(), path: 'bootr' as const, from: '2026-11-01', agent: 'no' as const, sort: 'mcap' as const };
    const q = tokensPageQuery('graduated', f);
    expect(new URLSearchParams(q).get('tab')).toBe('graduated');
    expect(parse(q)).toEqual(f);
  });

  it('leaves the default tab and empty filters out', () => {
    expect(tokensPageQuery('newest', {})).toBe('');
    expect(tokensPageQuery('trending', {})).toBe('tab=trending');
  });
});

describe('counts', () => {
  it('does not count the sort as a filter', () => {
    expect(activeFilterCount({ sort: 'mcap' })).toBe(0);
    expect(hasFilters({ sort: 'mcap' })).toBe(true);
    expect(activeFilterCount({ path: 'bootr', agent: 'yes' })).toBe(2);
    expect(hasFilters({})).toBe(false);
  });
});

describe('isCreatorAddress', () => {
  it('takes a full address only', () => {
    expect(isCreatorAddress(addr)).toBe(true);
    expect(isCreatorAddress(`  ${addr} `)).toBe(true);
    expect(isCreatorAddress('0x12')).toBe(false);
  });
});

describe('tokenListRequest', () => {
  it('gives each tab its meaning', () => {
    expect(Object.fromEntries(tokenListRequest('newest', {}).params)).toEqual({ sort: 'bumped' });
    expect(Object.fromEntries(tokenListRequest('mcap', {}).params)).toEqual({ sort: 'mcap' });
    expect(Object.fromEntries(tokenListRequest('graduated', {}).params)).toEqual({ sort: 'graduated', graduated: 'true' });
    expect(Object.fromEntries(tokenListRequest('active', {}).params)).toEqual({ sort: 'volume24h', agentStatus: 'awake' });
  });

  it('lets the sort in the URL win', () => {
    expect(tokenListRequest('active', { sort: 'holders' }).params.get('sort')).toBe('holders');
  });

  it('sends trending to its own route, filtered, with no sort', () => {
    const r = tokenListRequest('trending', { path: 'clanker', sort: 'mcap' });
    expect(r.path).toBe('/tokens/trending');
    expect(Object.fromEntries(r.params)).toEqual({ source: 'clanker' });
  });

  it('covers whole UTC days in the launch date filter', () => {
    const q = tokenListRequest('newest', { from: '2026-11-01', to: '2026-11-01', agent: 'no', creator: addr.toLowerCase() }).params;
    expect(q.get('from')).toBe(String(Date.UTC(2026, 10, 1) / 1000));
    expect(q.get('to')).toBe(String(Date.UTC(2026, 10, 1, 23, 59, 59) / 1000));
    expect(q.get('hasAgent')).toBe('false');
    expect(q.get('creator')).toBe(addr.toLowerCase());
    expect(dayEndUnix('2026-11-01') - dayStartUnix('2026-11-01')).toBe(86_399);
  });
});
