import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accounts, reads } from '../src/db/schema.js';
import { MAX_METRICS_IDS, toPostMetrics } from '../src/metrics.js';
import { AGENT, AGENT_X_ID, json, setup } from './helpers.js';

const tweet = (id: string, pub: Record<string, number>, priv?: Record<string, number>) => ({
  id,
  text: `post ${id}`,
  author_id: AGENT_X_ID,
  created_at: '2026-10-23T10:00:00.000Z',
  public_metrics: pub,
  ...(priv ? { non_public_metrics: priv } : {}),
});

describe('POST /internal/read/metrics', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  const read = (postIds: unknown, agentId = AGENT) => env.call('POST', '/internal/read/metrics', { agentId, postIds });

  it('reads public and author-only counts of several posts in one X call and meters it', async () => {
    env.fake.on('GET', '/2/tweets', ({ url }) => {
      expect(url.searchParams.get('ids')).toBe('9001,9002');
      expect(url.searchParams.get('tweet.fields')).toBe('created_at,public_metrics,non_public_metrics');
      return json({
        data: [
          tweet('9001', { like_count: 12, reply_count: 3, retweet_count: 2, quote_count: 1, bookmark_count: 4, impression_count: 900 }, { impression_count: 1234, url_link_clicks: 7, user_profile_clicks: 5 }),
          tweet('9002', { like_count: 0, reply_count: 0, retweet_count: 0, quote_count: 0, impression_count: 80 }),
        ],
      });
    });
    const res = await read(['9001', '9002']);
    expect(res.status).toBe(200);
    expect(res.body.nonPublic).toBe(true);
    expect(res.body.missing).toEqual([]);
    expect(res.body.items).toEqual([
      {
        postId: '9001',
        createdAt: '2026-10-23T10:00:00.000Z',
        likes: 12,
        replies: 3,
        reposts: 2,
        quotes: 1,
        bookmarks: 4,
        impressions: 1234,
        nonPublic: { impressions: 1234, urlLinkClicks: 7, userProfileClicks: 5 },
      },
      { postId: '9002', createdAt: '2026-10-23T10:00:00.000Z', likes: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: null, impressions: 80, nonPublic: null },
    ]);
    expect(env.fake.count('GET', '/2/tweets')).toBe(1);
    const auth = env.fake.calls[0]!;
    expect(auth.path).toBe('/2/tweets');
    const [metered] = await env.db.select().from(reads).where(eq(reads.agentId, AGENT));
    expect(metered).toMatchObject({ kind: 'metrics', count: 1 });
    expect(JSON.stringify(res.body)).not.toContain('access-token-secret');
  });

  it('lists deleted or invisible posts in missing and de-duplicates ids', async () => {
    env.fake.on('GET', '/2/tweets', ({ url }) => {
      expect(url.searchParams.get('ids')).toBe('9001,9003');
      return json({
        data: [tweet('9001', { like_count: 1, reply_count: 0, retweet_count: 0, quote_count: 0 })],
        errors: [{ resource_id: '9003', resource_type: 'tweet', title: 'Not Found Error', detail: 'Could not find tweet with ids: [9003].' }],
      });
    });
    const res = await read(['9001', '9003', '9001']);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { postId: string }) => i.postId)).toEqual(['9001']);
    expect(res.body.missing).toEqual(['9003']);
  });

  it('falls back to public fields when X refuses the author-only field', async () => {
    let calls = 0;
    env.fake.on('GET', '/2/tweets', ({ url }) => {
      calls += 1;
      if (url.searchParams.get('tweet.fields')!.includes('non_public_metrics')) {
        return json({ title: 'Forbidden', detail: 'Sorry, you are not authorized to see the field non_public_metrics.' }, 403);
      }
      return json({ data: [tweet('9001', { like_count: 5, reply_count: 1, retweet_count: 0, quote_count: 0, impression_count: 300 })] });
    });
    const res = await read(['9001']);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(res.body.nonPublic).toBe(false);
    expect(res.body.items[0]).toMatchObject({ postId: '9001', likes: 5, impressions: 300, nonPublic: null });
  });

  it('validates the body: 1 to 20 numeric ids', async () => {
    expect((await read([])).status).toBe(400);
    expect((await read(['abc'])).status).toBe(400);
    expect((await read(Array.from({ length: MAX_METRICS_IDS + 1 }, (_, i) => String(9000 + i)))).status).toBe(400);
    expect(env.fake.count('GET', '/2/tweets')).toBe(0);
    const res = await env.app.request('/internal/read/metrics', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('answers 409 when the agent has no usable X account, without calling X', async () => {
    expect((await read(['9001'], 'nobody')).status).toBe(409);
    await env.db.update(accounts).set({ revokedAt: env.clock.now() });
    const res = await read(['9001']);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('revoked');
    expect(env.fake.count('GET', '/2/tweets')).toBe(0);
  });

  it('retries once after a short rate limit and surfaces a long one as 429 with retryAt', async () => {
    let n = 0;
    const resetSec = Math.floor(env.clock.now().getTime() / 1000) + 2;
    env.fake.on('GET', '/2/tweets', () => {
      n += 1;
      if (n === 1) return json({ title: 'Too Many Requests' }, 429, { 'x-rate-limit-reset': String(resetSec) });
      return json({ data: [tweet('9001', { like_count: 1, reply_count: 0, retweet_count: 0, quote_count: 0 })] });
    });
    const ok = await read(['9001']);
    expect(ok.status).toBe(200);
    expect(n).toBe(2);

    const farReset = Math.floor(env.clock.now().getTime() / 1000) + 600;
    env.fake.on('GET', '/2/tweets', () => json({ title: 'Too Many Requests' }, 429, { 'x-rate-limit-reset': String(farReset) }));
    const limited = await read(['9001']);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('x_rate_limited');
    expect(limited.body.retryAt).toBe(new Date(farReset * 1000).toISOString());
    // The endpoint is cooled down: the next read does not touch X until the reset.
    const before = env.fake.count('GET', '/2/tweets');
    expect((await read(['9001'])).status).toBe(429);
    expect(env.fake.count('GET', '/2/tweets')).toBe(before);
  });

  it('an X outage is a 502 the caller may retry', async () => {
    env.fake.on('GET', '/2/tweets', () => json({ title: 'Service Unavailable' }, 503));
    const res = await read(['9001']);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('x_provider_unavailable');
  });
});

describe('toPostMetrics', () => {
  it('prefers author-only impressions, tolerates missing counts', () => {
    expect(toPostMetrics({ id: '1', text: '' })).toEqual({ postId: '1', createdAt: null, likes: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: null, impressions: null, nonPublic: null });
    expect(toPostMetrics({ id: '2', text: '', public_metrics: { impression_count: 10 }, non_public_metrics: { impression_count: 12 } }).impressions).toBe(12);
    expect(toPostMetrics({ id: '3', text: '', public_metrics: { impression_count: 10 }, non_public_metrics: {} }).impressions).toBe(10);
  });
});
