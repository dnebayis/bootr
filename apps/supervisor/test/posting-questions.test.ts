/**
 * Questions from anyone (the owner's decision of 2026-11-13, `REPLY_QUESTIONS_FROM_ANYONE`): a verified account is
 * answered as before, whatever it writes; an account without a verified badge is answered when it wrote to the agent
 * and asks a question in that post. All in code: the day's one count of replies outside the verified audience
 * (`OPEN_REPLIES_PER_DAY`, shared with the reply audience `own_threads`), the same number as a bound on the turns
 * such mentions may wake an agent for, the author's stop, the agent-to-agent caps for another Bootr agent, and the
 * setting switched off, which is the behaviour before this round.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { replyAudienceOf, replyDefaults } from '../src/agent-config.js';
import { AGENT_REPLY_CAP, OPEN_WAKE_CAP_REASON, agentDirectory, openRepliesInWindow, openWakeBound, recordOpenWake, wakeViews } from '../src/agent-directory.js';
import { queueForApproval } from '../src/approvals.js';
import { executeAction, inboxViews, openRepliesMeaning } from '../src/broker/index.js';
import { actions, approvals, runtimes } from '../src/db/schema.js';
import { autoClosable } from '../src/mention-close.js';
import { agentConfigOf } from '../src/onboarding.js';
import type { AgentState } from '../src/runtime.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import type { ActResult, DueView } from '@bootr/shared/own-agent';
import { OTHER_AGENT_ID, act, connectClient, finishInput, openSocial, ownWorld, patchState, quietRuntime, seedOther, seedOwn, withRoutes } from './own-helpers.js';
import { HOUR, T0, actionRow, brokerEnv, pendingOf } from './posting-helpers.js';

const MINUTE = 60_000;
const QUESTION = '@bootr_agent how does the fee split work?';
const STATEMENT = '@bootr_agent nice coin, good luck';
type Badge = 'blue' | 'business' | 'government' | 'none';

/** Somebody mentioning the agent in a post of their own; no verified badge unless `badge` says so. */
function mention(postId: string, authorId: string, text: string = QUESTION, badge: Badge | null = null, over: Partial<SenderInboxItem['post']> = {}): SenderInboxItem {
  const author = badge && badge !== 'none' ? { id: authorId, username: `user${authorId}`, verified: true, verifiedType: badge } : { id: authorId, username: `user${authorId}`, verified: false };
  return {
    postId,
    authorId,
    conversationId: postId,
    status: 'pending',
    observedAt: new Date(T0 - MINUTE).toISOString(),
    seenAt: null,
    deferredUntil: null,
    post: { id: postId, authorId, text, createdAt: new Date(T0 - 2 * MINUTE).toISOString(), conversationId: postId, author, ...over },
  };
}

/** A reply the agent already gave outside the verified audience today. */
const openReplyRow = (w: TestWorld, i: number) =>
  actionRow(w, `open-reply-${String(i).padStart(5, '0')}`, { tool: 'publish_reply', input: { postId: String(7000 + i), text: `an answer ${i}` } }, { createdAt: new Date(w.ctx.now() - (i + 1) * MINUTE), result: { actionId: `open-reply-${i}`, tool: 'publish_reply', status: 'completed', result: { postId: String(9500 + i), openReply: true } } });

/** A coin whose post is not due and whose next wake is hours away: a turn here is about a mention or it does not happen. */
async function world(opts: { config?: Record<string, string>; agent?: Record<string, unknown>; script?: Response[] } = {}) {
  const w = await makeWorld({ ...(opts.config ? { config: opts.config } : {}), ...(opts.script ? { script: opts.script } : {}) });
  const agent = await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * MINUTE).toISOString(), ...(opts.agent ?? {}) }, runtime: { nextAt: new Date(w.ctx.now() + 6 * HOUR) } });
  const config = agentConfigOf(agent)!;
  const views = async (items: SenderInboxItem[]) => inboxViews(config, items, w.ctx.now(), await agentDirectory(w.ctx, { fresh: true }));
  return { w, agent, config, views };
}

