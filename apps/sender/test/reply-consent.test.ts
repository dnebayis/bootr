import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actions, inbox, optouts } from '../src/db/schema.js';
import { readPublishedAction } from '../src/reconcile.js';
import { AGENT, acceptPosts, json, setup, timeoutError } from './helpers.js';

const ALICE = '42';

describe('reply consent (H-4)', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
    acceptPosts(env.fake, env.clock);
  });
  afterEach(async () => env.close());

  const optOut = (authorId: string) =>
    env.db.insert(optouts).values({ agentId: AGENT, authorId, enabled: true, postId: '1' });
  const inboxRow = (postId: string, authorId: string, username: string) =>
    env.db.insert(inbox).values({
      agentId: AGENT,
      postId,
      authorId,
      post: { id: postId, text: '@bootr_agent hi', authorId, author: { id: authorId, username } },
      observedAt: env.clock.now(),
    });
  const reply = (actionId: string, extra: Record<string, unknown> = {}) =>
    env.call('POST', '/internal/publish', {
      agentId: AGENT,
      actionId,
      text: 'thanks!',
      replyTo: '900',
      ...extra,
    });
  const tweet900 = (authorId: string) =>
    env.fake.on('GET', '/2/tweets/900', () =>
      json({
        data: { id: '900', text: 'x', author_id: authorId },
        includes: { users: [{ id: authorId, username: 'someone' }] },
      }),
    );

  it('a reply without the eligibility decision is rejected without contacting X', async () => {
    const res = await reply('act-noelig-1');
    expect(res.body.status).toBe('rejected');
    expect(res.body.receipt.error).toBe('policy:reply_not_eligible:missing_eligibility');
    expect(env.fake.calls).toHaveLength(0);
  });

  it('an ineligible reply carries the supervisor reason', async () => {
    const res = await reply('act-noelig-2', {
      replyEligibility: { eligible: false, reason: 'not_addressed_to_agent' },
    });
    expect(res.body.receipt.error).toBe('policy:reply_not_eligible:not_addressed_to_agent');
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);
  });

  it('resolves a non-inbox author on X and enforces their opt-out (caller author id ignored)', async () => {
    await optOut(ALICE);
    tweet900(ALICE);
    const res = await reply('act-optout-1', {
      replyAuthorId: '99',
      replyEligibility: { eligible: true },
    });
    expect(res.body.status).toBe('rejected');
    expect(res.body.receipt.error).toBe('policy:consent_opted_out');
    expect(env.fake.count('GET', '/2/tweets/900')).toBe(1);
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);
    const [row] = await env.db.select().from(actions).where(eq(actions.actionId, 'act-optout-1'));
    expect(row?.replyAuthorId).toBe(ALICE);
  });

  it('the inbox author wins over a caller-supplied one', async () => {
    await optOut(ALICE);
    await inboxRow('900', ALICE, 'alice');
    const res = await reply('act-optout-2', {
      replyAuthorId: '43',
      replyEligibility: { eligible: true },
    });
    expect(res.body.receipt.error).toBe('policy:consent_opted_out');
    expect(env.fake.calls).toHaveLength(0);
  });

  it('a deleted or invisible reply target is rejected', async () => {
    env.fake.on('GET', '/2/tweets/900', () => json({ title: 'Not Found' }, 404));
    const res = await reply('act-gone-1', { replyEligibility: { eligible: true } });
    expect(res.body.receipt.error).toBe('policy:reply_target_unavailable');
  });

  it('a transient lookup failure records nothing; the same actionId works later', async () => {
    env.fake.on('GET', '/2/tweets/900', () => timeoutError());
    const res = await reply('act-flaky-1', { replyEligibility: { eligible: true } });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('consent_lookup_failed');
    expect((await env.call('GET', '/internal/receipt/act-flaky-1')).status).toBe(404);
    tweet900('43');
    const again = await reply('act-flaky-1', { replyEligibility: { eligible: true } });
    expect(again.body.status).toBe('sent');
  });

  it('original posts may not @mention an opted-out author (resolved through the inbox)', async () => {
    await optOut(ALICE);
    await inboxRow('901', ALICE, 'Alice');
    const res = await env.call('POST', '/internal/publish', {
      agentId: AGENT,
      actionId: 'act-mention-1',
      text: 'great thread by @alice',
      attributions: [{ username: 'alice', sourceUrl: 'https://x.com/alice/status/1' }],
    });
    expect(res.body.status).toBe('rejected');
    expect(res.body.receipt.error).toBe('policy:mention_opted_out');
    expect(env.fake.count('GET', '/2/users/by/username')).toBe(0);
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);
  });

  it('a renamed opted-out author is found through X', async () => {
    await optOut(ALICE);
    env.fake.on('GET', '/2/users/by/username/alice_new', () =>
      json({ data: { id: ALICE, username: 'alice_new' } }),
    );
    const res = await env.call('POST', '/internal/publish', {
      agentId: AGENT,
      actionId: 'act-mention-2',
      text: 'cc @alice_new',
      attributions: [{ username: 'alice_new', sourceUrl: 'https://x.com/alice_new/status/1' }],
    });
    expect(res.body.receipt.error).toBe('policy:mention_opted_out');
    expect(env.fake.count('GET', '/2/users/by/username/alice_new')).toBe(1);
  });

  it('mentions cost no lookups while the agent has no opt-outs', async () => {
    const res = await env.call('POST', '/internal/publish', {
      agentId: AGENT,
      actionId: 'act-mention-3',
      text: 'cc @bob',
      attributions: [{ username: 'bob', sourceUrl: 'https://x.com/bob/status/1' }],
    });
    expect(res.body.status).toBe('sent');
    expect(env.fake.count('GET', '/2/users')).toBe(0);
  });

  it('reconciliation never settles a held action against a re-bound account (L-4)', async () => {
    env.fake.on('POST', '/2/tweets', () => timeoutError());
    const held = await env.call('POST', '/internal/publish', {
      agentId: AGENT,
      actionId: 'act-held-rebound',
      text: 'gm',
    });
    expect(held.body.status).toBe('held');
    await env.db.execute(
      sql`update sender_accounts set x_user_id = '6666' where agent_id = ${AGENT}`,
    );
    env.clock.advance(15 * 60_000);
    const [row] = await env.db
      .select()
      .from(actions)
      .where(eq(actions.actionId, 'act-held-rebound'));
    const res = await readPublishedAction(env.ctx, row!);
    expect(res).toMatchObject({ kind: 'error' });
    expect(env.fake.count('GET', '/2/users/6666/tweets')).toBe(0);
  });
});
