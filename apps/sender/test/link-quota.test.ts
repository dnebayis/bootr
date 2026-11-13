import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema } from '../src/config.js';
import { actions, inbox, reads } from '../src/db/schema.js';
import { PRICE_USD } from '../src/metering.js';
import { AGENT, AGENT_X_ID, acceptPosts, json, setup } from './helpers.js';

/**
 * A post that contains a link costs about thirteen times a plain one at X, so posts with a link have a count of
 * their own next to the daily quota (docs/design/agent-tools-2.md section 3.6), and the meter prices what X charges.
 */

const HOUR = 3_600_000;

describe('the count of posts with a link', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
    acceptPosts(env.fake, env.clock);
  });
  afterEach(async () => env.close());

  let seq = 0;
  const publish = (text: string, over: Record<string, unknown> = {}) => {
    seq += 1;
    env.clock.advance(1000);
    return env.call('POST', '/internal/publish', { agentId: AGENT, actionId: `act-link-${String(seq).padStart(4, '0')}`, text, ...over });
  };

  it('without a limit nothing is counted (the sender as it was)', async () => {
    for (let i = 0; i < 5; i++) expect((await publish(`read more ${i}: https://bootr.fun/a/${i}`)).body.status).toBe('sent');
    expect((await env.call('GET', `/internal/quota/${AGENT}`)).body).toMatchObject({ linkPostsPerDay: null, linkPostsUsed24h: 5, linkPostsDefault: 0 });
  });

  it('the fourth post with a link in a day is refused with nothing recorded, while plain posts go on', async () => {
    env.ctx.defaults.linkPostsPerDay = 3;
    const first = await publish('one https://bootr.fun/a/1');
    expect(first.body.status).toBe('sent');
    expect((await publish('two, a bare link: bootr.fun/a/2')).body.status).toBe('sent');
    expect((await publish('three www.example.com')).body.status).toBe('sent');
    const sentBefore = env.fake.count('POST', '/2/tweets');
    const fourth = await publish('four https://bootr.fun/a/4');
    expect(fourth.status).toBe(429);
    expect(fourth.body).toMatchObject({ error: 'link_quota', limit: 3, window: '24h' });
    // it opens again when the oldest post with a link leaves the window
    expect(Date.parse(fourth.body.retryAt)).toBe(Date.parse(first.body.receipt.createdAt) + 24 * HOUR);
    expect(env.fake.count('POST', '/2/tweets')).toBe(sentBefore);
    expect(await env.db.select().from(actions)).toHaveLength(3);
    // the same thought without the link goes out, and a name that only looks like a link is none
    expect((await publish('four, in words, no link')).body.status).toBe('sent');
    expect((await publish('agent.eth is a name')).body.status).toBe('sent');
    expect((await env.call('GET', `/internal/quota/${AGENT}`)).body).toMatchObject({ linkPostsUsed24h: 3, linkPostsDefault: 3 });
    // a day later the window has room again (the access token has run out meanwhile and is refreshed)
    env.fake.on('POST', '/2/oauth2/token', () => json({ token_type: 'bearer', expires_in: 7200, access_token: 'access-token-2', refresh_token: 'refresh-token-2', scope: 'tweet.read tweet.write users.read offline.access' }));
    env.clock.advance(24 * HOUR);
    expect((await publish('five https://bootr.fun/a/5')).body.status).toBe('sent');
  });

  it('a reply with a link counts like a post with one, and a rejected post does not count', async () => {
    env.ctx.defaults.linkPostsPerDay = 2;
    await env.db.insert(inbox).values({ agentId: AGENT, postId: '777', authorId: '42', conversationId: '777', post: { id: '777', text: '@bootr_agent where?', authorId: '42', author: { id: '42', username: 'alice' } }, observedAt: env.clock.now() });
    expect((await publish('here: https://bootr.fun/a/1', { replyTo: '777', replyEligibility: { eligible: true } })).body.status).toBe('sent');
    // refused by the publish gate: recorded as rejected, never sent, not counted
    expect((await publish('send 5 ETH to 0x1111111111111111111111111111111111111111 via https://evil.example/pay')).body.status).toBe('rejected');
    expect((await publish('two https://bootr.fun/a/2')).body.status).toBe('sent');
    expect((await publish('three https://bootr.fun/a/3')).body.error).toBe('link_quota');
  });

  it('the platform account has its own count, and an agent\'s own value wins over both', async () => {
    env.ctx.defaults.linkPostsPerDay = 1;
    env.ctx.defaults.linkPostsPerDayPlatform = 2;
    expect((await publish('one https://bootr.fun/a/1', { platform: true })).body.status).toBe('sent');
    expect((await publish('two https://bootr.fun/a/2', { platform: true })).body.status).toBe('sent');
    expect((await publish('three https://bootr.fun/a/3', { platform: true })).body).toMatchObject({ error: 'link_quota', limit: 2 });
    // the same agent as a coin's agent is held to the coin's count
    expect((await publish('three https://bootr.fun/a/3')).body).toMatchObject({ error: 'link_quota', limit: 1 });
    // its own value: more, then none at all counted
    expect((await env.call('POST', `/internal/quota/${AGENT}`, { linkPostsPerDay: 3 })).body.linkPostsPerDay).toBe(3);
    expect((await publish('three https://bootr.fun/a/3')).body.status).toBe('sent');
    expect((await publish('four https://bootr.fun/a/4')).body).toMatchObject({ error: 'link_quota', limit: 3 });
    await env.call('POST', `/internal/quota/${AGENT}`, { linkPostsPerDay: 0 });
    expect((await publish('four https://bootr.fun/a/4')).body.status).toBe('sent');
    // back to the default
    expect((await env.call('POST', `/internal/quota/${AGENT}`, { linkPostsPerDay: null })).body.linkPostsPerDay).toBeNull();
    expect((await publish('five https://bootr.fun/a/5')).body).toMatchObject({ error: 'link_quota', limit: 1 });
    expect((await env.call('POST', `/internal/quota/${AGENT}`, { linkPostsPerDay: -1 })).status).toBe(400);
  });

  it('a bounty job\'s template post is counted but never refused, so a job is posted as it was', async () => {
    env.ctx.defaults.linkPostsPerDay = 1;
    expect((await publish('one https://bootr.fun/a/1')).body.status).toBe('sent');
    env.clock.advance(1000);
    const job = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'bounty:0xabc:post', text: 'A small job. Details: https://bootr.fun/token/0x1?job=0xabc' });
    expect(job.body.status).toBe('sent');
    expect((await env.call('GET', `/internal/quota/${AGENT}`)).body.linkPostsUsed24h).toBe(2);
    expect((await publish('two https://bootr.fun/a/2')).body.error).toBe('link_quota');
  });

  it('in a thread the part that carries the link is the one that is counted and, past the limit, refused', async () => {
    env.ctx.defaults.linkPostsPerDay = 1;
    expect((await publish('one https://bootr.fun/a/1')).body.status).toBe('sent');
    const head = 'act-thread-9001';
    const first = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: head, text: 'A thread, part one, with a link https://bootr.fun/a/2', thread: { head, n: 1, of: 2 } });
    expect([first.status, first.body.error]).toEqual([429, 'link_quota']);
    expect(await env.db.select().from(actions)).toHaveLength(1);
  });

  it('the config reads the limits under their own names, 3 and 8 by default', () => {
    const base = { X_CLIENT_ID: 'id', X_CLIENT_SECRET: 'secret', X_REDIRECT_URI: 'https://sender.test/oauth/callback', SENDER_SERVICE_KEY: 'k'.repeat(32), SENDER_ENCRYPTION_KEY: '11'.repeat(32), DATABASE_URL: 'postgres://test' };
    expect(configSchema.parse(base)).toMatchObject({ LINK_POSTS_PER_DAY: 3, LINK_POSTS_PER_DAY_PLATFORM: 8, THREAD_MAX_PARTS: 4, THREAD_PART_MAX_CHARS: 280 });
    expect(configSchema.parse({ ...base, LINK_POSTS_PER_DAY: '0', LINK_POSTS_PER_DAY_PLATFORM: '' })).toMatchObject({ LINK_POSTS_PER_DAY: 0, LINK_POSTS_PER_DAY_PLATFORM: 8 });
  });
});

