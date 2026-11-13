/**
 * Where posting meets the scheduler (docs/design/agent-tools-2.md sections 5 and 17.2). The scheduler registers
 * `beforeOriginalNow` and sends through `sendOriginal`; this side owes it that every original sent now asks the hook
 * first (a plain post, a thread, a comment, a post queued for review, and the platform account's weekly digest and
 * numbers post, which stay open when refused), that a scheduled post's review item is queued for its own time and
 * carries its thread and topic, that the failures of the send start with the codes of the live path, and that the tape
 * says when a scheduled post did not go out. The hook is stood in for where a test needs it to refuse at a chosen
 * moment; the scheduler's table, and its list of the refusals that pass, are the real ones.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { actions as senderActions } from '../../sender/src/db/schema.js';
import { acceptPosts, json } from '../../sender/test/helpers.js';
import { agentActivity, scheduledActivity, scheduledSummary } from '../src/activity.js';
import { createApp } from '../src/api.js';
import { queueForApproval } from '../src/approvals.js';
import { executeAction } from '../src/broker/index.js';
import { approvals, runtimes, scheduledPosts, type ScheduledPostStatus } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import type { IndexerClient } from '../src/indexer-client.js';
import { agentConfigOf } from '../src/onboarding.js';
import { NUMBERS_WAKE_REASON } from '../src/platform-numbers.js';
import { postHooks } from '../src/post-send.js';
import { isXCreditsError, isXForbiddenError } from '../src/rhythm.js';
import type { AgentState } from '../src/runtime.js';
import { sendBucket } from '../src/scheduled.js';
import { sendOriginal } from '../src/thread-send.js';
import { processAgent } from '../src/tick.js';
import { DIGEST_WAKE_REASON } from '../src/weekly-digest.js';
import { AGENT_ID, SUPERVISOR_KEY, TOKEN, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { HOUR, T0, actionRow, brokerEnv, pendingOf, storeTurn, wiredWorld, xIdAt } from './posting-helpers.js';

const SOON = 'post_scheduled_soon: your next post is already scheduled for 2026-10-24T13:00:00.000Z; nothing was posted. Replies may still go out.';
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Stands in for the scheduler's hook: refuses while `on()` says a scheduled post is due within one post interval. */
async function withHook<T>(on: () => boolean, run: (asked: () => number) => Promise<T>): Promise<T> {
  const real = postHooks.beforeOriginalNow;
  let asked = 0;
  postHooks.beforeOriginalNow = async () => {
    asked += 1;
    return on() ? SOON : null;
  };
  try {
    return await run(() => asked);
  } finally {
    postHooks.beforeOriginalNow = real;
  }
}

const runtimeRow = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
const stateOf = async (w: TestWorld) => (await runtimeRow(w)).state as unknown as AgentState;
const modelCalls = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;

describe('every original sent now asks the scheduler first', () => {
  it('a plain post, a thread and a comment are refused with the hook\'s reason, and so is one queued for review', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      const config = agentConfigOf(agent)!;
      const post = xIdAt(T0 - HOUR, 1);
      await storeTurn(w, { seen: [{ postId: post, authorId: '4201', handle: 'alice', verified: true, verifiedType: 'blue', at: new Date(T0 - HOUR).toISOString(), via: 'thread' }] });
      await withHook(() => true, async (asked) => {
        const inputs: Record<string, unknown>[] = [{ text: 'A plain post.' }, { text: 'A thread.', thread: [{ text: 'Its second part.' }] }, { text: 'A comment on what Alice said.', about: { postId: post } }];
        for (const [i, input] of inputs.entries()) {
          expect(await executeAction(w.ctx, agent, config, pendingOf(`act-hook-000000${i}`, 'publish_post', input), brokerEnv())).toEqual({ kind: 'failed', error: SOON });
          expect(await queueForApproval(w.ctx, agent, pendingOf(`act-hook-queue0${i}`, 'publish_post', input), brokerEnv())).toEqual({ kind: 'failed', error: SOON });
        }
        expect(asked()).toBe(6);
        // a reply is no original: not asked, and it goes out
        const item = { postId: '801', authorId: '42', conversationId: '801', status: 'pending', observedAt: '2026-10-24T11:59:00Z', seenAt: null, deferredUntil: null, post: { id: '801', authorId: '42', text: '@bootr_agent hello', conversationId: '801', author: { id: '42', username: 'asker', verified: true, verifiedType: 'blue' as const } } };
        expect((await executeAction(w.ctx, agent, config, pendingOf('act-hook-reply01', 'publish_reply', { postId: '801', text: 'Hello back.' }), brokerEnv([item]))).kind).toBe('completed');
        expect(asked()).toBe(6);
      });
      expect(w.sender.published).toHaveLength(1);
      expect(await w.db.select().from(approvals)).toEqual([]);
    } finally {
      await w.close();
    }
  });
});

