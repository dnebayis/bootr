import { describe, expect, it } from 'vitest';
import { BOARDS, boardPeriod, isBoardId, knownPostCount, pageOf, parsePage, parseTokenFilters, parseTokenList, percentOfSupply, periodStart, rankRows } from './lists';

const addr = `0x${'Ab'.repeat(20)}`;

describe('parseTokenFilters', () => {
  it('reads every filter', () => {
    expect(parseTokenFilters({ creator: addr, source: 'clanker', from: '100', to: '200', hasAgent: 'false', graduated: 'true', agentStatus: 'awake' })).toEqual({
      creator: addr.toLowerCase(),
      source: 'clanker',
      from: 100,
      to: 200,
      hasAgent: false,
      graduated: true,
      agentStatus: 'awake',
    });
  });

  it('accepts each launch path as the source, Clanker v5 included', () => {
    expect(parseTokenFilters({ source: 'clanker-v5' })).toEqual({ source: 'clanker-v5' });
    expect(parseTokenFilters({ source: 'bootr' })).toEqual({ source: 'bootr' });
    expect(parseTokenFilters({ source: 'clanker-v4' })).toBe('source must be one of bootr, clanker, clanker-v5');
  });

  it('treats absent and empty as no filter', () => {
    expect(parseTokenFilters({})).toEqual({});
    expect(parseTokenFilters({ creator: '', source: '', from: '', to: '', hasAgent: '' })).toEqual({});
  });

  it.each([
    [{ creator: 'nope' }, 'creator'],
    [{ source: 'pump' }, 'source'],
    [{ from: 'yesterday' }, 'from'],
    [{ to: '-5' }, 'to'],
    [{ hasAgent: 'yes' }, 'hasAgent'],
    [{ graduated: '1' }, 'graduated'],
    [{ agentStatus: 'asleep' }, 'agentStatus'],
  ])('refuses %j', (q, name) => {
    expect(parseTokenFilters(q)).toContain(name);
  });
});

describe('parseTokenList and paging', () => {
  it('defaults to bump order and the first page', () => {
    expect(parseTokenList({})).toEqual({ filters: {}, sort: 'bumped', limit: 48, offset: 0 });
  });

  it('refuses an unknown sort', () => {
    expect(parseTokenList({ sort: 'price' })).toContain('sort');
  });

  it('bounds limit and offset', () => {
    expect(parsePage({ limit: '100000', after: '-3' })).toEqual({ limit: 100, offset: 0 });
    expect(parsePage({ limit: 'x', after: 'y' })).toEqual({ limit: 48, offset: 0 });
  });

  it('says where the next page starts', () => {
    const list = [1, 2, 3, 4, 5];
    expect(pageOf(list, 0, 2)).toEqual({ items: [1, 2], pageInfo: { endCursor: '2', hasNextPage: true } });
    expect(pageOf(list, 4, 2)).toEqual({ items: [5], pageInfo: { endCursor: null, hasNextPage: false } });
  });
});

describe('boards', () => {
  it('knows its boards and nothing inherited', () => {
    expect(isBoardId('volume')).toBe(true);
    expect(isBoardId('toString')).toBe(false);
    expect(Object.keys(BOARDS).sort()).toEqual(['agent-activity', 'agent-fees', 'burned', 'holders', 'volume']);
  });

  it('offers a period only where the data has one', () => {
    expect(boardPeriod('volume', undefined)).toBe('24h');
    expect(boardPeriod('volume', 'all')).toBe('all');
    expect(boardPeriod('holders', undefined)).toBe('now');
    expect(boardPeriod('holders', '7d')).toBeNull();
    expect(boardPeriod('agent-activity', '7d')).toBeNull();
  });

  it('turns a period into a start time', () => {
    expect(periodStart('24h', 100_000)).toBe(13_600);
    expect(periodStart('7d', 700_000)).toBe(95_200);
    expect(periodStart('all', 100)).toBeNull();
    expect(periodStart('now', 100)).toBeNull();
  });
});

describe('knownPostCount', () => {
  it('trusts a fresh report, including zero', () => {
    expect(knownPostCount({ postsCount24h: 4, updatedAt: 1000 }, 1500)).toBe(4);
    expect(knownPostCount({ postsCount24h: 0, updatedAt: 1000 }, 1500)).toBe(0);
  });

  it('calls a missing or stale report unknown', () => {
    expect(knownPostCount(undefined, 1500)).toBeNull();
    expect(knownPostCount({ postsCount24h: 4, updatedAt: 1000 }, 1000 + 86_401)).toBeNull();
  });
});

describe('percentOfSupply', () => {
  it('is exact to four decimals, for any size', () => {
    expect(percentOfSupply(25n * 10n ** 25n, 10n ** 27n)).toBe(25);
    expect(percentOfSupply(1234n * 10n ** 20n, 10n ** 27n)).toBe(0.0123);
  });

  it('is unknown without a supply', () => {
    expect(percentOfSupply(5n, 0n)).toBeNull();
  });
});

describe('rankRows', () => {
  it('ranks by value, highest first, keeping the order of ties', () => {
    const r = rankRows(
      [
        { id: 'a', value: 2 },
        { id: 'b', value: 9 },
        { id: 'c', value: 2 },
      ],
      10,
    );
    expect(r.items.map((x) => [x.rank, x.id])).toEqual([
      [1, 'b'],
      [2, 'a'],
      [3, 'c'],
    ]);
    expect(r.ranked).toBe(3);
  });

  it('never ranks an unknown or empty row, and counts the unknown', () => {
    const r = rankRows(
      [
        { id: 'a', value: null },
        { id: 'b', value: 0 },
        { id: 'c', value: Number.NaN },
        { id: 'd', value: 1 },
      ],
      10,
    );
    expect(r.items.map((x) => x.id)).toEqual(['d']);
    expect(r.unknown).toBe(1);
  });

  it('cuts at the limit but counts them all', () => {
    const r = rankRows([{ value: 1 }, { value: 2 }, { value: 3 }], 2);
    expect(r.items.length).toBe(2);
    expect(r.ranked).toBe(3);
  });
});