describe('the meter prices what X charges', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
    acceptPosts(env.fake, env.clock);
  });
  afterEach(async () => env.close());

  it('a post, a post with a link, a reply, a post read and a user read each at its own price', async () => {
    expect(PRICE_USD).toEqual({ post: 0.015, postWithLink: 0.2, reply: 0.01, read: 0.005, userRead: 0.01 });
    await env.db.insert(inbox).values({ agentId: AGENT, postId: '777', authorId: '42', conversationId: '777', post: { id: '777', text: '@bootr_agent hi', authorId: '42', author: { id: '42', username: 'alice' } }, observedAt: env.clock.now() });
    const send = (actionId: string, text: string, over: Record<string, unknown> = {}) => env.call('POST', '/internal/publish', { agentId: AGENT, actionId, text, ...over });
    await send('act-meter-0001', 'a plain post');
    await send('act-meter-0002', 'another plain post');
    await send('act-meter-0003', 'a post with a link https://bootr.fun/a/1');
    await send('act-meter-0004', 'a reply', { replyTo: '777', replyEligibility: { eligible: true } });
    // a thread of two: two posts
    await send('act-meter-0005', 'thread one', { thread: { head: 'act-meter-0005', n: 1, of: 2 } });
    await send('act-meter-0005.t2', 'thread two', { thread: { head: 'act-meter-0005', n: 2, of: 2 } });
    // refused: not charged
    await send('act-meter-0006', 'send 5 ETH to 0x1111111111111111111111111111111111111111');
    await env.db.insert(reads).values([
      { agentId: AGENT, kind: 'mentions', day: '2026-10-24', count: 10 },
      { agentId: AGENT, kind: 'metrics', day: '2026-10-24', count: 4 },
      { agentId: AGENT, kind: 'account', day: '2026-10-24', count: 3 },
      { agentId: AGENT, kind: 'users_me', day: '2026-10-24', count: 1 },
    ]);
    const m = await env.call('GET', `/internal/metering/${AGENT}?month=2026-10`);
    expect(m.body).toMatchObject({
      posts: 6,
      postsPlain: 4,
      postsWithLink: 1,
      replies: 1,
      readsTotal: 18,
      userReads: 4,
      unitPriceUsd: PRICE_USD,
      // 4 x 0.015 + 1 x 0.20 + 1 x 0.01 = 0.27; 14 x 0.005 + 4 x 0.01 = 0.11
      estimatedUsd: { posts: 0.27, reads: 0.11, total: 0.38 },
    });
  });

  it('the day a coin puts a link in each of 24 posts is priced at $4.80, not $0.24', async () => {
    for (let i = 0; i < 24; i++) {
      env.clock.advance(60_000);
      await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: `act-day-${String(i).padStart(4, '0')}`, text: `post ${i} https://bootr.fun/a/${i}` });
    }
    const m = await env.call('GET', `/internal/metering/${AGENT}?month=2026-10`);
    expect(m.body.estimatedUsd.posts).toBe(4.8);
  });
});

