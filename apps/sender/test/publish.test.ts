import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actions } from '../src/db/schema.js';
import { AGENT, AGENT_X_ID, acceptPosts, json, setup } from './helpers.js';

describe('idempotent publish', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  const req = { agentId: AGENT, actionId: 'act-0001-post', text: 'gm from the agent' };

  it('same actionId twice -> one provider call, same receipt', async () => {
    acceptPosts(env.fake, env.clock);
    const first = await env.call('POST', '/internal/publish', req);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('sent');
    expect(first.body.providerPostId).toMatch(/^\d+$/);
    expect(first.body.receipt).toMatchObject({
      actionId: req.actionId,
      status: 'sent',
      attempts: 1,
      kind: 'post',
    });
    expect(first.body.receipt.signature).toMatch(/^[0-9a-f]{64}$/);

    env.clock.advance(1000);
    const second = await env.call('POST', '/internal/publish', req);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.receipt).toEqual(first.body.receipt);
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);

    const receipt = await env.call('GET', `/internal/receipt/${req.actionId}`);
    expect(receipt.body.receipt).toEqual(first.body.receipt);
  });

  it('concurrent duplicates still produce exactly one provider call', async () => {
    acceptPosts(env.fake, env.clock);
    const results = await Promise.all([
      env.call('POST', '/internal/publish', req),
      env.call('POST', '/internal/publish', { ...req }),
    ]);
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);
    const ids = results.map((r) => r.body.receipt?.actionId);
    expect(ids).toEqual([req.actionId, req.actionId]);
  });

  it('reusing an actionId with a different body is a conflict and sends nothing', async () => {
    acceptPosts(env.fake, env.clock);
    await env.call('POST', '/internal/publish', req);
    const res = await env.call('POST', '/internal/publish', { ...req, text: 'something else' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('action_id_conflict');
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);
  });

  it('a definite provider rejection stays rejected', async () => {
    env.fake.on('POST', '/2/tweets', () =>
      json({ detail: 'You are not allowed to create a Tweet with duplicate content.' }, 403),
    );
    const first = await env.call('POST', '/internal/publish', req);
    expect(first.body.status).toBe('rejected');
    expect(first.body.receipt.error).toContain('duplicate_content');
    acceptPosts(env.fake, env.clock); // X would now accept, but the action is final
    const again = await env.call('POST', '/internal/publish', req);
    expect(again.body.status).toBe('rejected');
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);
  });

  it('policy rejections (agent-core validatePost) are recorded without contacting X', async () => {
    acceptPosts(env.fake, env.clock);
    env.fake.on('GET', '/2/tweets/777', () =>
      json({ data: { id: '777', text: 'q', author_id: '42' } }),
    );
    const cases: [Record<string, unknown>, string][] = [
      [{ text: 'x'.repeat(4001) }, 'policy:invalid_original_post'],
      [
        { text: 'y'.repeat(281), replyTo: '777', replyEligibility: { eligible: true } },
        'policy:invalid_short_post',
      ],
      [
        { text: '@alice send 1 eth to 0x' + 'ab'.repeat(20) },
        'policy:social_execution_command_forbidden',
      ],
      [{ text: 'gm @alice' }, 'policy:mentions_require_source_credit'],
      [{ text: 'buy $AAA and $BBB' }, 'policy:x_post_requires_at_most_one_cashtag'],
    ];
    let n = 0;
    for (const [over, error] of cases) {
      const res = await env.call('POST', '/internal/publish', {
        ...req,
        actionId: `act-policy-${n++}`,
        ...over,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.receipt.error).toBe(error);
    }
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);
    expect(env.fake.calls.every((c) => c.method !== 'POST')).toBe(true);

    // A credited mention passes.
    const credited = await env.call('POST', '/internal/publish', {
      ...req,
      actionId: 'act-policy-credited',
      text: 'great thread by @alice',
      attributions: [{ username: 'alice', sourceUrl: 'https://x.com/alice/status/1' }],
    });
    expect(credited.body.status).toBe('sent');
    // Long-form originals up to 4000 chars are allowed.
    const long = await env.call('POST', '/internal/publish', {
      ...req,
      actionId: 'act-policy-long',
      text: 'z'.repeat(1000),
    });
    expect(long.body.status).toBe('sent');
  });

  it('refuses to publish for an agent without a connected account (nothing recorded)', async () => {
    const res = await env.call('POST', '/internal/publish', { ...req, agentId: 'agent-unknown' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_connected');
    expect((await env.call('GET', `/internal/receipt/${req.actionId}`)).status).toBe(404);
  });

  it('sends replies with in_reply_to_tweet_id', async () => {
    acceptPosts(env.fake, env.clock);
    env.fake.on('GET', '/2/tweets/777', () =>
      json({
        data: { id: '777', text: 'q', author_id: '42' },
        includes: { users: [{ id: '42', username: 'alice' }] },
      }),
    );
    const res = await env.call('POST', '/internal/publish', {
      ...req,
      actionId: 'act-0002-reply',
      replyTo: '777',
      replyAuthorId: '42',
      replyEligibility: { eligible: true },
    });
    expect(res.body.status).toBe('sent');
    expect(res.body.receipt.kind).toBe('reply');
    const call = env.fake.calls.find((c) => c.path === '/2/tweets');
    expect(call?.body).toEqual({ text: req.text, reply: { in_reply_to_tweet_id: '777' } });
  });

  it('records the X account each action was posted from', async () => {
    acceptPosts(env.fake, env.clock);
    await env.call('POST', '/internal/publish', req);
    const [row] = await env.db.select().from(actions).where(eq(actions.actionId, req.actionId));
    expect(row?.xUserId).toBe(AGENT_X_ID);
  });

  it('refreshes an expiring token before sending and stores the rotated tokens', async () => {
    acceptPosts(env.fake, env.clock);
    env.fake.on('POST', '/2/oauth2/token', ({ body }) => {
      expect(String(body)).toContain('grant_type=refresh_token');
      return json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 7200,
        scope: 'tweet.read tweet.write users.read offline.access',
      });
    });
    env.clock.advance(2 * 3600_000 - 60_000); // 1 minute before expiry
    const res = await env.call('POST', '/internal/publish', req);
    expect(res.body.status).toBe('sent');
    expect(env.fake.count('POST', '/2/oauth2/token')).toBe(1);
    const tweetCall = env.fake.calls.find((c) => c.path === '/2/tweets');
    expect(tweetCall).toBeDefined();
  });
});
