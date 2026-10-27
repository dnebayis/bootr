import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT, AGENT_X_ID, acceptPosts, json, setup } from './helpers.js';

describe('rate budget', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
    acceptPosts(env.fake, env.clock);
  });
  afterEach(async () => env.close());

  const post = (n: number) =>
    env.call('POST', '/internal/publish', {
      agentId: AGENT,
      actionId: `act-quota-${n}`,
      text: `post number ${n}`,
    });

  it('defaults to 24 posts/day and 300s between mention reads', async () => {
    const q = await env.call('GET', `/internal/quota/${AGENT}`);
    expect(q.body).toMatchObject({ postsPerDay: 24, mentionReadIntervalSec: 300 });
  });

  it('enforces postsPerDay over a rolling 24h window', async () => {
    const set = await env.call('POST', `/internal/quota/${AGENT}`, { postsPerDay: 2 });
    expect(set.body.postsPerDay).toBe(2);
    expect((await post(1)).body.status).toBe('sent');
    env.clock.advance(60_000);
    expect((await post(2)).body.status).toBe('sent');
    const third = await post(3);
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: 'quota_exceeded', limit: 2 });
    expect(env.fake.count('POST', '/2/tweets')).toBe(2);
    // Not recorded: the same actionId may be retried later.
    expect((await env.call('GET', '/internal/receipt/act-quota-3')).status).toBe(404);
    // Duplicates of already-sent actions still return their receipt while over budget.
    expect((await post(1)).body.status).toBe('sent');

    env.clock.advance(24 * 3600_000);
    env.fake.on('POST', '/2/oauth2/token', () =>
      json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 7200 }),
    );
    const after = await post(3);
    expect(after.body).toMatchObject({ status: 'sent' });
    expect(env.fake.count('POST', '/2/tweets')).toBe(3);
  });

  it('throttles mention reads to one per interval', async () => {
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/mentions`, () =>
      json({ meta: { result_count: 0 } }),
    );
    const first = await env.call('POST', '/internal/read/mentions', { agentId: AGENT });
    expect(first.body.throttled).toBe(false);
    env.clock.advance(60_000);
    const second = await env.call('POST', '/internal/read/mentions', { agentId: AGENT });
    expect(second.body.throttled).toBe(true);
    expect(second.body.nextReadAt).toBe(
      new Date(env.clock.now().getTime() + 240_000).toISOString(),
    );
    expect(env.fake.count('GET', '/2/users/')).toBe(1);
    env.clock.advance(240_000);
    const third = await env.call('POST', '/internal/read/mentions', { agentId: AGENT });
    expect(third.body.throttled).toBe(false);
    expect(env.fake.count('GET', '/2/users/')).toBe(2);
  });

  it('meters posts and reads per month', async () => {
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/mentions`, () =>
      json({
        data: [
          { id: '11', author_id: '42', text: '@bootr_agent hi' },
          { id: '12', author_id: '42', text: '@bootr_agent yo' },
        ],
      }),
    );
    await post(1);
    await env.call('POST', '/internal/read/mentions', { agentId: AGENT });
    const m = await env.call('GET', `/internal/metering/${AGENT}?month=2026-10`);
    expect(m.body).toMatchObject({
      posts: 1,
      readsTotal: 2,
      reads: { mentions: 2 },
      estimatedUsd: { posts: 0.01, reads: 0.01, total: 0.02 },
    });
    const other = await env.call('GET', `/internal/metering/${AGENT}?month=2026-09`);
    expect(other.body).toMatchObject({ posts: 0, readsTotal: 0 });
  });
});
