/**
 * Threads end to end (docs/design/agent-tools-2.md sections 3 and 17.9): the broker, the real sender and a fake X. A
 * thread is one original in every rule that counts posts and one publish per part at X; every part is checked before
 * the first is sent; a later part hangs only under the agent's own earlier part; nothing is ever sent twice; and a
 * thread that breaks stays cut.
 */
import { THREAD_NOT_HERE, threadDailyCap, threadTooLong } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { json, timeoutError } from '../../sender/test/helpers.js';
import { reconcilePostActions } from '../../sender/src/reconcile.js';
import { agentActivity } from '../src/activity.js';
import { createApp } from '../src/api.js';
import { queueForApproval } from '../src/approvals.js';
import { executeAction, resolvePending } from '../src/broker/index.js';
import { actions, approvals, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { agentConfigOf } from '../src/onboarding.js';
import { publishesLast24h } from '../src/post-budget.js';
import { postHooks } from '../src/post-send.js';
import { questionBudget } from '../src/recent-posts.js';
import { slotsUsed } from '../src/rhythm.js';
import type { AgentState } from '../src/runtime.js';
import { SENDER_WITHOUT_THREADS, THREAD_CUT_NOTE, linkQuota, sendOriginal, threadsInWindow } from '../src/thread-send.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, SUPERVISOR_KEY, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { HOUR, T0, actionRow, brokerEnv, pendingOf, storeTurn, wiredWorld, type WiredWorld } from './posting-helpers.js';

const PARTS = ['Fees on a Bootr coin are split at launch, and the split cannot be changed later.', 'The agent gets its share as fuel: it pays for its own thinking from it.', 'The creator gets a share too, and the platform keeps the rest.', 'So a coin that trades keeps its agent awake. That is the whole loop.'];
const THREAD = { text: PARTS[0]!, thread: PARTS.slice(1).map((text) => ({ text })) };

type ToolMessage = { error?: string; status?: string; postId?: string; parts?: { n: number; postId: string }[]; sent?: number; of?: number; cut?: { n: number; error: string }; note?: string };
const toolResults = (w: TestWorld): ToolMessage[] => {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const last = calls[calls.length - 1]!.body as { messages: { role: string; content: string }[] };
  return last.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content) as ToolMessage);
};
const stateOf = async (w: TestWorld) => (await w.db.select().from(runtimes).where(eq(runtimes.agentId, AGENT_ID)))[0]!.state as unknown as AgentState;
const postRows = async (w: TestWorld) => (await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => (r.action as { tool?: string }).tool === 'publish_post');
const due = (w: TestWorld) => ({ config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString() } });

async function hostedTurn(script: Response[], opts: { config?: Record<string, string>; agent?: Record<string, unknown>; verifiedType?: string | null } = {}): Promise<WiredWorld> {
  const w = await wiredWorld({ script, ...(opts.config ? { config: opts.config } : {}), ...(opts.verifiedType !== undefined ? { verifiedType: opts.verifiedType } : {}) });
  await seedAgent(w, { config: { ...due(w).config, ...(opts.agent ?? {}) } });
  return w;
}

