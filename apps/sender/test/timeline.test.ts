import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reads } from '../src/db/schema.js';
import { DEFAULT_TIMELINE_POSTS, MAX_TIMELINE_POSTS, TIMELINE_WINDOW_MS, toTimelinePost } from '../src/inbox.js';
import { AGENT, json, setup } from './helpers.js';

const USER = { id: '42', username: 'jessepollak', name: 'jesse.base.eth', verified: true, verified_type: 'blue' };

const tweet = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: `post ${id}`,
  author_id: USER.id,
  created_at: createdAt,
  public_metrics: { like_count: 10, reply_count: 2, retweet_count: 3, quote_count: 1, impression_count: 500 },
  ...extra,
});

describe('POST /internal/read/timeline', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
    env.fake.on('GET', `/2/users/by/username/${USER.username}`, () => json({ data: USER }));
  });
  afterEach(async () => env.close());

  const read = (body: Record<string, unknown>) => env.call('POST', '/internal/read/timeline', { agentId: AGENT, ...body });

  it('reads the latest original posts of the week, newest first, and meters an account and a timeline read', async () => {
    env.fake.on('GET', `/2/users/${USER.id}/tweets`, ({ url }) => {
      const now = env.clock.now().getTime();
      expect(url.searchParams.get('exclude')).toBe('replies,retweets');
      expect(url.searchParams.get('max_results')).toBe('100');
      expect(Date.parse(url.searchParams.get('start_time')!)).toBe(now - TIMELINE_WINDOW_MS);
      expect(Date.parse(url.searchParams.get('end_time')!)).toBe(now - 10_000);
      expect(url.searchParams.get('tweet.fields')).toContain('public_metrics');
      return json({
        data: [
          tweet('9001', '2026-10-20T10:00:00.000Z'),
          tweet('9003', '2026-10-23T10:00:00.000Z', { note_tweet: { text: 'the long version of 9003' } }),
          tweet('9002', '2026-10-22T10:00:00.000Z', { public_metrics: undefined }),
        ],
      });
    });
    const res = await read({ username: '@jessepollak' });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: '42', username: 'jessepollak', name: 'jesse.base.eth' });
    expect(res.body.posts).toEqual([
      { id: '9003', text: 'the long version of 9003', createdAt: '2026-10-23T10:00:00.000Z', metrics: { likes: 10, replies: 2, reposts: 3, quotes: 1 } },
      { id: '9002', text: 'post 9002', createdAt: '2026-10-22T10:00:00.000Z', metrics: null },
      { id: '9001', text: 'post 9001', createdAt: '2026-10-20T10:00:00.000Z', metrics: { likes: 10, replies: 2, reposts: 3, quotes: 1 } },
    ]);
    expect(env.fake.count('GET', '/2/users/by/username/')).toBe(1);
    expect(env.fake.count('GET', `/2/users/${USER.id}/tweets`)).toBe(1);
    const metered = await env.db.select().from(reads).where(eq(reads.agentId, AGENT));
    expect(metered.map((r) => [r.kind, r.count]).sort()).toEqual([
      ['account', 1],
      ['timeline', 1],
    ]);
    expect(JSON.stringify(res.body)).not.toContain('access-token-secret');
  });

  it('caps the posts at max (default 5, never more than 10) and refuses a bad max', async () => {
    env.fake.on('GET', `/2/users/${USER.id}/tweets`, () => json({ data: Array.from({ length: 12 }, (_, i) => tweet(String(9100 + i), `2026-10-${String(12 + i).padStart(2, '0')}T10:00:00.000Z`)) }));
    expect(DEFAULT_TIMELINE_POSTS).toBe(5);
    expect(MAX_TIMELINE_POSTS).toBe(10);
    const byDefault = await read({ username: 'jessepollak' });
    expect(byDefault.body.posts.map((p: { id: string }) => p.id)).toEqual(['9111', '9110', '9109', '9108', '9107']);
    const two = await read({ username: 'jessepollak', max: 2 });
    expect(two.body.posts.map((p: { id: string }) => p.id)).toEqual(['9111', '9110']);
    const ten = await read({ username: 'jessepollak', max: 10 });
    expect(ten.body.posts).toHaveLength(10);
    expect((await read({ username: 'jessepollak', max: 11 })).status).toBe(400);
    expect((await read({ username: 'jessepollak', max: 0 })).status).toBe(400);
    expect((await read({ username: 'not a handle' })).status).toBe(400);
  });

  it('answers 404 x_not_found for an account X does not know, without a timeline call', async () => {
    env.fake.on('GET', '/2/users/by/username/nobody_here', () => json({ data: undefined, errors: [{ title: 'Not Found Error' }] }));
    const res = await read({ username: 'nobody_here' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('x_not_found');
    expect(env.fake.count('GET', '/2/users/42/tweets')).toBe(0);
    expect(await env.db.select().from(reads).where(eq(reads.agentId, AGENT))).toEqual([]);
  });

  it('passes a failed timeline read through as the sender error and meters only the account lookup', async () => {
    env.fake.on('GET', `/2/users/${USER.id}/tweets`, () => json({ title: 'Unauthorized' }, 401));
    const res = await read({ username: 'jessepollak' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.posts).toBeUndefined();
    const metered = await env.db.select().from(reads).where(eq(reads.agentId, AGENT));
    expect(metered.map((r) => r.kind)).toEqual(['account']);
  });

  it('normalises a post with and without counts', () => {
    expect(toTimelinePost({ id: '1', text: 't' })).toEqual({ id: '1', text: 't', createdAt: null, metrics: null });
    expect(toTimelinePost({ id: '2', text: 't', created_at: '2026-10-23T10:00:00.000Z', public_metrics: { like_count: 1, reply_count: 0, retweet_count: 2, quote_count: 0 } })).toEqual({
      id: '2',
      text: 't',
      createdAt: '2026-10-23T10:00:00.000Z',
      metrics: { likes: 1, replies: 0, reposts: 2, quotes: 0 },
    });
  });
});
