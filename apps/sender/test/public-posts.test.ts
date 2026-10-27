import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { accounts, actions } from '../src/db/schema.js';
import { parseLimit, RateLimiter } from '../src/public-posts.js';
import { AGENT, AGENT_HANDLE, AGENT_X_ID, setup } from './helpers.js';

type Row = typeof actions.$inferInsert;

function row(i: number, over: Partial<Row> = {}): Row {
  const createdAt = new Date(Date.UTC(2026, 9, 24, 10, i));
  return {
    actionId: `act-${i}`,
    agentId: AGENT,
    kind: 'post',
    text: `post number ${i}`,
    xUserId: AGENT_X_ID,
    bodyHash: `hash-${i}`,
    status: 'sent',
    providerPostId: String(9000 + i),
    attempts: 1,
    createdAt,
    sentAt: new Date(createdAt.getTime() + 1000),
    ...over,
  };
}

describe('GET /public/posts/:agentId', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await env.app.request(path, { headers });
    return { status: res.status, headers: res.headers, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it('returns the latest sent posts, newest first, without tokens or user ids', async () => {
    await env.db.insert(actions).values([
      row(1),
      row(2, { kind: 'reply', replyTo: '777', replyAuthorId: '4242' }),
      row(3),
      row(4),
      row(5, { status: 'held', providerPostId: null }),
      row(6, { status: 'rejected', providerPostId: null, error: 'policy:link' }),
      row(7, { status: 'pending', providerPostId: null }),
      row(8, { agentId: 'someone-else', providerPostId: '9999' }),
    ]);
    const res = await get(`/public/posts/${AGENT}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.body.agentId).toBe(AGENT);
    expect(res.body.handle).toBe(AGENT_HANDLE);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items.map((p: { id: string }) => p.id)).toEqual(['act-4', 'act-3', 'act-2']);
    expect(res.body.items[0]).toEqual({
      id: 'act-4',
      kind: 'post',
      text: 'post number 4',
      postId: '9004',
      url: `https://x.com/${AGENT_HANDLE}/status/9004`,
      createdAt: '2026-10-24T10:04:01.000Z',
    });
    expect(res.body.items[2].kind).toBe('reply');

    const raw = JSON.stringify(res.body);
    for (const secret of ['access-token-secret', 'refresh-token-secret', AGENT_X_ID, '4242', '777', 'hash-']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('honours limit (default 3, max 10, min 1)', async () => {
    await env.db.insert(actions).values(Array.from({ length: 12 }, (_, i) => row(i + 1)));
    expect((await get(`/public/posts/${AGENT}?limit=5`)).body.items).toHaveLength(5);
    expect((await get(`/public/posts/${AGENT}?limit=50`)).body.items).toHaveLength(10);
    expect((await get(`/public/posts/${AGENT}?limit=0`)).body.items).toHaveLength(1);
    expect((await get(`/public/posts/${AGENT}?limit=abc`)).body.items).toHaveLength(3);
    expect(parseLimit(undefined)).toBe(3);
    expect(parseLimit('2.9')).toBe(2);
  });

  it('links posts from an earlier X account through /i/status and hides a revoked handle', async () => {
    await env.db.insert(actions).values([row(1, { xUserId: 'old-account' })]);
    let res = await get(`/public/posts/${AGENT}`);
    expect(res.body.items[0].url).toBe('https://x.com/i/status/9001');

    await env.db.update(accounts).set({ revokedAt: env.clock.now() });
    res = await get(`/public/posts/${AGENT}`);
    expect(res.status).toBe(200);
    expect(res.body.handle).toBeNull();
    expect(res.body.items).toHaveLength(1);
  });

  it('returns an empty list for a connected agent that has not posted', async () => {
    const res = await get(`/public/posts/${AGENT}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agentId: AGENT, handle: AGENT_HANDLE, items: [] });
  });

  it('404s for unknown agents and invalid ids', async () => {
    const res = await get('/public/posts/10388');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    expect((await get(`/public/posts/${encodeURIComponent('bad id!')}`)).status).toBe(404);
  });

  it('is read-only: other methods are not routed', async () => {
    const res = await env.app.request(`/public/posts/${AGENT}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('rate-limits per client IP and resets after a minute', async () => {
    const app = createApp({ ...env.ctx, publicApi: { ratePerMinute: 2, trustProxy: true } });
    const hit = (ip: string) =>
      app.request(`/public/posts/${AGENT}`, { headers: { 'x-forwarded-for': `203.0.113.9, ${ip}` } });
    expect((await hit('198.51.100.1')).status).toBe(200);
    expect((await hit('198.51.100.1')).status).toBe(200);
    const limited = await hit('198.51.100.1');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // A different client (right-most hop) has its own budget.
    expect((await hit('198.51.100.2')).status).toBe(200);
    env.clock.advance(60_000);
    expect((await hit('198.51.100.1')).status).toBe(200);
  });

  it('does not trust X-Forwarded-For unless configured', async () => {
    const app = createApp({ ...env.ctx, publicApi: { ratePerMinute: 1, trustProxy: false } });
    expect((await app.request(`/public/posts/${AGENT}`, { headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(200);
    // Spoofing a new forwarded address does not buy a new budget.
    expect((await app.request(`/public/posts/${AGENT}`, { headers: { 'x-forwarded-for': '2.2.2.2' } })).status).toBe(429);
  });
});

describe('RateLimiter', () => {
  it('limit 0 disables limiting', () => {
    const rl = new RateLimiter(0, () => 0);
    for (let i = 0; i < 100; i++) expect(rl.check('a')).toBe(0);
  });
});
