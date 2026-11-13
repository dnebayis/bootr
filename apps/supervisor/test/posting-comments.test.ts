/**
 * Comments (docs/design/agent-tools-2.md section 4): `publish_post {about}` is a post of the agent's own about a post
 * it read in this turn. It must never be a way to reply to, @mention or link a stranger, and it is bounded per coin
 * and per author. Each rule of section 4.3 and its refusal, what a hostile or confused model could try with the
 * field, and one whole hosted turn through the real sender and a fake X.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { json } from '../../sender/test/helpers.js';
import { optouts } from '../../sender/src/db/schema.js';
import { agentActivity } from '../src/activity.js';
import { createApp } from '../src/api.js';
import { queueForApproval } from '../src/approvals.js';
import { executeAction } from '../src/broker/index.js';
import { COMMENT_AUTHOR_BLOCKED, COMMENT_AUTHOR_NOT_PUBLIC, COMMENT_LINK_FORBIDDEN, COMMENT_SOURCE_UNREAD, SEEN_MAX, linksPost, neverComment, noteSeen, postTimeMs, seenInResult, type SeenPost } from '../src/comment-posts.js';
import { actions, approvals, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { agentConfigOf } from '../src/onboarding.js';
import type { Turn } from '../src/runtime.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, SUPERVISOR_KEY, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { DAY, HOUR, T0, actionRow, brokerEnv, observed, pendingOf, storeTurn, wiredWorld, xIdAt } from './posting-helpers.js';

/** A verified account that never wrote to the agent, and a post of hers from an hour ago. */
const ALICE = { authorId: '4201', handle: 'alice', verified: true, verifiedType: 'blue' };
const POST = xIdAt(T0 - HOUR, 1);
const seen = (over: Partial<SeenPost> = {}): SeenPost => ({ postId: POST, ...ALICE, at: new Date(T0 - HOUR).toISOString(), via: 'thread', ...over });
const TEXT = 'Alice makes the case that fees should be visible on the coin page. I agree, and here is why it matters for holders.';

let n = 0;
const nextId = () => `act-comment-${String(++n).padStart(5, '0')}`;

async function world(opts: { config?: Record<string, string>; agent?: Record<string, unknown> } = {}) {
  const w = await makeWorld(opts.config ? { config: opts.config } : {});
  const agent = await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString(), ...(opts.agent ?? {}) } });
  const config = agentConfigOf(agent)!;
  const comment = (input: Record<string, unknown> = {}, items: SenderInboxItem[] = [], id = nextId()) => executeAction(w.ctx, agent, config, pendingOf(id, 'publish_post', { text: TEXT, about: { postId: POST }, ...input }), brokerEnv(items));
  const refusal = async (...args: Parameters<typeof comment>) => {
    const out = await comment(...args);
    return out.kind === 'failed' ? out.error : `not refused: ${JSON.stringify(out)}`;
  };
  return { w, agent, config, comment, refusal };
}

/** An earlier comment of the agent, as its action row keeps it. */
const earlier = (w: TestWorld, id: string, agoMs: number, about: { postId: string; authorId: string; handle?: string }, over: Record<string, unknown> = {}) =>
  actionRow(w, id, { tool: 'publish_post', input: { text: `an earlier comment ${id}`, about: { postId: about.postId } } }, { createdAt: new Date(w.ctx.now() - agoMs), result: { actionId: id, tool: 'publish_post', status: 'completed', result: { postId: '9100', about: { postId: about.postId, authorId: about.authorId, handle: about.handle ?? 'somebody' } } }, ...over });