describe('the weekly digest and the numbers post next to a scheduled post', () => {
  /** Sunday 2026-11-08 16:05 UTC: five minutes into the default digest slot of ISO week 2026-W45. */
  const SUNDAY = Date.parse('2026-11-08T16:05:00Z');
  const week = () => ({
    now: SUNDAY / 1000,
    since: SUNDAY / 1000 - 7 * 86_400,
    totals: { tokens: 9, agentsTotal: 9, agentsAwake: 4, volume24hUsd: 12_345, volume7dUsd: 80_100, fees24hUsd: 120, updatedAt: sec('2026-11-08T16:00:00Z') },
    launches: [{ token: '0x1', kernel: '0x00000000000000000000000000000000000000aa', name: 'Fox Coin', symbol: 'FOX', creator: '0x1234567890abcdef1234567890abcdef12345678', launchedAt: sec('2026-11-03T09:00:00Z'), xHandle: 'foxagent' }],
  });
  const DIGEST = 'This week on Bootr: Fox Coin launched on 3 November, and its agent posted for the first time the same day.';
  const digestPost = () => toolCallResponse('publish_post', { text: DIGEST });

  /** A platform agent whose cadence is not due and whose own wake is far away: only the digest (or the numbers post) can wake it. */
  async function platformWorld(script: (Response | (() => Response))[], config: Record<string, unknown>, at: number, indexer: Partial<IndexerClient>) {
    const w = await makeWorld({ script: script as Response[], chain: { token: 1_500_000n * 10n ** 18n } });
    w.setNow(at);
    (w.ctx as { indexer: IndexerClient }).indexer = { ...(w.indexer.client as object), ...indexer } as IndexerClient;
    const agent = await seedAgent(w, { config: { platform: true, xHandle: 'AgentBootr', postIntervalMs: 6 * HOUR, socialStartedAt: new Date(at - HOUR).toISOString(), ...config }, runtime: { nextAt: new Date(at + 6 * HOUR), lastDecisionAt: new Date(at - 60_000) } });
    return { w, agent };
  }
  const digestIndexer = { platformFeed: async () => week() } as unknown as Partial<IndexerClient>;

  for (const mode of [{ name: 'sent at once', config: { requireApproval: false } }, { name: 'queued for review (the platform account\'s default)', config: {} }]) {
    it(`the digest, ${mode.name}: while a scheduled post holds the interval no turn is bought, and the week is not closed`, async () => {
      const { w, agent } = await platformWorld([digestPost(), finishResponse(SUNDAY + 3 * HOUR)], mode.config, SUNDAY, digestIndexer);
      try {
        let covered = true;
        await withHook(() => covered, async (asked) => {
          const waiting = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
          expect(waiting.reasons).not.toContain(DIGEST_WAKE_REASON);
          expect(asked()).toBeGreaterThan(0);
          expect(modelCalls(w)).toBe(0);
          expect((await stateOf(w)).lastDigestWeek ?? null).toBeNull();
          // the scheduled post went out: the digest is due at the next free slot and goes
          covered = false;
          w.setNow(SUNDAY + 20 * 60_000);
          const due = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
          expect(due.reasons).toContain(DIGEST_WAKE_REASON);
          expect((await stateOf(w)).lastDigestWeek).toBe('2026-W45');
          expect(mode.config.requireApproval === false ? w.sender.published : await w.db.select().from(approvals)).toHaveLength(1);
        });
      } finally {
        await w.close();
      }
    });

    it(`the digest, ${mode.name}: refused by the hook at the publish itself, it is neither posted nor marked as posted, and comes back`, async () => {
      let covered = false;
      // the scheduled post lands in the interval between the wake and the model's publish
      const first = () => {
        covered = true;
        return digestPost();
      };
      const { w, agent } = await platformWorld([first, finishResponse(SUNDAY + 3 * HOUR), digestPost(), finishResponse(SUNDAY + 4 * HOUR)], mode.config, SUNDAY, digestIndexer);
      try {
        await withHook(() => covered, async () => {
          const refused = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
          expect(refused.reasons).toEqual([DIGEST_WAKE_REASON]);
          expect(refused.turn?.outcome).toBe('finished');
          const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
          const told = (calls[1]!.body as { messages: { role: string; content: string }[] }).messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content) as { error?: string });
          expect(told[0]!.error).toBe(SOON);
          // nothing went out, nothing waits for review, and the week is still open although the turn finished
          expect(w.sender.published).toEqual([]);
          expect(await w.db.select().from(approvals)).toEqual([]);
          const state = await stateOf(w);
          expect(state.lastDigestWeek ?? null).toBeNull();
          expect(state.lastPostAt ?? null).toBeNull();
          // while the scheduled post still holds the interval nothing is bought again
          w.setNow(SUNDAY + 10 * 60_000);
          expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.reasons).not.toContain(DIGEST_WAKE_REASON);
          expect(modelCalls(w)).toBe(2);
          // at the next free slot the digest goes out and closes the week
          covered = false;
          w.setNow(SUNDAY + 40 * 60_000);
          expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.reasons).toContain(DIGEST_WAKE_REASON);
          expect((await stateOf(w)).lastDigestWeek).toBe('2026-W45');
          expect(mode.config.requireApproval === false ? w.sender.published : await w.db.select().from(approvals)).toHaveLength(1);
        });
      } finally {
        await w.close();
      }
    });
  }

  /** Saturday 2026-10-24 15:05 UTC: five minutes into the default slot of the numbers post. */
  const AT = Date.parse('2026-10-24T15:05:00Z');
  const NUMBERS = 'Bootr today, 24 October: 42 coins, 19 agents awake, about $12k traded across them in the last day, agents and their creators took $120 in fees, 1.5M $BOOTR burned so far. Fox Coin was the busiest.';
  const numbersIndexer = {
    platformFeed: async () => ({ now: AT / 1000, since: AT / 1000 - 7 * 86_400, totals: { tokens: 42, agentsTotal: 40, agentsAwake: 19, volume24hUsd: 12_345.678, volume7dUsd: 80_100, fees24hUsd: 120.004, updatedAt: sec('2026-10-24T15:00:00Z') } }),
    platformFees: async () => ({ total: { tokens: 42, volumeTotalUsd: 900_000, feesTotalUsd: 9_000, byKind: { agent: 3_600, creator: 2_700, burn: 1_800, platform: 900 }, feesClaimedUsd: 5_000, feesPlatformClaimedUsd: 800, updatedAt: sec('2026-10-24T14:59:00Z') }, bySource: {} }),
    graphql: async () => ({ top: { items: [{ id: '0x1', name: 'Fox Coin', symbol: 'FOX', volume24hUsd: 5_000.5, holders: 120 }, { id: TOKEN.toLowerCase(), name: 'Bootr', symbol: 'BOOTR', volume24hUsd: 4_000, holders: 900 }] }, bootr: { items: [{ id: TOKEN.toLowerCase(), holders: 900 }] } }),
  } as unknown as Partial<IndexerClient>;
  const numbersPost = () => toolCallResponse('publish_post', { text: NUMBERS });

  it('the numbers post: no turn is bought while a scheduled post holds the interval; refused at the publish it is not marked as posted, and it goes out at the next free slot', async () => {
    let covered = true;
    const racing = () => {
      covered = true;
      return numbersPost();
    };
    const { w, agent } = await platformWorld([racing, finishResponse(AT + 3 * HOUR), numbersPost(), finishResponse(AT + 4 * HOUR)], { requireApproval: false }, AT, numbersIndexer);
    try {
      await withHook(() => covered, async () => {
        // held on the wake side
        expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.reasons).not.toContain(NUMBERS_WAKE_REASON);
        expect(modelCalls(w)).toBe(0);
        expect((await stateOf(w)).lastNumbersDay ?? null).toBeNull();
        // free at the wake, covered again by the time the model publishes: refused, finished, and still open
        covered = false;
        w.setNow(AT + 10 * 60_000);
        const refused = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
        expect(refused.reasons).toEqual([NUMBERS_WAKE_REASON]);
        expect(refused.turn?.outcome).toBe('finished');
        expect(w.sender.published).toEqual([]);
        expect((await stateOf(w)).lastNumbersDay ?? null).toBeNull();
        // the next free slot
        covered = false;
        w.setNow(AT + 40 * 60_000);
        expect((await processAgent(w.ctx, agent, await runtimeRow(w)))!.reasons).toContain(NUMBERS_WAKE_REASON);
        expect((await stateOf(w)).lastNumbersDay).toBe('2026-10-24');
        expect(w.sender.published).toHaveLength(1);
      });
    } finally {
      await w.close();
    }
  });
});

