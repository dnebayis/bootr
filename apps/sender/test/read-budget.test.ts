import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveAccount } from '../src/accounts.js';
import { reads } from '../src/db/schema.js';
import { maxResultsWithin, nextUtcMidnight, READ_BUDGET_EXHAUSTED } from '../src/read-budget.js';
import { AGENT, AGENT_HANDLE, AGENT_X_ID, json, setup } from './helpers.js';

/**
 * X bills the app's owner per post read. One agent's reads (a thread of 8, an account check that fetched a 100-post
 * page, mention pages of 100) could run that bill up on their own, so every read counts against a per-agent daily
 * budget and an agent past it is refused with a clear answer until midnight UTC.
 */

const USER = { id: '42', username: 'jessepollak', name: 'jesse.base.eth', verified: true, verified_type: 'blue' };
const post = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `post ${id}`, author_id: USER.id, conversation_id: id, created_at: '2026-10-23T10:00:00.000Z', ...extra });

describe('the X read budget', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  const metered = async () => (await env.db.select().from(reads).where(eq(reads.agentId, AGENT))).map((r) => [r.kind, r.count]).sort();

  it('a thread walk stops where the budget ends, the next read is refused, and the day rolls over at midnight UTC', async () => {
    env.ctx.defaults.readsPerDay = 3;
    // 5000 answers 4999 answers 4998 ... : a chain deeper than the budget
    env.fake.on('GET', /\/2\/tweets\/\d+/, ({ url }) => {
      const id = Number(url.pathname.split('/').pop());
      return json({ data: post(String(id), { referenced_tweets: [{ type: 'replied_to', id: String(id - 1) }] }), includes: { users: [USER] } });
    });
    const first = await env.call('POST', '/internal/read/thread', { agentId: AGENT, postId: '5000' });
    expect(first.status).toBe(200);
    expect(first.body.posts.map((p: { id: string }) => p.id)).toEqual(['4998', '4999', '5000']);
    expect(first.body.truncated).toBe(true);
    expect(env.fake.count('GET', '/2/tweets/')).toBe(3);
    expect(await metered()).toEqual([['thread', 3]]);

    const refused = await env.call('POST', '/internal/read/thread', { agentId: AGENT, postId: '5000' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe(READ_BUDGET_EXHAUSTED);
    expect(refused.body.message).toMatch(/used up \(3 of 3 posts and lookups\)/);
    expect(refused.body.retryAt).toBe('2026-10-25T00:00:00.000Z');
    expect(env.fake.count('GET', '/2/tweets/')).toBe(3); // nothing asked of X
    // ...and the account and timeline reads are refused the same way
    expect((await env.call('POST', '/internal/read/account', { agentId: AGENT, username: USER.username })).body.error).toBe(READ_BUDGET_EXHAUSTED);
    expect((await env.call('POST', '/internal/read/timeline', { agentId: AGENT, username: USER.username })).body.error).toBe(READ_BUDGET_EXHAUSTED);
    expect((await env.call('POST', '/internal/read/metrics', { agentId: AGENT, postIds: ['5000'] })).body.error).toBe(READ_BUDGET_EXHAUSTED);
    expect(env.fake.count('GET', '/2/users/by/username/')).toBe(0);

    // The next day (00:00:01 UTC), with an access token that is still good then.
    env.clock.advance(12 * 3600_000 + 1_000);
    await saveAccount(
      env.ctx,
      AGENT,
      { accessToken: 'access-token-secret', refreshToken: 'refresh-token-secret', expiresAt: new Date(env.clock.now().getTime() + 2 * 3600_000), scopes: 'tweet.read tweet.write users.read offline.access' },
      { id: AGENT_X_ID, username: AGENT_HANDLE },
    );
    const again = await env.call('POST', '/internal/read/thread', { agentId: AGENT, postId: '5000' });
    expect(again.status).toBe(200);
    expect(again.body.posts).toHaveLength(3);
  });

  it('an account read costs one unit for the lookup and reads one page of five for the activity check', async () => {
    env.ctx.defaults.readsPerDay = 10;
    let maxResults: string | null = null;
    env.fake.on('GET', `/2/users/by/username/${USER.username}`, () => json({ data: USER }));
    env.fake.on('GET', `/2/users/${USER.id}/tweets`, ({ url }) => {
      maxResults = url.searchParams.get('max_results');
      return json({ data: [post('9001', { created_at: '2026-10-20T10:00:00.000Z' }), post('9002', { created_at: '2026-10-22T10:00:00.000Z' })] });
    });
    const res = await env.call('POST', '/internal/read/account', { agentId: AGENT, username: `@${USER.username}` });
    expect(res.status).toBe(200);
    expect(res.body.activity).toBe('recent');
    expect(maxResults).toBe('5');
    expect(await metered()).toEqual([
      ['account', 1],
      ['timeline', 2],
    ]);
    // With one unit left the lookup goes through and the activity check is skipped rather than overspent.
    env.ctx.defaults.readsPerDay = 4;
    const tight = await env.call('POST', '/internal/read/account', { agentId: AGENT, username: USER.username });
    expect(tight.status).toBe(200);
    expect(tight.body.activity).toBe('unknown');
    expect(env.fake.count('GET', `/2/users/${USER.id}/tweets`)).toBe(1);
    expect(await metered()).toEqual([
      ['account', 2],
      ['timeline', 2],
    ]);
  });

  it('a mention page asks X for no more posts than the budget has left, and a spent budget keeps the mention slot', async () => {
    env.ctx.defaults.readsPerDay = 7;
    const asked: string[] = [];
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/mentions`, ({ url }) => {
      asked.push(url.searchParams.get('max_results') ?? '');
      const n = Number(url.searchParams.get('max_results'));
      return json({ data: Array.from({ length: n }, (_, i) => post(String(7000 + i), { text: `@bootr_agent hello ${i}` })), includes: { users: [USER] }, meta: { next_token: 'more' } });
    });
    const first = await env.call('POST', '/internal/read/mentions', { agentId: AGENT });
    expect(first.status).toBe(200);
    expect(first.body.fetched).toBe(7);
    expect(asked).toEqual(['7']); // one page of 7, no second page: the budget is spent
    expect(await metered()).toEqual([['mentions', 7]]);

    env.clock.advance(301_000);
    const refused = await env.call('POST', '/internal/read/mentions', { agentId: AGENT });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe(READ_BUDGET_EXHAUSTED);
    expect(asked).toHaveLength(1);
    // the refusal did not spend the mention slot: with the budget off, the next read goes through at once
    env.ctx.defaults.readsPerDay = 0;
    const open = await env.call('POST', '/internal/read/mentions', { agentId: AGENT });
    expect(open.status).toBe(200);
    expect(open.body.throttled).toBe(false);
    expect(asked.at(-1)).toBe('100'); // no budget: a full page, as before
  });

  it('fits max_results to the budget within X bounds, and knows when the day rolls over', () => {
    expect(maxResultsWithin(Number.POSITIVE_INFINITY)).toBe(100);
    expect(maxResultsWithin(37)).toBe(37);
    expect(maxResultsWithin(2)).toBe(5);
    expect(maxResultsWithin(500, 10)).toBe(10);
    expect(maxResultsWithin(3, 10)).toBe(5);
    expect(new Date(nextUtcMidnight(new Date('2026-10-24T12:00:00Z'))).toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(new Date(nextUtcMidnight(new Date('2026-12-31T23:59:59Z'))).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