describe('what the turn read', () => {
  it('a read keeps its posts on the turn, newest last, sixty at most, with author id, handle, badge and date', () => {
    const turn: { seen?: SeenPost[] } = {};
    const thread = { posts: [{ id: '501', text: 'root', authorId: '42', createdAt: '2026-10-24T10:00:00.000Z', author: { id: '42', username: 'Alice', verified: true, verifiedType: 'blue' } }, { id: '502', text: 'reply', authorId: '43' }], truncated: false };
    noteSeen(turn, seenInResult('read_x_thread', thread));
    expect(turn.seen).toEqual([
      { postId: '501', authorId: '42', handle: 'alice', verified: true, verifiedType: 'blue', at: '2026-10-24T10:00:00.000Z', via: 'thread' },
      { postId: '502', authorId: '43', handle: null, at: null, via: 'thread' },
    ]);
    // the inbox as read_mentions returns it
    noteSeen(turn, seenInResult('read_mentions', { items: [{ postId: '503', post: { id: '503', text: '@bootr_agent hi', authorId: '44', author: { id: '44', username: 'bob', verified: false } } }] }));
    expect(turn.seen![2]).toEqual({ postId: '503', authorId: '44', handle: 'bob', verified: false, at: null, via: 'mentions' });
    // an author block that does not belong to the post's author is not believed
    expect(seenInResult('read_x_thread', { posts: [{ id: '504', text: 'x', authorId: '45', author: { id: '99', username: 'mallory', verified: true, verifiedType: 'blue' } }] })).toEqual([{ postId: '504', authorId: '45', handle: null, at: null, via: 'thread' }]);
    // nothing that is not a post, and never more than the turn keeps
    expect(seenInResult('read_x_thread', { posts: [{ id: 'not-an-id' }, null, 7], items: 'x' })).toEqual([]);
    expect(seenInResult('read_x_account', { user: { id: '42', username: 'alice' } })).toEqual([]);
    noteSeen(turn, Array.from({ length: 80 }, (_, i) => ({ postId: String(1000 + i), authorId: '42', handle: 'alice', at: null, via: 'thread' as const })));
    expect(turn.seen).toHaveLength(SEEN_MAX);
    expect(turn.seen![SEEN_MAX - 1]!.postId).toBe('1079');
    expect(turn.seen!.some((p) => p.postId === '501')).toBe(false);
  });

  it('an X id carries its own date, so the age of a post is known when the read gave none', () => {
    expect(postTimeMs({ postId: xIdAt(T0 - 5 * HOUR), at: null })).toBe(T0 - 5 * HOUR);
    expect(postTimeMs({ postId: '5', at: '2026-10-24T09:00:00.000Z' })).toBe(Date.parse('2026-10-24T09:00:00.000Z'));
    expect(postTimeMs({ postId: '5', at: null })).toBeNull();
  });

  it('a link to the commented post is found whatever the site in front of it and however it is written', () => {
    for (const link of [`https://x.com/alice/status/${POST}`, `https://twitter.com/alice/status/${POST}?s=20`, `x.com/i/web/status/${POST}`, `https://mobile.twitter.com/alice/statuses/${POST}`, `https://fxtwitter.com/alice/status/${POST}/photo/1`, `https://x.com/alice/status%2F${POST}`, `HTTPS://X.COM/alice/STATUS/${POST}`]) expect([link, linksPost(`worth a read: ${link}`, POST)]).toEqual([link, true]);
    // another post, a longer id that only starts the same, and the bare number are not that link
    expect(linksPost(`https://x.com/alice/status/${POST}9`, POST)).toBe(false);
    expect(linksPost('https://x.com/alice/status/123', POST)).toBe(false);
    expect(linksPost(`post number ${POST} said it well`, POST)).toBe(false);
  });

  it('the platform list takes ids and handles', () => {
    expect(neverComment(' 4201, @Quiet_One ,, not a handle!, 77 ')).toEqual({ ids: new Set(['4201', '77']), handles: new Set(['quiet_one']) });
    expect(neverComment('')).toEqual({ ids: new Set(), handles: new Set() });
  });
});