/** A turn's first observation, as far as these tests read it. */
type Observation = Record<string, unknown> & { social: { messages: Record<string, unknown>[] }; openReplies?: unknown };
/** How often the model was asked for a thought. */
const thoughts = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
/** The first observation of the turn that made the `n`th model call. */
function observationOf(w: TestWorld, n = 0): Observation {
  const call = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))[n]!;
  const user = (call.body as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === 'user')!;
  return JSON.parse(user.content) as Observation;
}
const stateOf = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.state as unknown as AgentState;

describe('who gets a reply by default: verified accounts, plus anyone who asks', () => {
  it('a verified account is answered with or without a question, is not marked and is not counted; only blue and business are that badge', async () => {
    const { w, agent, config, views } = await world();
    try {
      const all = await views([mention('8101', '4300', QUESTION, 'blue'), mention('8102', '4301', STATEMENT, 'blue'), mention('8103', '4302', STATEMENT, 'business'), mention('8104', '4303', STATEMENT, 'government'), mention('8105', '4304', QUESTION, 'government')]);
      expect(all.map((v) => [v.postId, v.eligible, v.openReply ?? false, v.eligibleBecause ?? null, v.reason ?? null])).toEqual([
        ['8101', true, false, null, null],
        ['8102', true, false, null, null],
        ['8103', true, false, null, null],
        // a government badge is not the blue tick: it is answered like anyone, when it asks
        ['8104', false, false, null, 'verified_audience_required'],
        ['8105', true, true, 'asked_a_question', null],
      ]);
      // the day's count of replies outside the verified audience is used up: a verified account is still answered
      for (let i = 0; i < 10; i++) await openReplyRow(w, i);
      const item = mention('8106', '4305', STATEMENT, 'blue');
      expect((await views([item]))[0]).toMatchObject({ eligible: true });
      const sent = await executeAction(w.ctx, agent, config, pendingOf('act-q-verified-01', 'publish_reply', { postId: '8106', text: 'Thank you.' }), brokerEnv([item]));
      expect(sent.kind).toBe('completed');
      expect((sent as { result: Record<string, unknown> }).result).not.toHaveProperty('openReply');
      expect(await openRepliesInWindow(w.ctx, AGENT_ID, w.ctx.now())).toBe(10);
    } finally {
      await w.close();
    }
  });

  it('an unverified account that asks is eligible and marked; one that states something is closed unanswered as before', async () => {
    const { w, config, views } = await world();
    try {
      const question = mention('8101', '4300');
      const statement = mention('8102', '4301', STATEMENT);
      const underOwnPost = mention('8103', '4302', '@bootr_agent and where do I find the contract?', null, { inReplyToUserId: '1000', referencedPosts: [{ type: 'replied_to', id: '9001' }] });
      const all = await views([question, statement, underOwnPost]);
      expect(all.map((v) => [v.postId, v.eligible, v.openReply ?? false, v.eligibleBecause ?? null, v.reason ?? null])).toEqual([
        ['8101', true, true, 'asked_a_question', null],
        ['8102', false, false, null, 'verified_audience_required'],
        ['8103', true, true, 'asked_a_question', null],
      ]);
      // the pass that closes unverified mentions before a turn leaves the questions and takes the statement
      expect([question, statement, underOwnPost].map((item, i) => autoClosable(config, item, all[i]!))).toEqual([false, true, false]);
      // every coin has the day's count in the directory, on the verified audience too
      expect((await agentDirectory(w.ctx)).openReplies.get(AGENT_ID)).toMatchObject({ questions: true, left: 10 });
    } finally {
      await w.close();
    }
  });

  it('a hosted turn is woken by the question, is told why it may answer, answers it, and the answer is counted', async () => {
    const script = [toolCallResponse('publish_reply', { postId: '8101', text: 'It is fixed at launch and shown on the coin page.' }), finishResponse(T0 + 6 * HOUR)];
    const { w } = await world({ script });
    try {
      w.sender.items = [mention('8101', '4300'), mention('8102', '4301', STATEMENT)];
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect(r.ran).toEqual([AGENT_ID]);
      const observation = observationOf(w);
      // the statement was closed before the turn; the question is shown with the reason it is answerable
      expect(observation.social.messages).toMatchObject([{ postId: '8101', verified: false, eligibleBecause: 'asked_a_question' }]);
      expect(observation.openReplies).toEqual({ meaning: openRepliesMeaning(10), leftToday: 10 });
      expect(w.sender.published).toMatchObject([{ replyTo: '8101', replyEligibility: { eligible: true }, replyAuthorId: '4300' }]);
      const [reply] = (await w.db.select().from(actions)).filter((a) => (a.action as { tool?: string }).tool === 'publish_reply');
      expect((reply!.result as { result: Record<string, unknown> }).result).toMatchObject({ openReply: true, replyAuthorId: '4300' });
      expect(await openRepliesInWindow(w.ctx, AGENT_ID, w.ctx.now())).toBe(1);
      // the turn was bought by a mention from outside the verified audience: counted once
      expect((await stateOf(w)).openWakes).toEqual([T0]);
    } finally {
      await w.close();
    }
  });

  it('an unverified statement wakes nobody and buys no thought', async () => {
    const { w } = await world();
    try {
      w.sender.items = [mention('8102', '4301', STATEMENT), mention('8103', '4302', '@bootr_agent gm')];
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect(r.ran).toEqual([]);
      expect(thoughts(w)).toBe(0);
      expect(w.sender.published).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('a question hidden in a link, or behind characters nobody sees, is not a question', async () => {
    const { w, views } = await world();
    try {
      const hidden = [
        '@bootr_agent look at https://example.com/page?ref=1',
        '@bootr_agent look at example.com/page?ref=1',
        '@bootr_agent look at ht​tps://example.com/page?ref=1',
        '@bootr_agent ​​​?',
        '@bootr_agent ㅤㅤㅤ?',
        '@bootr_agent ?',
        '@bootr_agent?',
      ].map((text, i) => mention(String(8200 + i), String(4400 + i), text));
      expect((await views(hidden)).map((v) => [v.eligible, v.reason])).toEqual(hidden.map(() => [false, 'verified_audience_required']));
      w.sender.items = hidden;
      const r = await tick(w.ctx);
      expect(r.ran).toEqual([]);
      expect(thoughts(w)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('an author who said stop is not answered, and neither is one on the creator\'s blocked list', async () => {
    const { w, views } = await world({ agent: { blockedAuthorIds: ['4301'] } });
    try {
      const all = await views([mention('8101', '4300', '@bootr_agent stop replying to me?'), mention('8102', '4301'), mention('8103', '4302', '@bootr_agent leave me alone')]);
      expect(all.map((v) => [v.eligible, v.reason])).toEqual([
        [false, 'consent_stop'],
        [false, 'owner_blocked'],
        [false, 'consent_stop'],
      ]);
      w.sender.items = [mention('8101', '4300', '@bootr_agent stop replying to me?'), mention('8102', '4301')];
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect(thoughts(w)).toBe(0);
    } finally {
      await w.close();
    }
  });
});

describe('the day\'s count: ten replies outside the verified audience, questions and own-thread replies together', () => {
  it('past the count a question is what it was before: not eligible, closed unanswered, at the view and again at the publish', async () => {
    const { w, agent, config, views } = await world();
    try {
      for (let i = 0; i < 8; i++) await openReplyRow(w, i);
      // room for two more: the first two of an inbox, in order
      const items = [mention('8101', '4300'), mention('8102', '4301'), mention('8103', '4302')];
      const all = await views(items);
      expect(all.map((v) => [v.eligible, v.reason ?? null])).toEqual([[true, null], [true, null], [false, 'verified_audience_required']]);
      expect(autoClosable(config, items[2]!, all[2]!)).toBe(true);
      expect((await agentDirectory(w.ctx)).openReplies.get(AGENT_ID)!.left).toBe(2);

      // the decision taken when the mention was observed says eligible; by the time it is answered the day is full
      const env = brokerEnv([items[0]!]);
      env.eligibility.set('8101', { eligible: true });
      await openReplyRow(w, 8);
      await openReplyRow(w, 9);
      const late = await executeAction(w.ctx, agent, config, pendingOf('act-q-late-000001', 'publish_reply', { postId: '8101', text: 'A late answer.' }), env);
      expect(late).toEqual({ kind: 'failed', error: 'sender_rejected:policy:reply_not_eligible:verified_audience_required' });
      expect((await views(items)).every((v) => !v.eligible)).toBe(true);
      // nothing waits for a full day: no turn is bought
      w.sender.items = items;
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect(thoughts(w)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('the count is one: replies under the agent\'s own posts (own_threads) and answered questions use the same ten', async () => {
    const { w, views } = await world({ agent: { replyAudience: 'own_threads' } });
    try {
      await actionRow(w, 'own-post-000001', { tool: 'publish_post', input: { text: 'A post of the agent\'s own.' } }, { createdAt: new Date(w.ctx.now() - 3 * HOUR), result: { actionId: 'own-post-000001', tool: 'publish_post', status: 'completed', result: { postId: '9001' } } });
      for (let i = 0; i < 9; i++) await openReplyRow(w, i);
      const under = mention('8101', '4300', '@bootr_agent thanks for this', null, { inReplyToUserId: '1000', referencedPosts: [{ type: 'replied_to', id: '9001' }] });
      const question = mention('8102', '4301');
      // one left: the statement under the agent's own post takes it, the question after it finds the day full
      expect((await views([under, question])).map((v) => [v.eligible, v.eligibleBecause ?? null, v.reason ?? null])).toEqual([
        [true, 'replied_under_your_post', null],
        [false, null, 'verified_audience_required'],
      ]);
      expect((await views([question, under])).map((v) => [v.eligible, v.eligibleBecause ?? null])).toEqual([
        [true, 'asked_a_question'],
        [false, null],
      ]);
    } finally {
      await w.close();
    }
  });

  it('a question answered through the review queue is held to the same count and carries the mark', async () => {
    const { w, agent } = await world({ agent: { requireApproval: true } });
    try {
      const item = mention('8101', '4300');
      const queued = await queueForApproval(w.ctx, agent, pendingOf('act-q-review-0001', 'publish_reply', { postId: '8101', text: 'An answer for review.' }), brokerEnv([item]));
      expect(queued).toMatchObject({ kind: 'completed', result: { queued: true, openReply: true } });
      expect((await w.db.select().from(approvals))[0]!.meta).toMatchObject({ openReply: true, replyEligibility: { eligible: true } });
      // the step's row keeps the queue's result, as the runtime stores it: a reply that waits for review is counted from then on
      expect(await openRepliesInWindow(w.ctx, AGENT_ID, w.ctx.now())).toBe(0);
      await actionRow(w, 'act-q-review-0001', { tool: 'publish_reply', input: { postId: '8101', text: 'An answer for review.' } }, { result: { actionId: 'act-q-review-0001', tool: 'publish_reply', status: 'completed', result: (queued as { result: Record<string, unknown> }).result } });
      expect(await openRepliesInWindow(w.ctx, AGENT_ID, w.ctx.now())).toBe(1);
    } finally {
      await w.close();
    }
  });
});

describe('strangers cannot make a coin buy thoughts without bound', () => {
  it('ten turns a day at most are bought by mentions from outside the verified audience, answered or not', async () => {
    const script: Response[] = [];
    const { w } = await world({ script });
    try {
      let at = T0;
      const ran: number[] = [];
      // a new stranger asks every twenty minutes, and the model closes each one without answering: nothing is ever counted as a reply
      for (let i = 0; i < 13; i++) {
        const postId = String(8100 + i);
        w.sender.items = [mention(postId, String(4300 + i))];
        script.length = 0;
        script.push(toolCallResponse('resolve_mention', { postId, outcome: 'skip', reason: 'nothing to add' }), finishResponse(at + 12 * HOUR));
        const r = await tick(w.ctx);
        expect(r.errors).toEqual([]);
        if (r.ran.length) ran.push(i);
        at += 20 * MINUTE;
        w.setNow(at);
      }
      expect(ran).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(thoughts(w)).toBe(20);
      expect(await openRepliesInWindow(w.ctx, AGENT_ID, w.ctx.now())).toBe(0);
      expect((await stateOf(w)).openWakes).toHaveLength(10);

      // the questions that came after wait: a turn that runs for another reason still sees them, at no extra turn
      w.sender.items = [mention('8190', '4390'), mention('8191', '4391', STATEMENT, 'blue')];
      script.length = 0;
      script.push(finishResponse(at + 12 * HOUR));
      const r = await tick(w.ctx);
      expect(r.ran).toEqual([AGENT_ID]);
      expect(observationOf(w, 20).social.messages).toMatchObject([{ postId: '8191', verified: true }, { postId: '8190', eligibleBecause: 'asked_a_question' }]);
      // a turn a verified account's mention started is not one a stranger bought
      expect((await stateOf(w)).openWakes).toHaveLength(10);

      // a day later the count has room again
      at += 25 * HOUR;
      w.setNow(at);
      w.sender.items = [mention('8195', '4395')];
      script.length = 0;
      script.push(toolCallResponse('resolve_mention', { postId: '8195', outcome: 'skip', reason: 'nothing to add' }), finishResponse(at + 12 * HOUR));
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
    } finally {
      await w.close();
    }
  });

  it('wakeViews and recordOpenWake: the bound, its window, and what counts as a bought turn', () => {
    const directory = { at: T0, entries: [], byUserId: new Map(), byHandle: new Map(), openReplies: new Map() };
    const open = { authorId: '4300', eligible: true, openReply: true };
    const verified = { authorId: '4301', eligible: true };
    const full = Array.from({ length: 10 }, (_, i) => T0 - i * MINUTE);
    expect(wakeViews([open, verified], directory, AGENT_ID, null, T0, { wakes: full.slice(1), limit: 10 })).toEqual([open, verified]);
    expect(wakeViews([open, verified], directory, AGENT_ID, null, T0, { wakes: full, limit: 10 })).toEqual([{ ...open, eligible: false, reason: OPEN_WAKE_CAP_REASON }, verified]);
    // wakes older than a day no longer count, and without a bound nothing changes
    expect(wakeViews([open], directory, AGENT_ID, null, T0 + 24 * HOUR, { wakes: full, limit: 10 })).toEqual([open]);
    expect(wakeViews([open], directory, AGENT_ID, null, T0)).toEqual([open]);
    expect(recordOpenWake([open], full.slice(2), T0)).toEqual({ wakes: [...full.slice(2), T0], counted: true });
    expect(recordOpenWake([open, verified], [], T0)).toEqual({ wakes: [], counted: false });
    expect(recordOpenWake([{ ...open, eligible: false }], [T0 - 25 * HOUR, T0 - HOUR], T0)).toEqual({ wakes: [T0 - HOUR], counted: false });
    expect(openWakeBound({ config: { OPEN_REPLIES_PER_DAY: 10 } } as never, { openWakes: [1, 2] })).toEqual({ wakes: [1, 2], limit: 10 });
  });
});

describe('another Bootr agent that asks', () => {
  it('is answered as a Bootr agent, inside the agent-to-agent caps, and never through the question audience', async () => {
    const { w, agent, config, views } = await world();
    try {
      await seedOther(w, { config: { xHandle: 'other_agent', xUserId: '2000', token: { address: '0x3000000000000000000000000000000000000008', symbol: 'OTHR', name: 'Other Coin', chainId: 84532 } } });
      const item = mention('8101', '2000', '@bootr_agent what are you building?', null, { conversationId: '7700' });
      item.conversationId = '7700';
      const [view] = await views([item]);
      expect(view).toMatchObject({ eligible: true, bootrAgent: { handle: 'other_agent' } });
      expect(view).not.toHaveProperty('openReply');
      expect(view).not.toHaveProperty('eligibleBecause');
      // the thread already holds the most answers one Bootr agent gives another: the cap refuses, question or not
      for (let i = 0; i < AGENT_REPLY_CAP; i++) {
        await actionRow(w, `peer-reply-00000${i}`, { tool: 'publish_reply', input: { postId: String(7600 + i), text: `answer ${i}` } }, { createdAt: new Date(w.ctx.now() - (i + 1) * MINUTE), result: { actionId: `peer-reply-00000${i}`, tool: 'publish_reply', status: 'completed', result: { postId: String(9700 + i), replyAuthorId: '2000', conversationId: '7700' } } });
      }
      const capped = await executeAction(w.ctx, agent, config, pendingOf('act-q-peer-000001', 'publish_reply', { postId: '8101', text: 'One more answer.' }), brokerEnv([item]));
      expect(capped.kind).toBe('failed');
      expect((capped as { error: string }).error).toMatch(/^bootr_agent_/);
      expect(w.sender.published).toEqual([]);
      // and no reply to a Bootr agent is counted against the strangers' ten
      expect(await openRepliesInWindow(w.ctx, AGENT_ID, w.ctx.now())).toBe(0);
      expect(OTHER_AGENT_ID).toBe('8');
    } finally {
      await w.close();
    }
  });
});

describe('an own agent: the same rule through the run routes', () => {
  async function ownCoin(config: Record<string, string> = {}) {
    const w = await ownWorld({ config });
    const quiet = quietRuntime(w.ctx.now());
    await seedOwn(w, { config: quiet.config, runtime: quiet.runtime });
    const { credential } = await connectClient(w);
    const due = async () => (await w.run<DueView>('due', credential)).body.social;
    return { w, credential, due };
  }

  it('a question from an account without a badge makes the social role due, is shown with the reason, is answered once and counted; a statement makes nothing due', async () => {
    const { w, credential, due } = await ownCoin();
    try {
      w.sender.items = [mention('8102', '4301', STATEMENT)];
      expect(await due()).toMatchObject({ due: false });
      w.sender.items = [mention('8101', '4300'), mention('8102', '4301', STATEMENT)];
      expect(await due()).toMatchObject({ due: true, reasons: ['pending_mention'] });
      const turn = await openSocial(w, credential);
      expect(turn.reasons).toEqual(['pending_mention']);
      const observation = turn.observation as Observation;
      expect(observation.social.messages).toMatchObject([{ postId: '8101', verified: false, eligibleBecause: 'asked_a_question' }]);
      expect(observation.openReplies).toEqual({ meaning: openRepliesMeaning(10), leftToday: 10 });
      const reply = await act(w, credential, turn.turnId, 'publish_reply', { postId: '8101', text: 'It is fixed at launch and shown on the coin page.' });
      expect(reply.body).toMatchObject({ status: 'completed', result: { openReply: true, replyAuthorId: '4300' } });
      // one reply per mention, and the statement is nobody's to answer
      expect((await act(w, credential, turn.turnId, 'publish_reply', { postId: '8101', text: 'And one more thing.' })).body.status).toBe('failed');
      const tried = await act(w, credential, turn.turnId, 'publish_reply', { postId: '8102', text: 'Thanks.' });
      expect(tried.body.status).toBe('failed');
      // the sender was handed the statement's reply marked as not to be answered, and refused it; only the answer went out
      expect(w.sender.published).toMatchObject([{ replyTo: '8101', replyEligibility: { eligible: true } }, { replyTo: '8102', replyEligibility: { eligible: false } }]);
      await w.run<ActResult>('finish', credential, { turnId: turn.turnId, ...finishInput(w) });
      expect(await openRepliesInWindow(w.ctx, AGENT_ID, w.ctx.now())).toBe(1);
      expect((await stateOf(w)).openWakes).toEqual([T0]);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('the day\'s ten turns for such mentions hold for an own agent too, and the setting off makes a question nothing', async () => {
    const { w, due } = await ownCoin();
    try {
      await patchState(w, { openWakes: Array.from({ length: 10 }, (_, i) => T0 - (i + 1) * MINUTE) });
      w.sender.items = [mention('8101', '4300')];
      expect(await due()).toMatchObject({ due: false });
      // a verified account still makes it due
      w.sender.items = [mention('8101', '4300'), mention('8103', '4302', STATEMENT, 'blue')];
      expect(await due()).toMatchObject({ due: true, reasons: ['pending_mention'] });
    } finally {
      await w.close();
    }
    const off = await ownCoin({ REPLY_QUESTIONS_FROM_ANYONE: 'false' });
    try {
      off.w.sender.items = [mention('8101', '4300')];
      expect(await off.due()).toMatchObject({ due: false });
    } finally {
      await off.w.close();
    }
  });
});

describe('REPLY_QUESTIONS_FROM_ANYONE=false: the verified audience alone, as before this round', () => {
  it('an unverified question is not eligible, is closed unanswered, wakes nobody, and nothing is read for the count', async () => {
    const { w, agent, config, views } = await world({ config: { REPLY_QUESTIONS_FROM_ANYONE: 'false' } });
    try {
      const question = mention('8101', '4300');
      const [view] = await views([question]);
      expect(view).toEqual({ postId: '8101', authorId: '4300', conversationId: '8101', eligible: false, reason: 'verified_audience_required', post: question.post, observedAt: question.observedAt });
      expect(autoClosable(config, question, view!)).toBe(true);
      expect((await agentDirectory(w.ctx)).openReplies.size).toBe(0);
      w.sender.items = [question];
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect(thoughts(w)).toBe(0);
      // a reply the model tries anyway is refused by the sender's own check of the decision
      const tried = await executeAction(w.ctx, agent, config, pendingOf('act-q-off-0000001', 'publish_reply', { postId: '8101', text: 'An answer nobody may give.' }), brokerEnv([question]));
      expect(tried).toEqual({ kind: 'failed', error: 'sender_rejected:policy:reply_not_eligible:verified_audience_required' });
    } finally {
      await w.close();
    }
  });

  it('a verified account\'s turn is what it was: no mark on its message and no note in the observation', async () => {
    const off = await world({ config: { REPLY_QUESTIONS_FROM_ANYONE: 'false' }, script: [finishResponse(T0 + 6 * HOUR)] });
    const on = await world({ script: [finishResponse(T0 + 6 * HOUR)] });
    try {
      for (const { w } of [off, on]) {
        w.sender.items = [mention('8101', '4300', QUESTION, 'blue')];
        expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      }
      // with nobody from outside the verified audience in the inbox, the observation is the same with the setting on or off
      expect(observationOf(on.w)).toEqual(observationOf(off.w));
      expect(observationOf(off.w)).not.toHaveProperty('openReplies');
      expect(observationOf(off.w).social.messages[0]).not.toHaveProperty('eligibleBecause');
      expect((await stateOf(on.w)).openWakes ?? []).toEqual([]);
    } finally {
      await off.w.close();
      await on.w.close();
    }
  });

  it('own_threads still works as built with the setting off, and the count at 0 switches both off', async () => {
    const own = await world({ config: { REPLY_QUESTIONS_FROM_ANYONE: 'false' }, agent: { replyAudience: 'own_threads' } });
    try {
      await actionRow(own.w, 'own-post-000001', { tool: 'publish_post', input: { text: 'A post of the agent\'s own.' } }, { createdAt: new Date(own.w.ctx.now() - 3 * HOUR), result: { actionId: 'own-post-000001', tool: 'publish_post', status: 'completed', result: { postId: '9001' } } });
      const under = mention('8101', '4300', STATEMENT, null, { inReplyToUserId: '1000', referencedPosts: [{ type: 'replied_to', id: '9001' }] });
      expect((await own.views([under, mention('8102', '4301')])).map((v) => [v.eligible, v.eligibleBecause ?? null, v.reason ?? null])).toEqual([
        [true, 'replied_under_your_post', null],
        [false, null, 'verified_audience_required'],
      ]);
      expect((await agentDirectory(own.w.ctx)).openReplies.get(AGENT_ID)).toMatchObject({ questions: false });
    } finally {
      await own.w.close();
    }
    const zero = await world({ config: { OPEN_REPLIES_PER_DAY: '0' } });
    try {
      expect((await zero.views([mention('8101', '4300')]))[0]).toMatchObject({ eligible: false, reason: 'verified_audience_required' });
      expect((await agentDirectory(zero.w.ctx)).openReplies.size).toBe(0);
      expect(replyDefaults(zero.w.ctx)).toEqual({ audience: 'verified', questionsFromAnyone: false, perDay: 0 });
    } finally {
      await zero.w.close();
    }
  });
});

describe('the config view says what is in force', () => {
  const PATH = `/internal/agents/${AGENT_ID}/config`;
  type View = { replyAudience: string; openReplies: { questionsFromAnyone: boolean; perDay: number }; revision: number };

  it('a coin that chose no audience shows the deployment\'s default, and what the deployment adds to it', async () => {
    const byDefault = await world();
    try {
      const api = withRoutes(byDefault.w);
      const view = (await api.call<View>('GET', PATH)).body;
      expect(view).toMatchObject({ replyAudience: 'verified', openReplies: { questionsFromAnyone: true, perDay: 10 } });
    } finally {
      await byDefault.w.close();
    }
    const widened = await world({ config: { REPLY_AUDIENCE_DEFAULT: 'own_threads', REPLY_QUESTIONS_FROM_ANYONE: 'false', OPEN_REPLIES_PER_DAY: '6' } });
    try {
      const api = withRoutes(widened.w);
      expect((await api.call<View>('GET', PATH)).body).toMatchObject({ replyAudience: 'own_threads', openReplies: { questionsFromAnyone: false, perDay: 6 } });
      // the creator picks the other one than the console showed: it is stored, although it is what a coin without a choice had before
      const put = await api.raw<View>('PUT' as never, PATH, JSON.stringify({ by: CREATOR, replyAudience: 'verified' }));
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ replyAudience: 'verified', openReplies: { questionsFromAnyone: false, perDay: 6 } });
      const stored = (await widened.w.db.query.agents.findFirst())!.config;
      expect(stored.replyAudience).toBe('verified');
      expect((await api.call<View>('GET', PATH)).body.replyAudience).toBe('verified');
      // picking what is already in force changes nothing
      expect((await api.raw('PUT' as never, PATH, JSON.stringify({ by: CREATOR, replyAudience: 'verified' }))).status).toBe(409);
    } finally {
      await widened.w.close();
    }
    expect(replyAudienceOf({}, 'own_threads')).toBe('own_threads');
    expect(replyAudienceOf({ replyAudience: 'verified' }, 'own_threads')).toBe('verified');
    expect(replyAudienceOf({ replyAudience: 'everyone' }, 'nonsense')).toBe('verified');
    expect(replyAudienceOf({})).toBe('verified');
  });
});