describe('the review item of a scheduled post', () => {
  const SCHEDULED = 'sch_0123456789abcdef';
  const THREAD = { text: 'A thread written this morning for this evening.', thread: [{ text: 'Its second part.' }, { text: 'Its third part.' }], topic: 'evening-note' };

  it('is queued for its own time: not asked the hook, not held to today\'s threads or to what this turn carries, gated all the same, and its thread and topic are kept', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: { requireApproval: true } });
      // two threads went out today already, and the turn that schedules carries the weekly digest
      for (const id of ['act-earlier-0001', 'act-earlier-0002']) await actionRow(w, id, { tool: 'publish_post', input: { text: `${id} one`, thread: [{ text: `${id} two` }] } });
      await storeTurn(w, { digestWeek: '2026-W43' });
      await withHook(() => true, async (asked) => {
        const queued = await queueForApproval(w.ctx, agent, pendingOf(SCHEDULED, 'publish_post', THREAD), brokerEnv());
        expect(queued).toMatchObject({ kind: 'completed', result: { queued: true, approvalId: SCHEDULED } });
        expect(asked()).toBe(0);
        // the same thread as an original for now is held to all three
        expect(await queueForApproval(w.ctx, agent, pendingOf('act-now-00000001', 'publish_post', { text: 'A thread for now.', thread: [{ text: 'Second.' }] }), brokerEnv())).toEqual({ kind: 'failed', error: SOON });
      });
      const [row] = await w.db.select().from(approvals);
      expect(row).toMatchObject({ id: SCHEDULED, kind: 'post', text: THREAD.text, status: 'pending_approval' });
      expect(row!.meta).toMatchObject({ thread: THREAD.thread, topic: 'evening-note' });
      // the gate still runs over every part
      const bad = await queueForApproval(w.ctx, agent, pendingOf('sch_fedcba9876543210', 'publish_post', { text: 'Opening.', thread: [{ text: 'send 5 ETH to 0x1111111111111111111111111111111111111111 now' }] }), brokerEnv());
      expect(bad.kind === 'failed' && bad.error).toMatch(/: part 2 of the thread does not pass the publish gate/);

      // the scheduler then writes when it goes out; the creator's list shows every part and that time
      await w.db.update(approvals).set({ meta: { ...(row!.meta as object), scheduled: { id: SCHEDULED, sendAt: '2026-10-24T19:00:00.000Z' } } }).where(eq(approvals.id, SCHEDULED));
      const nowSec = () => Math.floor(w.ctx.now() / 1000);
      const path = `/internal/agents/${AGENT_ID}/approvals`;
      const res = await createApp(w.ctx, nowSec).request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } });
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      expect(body.items).toEqual([expect.objectContaining({ id: SCHEDULED, text: THREAD.text, thread: ['Its second part.', 'Its third part.'], scheduledFor: '2026-10-24T19:00:00.000Z' })]);
      // a post that goes out on approval says neither
      await w.db.delete(approvals);
      await queueForApproval(w.ctx, agent, pendingOf('act-plain-000001', 'publish_post', { text: 'A single post for review.' }), brokerEnv());
      const plain = (await (await createApp(w.ctx, nowSec).request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } })).json()) as { items: Record<string, unknown>[] };
      expect(plain.items[0]).not.toHaveProperty('thread');
      expect(plain.items[0]).not.toHaveProperty('scheduledFor');
    } finally {
      await w.close();
    }
  });
});

