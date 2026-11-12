import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READ_BUDGET_EXHAUSTED } from '../src/read-budget.js';
import { AGENT, json, setup } from './helpers.js';

/**
 * The per-agent X read budget (docs/design/byo-agent.md section 7): an own-agent coin thinks for free, so fuel no
 * longer stops it from costing Bootr X reads; the supervisor sets a lower budget for it through the quota route. An
 * agent's own value is used when set, the sender's default otherwise.
 */

const USER = { id: '42', username: 'jessepollak', name: 'jesse.base.eth', verified: true, verified_type: 'blue' };
const post = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `post ${id}`, author_id: USER.id, conversation_id: id, created_at: '2026-10-23T10:00:00.000Z', ...extra });

describe('the per-agent X read budget', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
    // A chain of replies deeper than any budget here: every post read is one unit.
    env.fake.on('GET', /\/2\/tweets\/\d+/, ({ url }) => {
      const id = Number(url.pathname.split('/').pop());
      return json({ data: post(String(id), { referenced_tweets: [{ type: 'replied_to', id: String(id - 1) }] }), includes: { users: [USER] } });
    });
  });
  afterEach(async () => env.close());

  it('the quota route reports the default, takes an own value, and null returns the agent to the default', async () => {
    env.ctx.defaults.readsPerDay = 400;
    const before = await env.call('GET', `/internal/quota/${AGENT}`);
    expect(before.body).toMatchObject({ readsPerDay: 400, readsUsedToday: 0, postsUsed24h: 0 });

    const set = await env.call('POST', `/internal/quota/${AGENT}`, { readsPerDay: 200 });
    expect(set.status).toBe(200);
    expect(set.body.readsPerDay).toBe(200);
    // The other fields are untouched by a patch that names only one.
    expect(set.body).toMatchObject({ postsPerDay: 24, mentionReadIntervalSec: 300 });

    const cleared = await env.call('POST', `/internal/quota/${AGENT}`, { readsPerDay: null });
    expect(cleared.body.readsPerDay).toBe(400);
  });

  it('an agent with its own budget is held to it, not to the larger default', async () => {
    env.ctx.defaults.readsPerDay = 400;
    await env.call('POST', `/internal/quota/${AGENT}`, { readsPerDay: 2 });
    const first = await env.call('POST', '/internal/read/thread', { agentId: AGENT, postId: '5000' });
    expect(first.status).toBe(200);
    expect(first.body.posts).toHaveLength(2);
    expect(first.body.truncated).toBe(true);
    const refused = await env.call('POST', '/internal/read/thread', { agentId: AGENT, postId: '5000' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe(READ_BUDGET_EXHAUSTED);
    expect(refused.body.message).toMatch(/used up \(2 of 2 posts and lookups\)/);
    expect(env.fake.count('GET', '/2/tweets/')).toBe(2);
    expect((await env.call('GET', `/internal/quota/${AGENT}`)).body).toMatchObject({ readsPerDay: 2, readsUsedToday: 2 });
  });

  it('another agent keeps the default while one agent has its own budget', async () => {
    env.ctx.defaults.readsPerDay = 3;
    await env.call('POST', `/internal/quota/some-other-agent`, { readsPerDay: 1 });
    const mine = await env.call('POST', '/internal/read/thread', { agentId: AGENT, postId: '5000' });
    expect(mine.status).toBe(200);
    expect(mine.body.posts).toHaveLength(3);
    expect((await env.call('GET', `/internal/quota/${AGENT}`)).body.readsPerDay).toBe(3);
    expect((await env.call('GET', `/internal/quota/some-other-agent`)).body.readsPerDay).toBe(1);
  });

  it('an own value applies even while the default budget is off', async () => {
    env.ctx.defaults.readsPerDay = 0;
    await env.call('POST', `/internal/quota/${AGENT}`, { readsPerDay: 1 });
    const first = await env.call('POST', '/internal/read/thread', { agentId: AGENT, postId: '5000' });
    expect(first.body.posts).toHaveLength(1);
    expect((await env.call('POST', '/internal/read/thread', { agentId: AGENT, postId: '5000' })).body.error).toBe(READ_BUDGET_EXHAUSTED);
  });

  it('refuses a budget of zero, a negative one and one that is not a whole number', async () => {
    for (const readsPerDay of [0, -5, 1.5, 'many']) {
      const res = await env.call('POST', `/internal/quota/${AGENT}`, { readsPerDay });
      expect(res.status).toBe(400);
    }
    expect((await env.call('GET', `/internal/quota/${AGENT}`)).body.readsPerDay).toBe(env.ctx.defaults.readsPerDay);
  });
});
