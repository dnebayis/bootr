import { describe, expect, it } from 'vitest';

import { FEED_LIMIT, composePlatformFeed, feedNameRefs, feedWindow, socialRows, type FeedInput, type FeedSocial } from './platform-feed';

const NOW = 1_800_000_000;
const SINCE = NOW - 86_400;
const OWL_T = '0x00000000000000000000000000000000000000a1';
const OWL_K = '0x00000000000000000000000000000000000000a2';
const FOX_T = '0x00000000000000000000000000000000000000b1';
const FOX_K = '0x00000000000000000000000000000000000000b2';
const TX = '0x3333333333333333333333333333333333333333333333333333333333333333';

const social = (over: Partial<FeedSocial> & { kernel: string }): FeedSocial => ({ xHandle: null, lastPostAt: null, firstPostAt: null, postsCount24h: 0, ...over });

function input(over: Partial<FeedInput> = {}): FeedInput {
  return {
    now: NOW,
    since: SINCE,
    stats: { tokens: 5, agentsTotal: 5, agentsAwake: 2, volume24hUsd: 1234.5, fees24hUsd: 12, updatedAt: NOW - 30 },
    volume7dUsd: 9999.123456789,
    social: new Map([
      [OWL_K, social({ kernel: OWL_K, xHandle: 'owlagent', lastPostAt: NOW - 100, firstPostAt: NOW - 100, postsCount24h: 1 })],
      [FOX_K, social({ kernel: FOX_K, xHandle: 'foxagent', lastPostAt: NOW - 50, firstPostAt: SINCE - 5000, postsCount24h: 4 })],
    ]),
    launches: [{ token: OWL_T, kernel: OWL_K, name: 'Owl', symbol: 'OWL', creator: '0xcc', launchedAt: NOW - 3000, xHandle: null }],
    statusChanges: [{ kernel: FOX_K, token: FOX_T, status: 'sleeping', at: NOW - 400 }],
    claims: [{ token: FOX_T, recipient: FOX_K, amountUsd: 4.2, at: NOW - 900, txHash: TX }],
    milestones: [
      { token: OWL_T, kernel: OWL_K, kind: 'first_swap', value: 0, timestamp: NOW - 2000, txHash: TX },
      { token: FOX_T, kernel: FOX_K, kind: 'holders', value: 100, timestamp: NOW - 10, txHash: null },
      { token: FOX_T, kernel: FOX_K, kind: 'volume24h', value: 1000, timestamp: NOW - 700, txHash: TX },
    ],
    named: [
      { id: OWL_T, kernel: OWL_K, symbol: 'OWL', xHandle: null },
      { id: FOX_T, kernel: FOX_K, symbol: 'FOX', xHandle: 'foxagent' },
    ],
    ...over,
  };
}

describe('feedWindow', () => {
  it('clamps since to the last 7 days and ignores junk', () => {
    expect(feedWindow(NOW, undefined).since).toBe(NOW - 7 * 86_400);
    expect(feedWindow(NOW, 'abc').since).toBe(NOW - 7 * 86_400);
    expect(feedWindow(NOW, String(NOW - 30 * 86_400)).since).toBe(NOW - 7 * 86_400);
    expect(feedWindow(NOW, `${NOW - 100}.7`).since).toBe(NOW - 100);
  });
});

describe('socialRows / feedNameRefs', () => {
  it('splits posters from first-time posters and names every address the rows carry', () => {
    const i = input();
    const { posted, firstPosts } = socialRows(i.social, i.since);
    expect(posted.map((p) => p.kernel)).toEqual([FOX_K, OWL_K]); // newest last post first
    expect(firstPosts.map((p) => p.kernel)).toEqual([OWL_K]); // the fox's first post is older than the window
    const refs = feedNameRefs(i);
    expect(refs.kernels.sort()).toEqual([FOX_K, OWL_K].sort());
    expect(refs.tokenIds.sort()).toEqual([FOX_T, OWL_T].sort());
  });
});

describe('composePlatformFeed', () => {
  it('keeps the existing fields and adds milestones and first posts, newest first, with symbols and no prices', () => {
    const body = composePlatformFeed(input());
    expect(body.now).toBe(NOW);
    expect(body.since).toBe(SINCE);
    expect(body.totals).toEqual({ tokens: 5, agentsTotal: 5, agentsAwake: 2, volume24hUsd: 1234.5, volume7dUsd: 9999.123457, fees24hUsd: 12, updatedAt: NOW - 30 });
    expect(body.launches).toEqual([{ token: OWL_T, kernel: OWL_K, name: 'Owl', symbol: 'OWL', creator: '0xcc', launchedAt: NOW - 3000, xHandle: 'owlagent' }]);
    expect(body.statusChanges).toEqual([{ kernel: FOX_K, token: FOX_T, status: 'sleeping', at: NOW - 400, symbol: 'FOX', xHandle: 'foxagent' }]);
    expect(body.posts.map((p) => [p.symbol, p.postsCount24h])).toEqual([
      ['FOX', 4],
      ['OWL', 1],
    ]);
    expect(body.claims).toEqual([{ token: FOX_T, recipient: FOX_K, amountUsd: 4.2, at: NOW - 900, txHash: TX, kernel: FOX_K, symbol: 'FOX' }]);
    expect(body.milestones).toEqual([
      { token: FOX_T, kernel: FOX_K, symbol: 'FOX', kind: 'holders', value: 100, at: NOW - 10, txHash: null },
      { token: FOX_T, kernel: FOX_K, symbol: 'FOX', kind: 'volume24h', value: 1000, at: NOW - 700, txHash: TX },
      { token: OWL_T, kernel: OWL_K, symbol: 'OWL', kind: 'first_swap', value: 0, at: NOW - 2000, txHash: TX },
    ]);
    expect(body.firstPosts).toEqual([{ kernel: OWL_K, token: OWL_T, symbol: 'OWL', xHandle: 'owlagent', firstPostAt: NOW - 100, lastPostAt: NOW - 100, postsCount24h: 1 }]);
    const text = JSON.stringify(body);
    for (const banned of ['priceUsd', 'marketCapUsd', 'priceWeth', 'change24hPct']) expect(text).not.toContain(banned);
  });

  it('answers with empty lists and zero totals when there is nothing, and caps every list at FEED_LIMIT', () => {
    const empty = composePlatformFeed(input({ stats: undefined, volume7dUsd: Number.NaN, social: new Map(), launches: [], statusChanges: [], claims: [], milestones: [], named: [] }));
    expect(empty.totals).toEqual({ tokens: 0, agentsTotal: 0, agentsAwake: 0, volume24hUsd: 0, volume7dUsd: 0, fees24hUsd: 0, updatedAt: null });
    expect(empty.launches).toEqual([]);
    expect(empty.milestones).toEqual([]);
    expect(empty.firstPosts).toEqual([]);
    const many = Array.from({ length: 70 }, (_, i) => ({ token: FOX_T, kernel: FOX_K, kind: 'holders', value: i, timestamp: NOW - i, txHash: null }));
    const capped = composePlatformFeed(input({ milestones: many }));
    expect(capped.milestones).toHaveLength(FEED_LIMIT);
    expect(capped.milestones[0]?.value).toBe(0);
    expect(capped.milestones[FEED_LIMIT - 1]?.value).toBe(FEED_LIMIT - 1);
  });
});