describe('each rule of a comment and its refusal', () => {
  it('a post the agent read in this turn, by a verified account, is commented on as a post of its own that names nobody to X', async () => {
    const { w, agent, comment } = await world();
    try {
      await storeTurn(w, { seen: [seen()] });
      const out = await comment({ topic: 'fees' });
      expect(out).toMatchObject({ kind: 'completed', result: { postId: expect.stringMatching(/^\d+$/), about: { postId: POST, authorId: '4201', handle: 'alice' } } });
      // what the sender was handed: the author for the opt-out check, and nothing that makes it a reply, a quote or a mention
      const [body] = w.sender.published as Record<string, unknown>[];
      expect(body).toMatchObject({ agentId: AGENT_ID, text: TEXT, aboutAuthorId: '4201' });
      for (const key of ['replyTo', 'replyAuthorId', 'replyEligibility', 'quote', 'attributions', 'thread']) expect(body).not.toHaveProperty(key);
      // the tape says whose post it is about and keeps the link to it for the coin page
      await actionRow(w, 'act-tape-0000001', { tool: 'publish_post', input: { text: TEXT, about: { postId: POST } } }, { result: { actionId: 'act-tape-0000001', tool: 'publish_post', status: 'completed', result: (out as { result: Record<string, unknown> }).result } });
      const tape = (await agentActivity(w.ctx, agent, null)).filter((t) => t.kind === 'post');
      expect(tape).toEqual([expect.objectContaining({ summary: 'Commented on a post by @alice', about: { handle: 'alice', postId: POST, url: `https://x.com/alice/status/${POST}` }, url: expect.stringMatching(/^https:\/\/x\.com\/bootr_agent\/status\/\d+$/) })]);
    } finally {
      await w.close();
    }
  });

  it('comment_source_unread: a post id the turn was never shown, whatever the model says about it', async () => {
    const { w, refusal } = await world();
    try {
      // no turn on record, an empty turn, and a turn that read something else
      expect(await refusal()).toBe(COMMENT_SOURCE_UNREAD);
      expect(COMMENT_SOURCE_UNREAD).toBe('comment_source_unread: you can comment only on a post you read in this turn; nothing was posted.');
      await storeTurn(w, {});
      expect(await refusal()).toBe(COMMENT_SOURCE_UNREAD);
      await storeTurn(w, { seen: [seen({ postId: xIdAt(T0 - HOUR, 2) })] });
      expect(await refusal()).toBe(COMMENT_SOURCE_UNREAD);
      // what an earlier turn read is not what this one read
      await storeTurn(w, { seen: [seen()] });
      await storeTurn(w, {});
      expect(await refusal()).toBe(COMMENT_SOURCE_UNREAD);
      expect(w.sender.published).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('comment_author_not_public: an account with no badge that never wrote to the agent, and an author the read did not name', async () => {
    const { w, refusal, comment } = await world();
    try {
      expect(COMMENT_AUTHOR_NOT_PUBLIC).toBe('comment_author_not_public: you can comment only on posts by accounts you follow, other Bootr agents, accounts that wrote to you, or verified accounts; nothing was posted. Say your own thought without naming the author.');
      for (const author of [{ verified: false, verifiedType: 'none' }, { verified: undefined, verifiedType: undefined }, { verified: true, verifiedType: 'none' }, { verified: false, verifiedType: 'blue' }, { verified: true, verifiedType: 'government' }]) {
        await storeTurn(w, { seen: [seen(author as Partial<SeenPost>)] });
        expect([author, await refusal()]).toEqual([author, COMMENT_AUTHOR_NOT_PUBLIC]);
      }
      // a post whose author the read did not name: nobody to call public
      await storeTurn(w, { seen: [seen({ handle: null, verified: undefined, verifiedType: undefined })] });
      expect(await refusal()).toBe(COMMENT_AUTHOR_NOT_PUBLIC);
      expect(w.sender.published).toEqual([]);
      // a business badge is a badge
      await storeTurn(w, { seen: [seen({ verifiedType: 'business' })] });
      expect((await comment()).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('public without a badge: another Bootr agent, somebody in this turn\'s inbox, somebody who wrote to the agent in the last 30 days', async () => {
    const { w, refusal, comment } = await world();
    try {
      const plain = { verified: false, verifiedType: 'none' };
      // another Bootr agent
      await seedAgent(w, { agent: { agentId: '77', kernel: '0x7777777777777777777777777777777777777777', token: '0x7777777777777777777777777777777777777770' }, runtime: { agentId: '77' }, config: { xHandle: 'OwlAgent', xUserId: '7700' } });
      await storeTurn(w, { seen: [seen({ authorId: '7700', handle: 'owlagent', ...plain })] });
      expect(await comment()).toMatchObject({ kind: 'completed', result: { about: { authorId: '7700', handle: 'owlagent' } } });

      // somebody whose mention is in this turn's inbox: the inbox itself is a read
      const item: SenderInboxItem = { postId: POST, authorId: '4300', conversationId: POST, status: 'pending', observedAt: new Date(T0 - 60_000).toISOString(), seenAt: null, deferredUntil: null, post: { id: POST, authorId: '4300', text: '@bootr_agent the fee split should be on the page', createdAt: new Date(T0 - HOUR).toISOString(), conversationId: POST, author: { id: '4300', username: 'carol', verified: false } } };
      await storeTurn(w, {});
      expect(await comment({}, [item])).toMatchObject({ kind: 'completed', result: { about: { authorId: '4300', handle: 'carol' } } });

      // somebody who wrote to the agent 29 days ago (the sender's inbox says so, with the account lookup)
      await storeTurn(w, { seen: [seen({ authorId: '4400', handle: 'dave', ...plain })] });
      w.sender.accountReads.dave = { user: { id: '4400', username: 'dave' }, activity: 'recent', latestPostAt: null, addressedAt: new Date(T0 - 29 * DAY).toISOString() } as never;
      expect(await comment()).toMatchObject({ kind: 'completed', result: { about: { authorId: '4400', handle: 'dave' } } });
      // 31 days ago is no longer "wrote to you", and a handle that now belongs to somebody else proves nothing
      await storeTurn(w, { seen: [seen({ authorId: '4500', handle: 'erin', ...plain })] });
      w.sender.accountReads.erin = { user: { id: '4500', username: 'erin' }, activity: 'recent', latestPostAt: null, addressedAt: new Date(T0 - 31 * DAY).toISOString() } as never;
      expect(await refusal()).toBe(COMMENT_AUTHOR_NOT_PUBLIC);
      w.sender.accountReads.erin = { user: { id: '9999', username: 'erin' }, activity: 'recent', latestPostAt: null, addressedAt: new Date(T0 - DAY).toISOString() } as never;
      expect(await refusal()).toBe(COMMENT_AUTHOR_NOT_PUBLIC);
    } finally {
      await w.close();
    }
  });

  it('comment_author_blocked: the agent itself, the creator\'s blocked list, the platform\'s own list', async () => {
    const { w, refusal } = await world({ config: { PLATFORM_NEVER_COMMENT: '4800,@quiet_one' }, agent: { blockedAuthorIds: ['4700'] } });
    try {
      expect(COMMENT_AUTHOR_BLOCKED).toBe('comment_author_blocked: this account is not to be commented on; nothing was posted.');
      const blocked: Partial<SeenPost>[] = [{ authorId: '1000', handle: 'bootr_agent' }, { authorId: '1000', handle: null }, { authorId: '4700', handle: 'frank' }, { authorId: '4800', handle: 'grace' }, { authorId: '4900', handle: 'quiet_one' }];
      for (const author of blocked) {
        await storeTurn(w, { seen: [seen(author)] });
        expect([author, await refusal()]).toEqual([author, COMMENT_AUTHOR_BLOCKED]);
      }
      expect(w.sender.published).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('a post older than 72 hours is not commented on, by its date or by its id', async () => {
    const { w, refusal, comment } = await world();
    try {
      const old = 'comment_source_too_old: you can comment only on a post of the last 72 hours; nothing was posted.';
      await storeTurn(w, { seen: [seen({ at: new Date(T0 - 73 * HOUR).toISOString() })] });
      expect(await refusal()).toBe(old);
      const oldId = xIdAt(T0 - 80 * HOUR);
      await storeTurn(w, { seen: [seen({ postId: oldId, at: null })] });
      expect(await refusal({ about: { postId: oldId } })).toBe(old);
      // a post whose age nothing says is not taken on trust
      await storeTurn(w, { seen: [seen({ postId: '555', at: null })] });
      expect(await refusal({ about: { postId: '555' } })).toBe(old);
      await storeTurn(w, { seen: [seen({ at: new Date(T0 - 71 * HOUR).toISOString() })] });
      expect((await comment()).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('comment_daily_cap: three comments a day per coin, counted from the rows, a queued one included', async () => {
    const { w, refusal, comment } = await world();
    try {
      await storeTurn(w, { seen: [seen()] });
      await earlier(w, 'c1', 2 * HOUR, { postId: '601', authorId: '5001' });
      await earlier(w, 'c2', 5 * HOUR, { postId: '602', authorId: '5002' });
      // one still waiting for the creator's review counts; the row an approved one is recorded under repeats it and does not
      await earlier(w, 'c3', 9 * HOUR, { postId: '603', authorId: '5003' }, { result: { actionId: 'c3', tool: 'publish_post', status: 'completed', result: { queued: true, approvalId: 'c3', about: { postId: '603', authorId: '5003', handle: 'x' } } } });
      await actionRow(w, 'c3-approved', { tool: 'publish_post', input: { text: 'approved copy', about: { postId: '603' } }, approval: { id: 'c3' } }, { createdAt: new Date(w.ctx.now() - 8 * HOUR), result: { postId: '9103', about: { postId: '603', authorId: '5003', handle: 'x' }, approvalId: 'c3', senderStatus: 'sent' } });
      expect(await refusal()).toBe('comment_daily_cap: at most 3 comments per 24 hours; nothing was posted.');
      expect(w.sender.published).toEqual([]);
      // a failed one never counted, and one from yesterday no longer does
      await w.db.update(actions).set({ status: 'failed' }).where(eq(actions.actionId, 'c2'));
      expect((await comment()).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('comment_author_cap: one comment on an author a day and three a week, whichever post it was', async () => {
    const { w, refusal, comment } = await world({ config: { COMMENT_POSTS_PER_DAY: '10' } });
    try {
      await storeTurn(w, { seen: [seen()] });
      await earlier(w, 'a1', 3 * HOUR, { postId: '701', authorId: '4201' });
      expect(await refusal()).toBe('comment_author_cap: you already commented on this account\'s posts 1 times this day; nothing was posted.');
      // other authors are not touched by it
      await storeTurn(w, { seen: [seen({ authorId: '4202', handle: 'bob' })] });
      expect((await comment()).kind).toBe('completed');

      // three in the week, none today: the fourth waits
      await w.db.delete(actions);
      await storeTurn(w, { seen: [seen()] });
      await earlier(w, 'w1', 2 * DAY, { postId: '711', authorId: '4201' });
      await earlier(w, 'w2', 4 * DAY, { postId: '712', authorId: '4201' });
      expect((await comment({}, [], 'act-week-000001')).kind).toBe('completed');
      await w.db.delete(actions);
      await earlier(w, 'w1', 2 * DAY, { postId: '711', authorId: '4201' });
      await earlier(w, 'w2', 4 * DAY, { postId: '712', authorId: '4201' });
      await earlier(w, 'w3', 6 * DAY, { postId: '713', authorId: '4201' });
      expect(await refusal()).toBe('comment_author_cap: you already commented on this account\'s posts 3 times this week; nothing was posted.');
      // a comment whose outcome is still unknown carries no author yet: it counts when it is about this very post
      await w.db.delete(actions);
      await actionRow(w, 'held1', { tool: 'publish_post', input: { text: 'held', about: { postId: POST } } }, { status: 'held', result: null, createdAt: new Date(w.ctx.now() - HOUR) });
      expect(await refusal()).toMatch(/^comment_author_cap: .* 1 times this day/);
    } finally {
      await w.close();
    }
  });

  it('comment_link_forbidden: no link to the commented post, in the text or in any part of a thread', async () => {
    const { w, refusal, comment } = await world();
    try {
      expect(COMMENT_LINK_FORBIDDEN).toBe('comment_link_forbidden: do not link the post you comment on; nothing was posted. Say whose post it is in words.');
      await storeTurn(w, { seen: [seen()] });
      expect(await refusal({ text: `Alice is right about fees. https://x.com/alice/status/${POST}` })).toBe(COMMENT_LINK_FORBIDDEN);
      expect(await refusal({ text: 'Alice is right about fees.', thread: [{ text: 'The reasons, in order.' }, { text: `Her post: x.com/i/status/${POST}` }] })).toBe(COMMENT_LINK_FORBIDDEN);
      expect(w.sender.published).toEqual([]);
      // a comment may open a thread, with nothing of the commented post linked (this world's sender is a stand-in that
      // does not know threads, so the first part is all that goes: the whole thread is followed in the next test)
      expect(await comment({ text: 'Alice is right about fees.', thread: [{ text: 'The reasons, in order: first the split is fixed at launch.' }] })).toMatchObject({ kind: 'completed', result: { sent: 1, of: 2, cut: { n: 2 }, about: { handle: 'alice' } } });
      expect((w.sender.published as { aboutAuthorId?: string }[]).map((p) => p.aboutAuthorId)).toEqual(['4201']);
    } finally {
      await w.close();
    }
  });

  it('a comment that is a thread goes out whole through the real sender, every part naming the author for the stop check', async () => {
    const w = await wiredWorld();
    try {
      const agent = await seedAgent(w);
      const config = agentConfigOf(agent)!;
      await storeTurn(w, { seen: [seen()] });
      const parts = { text: 'Alice is right about fees.', thread: [{ text: 'First, the split is fixed at launch.' }, { text: 'Second, a holder can read it on the coin page.' }], about: { postId: POST } };
      const out = await executeAction(w.ctx, agent, config, pendingOf('act-comment-thread1', 'publish_post', parts), brokerEnv());
      expect(out).toMatchObject({ kind: 'completed', result: { sent: 3, of: 3, about: { postId: POST, authorId: '4201', handle: 'alice' } } });
      const rows = await w.senderRows();
      expect(w.posted().map((p) => p.replyTo)).toEqual([null, rows[0]!.providerPostId, rows[1]!.providerPostId]);
      // the author said stop meanwhile: the next comment thread is refused at its first part, and nothing goes out
      await w.x.db.insert(optouts).values({ agentId: AGENT_ID, authorId: '4201', enabled: true, postId: '900', updatedAt: w.x.clock.now() });
      const refused = await executeAction(w.ctx, agent, config, pendingOf('act-comment-thread2', 'publish_post', { ...parts, text: 'Alice has a second point.' }), brokerEnv());
      expect(refused).toEqual({ kind: 'failed', error: 'sender_rejected:policy:about_opted_out' });
      expect(w.posted()).toHaveLength(3);
    } finally {
      await w.close();
    }
  });

  it('the owner may allow the link (COMMENT_LINK), and it is then a post with a link like any other', async () => {
    const { w, comment } = await world({ config: { COMMENT_LINK: 'true' } });
    try {
      await storeTurn(w, { seen: [seen()] });
      expect((await comment({ text: `Alice is right about fees. https://x.com/alice/status/${POST}` })).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('a comment never @mentions somebody who did not write to the agent, whatever the mention audience is set to', async () => {
    const { w, refusal, comment } = await world({ config: { MENTION_AUDIENCE: 'anyone' } });
    try {
      await storeTurn(w, { seen: [seen()] });
      const credits = [{ username: 'alice', sourceUrl: 'https://example.com/alice-on-fees' }];
      // the same original without `about` is allowed by this audience; as a comment it is not
      expect(await refusal({ text: '@alice makes the case for visible fees, and she is right.', attributions: credits })).toBe('mention_not_engaged: @alice has not written to you; name them without the @. Nothing was posted.');
      expect(w.sender.published).toEqual([]);
      // somebody who did write to the agent may be named with the @
      w.sender.accountReads.alice = { user: { id: '4201', username: 'alice' }, activity: 'recent', latestPostAt: null, addressedAt: new Date(T0 - DAY).toISOString() } as never;
      expect((await comment({ text: '@alice makes the case for visible fees, and she is right.', attributions: credits })).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('comments are switched off by the limit, or by the creator for their own coin', async () => {
    const off = await world({ config: { COMMENT_POSTS_PER_DAY: '0' } });
    try {
      await storeTurn(off.w, { seen: [seen()] });
      expect(await off.refusal()).toBe('comment_daily_cap: at most 0 comments per 24 hours; nothing was posted.');
    } finally {
      await off.w.close();
    }
    const quiet = await world({ agent: { comments: false } });
    try {
      await storeTurn(quiet.w, { seen: [seen()] });
      expect(await quiet.refusal()).toBe('comment_daily_cap: at most 0 comments per 24 hours; nothing was posted.');
      // the same coin still posts
      expect(await executeAction(quiet.w.ctx, quiet.agent, quiet.config, pendingOf(nextId(), 'publish_post', { text: 'A post of its own.' }), brokerEnv())).toMatchObject({ kind: 'completed' });
    } finally {
      await quiet.w.close();
    }
  });
});

describe('the watchlist as a source, and the author lookup it needs', () => {
  const watchlist = (posts: { postId: string; at?: string | null }[]) => ({ watchlist: { instructionAuthority: false, source: 'x', accounts: [{ handle: 'jessepollak', latestPosts: posts.map((p) => ({ postId: p.postId, at: p.at ?? new Date(T0 - 2 * HOUR).toISOString(), text: 'Base is for builders.', link: `https://x.com/jessepollak/status/${p.postId}` })) }] } });

  it('a post the watchlist section showed may be commented on; its author is a followed account, and the id comes from one lookup', async () => {
    const { w, comment, refusal } = await world();
    try {
      await storeTurn(w, observed(watchlist([{ postId: POST }])));
      // the lookup cannot say who it is: no comment without the author's stable id (the caps and a stop request hang on it)
      expect(await refusal()).toBe('comment_author_unknown: @jessepollak could not be looked up on X right now; nothing was posted. Say your own thought without naming the author, or try again in a later turn.');
      w.sender.accountReads.jessepollak = { user: { id: '18876842', username: 'jessepollak' }, activity: 'recent', latestPostAt: null };
      expect(await comment()).toMatchObject({ kind: 'completed', result: { about: { postId: POST, authorId: '18876842', handle: 'jessepollak' } } });
      expect((w.sender.published as { aboutAuthorId?: string }[])[0]!.aboutAuthorId).toBe('18876842');
      // an own agent's turn keeps the observation it was opened with
      await storeTurn(w, { messages: [], ownOpen: { brief: 'b', observation: watchlist([{ postId: xIdAt(T0 - HOUR, 7) }]), tools: ['publish_post'] } } as Partial<Turn>);
      expect(await comment({ about: { postId: xIdAt(T0 - HOUR, 7) } })).toMatchObject({ kind: 'completed', result: { about: { handle: 'jessepollak' } } });
      expect(await refusal({ about: { postId: xIdAt(T0 - HOUR, 8) } })).toBe(COMMENT_SOURCE_UNREAD);
    } finally {
      await w.close();
    }
  });
});

describe('a comment in approval mode', () => {
  it('is checked when it is queued, keeps the post it is about, and names the author to the sender when it is approved', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: { requireApproval: true } });
      await storeTurn(w, { seen: [seen()] });
      const unread = await queueForApproval(w.ctx, agent, pendingOf('act-queue-000001', 'publish_post', { text: TEXT, about: { postId: '12345' } }), brokerEnv());
      expect(unread).toEqual({ kind: 'failed', error: COMMENT_SOURCE_UNREAD });
      const queued = await queueForApproval(w.ctx, agent, pendingOf('act-queue-000002', 'publish_post', { text: TEXT, about: { postId: POST } }), brokerEnv());
      expect(queued).toMatchObject({ kind: 'completed', result: { queued: true, about: { postId: POST, authorId: '4201', handle: 'alice' } } });
      expect(((await w.db.select().from(approvals))[0]!.meta as { about: unknown }).about).toEqual({ postId: POST, authorId: '4201', handle: 'alice' });
      expect(w.sender.published).toEqual([]);

      const nowSec = () => Math.floor(w.ctx.now() / 1000);
      const path = `/internal/agents/${AGENT_ID}/approvals/act-queue-000002`;
      const text = JSON.stringify({ decision: 'approve', by: CREATOR });
      const res = await createApp(w.ctx, nowSec).request(path, { method: 'POST', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'POST', path, text, nowSec()) } });
      expect(res.status).toBe(200);
      expect(w.sender.published).toMatchObject([{ actionId: 'act-queue-000002', text: TEXT, aboutAuthorId: '4201' }]);
      const [sent] = (await w.db.select().from(actions)).filter((r) => r.actionId === 'act-queue-000002-approved');
      expect(sent).toMatchObject({ action: { input: { text: TEXT, about: { postId: POST } } }, result: { about: { postId: POST, authorId: '4201', handle: 'alice' }, senderStatus: 'sent' } });
    } finally {
      await w.close();
    }
  });
});

describe('a whole hosted turn through the sender and X', () => {
  const THREAD_POST = xIdAt(T0 - 2 * HOUR, 3);
  const tweet = { id: THREAD_POST, text: 'Fees should be on the coin page, where a holder can see them.', author_id: '4201', conversation_id: THREAD_POST, created_at: new Date(T0 - 2 * HOUR).toISOString() };
  const user = { id: '4201', username: 'alice', name: 'Alice', verified: true, verified_type: 'blue' };

  it('reads a post, comments on it as a post of its own, and the author who said stop is never commented on', async () => {
    const script = [toolCallResponse('read_x_thread', { postId: THREAD_POST }, 'call_read'), toolCallResponse('publish_post', { text: TEXT, about: { postId: THREAD_POST }, topic: 'fees' }, 'call_post'), finishResponse(T0 + 3 * HOUR)];
    const w = await wiredWorld({ script });
    try {
      await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString() } });
      w.x.fake.on('GET', `/2/tweets/${THREAD_POST}`, () => json({ data: tweet, includes: { users: [user] } }));
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      // one post at X: an original, with no reply target and no quote
      const sent = w.x.fake.calls.filter((c) => c.method === 'POST' && c.path === '/2/tweets').map((c) => c.body as Record<string, unknown>);
      expect(sent).toEqual([{ text: TEXT }]);
      const [row] = (await w.db.select().from(actions)).filter((a) => (a.action as { tool?: string }).tool === 'publish_post');
      expect(row).toMatchObject({ status: 'completed', action: { input: { about: { postId: THREAD_POST }, topic: 'fees' } } });
      expect((row!.result as { result: Record<string, unknown> }).result).toMatchObject({ about: { postId: THREAD_POST, authorId: '4201', handle: 'alice' } });
      // the turn is over and stored no more; while it ran it carried what the read showed, or the comment had been refused as unread
      expect((await w.db.select().from(runtimes))[0]!.turn).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('an author who told this agent to stop is refused by the sender, the only place that keeps those', async () => {
    const script = [toolCallResponse('read_x_thread', { postId: THREAD_POST }, 'call_read'), toolCallResponse('publish_post', { text: TEXT, about: { postId: THREAD_POST } }, 'call_post'), finishResponse(T0 + 3 * HOUR)];
    const w = await wiredWorld({ script });
    try {
      await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString() } });
      w.x.fake.on('GET', `/2/tweets/${THREAD_POST}`, () => json({ data: tweet, includes: { users: [user] } }));
      await w.x.db.insert(optouts).values({ agentId: AGENT_ID, authorId: '4201', enabled: true, postId: '900', updatedAt: w.x.clock.now() });
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect(w.posted()).toEqual([]);
      const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
      const last = calls[calls.length - 1]!.body as { messages: { role: string; content: string }[] };
      const results = last.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content) as { error?: string });
      expect(results[1]!.error).toBe('sender_rejected:policy:about_opted_out');
    } finally {
      await w.close();
    }
  });
});