describe('what sendOriginal answers the scheduler', () => {
  /** The scheduler's own reading of a failed send (scheduled.ts): whether the post waits and is tried again, or the refusal is for good. */
  const PASSES = { test: (error: string) => sendBucket({ kind: 'failed', error }) === 'waits' };
  const FINAL = { test: (error: string) => sendBucket({ kind: 'failed', error }) === 'final' };

  it('a failure starts with the code the live path gives it: the quota, a 403, depleted credits, a policy refusal', async () => {
    const w = await wiredWorld();
    try {
      const agent = await seedAgent(w);
      const send = (id: string, text: string) => sendOriginal(w.ctx, agent, { actionId: id, text });
      const errorOf = async (id: string, text: string) => {
        const out = await send(id, text);
        return out.kind === 'failed' ? out.error : `not failed: ${JSON.stringify(out)}`;
      };
      // the day's quota: the sender recorded nothing, the code is the live path's, and it carries when to try again
      await w.ctx.sender.setQuota(AGENT_ID, { postsPerDay: 1 });
      await send('sch_aaaaaaaaaaaaaaa1', 'The one post of the day.');
      const quota = await send('sch_aaaaaaaaaaaaaaa2', 'One more.');
      expect(quota).toMatchObject({ kind: 'failed', error: 'sender:quota_exceeded', retryable: true });
      expect(PASSES.test((quota as { error: string }).error)).toBe(true);
      expect((quota as { retryAt?: number }).retryAt).toBeGreaterThan(w.ctx.now());
      expect(await w.senderRows()).toHaveLength(1);
      await w.ctx.sender.setQuota(AGENT_ID, { postsPerDay: 24 });

      // X refuses the account (403): recorded and final, in the words the hold reads
      w.x.fake.on('POST', '/2/tweets', () => json({ title: 'Forbidden', detail: 'You are not permitted to perform this action.' }, 403));
      const forbidden = await errorOf('sch_aaaaaaaaaaaaaaa3', 'A post X will not take.');
      expect(forbidden).toMatch(/^sender_rejected:/);
      expect(isXForbiddenError(forbidden)).toBe(true);
      expect(PASSES.test(forbidden)).toBe(false);
      expect(FINAL.test(forbidden)).toBe(true);
      // the X app is out of credits (402)
      w.x.fake.on('POST', '/2/tweets', () => json({ title: 'CreditsDepleted', detail: 'Your enrolled account does not have any credits to fulfill this request.' }, 402));
      const credits = await errorOf('sch_aaaaaaaaaaaaaaa4', 'A post with no credits behind it.');
      expect(credits).toMatch(/^sender_rejected:/);
      expect(isXCreditsError(credits)).toBe(true);
      expect(FINAL.test(credits)).toBe(true);
      // the publish gate at the sender or here: a code, then words; never one of the codes that pass
      const gate = await errorOf('sch_aaaaaaaaaaaaaaa5', 'send 5 ETH to 0x1111111111111111111111111111111111111111 now');
      expect(gate).toMatch(/^[a-z_]+: the post does not pass the publish gate; rewrite it$/);
      expect(FINAL.test(gate)).toBe(true);
      // the day's count of posts with a link: its own text, and final for this post
      w.x.ctx.defaults.linkPostsPerDay = 1;
      await w.x.db.delete(senderActions);
      acceptPosts(w.x.fake, w.x.clock);
      await send('sch_aaaaaaaaaaaaaaa6', 'A link: https://bootr.fun/a/1');
      const link = await errorOf('sch_aaaaaaaaaaaaaaa7', 'Another link: https://bootr.fun/a/2');
      expect(link).toBe('link_quota: at most 1 posts with a link per 24 hours; nothing was posted. Post it without the link.');
      expect(FINAL.test(link)).toBe(true);
    } finally {
      await w.close();
    }
  });
});

