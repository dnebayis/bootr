/**
 * The minutes of a deploy in which one of the two services is new and the other old (the sender carries migration
 * 0004 and the round's posting rules; the supervisor carries the round's tools). Both restart together in one compose
 * deploy, in no fixed order, so each order is a state production passes through:
 *
 *   - a NEW supervisor in front of an OLD sender. The old sender drops what it does not know (`thread`,
 *     `aboutAuthorId`), answers an account read with no `addressedAt`, and has no count of posts with a link. The
 *     supervisor must not post a thread's later parts unchained, must not comment on an author whose stop request
 *     nobody checks, and must not refuse a mention that was allowed the day before only because the sender cannot say
 *     who wrote to the agent;
 *   - an OLD supervisor in front of the NEW sender. It sends none of the new fields: everything it sends is taken as
 *     before, and the one new refusal it can meet (the count of posts with a link) leaves nothing behind.
 */
import { describe, expect, it } from 'vitest';
import { resetAccountChecks } from '../src/attributions.js';
import { executeAction } from '../src/broker/index.js';
import { COMMENT_NOT_NOW, senderKnowsComments } from '../src/comment-posts.js';
import { agentConfigOf } from '../src/onboarding.js';
import { SenderError } from '../src/sender-client.js';
import { SENDER_WITHOUT_THREADS, sendOriginal } from '../src/thread-send.js';
import { AGENT_ID, makeWorld, seedAgent } from './helpers.js';
import { HOUR, POSTING_DEFAULTS, T0, brokerEnv, pendingOf, storeTurn, wiredWorld, xIdAt } from './posting-helpers.js';

let n = 0;
const nextId = () => `act-deploy-${String(++n).padStart(6, '0')}`;
const credit = (username: string) => [{ username, sourceUrl: `https://example.com/${username}` }];
const POST = xIdAt(T0 - HOUR, 1);
const seen = () => ({ postId: POST, authorId: '4201', handle: 'alice', verified: true, verifiedType: 'blue', at: new Date(T0 - HOUR).toISOString(), via: 'thread' as const });

async function oldSenderWorld() {
  resetAccountChecks();
  // the posting rules at their defaults, whichever run this file is part of
  const w = await makeWorld({ config: POSTING_DEFAULTS });
  w.sender.oldSender = true;
  const agent = await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString() } });
  const config = agentConfigOf(agent)!;
  const post = (input: Record<string, unknown>) => executeAction(w.ctx, agent, config, pendingOf(nextId(), 'publish_post', input), brokerEnv());
  const published = () => (w.sender.published as { text: string }[]).map((p) => p.text);
  return { w, agent, config, post, published };
}

describe('a new supervisor in front of a sender from before the round', () => {
  it('a mention that was allowed before is not refused: the audience is unknown, so the rule of before holds', async () => {
    const { w, post, published } = await oldSenderWorld();
    try {
      expect(w.ctx.config.MENTION_AUDIENCE).toBe('engaged');
      // the old sender's account read: the account, whether it posts these days, and no word on who wrote to the agent
      expect(await w.ctx.sender.readAccount(AGENT_ID, 'somebody')).not.toHaveProperty('addressedAt');
      expect((await post({ text: 'A sharp point from @somebody on agent fees.', attributions: credit('somebody') })).kind).toBe('completed');
      // the checks of before still stand: an account X does not know, and one that went quiet (the credit every mention needs is the sender's own gate, old or new)
      w.sender.accountReads.nosuchaccount = null;
      const unknown = await post({ text: 'As @nosuchaccount wrote.', attributions: credit('nosuchaccount') });
      expect(unknown.kind === 'failed' && unknown.error).toMatch(/mention_unknown_account: @nosuchaccount is not an account on X/);
      w.sender.accountReads.quiet = { user: { id: '5100', username: 'quiet' }, activity: 'stale', latestPostAt: null };
      const stale = await post({ text: 'As @quiet wrote.', attributions: credit('quiet') });
      expect(stale.kind === 'failed' && stale.error).toMatch(/mention_inactive_account: @quiet has not posted in months/);
      expect(published()).toEqual(['A sharp point from @somebody on agent fees.']);
    } finally {
      await w.close();
    }
  });

  it('the same mention through today\'s sender is held to the new rule: only an old sender\'s silence is read as "unknown"', async () => {
    const { w, post } = await oldSenderWorld();
    try {
      w.sender.oldSender = false;
      expect(await w.ctx.sender.readAccount(AGENT_ID, 'somebody')).toMatchObject({ addressedAt: null });
      expect(await post({ text: 'A sharp point from @somebody on agent fees.', attributions: credit('somebody') })).toEqual({ kind: 'failed', error: 'mention_not_engaged: @somebody has not written to you; name them without the @. Nothing was posted.' });
    } finally {
      await w.close();
    }
  });

  it('no comment goes out: the old sender would not check whether the author told this agent to stop', async () => {
    const { w, post, published } = await oldSenderWorld();
    try {
      await storeTurn(w, { seen: [seen()] });
      expect(await senderKnowsComments(w.ctx, AGENT_ID)).toBe(false);
      expect(await post({ text: 'A fair point on fees, and here is what I would add.', about: { postId: POST } })).toEqual({ kind: 'failed', error: COMMENT_NOT_NOW });
      expect(COMMENT_NOT_NOW).toBe('comment_not_now: comments cannot be checked for a moment while Bootr restarts; nothing was posted. Say your own thought without naming the author, or comment in a later turn.');
      expect(published()).toEqual([]);
      // an `@` in a comment is not let through on "unknown" either: a comment is no way to notify a stranger
      const mention = await post({ text: 'A fair point from @somebody.', attributions: credit('somebody'), about: { postId: POST } });
      expect(mention.kind).toBe('failed');
      expect(published()).toEqual([]);
      // the sender is replaced by the new one: the same comment goes out, with the author handed over for the stop check
      w.sender.oldSender = false;
      expect(await senderKnowsComments(w.ctx, AGENT_ID)).toBe(true);
      expect(await post({ text: 'A fair point on fees, and here is what I would add.', about: { postId: POST } })).toMatchObject({ kind: 'completed', result: { about: { authorId: '4201', handle: 'alice' } } });
      expect(w.sender.published).toMatchObject([{ aboutAuthorId: '4201' }]);
      // a sender that cannot be asked is not known to be new
      w.sender.client.quota = async () => {
        throw new SenderError(503, 'http_503', null, true);
      };
      expect(await senderKnowsComments(w.ctx, AGENT_ID)).toBe(false);
    } finally {
      await w.close();
    }
  });

  it('a thread stops after its first post, sent now or from the schedule: the old sender would post the rest unchained', async () => {
    const { w, agent, post } = await oldSenderWorld();
    try {
      const thread = { text: 'A thought that needs room, part one.', thread: [{ text: 'Part two goes on.' }, { text: 'Part three closes it.' }] };
      expect(await post(thread)).toMatchObject({ kind: 'completed', result: { sent: 1, of: 3, cut: { n: 2, error: SENDER_WITHOUT_THREADS } } });
      expect(await sendOriginal(w.ctx, agent, { actionId: 'sch_0123456789abcdef', text: 'A scheduled thread, part one.', thread: [{ text: 'Its second part.' }] })).toMatchObject({ kind: 'completed', result: { sent: 1, of: 2, cut: { n: 2, error: SENDER_WITHOUT_THREADS } } });
      expect((w.sender.published as { text: string }[]).map((p) => p.text)).toEqual(['A thought that needs room, part one.', 'A scheduled thread, part one.']);
    } finally {
      await w.close();
    }
  });

  it('a plain post, a reply and the read tools are untouched', async () => {
    const { w, agent, config, post } = await oldSenderWorld();
    try {
      expect((await post({ text: 'One plain post.' })).kind).toBe('completed');
      const item = { postId: '801', authorId: '42', conversationId: '801', status: 'pending', observedAt: '2026-10-24T11:59:00Z', seenAt: null, deferredUntil: null, post: { id: '801', authorId: '42', text: '@bootr_agent hello', conversationId: '801', author: { id: '42', username: 'asker', verified: true, verifiedType: 'blue' as const } } };
      expect((await executeAction(w.ctx, agent, config, pendingOf(nextId(), 'publish_reply', { postId: '801', text: 'Hello back.' }), brokerEnv([item]))).kind).toBe('completed');
      expect(w.sender.published).toHaveLength(2);
    } finally {
      await w.close();
    }
  });
});