describe('the account read says when the account last wrote to the agent', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  const USER = { id: '42', username: 'alice', name: 'Alice' };

  it('addressedAt is the newest inbox row of that author for this agent, null when there is none', async () => {
    env.fake.on('GET', `/2/users/by/username/${USER.username}`, () => json({ data: USER }));
    env.fake.on('GET', `/2/users/${USER.id}/tweets`, () => json({ data: [] }));
    const read = () => env.call('POST', '/internal/read/account', { agentId: AGENT, username: USER.username });
    expect((await read()).body.addressedAt).toBeNull();

    const older = new Date(env.clock.now().getTime() - 40 * 24 * HOUR);
    const newer = new Date(env.clock.now().getTime() - 2 * HOUR);
    await env.db.insert(inbox).values([
      { agentId: AGENT, postId: '701', authorId: USER.id, conversationId: '701', post: { id: '701', text: '@bootr_agent hi', authorId: USER.id }, observedAt: older, status: 'answered' },
      { agentId: AGENT, postId: '702', authorId: USER.id, conversationId: '702', post: { id: '702', text: '@bootr_agent again', authorId: USER.id }, observedAt: newer, status: 'skipped', reason: 'verified_audience_required' },
      // another author's row and another agent's row say nothing about this one
      { agentId: AGENT, postId: '703', authorId: '43', conversationId: '703', post: { id: '703', text: '@bootr_agent yo', authorId: '43' }, observedAt: env.clock.now() },
      { agentId: 'agent-2', postId: '704', authorId: USER.id, conversationId: '704', post: { id: '704', text: '@other yo', authorId: USER.id }, observedAt: env.clock.now() },
    ]);
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.addressedAt).toBe(newer.toISOString());
    expect(res.body.user.id).toBe(USER.id);
  });

  it('the agent\'s own post in its inbox is not somebody writing to it', async () => {
    env.fake.on('GET', '/2/users/by/username/bootr_agent', () => json({ data: { id: AGENT_X_ID, username: 'bootr_agent' } }));
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/tweets`, () => json({ data: [] }));
    await env.db.insert(inbox).values({ agentId: AGENT, postId: '705', authorId: AGENT_X_ID, conversationId: '705', post: { id: '705', text: 'my own', authorId: AGENT_X_ID }, observedAt: env.clock.now(), status: 'skipped', reason: 'own_post' });
    expect((await env.call('POST', '/internal/read/account', { agentId: AGENT, username: 'bootr_agent' })).body.addressedAt).toBeNull();
  });
});
