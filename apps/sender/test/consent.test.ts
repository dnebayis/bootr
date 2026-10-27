import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inbox, optouts } from '../src/db/schema.js';
import { AGENT, AGENT_X_ID, acceptPosts, json, setup } from './helpers.js';
import type { XTweet } from '../src/x-client.js';

const ALICE = '42';
const BOB = '43';

function mention(id: string, author: string, text: string): XTweet {
  return {
    id,
    author_id: author,
    text,
    conversation_id: id,
    created_at: '2026-10-24T11:00:00.000Z',
  };
}

describe('consent stop/resume', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  let page: XTweet[] = [];
  beforeEach(async () => {
    env = await setup();
    acceptPosts(env.fake, env.clock);
    env.fake.on('GET', `/2/users/${AGENT_X_ID}/mentions`, () =>
      json({
        data: page,
        includes: {
          users: [
            { id: ALICE, username: 'alice' },
            { id: BOB, username: 'bob' },
          ],
        },
        meta: { result_count: page.length },
      }),
    );
  });
  afterEach(async () => env.close());

  const read = async () => {
    const res = await env.call('POST', '/internal/read/mentions', { agentId: AGENT });
    env.clock.advance(5 * 60_000);
    return res;
  };

  it('stop opts the author out; resume opts them back in', async () => {
    page = [
      mention('101', ALICE, '@bootr_agent what is the token?'),
      mention('102', BOB, '@bootr_agent hi'),
    ];
    let res = await read();
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { postId: string }) => i.postId)).toEqual(['101', '102']);
    expect(res.body.sinceId).toBe('102');

    page = [mention('103', ALICE, '@bootr_agent STOP')];
    res = await read();
    expect(env.fake.calls.at(-1)?.url.searchParams.get('since_id')).toBe('102');
    // Alice's earlier pending mention is no longer eligible; Bob's still is.
    expect(res.body.items.map((i: { postId: string }) => i.postId)).toEqual(['102']);
    const [opt] = await env.db
      .select()
      .from(optouts)
      .where(and(eq(optouts.agentId, AGENT), eq(optouts.authorId, ALICE)));
    expect(opt).toMatchObject({ enabled: true, postId: '103' });

    // Replies to an opted-out author are refused before X is contacted.
    const reply = await env.call('POST', '/internal/publish', {
      agentId: AGENT,
      actionId: 'act-reply-alice',
      text: 'here you go',
      replyTo: '101',
    });
    expect(reply.body.status).toBe('rejected');
    expect(reply.body.receipt.error).toBe('policy:consent_opted_out');
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);

    // New mentions from Alice are stored as skipped.
    page = [mention('104', ALICE, '@bootr_agent hello again')];
    res = await read();
    expect(res.body.items.map((i: { postId: string }) => i.postId)).toEqual(['102']);
    const [row] = await env.db
      .select()
      .from(inbox)
      .where(and(eq(inbox.agentId, AGENT), eq(inbox.postId, '104')));
    expect(row).toMatchObject({ status: 'skipped', reason: 'opted_out' });

    // resume
    page = [
      mention('105', ALICE, '@bootr_agent resume'),
      mention('106', ALICE, '@bootr_agent back!'),
    ];
    res = await read();
    expect(res.body.items.map((i: { postId: string }) => i.postId)).toEqual(['101', '102', '106']);
    const [opt2] = await env.db
      .select()
      .from(optouts)
      .where(and(eq(optouts.agentId, AGENT), eq(optouts.authorId, ALICE)));
    expect(opt2?.enabled).toBe(false);
  });

  it('an older consent post never overrides a newer one', async () => {
    page = [mention('402', ALICE, '@bootr_agent stop')];
    await read();
    // A newer resume, then an opt_out tied to an OLDER post: the newer post wins.
    page = [mention('403', ALICE, '@bootr_agent resume'), mention('404', ALICE, '@bootr_agent q')];
    await read();
    await env.db.insert(inbox).values({
      agentId: AGENT,
      postId: '401',
      authorId: ALICE,
      post: {},
      observedAt: env.clock.now(),
    });
    await env.call('POST', '/internal/inbox/resolve', {
      agentId: AGENT,
      postId: '401',
      outcome: 'opt_out',
      reason: 'old',
    });
    const [opt] = await env.db
      .select()
      .from(optouts)
      .where(and(eq(optouts.agentId, AGENT), eq(optouts.authorId, ALICE)));
    expect(opt).toMatchObject({ enabled: false, postId: '403' });
  });

  it('replying to an inbox item marks it answered', async () => {
    page = [mention('201', BOB, '@bootr_agent gm')];
    await read();
    const res = await env.call('POST', '/internal/publish', {
      agentId: AGENT,
      actionId: 'act-reply-bob-1',
      text: 'gm bob',
      replyTo: '201',
    });
    expect(res.body.status).toBe('sent');
    const [row] = await env.db.select().from(inbox).where(eq(inbox.postId, '201'));
    expect(row).toMatchObject({ status: 'answered', replyId: res.body.providerPostId });
  });

  it('inbox/resolve: skip, defer and opt_out', async () => {
    page = [
      mention('301', BOB, '@bootr_agent a'),
      mention('302', BOB, '@bootr_agent b'),
      mention('303', ALICE, '@bootr_agent c'),
    ];
    await read();
    const skip = await env.call('POST', '/internal/inbox/resolve', {
      agentId: AGENT,
      postId: '301',
      outcome: 'skip',
      reason: 'spam',
    });
    expect(skip.body.item).toMatchObject({ status: 'skipped', reason: 'spam' });
    const reviewAt = new Date(env.clock.now().getTime() + 3600_000).toISOString();
    const defer = await env.call('POST', '/internal/inbox/resolve', {
      agentId: AGENT,
      postId: '302',
      outcome: 'defer',
      reason: 'later',
      reviewAt,
    });
    expect(defer.body.item).toMatchObject({ status: 'pending', deferredUntil: reviewAt });
    const out = await env.call('POST', '/internal/inbox/resolve', {
      agentId: AGENT,
      postId: '303',
      outcome: 'opt_out',
      reason: 'asked privately',
    });
    expect(out.status).toBe(200);
    page = [];
    let res = await read();
    expect(res.body.items).toEqual([]);
    env.clock.advance(3600_000);
    res = await read();
    expect(res.body.items.map((i: { postId: string }) => i.postId)).toEqual(['302']);
  });
});
