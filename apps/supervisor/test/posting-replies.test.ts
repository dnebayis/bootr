/**
 * The reply audience (docs/design/agent-tools-2.md section 4.5): `verified` (the default) answers verified accounts,
 * the creator's list and other Bootr agents; `own_threads` also answers a direct reply under one of the agent's own
 * posts from anybody, at most `OPEN_REPLIES_PER_DAY` a day. Both ways, and the daily count.
 *
 * The replies here state something and ask nothing, so what is proven is this audience alone: since the owner's
 * decision of 2026-11-13 a question from anyone is answered on either audience (`REPLY_QUESTIONS_FROM_ANYONE`,
 * posting-questions.test.ts), and a reply that asked would be answered for that reason.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentDirectory, openRepliesInWindow, replyAudienceOf } from '../src/agent-directory.js';
import { queueForApproval } from '../src/approvals.js';
import { executeAction, inboxViews } from '../src/broker/index.js';
import { actions, approvals } from '../src/db/schema.js';
import { autoClosable } from '../src/mention-close.js';
import { agentConfigOf } from '../src/onboarding.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { HOUR, T0, actionRow, brokerEnv, pendingOf } from './posting-helpers.js';

const OWN_POST = '9001';

/** An unverified account replying directly under the agent's own post. */
function under(postId: string, authorId: string, over: Partial<SenderInboxItem['post']> = {}): SenderInboxItem {
  return {
    postId,
    authorId,
    conversationId: OWN_POST,
    status: 'pending',
    observedAt: new Date(T0 - 60_000).toISOString(),
    seenAt: null,
    deferredUntil: null,
    post: { id: postId, authorId, text: '@bootr_agent thanks, the fee split is clear now.', createdAt: new Date(T0 - 2 * 60_000).toISOString(), conversationId: OWN_POST, inReplyToUserId: '1000', referencedPosts: [{ type: 'replied_to', id: OWN_POST }], author: { id: authorId, username: `user${authorId}`, verified: false }, ...over },
  };
}

/** The agent's own post on X, as its action row keeps it. */
const ownPost = (w: TestWorld, id = 'own-post-000001', result: Record<string, unknown> = { postId: OWN_POST }) => actionRow(w, id, { tool: 'publish_post', input: { text: 'A post of the agent\'s own.' } }, { createdAt: new Date(w.ctx.now() - 3 * HOUR), result: { actionId: id, tool: 'publish_post', status: 'completed', result } });
/** A reply the agent already gave outside the verified audience today. */
const openReplyRow = (w: TestWorld, i: number, over: Record<string, unknown> = {}) => actionRow(w, `open-reply-${String(i).padStart(5, '0')}`, { tool: 'publish_reply', input: { postId: String(8000 + i), text: `an answer ${i}` } }, { createdAt: new Date(w.ctx.now() - (i + 1) * 60_000), result: { actionId: `open-reply-${i}`, tool: 'publish_reply', status: 'completed', result: { postId: String(9500 + i), openReply: true } }, ...over });

async function world(opts: { config?: Record<string, string>; agent?: Record<string, unknown>; script?: Response[] } = {}) {
  const w = await makeWorld({ ...(opts.config ? { config: opts.config } : {}), ...(opts.script ? { script: opts.script } : {}) });
  // not due for a post of its own: a turn here is about the mention
  const agent = await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * 60_000).toISOString(), ...(opts.agent ?? {}) } });
  const config = agentConfigOf(agent)!;
  const views = async (items: SenderInboxItem[]) => inboxViews(config, items, w.ctx.now(), await agentDirectory(w.ctx, { fresh: true }));
  return { w, agent, config, views };
}

describe('replyAudience: verified (the default)', () => {
  it('an unverified reply under the agent\'s own post is not answered, and is closed unanswered like any other', async () => {
    const { w, config, views } = await world();
    try {
      await ownPost(w);
      const item = under('8101', '4300');
      const [view] = await views([item]);
      expect(view).toMatchObject({ eligible: false, reason: 'verified_audience_required' });
      expect(view).not.toHaveProperty('openReply');
      // the coin keeps none of its own posts in view for this: its entry is there for questions alone
      expect((await agentDirectory(w.ctx)).openReplies.get(AGENT_ID)).toEqual({ ownPostIds: new Set(), questions: true, left: 10 });
      expect(autoClosable(config, item, view!)).toBe(true);
      expect(replyAudienceOf({}, 'verified')).toBe('verified');
      expect(replyAudienceOf({ replyAudience: 'everyone' }, undefined)).toBe('verified');
    } finally {
      await w.close();
    }
  });
});