describe('an old supervisor in front of the sender of this round', () => {
  it('a publish, its receipt, the quota read and a repeat, asked the way the old supervisor asks, are answered as before', async () => {
    const w = await wiredWorld({ config: POSTING_DEFAULTS });
    try {
      await seedAgent(w);
      // what the supervisor of before sends: no `thread`, no `aboutAuthorId`, nothing of the round
      const res = await w.ctx.sender.publish({ agentId: AGENT_ID, actionId: 'act-old-sup-00001', text: 'A post from the supervisor of yesterday.', xUserId: '1000' });
      expect(res).toMatchObject({ status: 'sent', providerPostId: expect.stringMatching(/^\d+$/) });
      // what it does not know in the answers it ignores; what it does read is where it was
      expect(res.receipt).toMatchObject({ actionId: 'act-old-sup-00001', status: 'sent' });
      const receipt = await w.ctx.sender.receipt('act-old-sup-00001');
      expect(receipt).toMatchObject({ status: 'sent', providerPostId: res.providerPostId });
      expect(receipt.thread).toBeUndefined();
      expect(await w.ctx.sender.quota(AGENT_ID)).toMatchObject({ postsPerDay: 24, postsUsed24h: 1 });
      // a repeat is still answered from the stored receipt
      expect(await w.ctx.sender.publish({ agentId: AGENT_ID, actionId: 'act-old-sup-00001', text: 'A post from the supervisor of yesterday.', xUserId: '1000' })).toMatchObject({ status: 'sent', duplicate: true, providerPostId: res.providerPostId });
      expect(w.posted()).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('the one new refusal it can meet is the count of posts with a link: a 429 that leaves nothing behind, which it reads as a failed post it may retry', async () => {
    const w = await wiredWorld({ config: POSTING_DEFAULTS });
    try {
      await seedAgent(w);
      w.x.ctx.defaults.linkPostsPerDay = 1;
      expect((await w.ctx.sender.publish({ agentId: AGENT_ID, actionId: 'act-old-sup-00002', text: 'A link: https://bootr.fun/a/1', xUserId: '1000' })).status).toBe('sent');
      const refused = await w.ctx.sender.publish({ agentId: AGENT_ID, actionId: 'act-old-sup-00003', text: 'Another link: https://bootr.fun/a/2', xUserId: '1000' }).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(SenderError);
      // the old supervisor turns any sender error into `sender:<code>` with the retry time: a failed step, nothing held, nothing posted
      expect(refused).toMatchObject({ status: 429, code: 'link_quota', retryable: true });
      expect((refused as SenderError).retryAt).toBeGreaterThan(w.ctx.now());
      expect(await w.senderRows()).toHaveLength(1);
      // the same thought without the link goes out
      expect((await w.ctx.sender.publish({ agentId: AGENT_ID, actionId: 'act-old-sup-00004', text: 'The same thought without a link.', xUserId: '1000' })).status).toBe('sent');
    } finally {
      await w.close();
    }
  });
});
