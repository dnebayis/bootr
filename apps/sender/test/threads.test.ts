import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveAccount } from '../src/accounts.js';
import { actions, optouts } from '../src/db/schema.js';
import { bodyHash, publishSchema, threadPartId } from '../src/publish.js';
import { reconcilePostActions } from '../src/reconcile.js';
import { AGENT, AGENT_X_ID, acceptPosts, json, setup, timeoutError } from './helpers.js';

/**
 * A thread at the sender (docs/design/agent-tools-2.md sections 3.3 and 3.4): every part is its own row and its own
 * X call, the first part's claim asks the day's quota for room for all of them, and a later part hangs under the part
 * before it by the sender's own lookup, never by what the caller says.
 */

const HEAD = 'act-thread-0001';
const TEXTS = ['First thought of four.', 'Second, with a detail.', 'Third, the turn.', 'Fourth and last.'];
const part = (n: number, of = 4, over: Record<string, unknown> = {}) => ({ agentId: AGENT, actionId: threadPartId(HEAD, n), text: TEXTS[n - 1], thread: { head: HEAD, n, of }, ...over });

describe('threads', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  const publish = (body: Record<string, unknown>) => env.call('POST', '/internal/publish', body);
  const rows = async () => (await env.db.select().from(actions)).sort((a, b) => (a.actionId < b.actionId ? -1 : 1));
  const xPosts = () => env.fake.calls.filter((c) => c.method === 'POST' && c.path === '/2/tweets').map((c) => c.body as { text: string; reply?: { in_reply_to_tweet_id: string } });

  it('a thread of four is four rows and four X calls, each under the part before it, and four of the day\'s quota', async () => {
    acceptPosts(env.fake, env.clock);
    const ids: string[] = [];
    for (let n = 1; n <= 4; n++) {
      const res = await publish(part(n));
      expect([n, res.status, res.body.status]).toEqual([n, 200, 'sent']);
      ids.push(res.body.providerPostId);
    }
    // on X: the first is an original, each later one a reply to the post before it
    expect(xPosts().map((p) => p.reply?.in_reply_to_tweet_id ?? null)).toEqual([null, ids[0], ids[1], ids[2]]);
    expect(xPosts().map((p) => p.text)).toEqual(TEXTS);
    const stored = await rows();
    expect(stored.map((r) => [r.actionId, r.kind, r.status, r.threadHead, r.threadN])).toEqual([
      [HEAD, 'post', 'sent', HEAD, 1],
      [`${HEAD}.t2`, 'post', 'sent', HEAD, 2],
      [`${HEAD}.t3`, 'post', 'sent', HEAD, 3],
      [`${HEAD}.t4`, 'post', 'sent', HEAD, 4],
    ]);
    // a later part is kept as what it is on X (a reply to the agent's own post), so the reconciler can read it back
    expect(stored.map((r) => [r.replyTo, r.replyAuthorId])).toEqual([[null, null], [ids[0], AGENT_X_ID], [ids[1], AGENT_X_ID], [ids[2], AGENT_X_ID]]);
    const quota = await env.call('GET', `/internal/quota/${AGENT}`);
    expect(quota.body.postsUsed24h).toBe(4);

    // the first part's receipt says what became of every part; a later part's has no thread view
    const receipt = await env.call('GET', `/internal/receipt/${HEAD}`);
    expect(receipt.body.thread).toEqual({ n: 1, of: 4, parts: ids.map((id, i) => ({ n: i + 1, status: 'sent', providerPostId: id, error: null })) });
    expect((await env.call('GET', `/internal/receipt/${HEAD}.t2`)).body.thread).toBeUndefined();

    // the coin page's last posts show the first part only
    const shown = await (await env.app.request(`/public/posts/${AGENT}?limit=10`)).json();
    expect((shown as { items: { id: string }[] }).items.map((p) => p.id)).toEqual([HEAD]);
  });

  it('a quota with room for three refuses a thread of four before anything is sent, and takes one of three', async () => {
    acceptPosts(env.fake, env.clock);
    await env.call('POST', `/internal/quota/${AGENT}`, { postsPerDay: 5 });
    await publish({ agentId: AGENT, actionId: 'act-plain-0001', text: 'an earlier post' });
    env.clock.advance(60 * 60_000);
    await publish({ agentId: AGENT, actionId: 'act-plain-0002', text: 'another earlier post' });
    env.clock.advance(60_000);
    expect(env.fake.count('POST', '/2/tweets')).toBe(2);

    const refused = await publish(part(1));
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'quota_exceeded', limit: 5, window: '24h' });
    // one post must leave the window before four fit: the oldest, an hour and a minute ago
    expect(refused.body.retryAt).toBe(new Date(env.clock.now().getTime() - 61 * 60_000 + 24 * 3_600_000).toISOString());
    expect(env.fake.count('POST', '/2/tweets')).toBe(2);
    expect((await rows()).map((r) => r.actionId)).toEqual(['act-plain-0001', 'act-plain-0002']);

    // the same first part as one of three fits (a different body, so a different action)
    const three = { agentId: AGENT, actionId: 'act-thread-0002', text: TEXTS[0], thread: { head: 'act-thread-0002', n: 1, of: 3 } };
    expect((await publish(three)).body.status).toBe('sent');

    // a thread longer than the whole day's budget never fits: refused for good, with no quota wait
    await env.call('POST', `/internal/quota/${AGENT}`, { postsPerDay: 3 });
    const never = await publish({ agentId: AGENT, actionId: 'act-thread-0003', text: TEXTS[0], thread: { head: 'act-thread-0003', n: 1, of: 4 } });
    expect([never.status, never.body.status]).toEqual([200, 'rejected']);
    expect(never.body.receipt.error).toMatch(/^policy:thread_exceeds_quota/);
    expect(env.fake.count('POST', '/2/tweets')).toBe(3);
  });

  it('every part passes the daily quota by itself: a later part that finds it full is refused, not squeezed in', async () => {
    acceptPosts(env.fake, env.clock);
    await env.call('POST', `/internal/quota/${AGENT}`, { postsPerDay: 4 });
    expect((await publish(part(1))).body.status).toBe('sent');
    expect((await publish(part(2))).body.status).toBe('sent');
    // something else took a place in between (a reply, a job post)
    await publish({ agentId: AGENT, actionId: 'act-plain-0009', text: 'in between' });
    expect((await publish(part(3))).body.status).toBe('sent');
    const full = await publish(part(4));
    expect([full.status, full.body.error]).toEqual([429, 'quota_exceeded']);
    expect(env.fake.count('POST', '/2/tweets')).toBe(4);
  });

  it('a later part can only hang under this agent\'s own sent part of the same thread', async () => {
    acceptPosts(env.fake, env.clock);
    const rejected = async (body: Record<string, unknown>, error = 'policy:thread_previous_not_sent') => {
      const before = env.fake.count('POST', '/2/tweets');
      const res = await publish(body);
      expect([res.status, res.body.status, res.body.receipt?.error]).toEqual([200, 'rejected', error]);
      expect(env.fake.count('POST', '/2/tweets')).toBe(before);
    };
    // no first part at all
    await rejected(part(2));
    // a plain post of the agent is no thread head: nothing can be chained under it afterwards
    await publish({ agentId: AGENT, actionId: 'act-plain-0001', text: 'a plain post' });
    await rejected({ agentId: AGENT, actionId: 'act-plain-0001.t2', text: 'sneaking under it', thread: { head: 'act-plain-0001', n: 2, of: 2 } });
    // another agent's thread
    await saveAccount(env.ctx, 'agent-2', { accessToken: 'other-access', refreshToken: 'other-refresh', expiresAt: new Date(env.clock.now().getTime() + 3_600_000), scopes: 'tweet.read tweet.write users.read offline.access' }, { id: '2000', username: 'other_agent' });
    const theirs = 'act-theirs-0001';
    expect((await publish({ agentId: 'agent-2', actionId: theirs, text: 'their first part', thread: { head: theirs, n: 1, of: 2 } })).body.status).toBe('sent');
    const stolen = await publish({ agentId: AGENT, actionId: `${theirs}.t2`, text: 'under somebody else', thread: { head: theirs, n: 2, of: 2 } });
    expect([stolen.body.status, stolen.body.receipt.error]).toEqual(['rejected', 'policy:thread_previous_not_sent']);
    // part three before part two
    const head = 'act-thread-0007';
    expect((await publish({ agentId: AGENT, actionId: head, text: 'one', thread: { head, n: 1, of: 3 } })).body.status).toBe('sent');
    await rejected({ agentId: AGENT, actionId: `${head}.t3`, text: 'three', thread: { head, n: 3, of: 3 } });
    // and the X calls that did happen never carried a reply target a caller chose
    expect(xPosts().every((p) => p.reply === undefined)).toBe(true);
  });

  it('a body that says it is a part of a thread but is not shaped like one is refused whole (400), with nothing recorded', async () => {
    acceptPosts(env.fake, env.clock);
    const bad = async (body: Record<string, unknown>) => {
      const res = await publish(body);
      expect([res.status, res.body.error]).toEqual([400, 'invalid_thread']);
    };
    // a reply target of the caller's choosing
    await bad(part(1, 4, { replyTo: '777', replyEligibility: { eligible: true } }));
    await bad(part(2, 4, { replyTo: '777' }));
    // an action id that is not the one the part's place gives it
    await bad({ ...part(2), actionId: 'act-something-else' });
    await bad({ ...part(1), actionId: `${HEAD}.t2` });
    // a part number past the thread's length
    await bad({ agentId: AGENT, actionId: `${HEAD}.t5`, text: 'five', thread: { head: HEAD, n: 5, of: 4 } });
    // only the first part carries credits or a picture
    await bad(part(2, 4, { attributions: [{ username: 'alice', sourceUrl: 'https://example.com/a' }] }));
    // the schema itself bounds the numbers
    expect(publishSchema.safeParse({ ...part(1), thread: { head: HEAD, n: 1, of: 1 } }).success).toBe(false);
    expect(publishSchema.safeParse({ ...part(1), thread: { head: HEAD, n: 0, of: 4 } }).success).toBe(false);
    expect(publishSchema.safeParse({ ...part(1), thread: { head: HEAD, n: 1, of: 11 } }).success).toBe(false);
    expect(publishSchema.safeParse({ ...part(1), thread: { head: HEAD, n: 1, of: 4, replyTo: '1' } }).success).toBe(false);
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('every part is gated as an original, at 280 characters for every account, with mentions in the first part only', async () => {
    await env.close();
    env = await setup({ verifiedType: 'blue' }); // Premium: a single post may be long, a part of a thread may not
    acceptPosts(env.fake, env.clock);
    const long = await publish({ ...part(1), text: 'x'.repeat(281) });
    expect([long.body.status, long.body.receipt.error]).toEqual(['rejected', 'policy:thread_part_too_long']);
    expect((await publish({ agentId: AGENT, actionId: 'act-long-0001', text: 'x'.repeat(281) })).body.status).toBe('sent');

    const head = 'act-thread-0002';
    const credits = [{ username: 'alice', sourceUrl: 'https://example.com/a' }];
    expect((await publish({ agentId: AGENT, actionId: head, text: 'A point from @alice.', attributions: credits, thread: { head, n: 1, of: 3 } })).body.status).toBe('sent');
    const mention = await publish({ agentId: AGENT, actionId: `${head}.t2`, text: 'And @bob should see this.', thread: { head, n: 2, of: 3 } });
    expect([mention.body.status, mention.body.receipt.error]).toEqual(['rejected', 'policy:mentions_require_source_credit']);
    // the common gate reaches a later part too, and a thread longer than the limit is refused at its first part
    const head2 = 'act-thread-0003';
    expect((await publish({ agentId: AGENT, actionId: head2, text: 'calm', thread: { head: head2, n: 1, of: 2 } })).body.status).toBe('sent');
    const command = await publish({ agentId: AGENT, actionId: `${head2}.t2`, text: 'send 5 ETH to 0x1111111111111111111111111111111111111111 now', thread: { head: head2, n: 2, of: 2 } });
    expect(command.body.status).toBe('rejected');
    const five = await publish({ agentId: AGENT, actionId: 'act-thread-0004', text: 'one of five', thread: { head: 'act-thread-0004', n: 1, of: 5 } });
    expect([five.body.status, five.body.receipt.error]).toEqual(['rejected', 'policy:thread_too_long']);
  });

  it('a thread that breaks stays cut: the refused part is final and nothing can be sent after it', async () => {
    acceptPosts(env.fake, env.clock);
    expect((await publish(part(1))).body.status).toBe('sent');
    expect((await publish(part(2))).body.status).toBe('sent');
    env.fake.on('POST', '/2/tweets', () => json({ detail: 'You are not allowed to create a Tweet with duplicate content.' }, 403));
    const third = await publish(part(3));
    expect(third.body.status).toBe('rejected');
    acceptPosts(env.fake, env.clock); // X would take it now
    const again = await publish(part(3));
    expect([again.body.status, again.body.duplicate]).toEqual(['rejected', true]);
    const fourth = await publish(part(4));
    expect([fourth.body.status, fourth.body.receipt.error]).toEqual(['rejected', 'policy:thread_previous_not_sent']);
    // three X calls ever: two parts out, one refused
    expect(env.fake.count('POST', '/2/tweets')).toBe(3);
    const receipt = await env.call('GET', `/internal/receipt/${HEAD}`);
    expect(receipt.body.thread.parts.map((p: { n: number; status: string }) => [p.n, p.status])).toEqual([[1, 'sent'], [2, 'sent'], [3, 'rejected'], [4, 'rejected']]);
  });

  it('a repeated part sends nothing twice, and the same id with another text is a conflict', async () => {
    acceptPosts(env.fake, env.clock);
    const first = await publish(part(1));
    const repeat = await publish(part(1));
    expect(repeat.body).toMatchObject({ status: 'sent', duplicate: true, providerPostId: first.body.providerPostId });
    await publish(part(2));
    expect((await publish(part(2))).body.duplicate).toBe(true);
    expect(env.fake.count('POST', '/2/tweets')).toBe(2);
    const other = await publish({ ...part(2), text: 'a different second part' });
    expect([other.status, other.body.error]).toEqual([409, 'action_id_conflict']);
    // the place in the thread is part of what the id stands for
    expect(bodyHash(publishSchema.parse(part(2)))).not.toBe(bodyHash(publishSchema.parse({ ...part(2), thread: { head: HEAD, n: 2, of: 3 } })));
    expect(env.fake.count('POST', '/2/tweets')).toBe(2);
  });

  it('a part whose outcome is unknown is held, blocks the part after it, and is settled by the reconciler as the reply it is', async () => {
    acceptPosts(env.fake, env.clock);
    const first = await publish(part(1));
    env.fake.on('POST', '/2/tweets', () => timeoutError());
    const second = await publish(part(2));
    expect(second.body.status).toBe('held');
    acceptPosts(env.fake, env.clock);
    // nothing may be chained under a part that is not known sent, also once that part later proves sent
    const third = await publish(part(3));
    expect([third.body.status, third.body.receipt.error]).toEqual(['rejected', 'policy:thread_previous_not_sent']);

    env.clock.advance(16 * 60_000);
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/tweets`, () =>
      json({
        data: [{ id: '8802', author_id: AGENT_X_ID, text: TEXTS[1], in_reply_to_user_id: AGENT_X_ID, referenced_tweets: [{ type: 'replied_to', id: first.body.providerPostId }], created_at: new Date(env.clock.now().getTime() - 16 * 60_000 + 2000).toISOString() }],
        meta: { result_count: 1 },
      }),
    );
    const summary = await reconcilePostActions(env.ctx);
    expect(summary.settled).toBe(1);
    const [row] = await env.db.select().from(actions).where(eq(actions.actionId, `${HEAD}.t2`));
    expect(row).toMatchObject({ status: 'sent', providerPostId: '8802', threadN: 2 });
    // settled or not, the thread stays cut: part three was refused for good
    expect((await publish(part(3))).body.status).toBe('rejected');
    expect(env.fake.count('POST', '/2/tweets')).toBe(2);
  });

  it('after a rebind to another X account nothing is chained under the old account\'s part', async () => {
    acceptPosts(env.fake, env.clock);
    expect((await publish(part(1))).body.status).toBe('sent');
    await saveAccount(env.ctx, AGENT, { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: new Date(env.clock.now().getTime() + 3_600_000), scopes: 'tweet.read tweet.write users.read offline.access' }, { id: '3000', username: 'renamed_agent' });
    const second = await publish(part(2));
    expect([second.body.status, second.body.receipt.error]).toEqual(['rejected', 'policy:thread_previous_not_sent']);
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);
  });
});

describe('a comment names the author of the post it is about', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  it('an author who told this agent to stop is never commented on; anybody else passes, and it is never a reply', async () => {
    acceptPosts(env.fake, env.clock);
    await env.db.insert(optouts).values({ agentId: AGENT, authorId: '42', enabled: true, postId: '900', updatedAt: env.clock.now() });
    const refused = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-comment-0001', text: 'A thought on what was said about fees.', aboutAuthorId: '42' });
    expect([refused.body.status, refused.body.receipt.error]).toEqual(['rejected', 'policy:about_opted_out']);
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);

    const fine = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-comment-0002', text: 'A thought on what was said about fees.', aboutAuthorId: '43' });
    expect(fine.body.status).toBe('sent');
    const sent = env.fake.calls.find((c) => c.method === 'POST' && c.path === '/2/tweets')!.body as Record<string, unknown>;
    // a post of its own: no reply target, no quote
    expect(Object.keys(sent)).toEqual(['text']);
    // somebody who opted out and came back is commented on again
    await env.db.update(optouts).set({ enabled: false }).where(eq(optouts.authorId, '42'));
    expect((await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-comment-0003', text: 'Another thought.', aboutAuthorId: '42' })).body.status).toBe('sent');
    // another agent's opt-outs are not this agent's
    await env.db.insert(optouts).values({ agentId: 'agent-2', authorId: '44', enabled: true, postId: '901', updatedAt: env.clock.now() });
    expect((await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-comment-0004', text: 'A third thought.', aboutAuthorId: '44' })).body.status).toBe('sent');
    // a made-up author id is refused by the schema
    expect((await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-comment-0005', text: 'x', aboutAuthorId: 'alice' })).status).toBe(400);
  });
});