describe('replyAudience: own_threads', () => {
  it('a direct reply under one of the agent\'s own posts is eligible from anybody; anything else from an unverified account is not', async () => {
    const { w, config, views } = await world({ agent: { replyAudience: 'own_threads' } });
    try {
      await ownPost(w);
      // a thread's later parts are the agent's own posts too
      await ownPost(w, 'own-post-000002', { postId: '9010', parts: [{ n: 1, postId: '9010' }, { n: 2, postId: '9011' }], sent: 2, of: 2 });
      const direct = under('8101', '4300');
      const underPart = under('8102', '4301', { referencedPosts: [{ type: 'replied_to', id: '9011' }] });
      const mention = under('8103', '4302', { inReplyToUserId: null, referencedPosts: [] });
      const elsewhere = under('8104', '4303', { referencedPosts: [{ type: 'replied_to', id: '5555' }] });
      const toOther = under('8105', '4304', { inReplyToUserId: '777' });
      const all = await views([direct, underPart, mention, elsewhere, toOther]);
      expect(all.map((v) => [v.postId, v.eligible, v.openReply ?? false, v.reason ?? null])).toEqual([
        ['8101', true, true, null],
        ['8102', true, true, null],
        ['8103', false, false, 'verified_audience_required'],
        ['8104', false, false, 'verified_audience_required'],
        ['8105', false, false, 'verified_audience_required'],
      ]);
      // the pass that closes unverified mentions leaves the ones this audience answers
      expect([direct, underPart, mention].map((item, i) => autoClosable(config, item, all[i]!))).toEqual([false, false, true]);
      // a verified account needs no such way in and is not counted as one
      const verified = under('8106', '4305', { author: { id: '4305', username: 'user4305', verified: true, verifiedType: 'blue' } });
      expect((await views([verified]))[0]).not.toHaveProperty('openReply');
      expect(replyAudienceOf({ replyAudience: 'own_threads' }, 'verified')).toBe('own_threads');
    } finally {
      await w.close();
    }
  });

  it('a hosted turn answers it, and the answer is counted as one outside the verified audience', async () => {
    const script = [toolCallResponse('publish_reply', { postId: '8101', text: 'It is fixed at launch and shown on the coin page.' }), finishResponse(T0 + 3 * HOUR)];
    const { w } = await world({ agent: { replyAudience: 'own_threads' }, script });
    try {
      await ownPost(w);
      w.sender.items = [under('8101', '4300')];
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect(r.ran).toEqual([AGENT_ID]);
      expect(w.sender.published).toMatchObject([{ replyTo: '8101', replyEligibility: { eligible: true }, text: 'It is fixed at launch and shown on the coin page.' }]);
      const [reply] = (await w.db.select().from(actions)).filter((a) => (a.action as { tool?: string }).tool === 'publish_reply');
      expect((reply!.result as { result: Record<string, unknown> }).result).toMatchObject({ openReply: true, replyAuthorId: '4300' });
      expect(await openRepliesInWindow(w.ctx, AGENT_ID, w.ctx.now())).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('ten a day: past the count an unverified reply is what it was before, at the view and again at the publish', async () => {
    const { w, agent, config, views } = await world({ agent: { replyAudience: 'own_threads' } });
    try {
      await ownPost(w);
      for (let i = 0; i < 8; i++) await openReplyRow(w, i);
      // room for two more: the first two of an inbox, in order
      const items = [under('8101', '4300'), under('8102', '4301'), under('8103', '4302')];
      expect((await views(items)).map((v) => [v.eligible, v.reason ?? null])).toEqual([[true, null], [true, null], [false, 'verified_audience_required']]);
      expect((await agentDirectory(w.ctx)).openReplies.get(AGENT_ID)!.left).toBe(2);

      // the decision taken when a mention was observed says eligible; by the time it is answered the day is full
      const env = brokerEnv([items[0]!]);
      env.eligibility.set('8101', { eligible: true });
      await openReplyRow(w, 8);
      await openReplyRow(w, 9);
      const late = await executeAction(w.ctx, agent, config, pendingOf('act-open-0000001', 'publish_reply', { postId: '8101', text: 'A late answer.' }), env);
      expect(late).toEqual({ kind: 'failed', error: 'sender_rejected:policy:reply_not_eligible:verified_audience_required' });
      expect(w.sender.published).toMatchObject([{ replyTo: '8101', replyEligibility: { eligible: false, reason: 'verified_audience_required' } }]);
      expect((await views(items)).every((v) => !v.eligible)).toBe(true);

      // a failed one never counted, and yesterday's no longer do
      await w.db.update(actions).set({ status: 'failed' }).where(eq(actions.actionId, 'open-reply-00009'));
      await w.db.update(actions).set({ createdAt: new Date(w.ctx.now() - 25 * HOUR) }).where(eq(actions.actionId, 'open-reply-00008'));
      expect(await openRepliesInWindow(w.ctx, AGENT_ID, w.ctx.now())).toBe(8);
      // the directory is read again (it is kept for a minute; until then the stricter of the two counts holds)
      expect((await views(items)).filter((v) => v.eligible)).toHaveLength(2);
      const fine = await executeAction(w.ctx, agent, config, pendingOf('act-open-0000002', 'publish_reply', { postId: '8101', text: 'An answer in time.' }), env);
      expect(fine).toMatchObject({ kind: 'completed', result: { openReply: true } });
      // a reply to a verified account is not counted against it
      const verified = under('8106', '4305', { author: { id: '4305', username: 'user4305', verified: true, verifiedType: 'blue' } });
      const plain = await executeAction(w.ctx, agent, config, pendingOf('act-open-0000003', 'publish_reply', { postId: '8106', text: 'An answer to a verified account.' }), brokerEnv([verified]));
      expect(plain.kind).toBe('completed');
      expect((plain as { result: Record<string, unknown> }).result).not.toHaveProperty('openReply');
    } finally {
      await w.close();
    }
  });

  it('a reply queued for review is held to the same count and carries the mark', async () => {
    const { w, agent } = await world({ agent: { replyAudience: 'own_threads', requireApproval: true } });
    try {
      await ownPost(w);
      const item = under('8101', '4300');
      const queued = await queueForApproval(w.ctx, agent, pendingOf('act-open-0000010', 'publish_reply', { postId: '8101', text: 'An answer for review.' }), brokerEnv([item]));
      expect(queued).toMatchObject({ kind: 'completed', result: { queued: true, openReply: true } });
      expect((await w.db.select().from(approvals))[0]!.meta).toMatchObject({ openReply: true, replyEligibility: { eligible: true } });
    } finally {
      await w.close();
    }
  });

  it('the deployment\'s default applies to a coin that set none, a coin\'s own setting wins, and a count of 0 switches it off', async () => {
    const byDefault = await world({ config: { REPLY_AUDIENCE_DEFAULT: 'own_threads' } });
    try {
      await ownPost(byDefault.w);
      expect((await byDefault.views([under('8101', '4300')]))[0]).toMatchObject({ eligible: true, openReply: true });
    } finally {
      await byDefault.w.close();
    }
    const optedBack = await world({ config: { REPLY_AUDIENCE_DEFAULT: 'own_threads' }, agent: { replyAudience: 'verified' } });
    try {
      await ownPost(optedBack.w);
      expect((await optedBack.views([under('8101', '4300')]))[0]).toMatchObject({ eligible: false, reason: 'verified_audience_required' });
    } finally {
      await optedBack.w.close();
    }
    const off = await world({ config: { OPEN_REPLIES_PER_DAY: '0' }, agent: { replyAudience: 'own_threads' } });
    try {
      await ownPost(off.w);
      expect((await off.views([under('8101', '4300')]))[0]).toMatchObject({ eligible: false, reason: 'verified_audience_required' });
      expect((await agentDirectory(off.w.ctx)).openReplies.size).toBe(0);
    } finally {
      await off.w.close();
    }
  });
});