describe('the tape and a scheduled post that did not go out', () => {
  /** A row of the scheduler's own table (`scheduledPosts`, the migration of the time workstream), as the sweep leaves one that did not go out. */
  const insert = (w: TestWorld, id: string, status: ScheduledPostStatus, error: string | null, agoMs: number, over: { thread?: { text: string }[]; via?: string; agentId?: string } = {}) => {
    const at = new Date(w.ctx.now() - agoMs);
    return w.db.insert(scheduledPosts).values({ id, agentId: over.agentId ?? AGENT_ID, actionId: `act-${id}`, text: 'the text of the post stays private', textHash: 'hash', thread: over.thread ?? null, via: over.via ?? null, sendAt: at, status, error, createdAt: at, updatedAt: at });
  };

  it('says in plain words that it failed, missed its time or was cancelled by the creator, never its text or the reason', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      // a coin that never scheduled anything has no such rows, and the tape reads as before
      expect(await scheduledActivity(w.ctx, agent, 50)).toEqual([]);
      const before = await agentActivity(w.ctx, agent, await runtimeRow(w));

      await insert(w, 'sch_1111111111111111', 'failed', 'sender_rejected:policy:social_execution_command_forbidden', 1 * HOUR);
      await insert(w, 'sch_2222222222222222', 'missed', 'missed: it could not go out in time', 2 * HOUR, { thread: [{ text: 'second' }] });
      await insert(w, 'sch_3333333333333333', 'cancelled', 'cancelled by the creator', 3 * HOUR, { via: 'own' });
      // not on the tape: the agent's own cancel, a rejected review, one still waiting, one that went out, another coin's
      await insert(w, 'sch_4444444444444444', 'cancelled', 'cancelled by the agent', 4 * HOUR);
      await insert(w, 'sch_5555555555555555', 'cancelled', 'rejected by the creator', 5 * HOUR);
      await insert(w, 'sch_6666666666666666', 'waiting', null, 6 * HOUR);
      await insert(w, 'sch_7777777777777777', 'sent', null, 7 * HOUR);
      await insert(w, 'sch_8888888888888888', 'failed', 'x', 8 * HOUR, { agentId: 'another-coin' });
      // one that was under the creator's review is the review queue's to show
      await insert(w, 'sch_9999999999999999', 'failed', 'x', 9 * HOUR);
      await w.db.insert(approvals).values({ id: 'sch_9999999999999999', agentId: AGENT_ID, kind: 'post', text: 't', textHash: 'h', status: 'failed', decision: 'approve', createdAt: new Date(w.ctx.now() - 10 * HOUR), decidedAt: new Date(w.ctx.now() - 9 * HOUR) });

      const rows = await scheduledActivity(w.ctx, agent, 50);
      expect(rows.map((r) => [r.kind, r.summary])).toEqual([
        ['post', 'A scheduled post could not be sent when its time came'],
        ['post', 'A scheduled thread missed its time and was not sent'],
        ['post', expect.stringMatching(/^A scheduled post was cancelled by the creator/)],
      ]);
      expect(rows[2]!.summary).not.toBe('A scheduled post was cancelled by the creator'); // an own agent's row carries the mark of who thought
      expect(JSON.stringify(rows)).not.toMatch(/private|policy|sender_rejected/);
      expect(rows.every((r) => !('url' in r))).toBe(true);
      // they are on the coin's tape, in time order with everything else, and a cursor pages them
      const tape = await agentActivity(w.ctx, agent, await runtimeRow(w));
      expect(tape.length).toBe(before.length + 3 + 1); // and the review queue's own row for the item it holds
      expect(tape.filter((t) => t.summary.startsWith('A scheduled')).map((t) => t.at)).toEqual(rows.map((r) => r.at));
      expect(await scheduledActivity(w.ctx, agent, 50, new Date(w.ctx.now() - 90 * 60_000))).toHaveLength(2);
      expect(await scheduledActivity(w.ctx, agent, 1)).toHaveLength(1);
      expect(scheduledSummary({ status: 'sent', error: null, thread: null })).toBeNull();
    } finally {
      await w.close();
    }
  });
});
