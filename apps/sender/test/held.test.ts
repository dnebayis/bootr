import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actions } from '../src/db/schema.js';
import { reconcilePostActions } from '../src/reconcile.js';
import { AGENT, AGENT_X_ID, json, setup, timeoutError } from './helpers.js';
import type { XTweet } from '../src/x-client.js';

const MIN = 60_000;

describe('ambiguous outcomes are held and reconciled', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  const text = 'launch day: details at https://bootr.fun/a/1 & more';
  const req = { agentId: AGENT, actionId: 'act-held-0001', text };

  async function publishWithTimeout() {
    env.fake.on('POST', '/2/tweets', () => timeoutError());
    const res = await env.call('POST', '/internal/publish', req);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('held');
    return res;
  }

  function tweet(over: Partial<XTweet> = {}): XTweet {
    return {
      id: '9001',
      author_id: AGENT_X_ID,
      // X shortens links and HTML-escapes "&"
      text: 'launch day: details at https://t.co/abc123 &amp; more',
      entities: {
        urls: [
          { start: 23, end: 46, url: 'https://t.co/abc123', expanded_url: 'https://bootr.fun/a/1' },
        ],
      },
      created_at: new Date(env.clock.now().getTime()).toISOString(),
      ...over,
    };
  }

  it('provider timeout -> held; repeats never resend', async () => {
    const res = await publishWithTimeout();
    expect(res.body.receipt.error).toContain('timeout');
    expect(res.body.receipt.nextCheckAt).toBe(
      new Date(env.clock.now().getTime() + 15 * MIN).toISOString(),
    );
    const again = await env.call('POST', '/internal/publish', req);
    expect(again.body.status).toBe('held');
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);
  });

  it('5xx is ambiguous too', async () => {
    env.fake.on('POST', '/2/tweets', () => json({ title: 'Service Unavailable' }, 503));
    const res = await env.call('POST', '/internal/publish', req);
    expect(res.body.status).toBe('held');
  });

  it('reconciliation settles on a unique match (URL expansion + created_at window)', async () => {
    const createdAt = env.clock.now();
    await publishWithTimeout();
    const posted = tweet({ created_at: new Date(createdAt.getTime() + 2000).toISOString() });
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/tweets`, () =>
      json({
        data: [
          posted,
          tweet({ id: '9002', text: 'unrelated post', entities: {} }),
          // same text but a reply: parent mismatch
          tweet({ id: '9003', referenced_tweets: [{ type: 'replied_to', id: '55' }] }),
        ],
        meta: { result_count: 3 },
      }),
    );

    // Not due yet: no timeline read.
    env.clock.advance(5 * MIN);
    expect((await reconcilePostActions(env.ctx)).checked).toBe(0);
    expect(env.fake.count('GET', `/2/users/${AGENT_X_ID}/tweets`)).toBe(0);

    env.clock.advance(10 * MIN);
    const summary = await reconcilePostActions(env.ctx);
    expect(summary).toMatchObject({ checked: 1, settled: 1 });

    const call = env.fake.calls.find((c) => c.path === `/2/users/${AGENT_X_ID}/tweets`)!;
    expect(call.url.searchParams.get('start_time')).toBe(
      new Date(createdAt.getTime() - 1000).toISOString().replace('.000Z', 'Z'),
    );
    expect(call.url.searchParams.get('end_time')).toBe(
      new Date(createdAt.getTime() + 5 * MIN).toISOString().replace('.000Z', 'Z'),
    );

    const receipt = await env.call('GET', `/internal/receipt/${req.actionId}`);
    expect(receipt.body).toMatchObject({ status: 'sent', providerPostId: '9001' });
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);

    // Settled reads are metered.
    const meter = await env.call('GET', `/internal/metering/${AGENT}?month=2026-10`);
    expect(meter.body.reads.timeline).toBe(3);
  });

  it('keeps held on no match / multiple matches and backs off 15m -> hourly', async () => {
    const createdAt = env.clock.now();
    await publishWithTimeout();
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/tweets`, () =>
      json({
        data: [
          tweet({ id: '9001', created_at: createdAt.toISOString() }),
          tweet({ id: '9004', created_at: new Date(createdAt.getTime() + 60_000).toISOString() }),
        ],
      }),
    );
    env.clock.advance(15 * MIN);
    const s = await reconcilePostActions(env.ctx);
    expect(s).toMatchObject({ checked: 1, settled: 0, stillHeld: 1 });
    let [row] = await env.db.select().from(actions).where(eq(actions.actionId, req.actionId));
    expect(row?.status).toBe('held');
    expect(row?.checks).toBe(1);
    expect(row?.nextCheckAt?.getTime()).toBe(env.clock.now().getTime() + 60 * MIN);

    // No match at all
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/tweets`, () => json({ meta: { result_count: 0 } }));
    env.clock.advance(60 * MIN);
    await reconcilePostActions(env.ctx);
    [row] = await env.db.select().from(actions).where(eq(actions.actionId, req.actionId));
    expect(row?.status).toBe('held');
    expect(row?.checks).toBe(2);
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);
  });

  it('settles a held reply when X prepends the addressed @handle', async () => {
    const createdAt = env.clock.now();
    env.fake.on('POST', '/2/tweets', () => timeoutError());
    const reply = {
      agentId: AGENT,
      actionId: 'act-held-reply',
      text: 'thanks for asking',
      replyTo: '555',
      replyAuthorId: '42',
      replyEligibility: { eligible: true },
    };
    env.fake.on('GET', '/2/tweets/555', () =>
      json({
        data: { id: '555', text: 'q', author_id: '42' },
        includes: { users: [{ id: '42', username: 'alice' }] },
      }),
    );
    expect((await env.call('POST', '/internal/publish', reply)).body.status).toBe('held');
    const base = {
      author_id: AGENT_X_ID,
      created_at: new Date(createdAt.getTime() + 1500).toISOString(),
      referenced_tweets: [{ type: 'replied_to' as const, id: '555' }],
    };
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/tweets`, () =>
      json({
        data: [
          { ...base, id: '9101', text: '@alice thanks for asking', in_reply_to_user_id: '42' },
          // same text but addressed to someone else: not ours
          { ...base, id: '9102', text: '@bob thanks for asking', in_reply_to_user_id: '43' },
        ],
      }),
    );
    env.clock.advance(15 * MIN);
    expect(await reconcilePostActions(env.ctx)).toMatchObject({ settled: 1 });
    expect((await env.call('GET', '/internal/receipt/act-held-reply')).body).toMatchObject({
      status: 'sent',
      providerPostId: '9101',
    });
  });

  it('reads at most 3 timeline pages', async () => {
    await publishWithTimeout();
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/tweets`, () =>
      json({ data: [], meta: { next_token: 'more' } }),
    );
    env.clock.advance(15 * MIN);
    await reconcilePostActions(env.ctx);
    expect(env.fake.count('GET', `/2/users/${AGENT_X_ID}/tweets`)).toBe(3);
  });

  it('a crashed in-flight pending row becomes held', async () => {
    await env.db.insert(actions).values({
      actionId: 'act-crashed-01',
      agentId: AGENT,
      kind: 'post',
      text: 'crash test',
      bodyHash: 'x',
      status: 'pending',
      attempts: 1,
      createdAt: env.clock.now(),
    });
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/tweets`, () => json({ meta: { result_count: 0 } }));
    env.clock.advance(3 * MIN);
    const s = await reconcilePostActions(env.ctx);
    expect(s.promotedStale).toBe(1);
    const [row] = await env.db.select().from(actions).where(eq(actions.actionId, 'act-crashed-01'));
    expect(row?.status).toBe('held');
  });
});