describe('a thread through the broker, the sender and X', () => {
  it('a thread of four is four posts at X under one another, four sender rows, four of the quota, and one original in every count', async () => {
    const w = await hostedTurn([toolCallResponse('publish_post', THREAD), finishResponse(T0 + 3 * HOUR)]);
    try {
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      // X: the first an original, each later one a reply to the part before it, in order
      const posted = w.posted();
      expect(posted.map((p) => p.text)).toEqual(PARTS);
      const rows = await w.senderRows();
      const ids = rows.map((row) => row.providerPostId!);
      expect(posted.map((p) => p.replyTo)).toEqual([null, ids[0], ids[1], ids[2]]);
      // the sender: one row per part, the first under the action's own id, the rest derived from it
      const [action] = await postRows(w);
      expect(rows.map((row) => [row.actionId, row.status, row.threadN])).toEqual([[action!.actionId, 'sent', 1], [`${action!.actionId}.t2`, 'sent', 2], [`${action!.actionId}.t3`, 'sent', 3], [`${action!.actionId}.t4`, 'sent', 4]]);
      // the quota: four
      expect((await w.ctx.sender.quota(AGENT_ID)).postsUsed24h).toBe(4);
      expect((await publishesLast24h(w.ctx, AGENT_ID)).count).toBe(4);

      // the supervisor: ONE action, one slot of the platform's window, one step of the cadence, one thread of the day
      expect(await postRows(w)).toHaveLength(1);
      expect(action!.status).toBe('completed');
      expect((action!.result as { result: ToolMessage }).result).toEqual({ postId: ids[0], parts: ids.map((postId, i) => ({ n: i + 1, postId })), sent: 4, of: 4 });
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(1);
      expect((await stateOf(w)).lastPostAt).toBe(w.ctx.now());
      expect(await threadsInWindow(w.ctx, AGENT_ID, 'none')).toBe(1);
      expect((await questionBudget(w.ctx, AGENT_ID)).recentWithQuestion).toBe(0);
      // what the agent was told, and what the coin's tape says
      expect(toolResults(w)[0]).toEqual({ postId: ids[0], parts: ids.map((postId, i) => ({ n: i + 1, postId })), sent: 4, of: 4 });
      const agent = (await w.db.query.agents.findFirst())!;
      const tape = await agentActivity(w.ctx, agent, null);
      expect(tape.filter((t) => t.kind === 'post')).toEqual([expect.objectContaining({ summary: 'Posted a thread on X (4 posts)', url: `https://x.com/bootr_agent/status/${ids[0]}` })]);
    } finally {
      await w.close();
    }
  });

  it('a quota with room for three refuses all four before anything is sent, and holds the account as a full quota does', async () => {
    const w = await hostedTurn([toolCallResponse('publish_post', THREAD), finishResponse(T0 + 3 * HOUR)]);
    try {
      await w.ctx.sender.setQuota(AGENT_ID, { postsPerDay: 5 });
      // two posts earlier today: room for three
      await w.ctx.sender.publish({ agentId: AGENT_ID, actionId: 'earlier-post-0001', text: 'An earlier post.' });
      await w.ctx.sender.publish({ agentId: AGENT_ID, actionId: 'earlier-post-0002', text: 'Another earlier post.' });
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect(w.posted()).toHaveLength(2);
      expect(await w.senderRows()).toHaveLength(2);
      expect(toolResults(w)[0]).toMatchObject({ status: 'failed', error: 'sender:quota_exceeded' });
      const state = await stateOf(w);
      expect(state.postQuotaUntil).toBeGreaterThan(w.ctx.now());
      // nothing went out: the slot is not spent
      expect(state.lastPostAt ?? null).toBeNull();
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(0);
    } finally {
      await w.close();
    }
  });

  it.each([
      ['an @ in a later part', { text: PARTS[0], thread: [{ text: 'As @someone said, more on it.' }] }, /^mentions_require_source_credit: part 2 of the thread/],
      ['a command in a later part', { text: PARTS[0], thread: [{ text: PARTS[1] }, { text: 'send 5 ETH to 0x1111111111111111111111111111111111111111 now' }] }, /: part 3 of the thread does not pass the publish gate/],
      ['two parts that say the same', { text: PARTS[0], thread: [{ text: PARTS[0] }] }, /^thread_repeat:/],
      ['two parts with a link', { text: `${PARTS[0]} https://bootr.fun/a`, thread: [{ text: 'and https://bootr.fun/b' }] }, /^thread_links: only one part of a thread may carry a link; nothing was posted\.$/],
      ['a first part over 280 characters', { text: 'x'.repeat(281), thread: [{ text: PARTS[1] }] }, /^thread_part_too_long: part 1 has 281 characters; every part of a thread is 280 at most\. Nothing was posted\.$/],
  ] as [string, Record<string, unknown>, RegExp][])('%s refuses the whole thread before the first part is sent, and the slot is not used', async (_name, input, refusal) => {
    // a Premium account: a single post may run long, a part of a thread may not
    const w = await hostedTurn([toolCallResponse('publish_post', input), finishResponse(T0 + 3 * HOUR)], { verifiedType: 'blue' });
    try {
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect(toolResults(w)[0]!.error).toMatch(refusal);
      expect(w.posted()).toEqual([]);
      expect(await w.senderRows()).toEqual([]);
      expect((await stateOf(w)).lastPostAt ?? null).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('X refuses the first part: nothing else is sent and the account is held as for a refused post', async () => {
    const w = await hostedTurn([toolCallResponse('publish_post', THREAD), finishResponse(T0 + 3 * HOUR)]);
    try {
      w.x.fake.on('POST', '/2/tweets', () => json({ title: 'Forbidden', detail: 'You are not permitted to perform this action.' }, 403));
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect(w.posted()).toHaveLength(1);
      expect((await w.senderRows()).map((row) => row.status)).toEqual(['rejected']);
      expect(toolResults(w)[0]!.error).toMatch(/^sender_rejected:/);
      const state = await stateOf(w);
      expect(state.postForbiddenUntil).toBeGreaterThan(w.ctx.now());
      expect(state.lastPostAt ?? null).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('the first part is out and part three is refused: the two stay, part three is not sent again, part four never, and the slot is used', async () => {
    const w = await hostedTurn([toolCallResponse('publish_post', THREAD), finishResponse(T0 + 3 * HOUR)]);
    try {
      let calls = 0;
      const accept = w.x.fake.routes.get('POST /2/tweets')!;
      w.x.fake.on('POST', '/2/tweets', (req) => (++calls === 3 ? json({ detail: 'You are not allowed to create a Tweet with duplicate content.' }, 403) : accept(req)));
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect(w.posted().map((p) => p.text)).toEqual(PARTS.slice(0, 3));
      const rows = await w.senderRows();
      expect(rows.map((row) => [row.threadN, row.status])).toEqual([[1, 'sent'], [2, 'sent'], [3, 'rejected']]);
      const told = toolResults(w)[0]!;
      expect(told).toMatchObject({ postId: rows[0]!.providerPostId, sent: 2, of: 4, cut: { n: 3 }, note: THREAD_CUT_NOTE });
      expect(told.note).toBe('A thread that is cut stays cut: do not post the rest.');
      expect(told.cut!.error).toMatch(/^sender_rejected:/);
      expect(told.parts).toEqual([{ n: 1, postId: rows[0]!.providerPostId }, { n: 2, postId: rows[1]!.providerPostId }]);
      // a cut thread used its slot and moved the cadence, and counts as the two posts that went out
      expect((await stateOf(w)).lastPostAt).toBe(w.ctx.now());
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(1);
      expect((await publishesLast24h(w.ctx, AGENT_ID)).count).toBe(2);
      const agent = (await w.db.query.agents.findFirst())!;
      expect((await agentActivity(w.ctx, agent, null)).filter((t) => t.kind === 'post').map((t) => t.summary)).toEqual(['Posted a thread on X (2 of 4 posts)']);
    } finally {
      await w.close();
    }
  });

  it('a later part whose outcome is unknown cuts the thread there and blocks nothing: the action completes', async () => {
    const w = await hostedTurn([toolCallResponse('publish_post', THREAD), finishResponse(T0 + 3 * HOUR)]);
    try {
      let calls = 0;
      const accept = w.x.fake.routes.get('POST /2/tweets')!;
      w.x.fake.on('POST', '/2/tweets', (req) => (++calls === 3 ? timeoutError() : accept(req)));
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect((await w.senderRows()).map((row) => [row.threadN, row.status])).toEqual([[1, 'sent'], [2, 'sent'], [3, 'held']]);
      expect(toolResults(w)[0]).toMatchObject({ sent: 2, of: 4, cut: { n: 3, error: 'sender_held' } });
      const [action] = await postRows(w);
      expect(action!.status).toBe('completed');
      expect((await w.db.select().from(runtimes))[0]!.status).not.toBe('held');
      // part four was never handed to the sender, and never will be
      expect(w.posted()).toHaveLength(3);
    } finally {
      await w.close();
    }
  });

  it('the first part\'s outcome is unknown: the action is held, the other parts are never sent, and it closes cut when the first later proves sent', async () => {
    const w = await hostedTurn([toolCallResponse('publish_post', THREAD), finishResponse(T0 + 6 * HOUR)]);
    try {
      const accept = w.x.fake.routes.get('POST /2/tweets')!;
      w.x.fake.on('POST', '/2/tweets', () => timeoutError());
      await tick(w.ctx);
      const [held] = await postRows(w);
      expect(held!.status).toBe('held');
      expect((await w.db.select().from(runtimes))[0]!.status).toBe('held');
      expect(w.posted()).toHaveLength(1);
      expect((await w.senderRows()).map((row) => [row.threadN, row.status])).toEqual([[1, 'held']]);

      // X did take the first part after all: the sender's reconciler finds it on the timeline a quarter of an hour later
      w.x.fake.on('POST', '/2/tweets', accept);
      w.advance(16 * 60_000);
      w.x.fake.on('GET', '/2/users/1000/tweets', () => json({ data: [{ id: '7001', author_id: '1000', text: PARTS[0], created_at: new Date(T0 + 2000).toISOString() }], meta: { result_count: 1 } }));
      expect((await reconcilePostActions(w.x.ctx)).settled).toBe(1);
      await tick(w.ctx);
      const [closed] = await postRows(w);
      expect(closed!.status).toBe('completed');
      expect((closed!.result as { result: ToolMessage }).result).toEqual({ postId: '7001', parts: [{ n: 1, postId: '7001' }], sent: 1, of: 4, cut: { n: 2, error: 'not_sent: the thread stopped before this part' }, note: THREAD_CUT_NOTE });
      // one X call ever: the rest was never sent, also now that the first proved sent
      expect(w.posted()).toHaveLength(1);
      expect(await w.senderRows()).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('the supervisor dies between parts: the resumed action closes from the first part\'s receipt, cut where it stopped, and sends nothing', async () => {
    const w = await wiredWorld();
    try {
      const agent = await seedAgent(w, due(w));
      const head = 'act-crash-000001';
      // parts one and two went out, then the process died before part three
      const base = { agentId: AGENT_ID, xUserId: '1000' };
      await w.ctx.sender.publish({ ...base, actionId: head, text: PARTS[0]!, thread: { head, n: 1, of: 4 } });
      await w.ctx.sender.publish({ ...base, actionId: `${head}.t2`, text: PARTS[1]!, thread: { head, n: 2, of: 4 } });
      const rows = await w.senderRows();
      const pending = pendingOf(head, 'publish_post', THREAD);
      const resolved = await resolvePending(w.ctx, agent, pending);
      expect(resolved).toEqual({
        resolved: true,
        outcome: { kind: 'completed', result: { postId: rows[0]!.providerPostId, parts: [{ n: 1, postId: rows[0]!.providerPostId }, { n: 2, postId: rows[1]!.providerPostId }], sent: 2, of: 4, cut: { n: 3, error: 'not_sent: the thread stopped before this part' }, note: THREAD_CUT_NOTE }, receipt: { postId: rows[0]!.providerPostId } },
        receipt: { postId: rows[0]!.providerPostId },
      });
      expect(w.posted()).toHaveLength(2);
      // died before the first part reached the sender at all: nothing was sent, and nothing is
      expect(await resolvePending(w.ctx, agent, pendingOf('act-crash-000002', 'publish_post', THREAD))).toEqual({ resolved: true, outcome: { kind: 'failed', error: 'sender_receipt_missing' } });
      // a single post is closed as it always was
      await w.ctx.sender.publish({ ...base, actionId: 'act-single-00001', text: 'One post.' });
      const single = await resolvePending(w.ctx, agent, pendingOf('act-single-00001', 'publish_post', { text: 'One post.' }));
      expect(single).toMatchObject({ resolved: true, outcome: { kind: 'completed', result: { postId: expect.stringMatching(/^\d+$/) } } });
      expect((single as { outcome: { result: Record<string, unknown> } }).outcome.result).not.toHaveProperty('parts');
    } finally {
      await w.close();
    }
  });

  it('a repeated send sends nothing twice and never continues a thread: it closes from what the sender holds', async () => {
    const w = await wiredWorld();
    try {
      const agent = await seedAgent(w, due(w));
      const config = agentConfigOf(agent)!;
      const pending = pendingOf('act-repeat-00001', 'publish_post', THREAD);
      const first = await executeAction(w.ctx, agent, config, pending, brokerEnv());
      expect(first).toMatchObject({ kind: 'completed', result: { sent: 4, of: 4 } });
      expect(w.posted()).toHaveLength(4);
      const again = await executeAction(w.ctx, agent, config, pending, brokerEnv());
      expect(again).toMatchObject({ kind: 'completed', result: { sent: 4, of: 4, postId: (first as { result: { postId: string } }).result.postId } });
      expect(w.posted()).toHaveLength(4);
      expect(await w.senderRows()).toHaveLength(4);

      // a thread interrupted after its first part: the same send again posts nothing more, whatever X would take now
      const head = 'act-repeat-00002';
      await w.ctx.sender.publish({ agentId: AGENT_ID, xUserId: '1000', actionId: head, text: 'A first part that went out alone.', thread: { head, n: 1, of: 3 } });
      const resumed = await sendOriginal(w.ctx, agent, { actionId: head, text: 'A first part that went out alone.', thread: [{ text: 'A second part.' }, { text: 'A third part.' }] });
      expect(resumed).toMatchObject({ kind: 'completed', result: { sent: 1, of: 3, cut: { n: 2, error: 'not_sent: the thread was not continued after an interrupted send' }, note: THREAD_CUT_NOTE } });
      expect(w.posted()).toHaveLength(5);
    } finally {
      await w.close();
    }
  });
});

describe('the counts and places of a thread', () => {
  it('two threads a day: the third is refused and told to go out as one post', async () => {
    const w = await wiredWorld();
    try {
      const agent = await seedAgent(w, due(w));
      const config = agentConfigOf(agent)!;
      for (const id of ['act-day-0000001', 'act-day-0000002']) {
        const two = { text: `${id}: a first part.`, thread: [{ text: `${id}: a second part.` }] };
        await actionRow(w, id, { tool: 'publish_post', input: two }, { status: 'sending', result: null });
        expect(await executeAction(w.ctx, agent, config, pendingOf(id, 'publish_post', two), brokerEnv())).toMatchObject({ kind: 'completed', result: { sent: 2, of: 2 } });
        await w.db.update(actions).set({ status: 'completed' }).where(eq(actions.actionId, id));
        w.advance(20 * 60_000);
      }
      const third = await executeAction(w.ctx, agent, config, pendingOf('act-day-0000003', 'publish_post', THREAD), brokerEnv());
      expect(third).toEqual({ kind: 'failed', error: 'thread_daily_cap: at most 2 threads per 24 hours; nothing was posted. Publish it as one post.' });
      expect(third).toEqual({ kind: 'failed', error: threadDailyCap(2) });
      expect(w.posted()).toHaveLength(4);
      // a single post still goes
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-day-0000004', 'publish_post', { text: 'One post, no thread.' }), brokerEnv())).toMatchObject({ kind: 'completed' });
      // a day later the count has room again
      w.advance(24 * HOUR);
      expect(await threadsInWindow(w.ctx, AGENT_ID, 'none')).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('a thread never has more parts than the coin may post in a day, and the digest and the numbers post are one post each', async () => {
    const w = await wiredWorld();
    try {
      const agent = await seedAgent(w, { config: { ...due(w).config, postsPerDay: 3 } });
      const config = agentConfigOf(agent)!;
      const tooLong = await executeAction(w.ctx, agent, config, pendingOf('act-size-0000001', 'publish_post', THREAD), brokerEnv());
      expect(tooLong).toEqual({ kind: 'failed', error: threadTooLong(3) });
      expect(tooLong).toEqual({ kind: 'failed', error: 'thread_too_long: a thread has at most 3 posts; nothing was posted. Say it in fewer.' });

      // a turn that carries the weekly digest (or the numbers post) takes no thread
      await storeTurn(w, { digestWeek: '2026-W43' });
      const three = { text: PARTS[0]!, thread: [{ text: PARTS[1]! }] };
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-size-0000002', 'publish_post', three), brokerEnv())).toEqual({ kind: 'failed', error: THREAD_NOT_HERE });
      expect(THREAD_NOT_HERE).toBe('thread_not_here: the digest and the numbers post are one post each; nothing was posted. Publish it without thread.');
      await storeTurn(w, { numbersDay: '2026-10-24' });
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-size-0000003', 'publish_post', three), brokerEnv())).toEqual({ kind: 'failed', error: THREAD_NOT_HERE });
      expect(w.posted()).toEqual([]);
      // once the turn carries neither, the same thread goes
      await storeTurn(w, {});
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-size-0000004', 'publish_post', three), brokerEnv())).toMatchObject({ kind: 'completed', result: { sent: 2, of: 2 } });
    } finally {
      await w.close();
    }
  });

  it('a question in any part counts once for the question quota, and a thread that asks is held to it', async () => {
    const w = await wiredWorld();
    try {
      const agent = await seedAgent(w, due(w));
      const config = agentConfigOf(agent)!;
      const asks = { text: 'A statement to open with.', thread: [{ text: 'And what would you build on it?' }] };
      await actionRow(w, 'act-ask-00000001', { tool: 'publish_post', input: asks });
      expect(await questionBudget(w.ctx, AGENT_ID)).toMatchObject({ recentWithQuestion: 1, mayAskNow: false });
      const refused = await executeAction(w.ctx, agent, config, pendingOf('act-ask-00000002', 'publish_post', { text: 'Another opening.', thread: [{ text: 'Who else sees it this way?' }] }), brokerEnv());
      expect(refused.kind === 'failed' && refused.error).toMatch(/^question_quota: 1 of your last 4 original posts already asked something/);
      expect(w.posted()).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('a link in a later part is asked of the link budget before the first part goes out; one in the first part is refused by the sender', async () => {
    const w = await wiredWorld();
    try {
      w.x.ctx.defaults.linkPostsPerDay = 1;
      const agent = await seedAgent(w, due(w));
      const config = agentConfigOf(agent)!;
      await w.ctx.sender.publish({ agentId: AGENT_ID, actionId: 'earlier-link-0001', text: 'Earlier today: https://bootr.fun/a/1' });
      const later = await executeAction(w.ctx, agent, config, pendingOf('act-link-0000001', 'publish_post', { text: 'A thread whose link comes last.', thread: [{ text: 'Here it is: https://bootr.fun/a/2' }] }), brokerEnv());
      expect(later).toEqual({ kind: 'failed', error: 'link_quota: at most 1 posts with a link per 24 hours; nothing was posted. Post it without the link.' });
      const first = await executeAction(w.ctx, agent, config, pendingOf('act-link-0000002', 'publish_post', { text: 'The link first: https://bootr.fun/a/3', thread: [{ text: 'and then the rest.' }] }), brokerEnv());
      expect(first).toEqual({ kind: 'failed', error: linkQuota(1) });
      // a single post with a link is told the same, in the same words, and sets no hold: it goes out without the link
      const single = await executeAction(w.ctx, agent, config, pendingOf('act-link-0000003', 'publish_post', { text: 'One post with https://bootr.fun/a/4' }), brokerEnv());
      expect(single).toEqual({ kind: 'failed', error: linkQuota(1) });
      expect(w.posted()).toHaveLength(1);
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-link-0000004', 'publish_post', { text: 'One post, the link said in words.' }), brokerEnv())).toMatchObject({ kind: 'completed' });
    } finally {
      await w.close();
    }
  });
});

describe('a thread in approval mode', () => {
  const api = (w: TestWorld) => {
    const nowSec = () => Math.floor(w.ctx.now() / 1000);
    const app = createApp(w.ctx, nowSec);
    return (path: string, body: unknown) => {
      const text = JSON.stringify(body);
      return app.request(path, { method: 'POST', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'POST', path, text, nowSec()) } });
    };
  };

  it('is one item in the queue, sends all parts when approved, and nothing when rejected', async () => {
    const w = await wiredWorld();
    try {
      const agent = await seedAgent(w, { config: { ...due(w).config, requireApproval: true } });
      const queued = await queueForApproval(w.ctx, agent, pendingOf('act-review-00001', 'publish_post', { ...THREAD, topic: 'fees' }), brokerEnv());
      expect(queued).toMatchObject({ kind: 'completed', result: { queued: true, approvalId: 'act-review-00001' } });
      const [row] = await w.db.select().from(approvals);
      expect(row).toMatchObject({ id: 'act-review-00001', kind: 'post', text: PARTS[0], status: 'pending_approval' });
      expect((row!.meta as { thread: unknown }).thread).toEqual(THREAD.thread);
      expect(await w.db.select().from(approvals)).toHaveLength(1);
      expect(w.posted()).toEqual([]);
      // the duplicate check is over all parts: the same thread again is refused, the same opening with another ending is another thread
      const same = await queueForApproval(w.ctx, agent, pendingOf('act-review-00002', 'publish_post', THREAD), brokerEnv());
      expect(same.kind === 'failed' && same.error).toMatch(/^approval_duplicate:/);
      const other = await queueForApproval(w.ctx, agent, pendingOf('act-review-00003', 'publish_post', { text: PARTS[0], thread: [{ text: 'A different second part.' }] }), brokerEnv());
      expect(other.kind).toBe('completed');
      // the rules of a thread apply before the creator sees it
      const bad = await queueForApproval(w.ctx, agent, pendingOf('act-review-00004', 'publish_post', { text: 'Opening.', thread: [{ text: 'With an @stranger in a later part.' }] }), brokerEnv());
      expect(bad.kind === 'failed' && bad.error).toMatch(/^mentions_require_source_credit: part 2 of the thread/);

      const post = api(w);
      // rejecting rejects all of it
      const rejected = await post(`/internal/agents/${AGENT_ID}/approvals/act-review-00003`, { decision: 'reject', by: CREATOR, note: 'not this one' });
      expect(rejected.status).toBe(200);
      expect(w.posted()).toEqual([]);
      // approving sends every part, through the same send, as one original
      const approved = await post(`/internal/agents/${AGENT_ID}/approvals/act-review-00001`, { decision: 'approve', by: CREATOR });
      expect(approved.status).toBe(200);
      const rows = await w.senderRows();
      expect(rows.map((r) => [r.actionId, r.status])).toEqual([['act-review-00001', 'sent'], ['act-review-00001.t2', 'sent'], ['act-review-00001.t3', 'sent'], ['act-review-00001.t4', 'sent']]);
      expect(w.posted().map((p) => p.text)).toEqual(PARTS);
      expect(w.posted().map((p) => p.replyTo)).toEqual([null, rows[0]!.providerPostId, rows[1]!.providerPostId, rows[2]!.providerPostId]);
      const [sent] = (await w.db.select().from(actions)).filter((r) => r.actionId === 'act-review-00001-approved');
      expect(sent).toMatchObject({ status: 'completed', action: { tool: 'publish_post', input: { text: PARTS[0], thread: THREAD.thread, topic: 'fees' }, approval: { id: 'act-review-00001' } }, result: { postId: rows[0]!.providerPostId, sent: 4, of: 4, approvalId: 'act-review-00001', senderStatus: 'sent' } });
      expect((await w.db.select().from(approvals).where(eq(approvals.id, 'act-review-00001')))[0]).toMatchObject({ status: 'approved', postId: rows[0]!.providerPostId });
      // approving again changes nothing and sends nothing
      expect((await post(`/internal/agents/${AGENT_ID}/approvals/act-review-00001`, { decision: 'approve', by: CREATOR })).status).toBe(409);
      expect(w.posted()).toHaveLength(4);
      // one slot of the platform's window, and the thread is counted once for the day (the queued row; the approved one repeats it)
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('goes out through the seam: whoever registered the send is asked once, with every part', async () => {
    const w = await wiredWorld();
    const real = postHooks.sendOriginal;
    try {
      const agent = await seedAgent(w, { config: { ...due(w).config, requireApproval: true } });
      await queueForApproval(w.ctx, agent, pendingOf('act-seam-0000001', 'publish_post', THREAD), brokerEnv());
      const seen: unknown[] = [];
      postHooks.sendOriginal = async (_ctx, _agent, post) => {
        seen.push(post);
        return { kind: 'completed', result: { postId: '4242', parts: [{ n: 1, postId: '4242' }], sent: 1, of: 4, cut: { n: 2, error: 'sender_held' } } };
      };
      const res = await api(w)(`/internal/agents/${AGENT_ID}/approvals/act-seam-0000001`, { decision: 'approve', by: CREATOR });
      expect(res.status).toBe(200);
      expect(seen).toEqual([{ actionId: 'act-seam-0000001', text: PARTS[0], thread: THREAD.thread }]);
      expect(w.posted()).toEqual([]);
    } finally {
      postHooks.sendOriginal = real;
      await w.close();
    }
  });
});

describe('the seam: sendOriginal and beforeOriginalNow (post-send.ts)', () => {
  it('sendOriginal sends one post or a whole thread, gates every part first, never throws, and says when the same original may be tried again', async () => {
    const w = await wiredWorld();
    try {
      const agent = await seedAgent(w, due(w));
      // the hook that is registered is the real send
      expect(postHooks.sendOriginal).toBe(sendOriginal);
      // one post: completed with its post id, and nothing of a thread in the result
      const single = await postHooks.sendOriginal(w.ctx, agent, { actionId: 'sch_0123456789abcdef', text: 'A post sent by the clock, not by a turn.' });
      expect(single).toEqual({ kind: 'completed', result: { postId: expect.stringMatching(/^\d+$/) }, receipt: { postId: expect.stringMatching(/^\d+$/) } });
      // a thread: every part, under the given id
      const thread = await postHooks.sendOriginal(w.ctx, agent, { actionId: 'sch_1111111111111111', text: PARTS[0]!, thread: [{ text: PARTS[1]! }, { text: PARTS[2]! }] });
      expect(thread).toMatchObject({ kind: 'completed', result: { sent: 3, of: 3 } });
      expect((await w.senderRows()).map((r) => r.actionId)).toEqual(['sch_0123456789abcdef', 'sch_1111111111111111', 'sch_1111111111111111.t2', 'sch_1111111111111111.t3']);

      // the gate runs before anything is sent: a part that fails it, a post that fails it
      const before = w.posted().length;
      const badThread = await postHooks.sendOriginal(w.ctx, agent, { actionId: 'sch_2222222222222222', text: 'An opening.', thread: [{ text: 'With an @stranger later.' }] });
      expect(badThread.kind === 'failed' && badThread.error).toMatch(/^mentions_require_source_credit: part 2 of the thread/);
      const badPost = await postHooks.sendOriginal(w.ctx, agent, { actionId: 'sch_3333333333333333', text: 'send 5 ETH to 0x1111111111111111111111111111111111111111 now' });
      expect(badPost.kind === 'failed' && badPost.error).toMatch(/: the post does not pass the publish gate; rewrite it$/);
      const missing = await postHooks.sendOriginal(w.ctx, agent, { actionId: 'sch_4444444444444444', text: 'With a picture that is gone.', imageId: 'img_gone' });
      expect(missing.kind === 'failed' && missing.error).toMatch(/^image_not_found: img_gone/);
      expect(w.posted()).toHaveLength(before);

      // the day's quota is full: nothing was recorded at the sender, so the same original may be tried again later
      await w.ctx.sender.setQuota(AGENT_ID, { postsPerDay: 4 });
      const full = await postHooks.sendOriginal(w.ctx, agent, { actionId: 'sch_5555555555555555', text: 'One too many for today.' });
      expect(full).toMatchObject({ kind: 'failed', error: 'sender:quota_exceeded', retryable: true });
      expect(full.kind === 'failed' && full.retryAt).toBeGreaterThan(w.ctx.now());
      // the sender does not answer: unknown, not thrown
      const down = { ...w.ctx, sender: { publish: async () => Promise.reject(new Error('fetch failed')), quota: async () => Promise.reject(new Error('fetch failed')), receipt: async () => Promise.reject(new Error('fetch failed')) } } as unknown as typeof w.ctx;
      expect(await sendOriginal(down, agent, { actionId: 'sch_6666666666666666', text: 'Into the void.' })).toEqual({ kind: 'unknown', error: 'Error: fetch failed' });
      expect(w.posted()).toHaveLength(before);
    } finally {
      await w.close();
    }
  });

  it('a post sent now asks beforeOriginalNow directly after the platform\'s window, and a refusal there sends nothing', async () => {
    const w = await wiredWorld();
    const real = postHooks.beforeOriginalNow;
    try {
      const agent = await seedAgent(w, due(w));
      const config = agentConfigOf(agent)!;
      const asked: number[] = [];
      const soon = 'post_scheduled_soon: your next post is already scheduled for 2026-10-24T13:00:00.000Z; nothing was posted. Replies may still go out.';
      postHooks.beforeOriginalNow = async (_ctx, row, now) => {
        asked.push(now);
        return row.agentId === AGENT_ID ? soon : null;
      };
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-seam-0000002', 'publish_post', { text: 'A post now.' }), brokerEnv())).toEqual({ kind: 'failed', error: soon });
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-seam-0000003', 'publish_post', THREAD), brokerEnv())).toEqual({ kind: 'failed', error: soon });
      expect(asked).toEqual([w.ctx.now(), w.ctx.now()]);
      expect(w.posted()).toEqual([]);
      // once nothing is scheduled soon, the post goes
      postHooks.beforeOriginalNow = async () => null;
      expect((await executeAction(w.ctx, agent, config, pendingOf('act-seam-0000004', 'publish_post', { text: 'A post now.' }), brokerEnv())).kind).toBe('completed');
    } finally {
      postHooks.beforeOriginalNow = real;
      await w.close();
    }
  });
});

describe('a sender from before threads', () => {
  it('is handed the first part and nothing more: it would post a later part as a post of its own', async () => {
    // this world's sender is a stand-in that takes a publish and knows nothing of `thread`, as a sender deployed before this round does
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, due(w));
      const config = agentConfigOf(agent)!;
      const out = await executeAction(w.ctx, agent, config, pendingOf('act-old-sender-01', 'publish_post', THREAD), brokerEnv());
      expect(out).toMatchObject({ kind: 'completed', result: { sent: 1, of: 4, cut: { n: 2, error: SENDER_WITHOUT_THREADS }, note: THREAD_CUT_NOTE } });
      expect(w.sender.published).toHaveLength(1);
      expect(w.sender.published[0]).toMatchObject({ text: PARTS[0], thread: { head: 'act-old-sender-01', n: 1, of: 4 } });
      // a single post is not touched by any of this
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-old-sender-02', 'publish_post', { text: 'One post.' }), brokerEnv())).toMatchObject({ kind: 'completed', result: { postId: expect.stringMatching(/^\d+$/) } });
      expect(w.sender.published).toHaveLength(2);
    } finally {
      await w.close();
    }
  });
});
