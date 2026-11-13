/**
 * Scheduled posts (docs/design/agent-tools-2.md sections 5.3, 5.4 and 17.9): the sweep in the tick. A post goes out
 * once, at its time, only when a post sent now could go out at that moment; what is refused for good is told to the
 * agent once and never rewritten; what cannot go out in time is missed, never sent late; and no crash, retry or
 * unknown outcome sends anything twice.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api.js';
import { actions, approvals, notifications, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { postHooks } from '../src/post-send.js';
import { slotsUsed } from '../src/rhythm.js';
import { acquireLease, releaseLease } from '../src/runtime.js';
import { postScheduledSoon, scheduledSection, sendPasses, sendScheduled, sweepScheduled } from '../src/scheduled.js';
import { postsLast24h, tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, SUPERVISOR_KEY, makeWorld, seedAgent, type TestWorld } from './helpers.js';
import { HOUR, INTERVAL, MIN, agentRow, callTool, fakeSend, iso, patchConfig, patchState, resetHooks, rowOf, rowsOf, schedule, seedCoin, seedPost, seedRow, stateOf, type FakeSend } from './scheduled-helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const AT = T0 + 30 * MIN;

async function world(config: Record<string, string> = {}, agent: Record<string, unknown> = {}): Promise<{ w: TestWorld; fake: FakeSend }> {
  const w = await makeWorld({ config });
  await seedAgent(w, { config: agent, runtime: { nextAt: new Date(T0 + 12 * HOUR) } });
  return { w, fake: fakeSend(w) };
}

/** One post scheduled for `AT`, and the clock moved to a moment after it. */
async function dueWorld(config: Record<string, string> = {}, agent: Record<string, unknown> = {}) {
  const { w, fake } = await world(config, agent);
  const id = await schedule(w, 'The half past twelve thought.', AT);
  w.setNow(AT + 1000);
  return { w, fake, id };
}

const sentRows = async (w: TestWorld, agentId: string = AGENT_ID) => (await w.db.select().from(actions).where(eq(actions.agentId, agentId))).filter((r) => (r.action as { scheduled?: unknown }).scheduled);
const notSent = async (w: TestWorld) => ((await scheduledSection(w.ctx, AGENT_ID)) as { scheduled?: { notSent?: { id: string; message: string }[] } }).scheduled?.notSent ?? [];

afterEach(() => resetHooks());

describe('the sweep sends a post at its time, once', () => {
  it('nothing before its time; then one send, an ordinary post on the record, the cadence moved', async () => {
    const { w, fake } = await world();
    try {
      const id = await schedule(w, 'The half past twelve thought.', AT, { more: { topic: 'coin-page' } });
      w.setNow(AT - 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 0, missed: 0 });
      expect(fake.calls).toHaveLength(0);

      w.setNow(AT + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1, failed: 0, missed: 0, unknown: 0 });
      // the row's id is the sender's action id of the post
      expect(fake.calls).toEqual([{ actionId: id, text: 'The half past twelve thought.' }]);
      expect(fake.written).toEqual([id]);
      const row = await rowOf(w, id);
      expect(row).toMatchObject({ status: 'sent', postId: '7001', attempts: 1, error: null });
      // one `publish_post` row, as an approved post is recorded: every query of posts sees an ordinary post
      const [sent] = await sentRows(w);
      expect(sent).toMatchObject({ actionId: `${id}-sent`, status: 'completed', action: { tool: 'publish_post', input: { text: 'The half past twelve thought.', topic: 'coin-page' }, scheduled: { id } }, result: { postId: '7001', scheduledId: id }, receipt: { postId: '7001' } });
      expect(sent!.createdAt.getTime()).toBe(AT + 1000);
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(1);
      expect(await postsLast24h(w.ctx, AGENT_ID)).toMatchObject({ count: 1, lastPostAt: AT + 1000 });
      // the cadence anchor moved: the agent's next slot is one interval after this post
      expect((await stateOf(w)).lastPostAt).toBe(AT + 1000);

      // later ticks find nothing to do
      w.setNow(AT + 5 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0 });
      expect(fake.calls).toHaveLength(1);
      expect(await sentRows(w)).toHaveLength(1);
      // and nothing is told to the agent: a post that went out needs no word
      expect(await notSent(w)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('the tick runs the sweep, and the agent is not woken for the slot the post just took', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      const report = await tick(w.ctx);
      expect(fake.written).toEqual([id]);
      // no thought was bought: the slot is not due (the post went out a moment ago) and the agent's own wake is hours away
      expect(report.ran).toEqual([]);
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('two sends of the same post at the same moment make one write', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      const results = await Promise.all([sendScheduled(w.ctx, id), sendScheduled(w.ctx, id)]);
      expect(results.sort()).toEqual(['sent', 'waits']);
      expect(fake.written).toEqual([id]);
      expect(await sentRows(w)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('sent once when the sender is called twice: the second call is answered from the first one\'s receipt', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      // X takes the post and the answer never arrives
      fake.next = 'crash_after';
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, unknown: 1 });
      expect((await rowOf(w, id)).status).toBe('sending');
      // ...and the receipt cannot be read either, so the supervisor believes nothing was sent and sends the same id again
      const receipt = w.sender.client.receipt.bind(w.sender.client);
      w.sender.client.receipt = async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      };
      fake.next = 'sent';
      w.setNow(AT + 2 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      w.sender.client.receipt = receipt;
      expect(fake.calls).toHaveLength(2);
      // one write at X, one post on the record
      expect(fake.written).toEqual([id]);
      expect(await sentRows(w)).toHaveLength(1);
      expect(await rowOf(w, id)).toMatchObject({ status: 'sent', postId: '7001' });
    } finally {
      await w.close();
    }
  });

  it('a thread goes to the sender whole, with its picture, and what was sent of it is on the record', async () => {
    const { w, fake } = await world();
    try {
      const id = await schedule(w, 'A thread opens here.', AT, { more: { thread: [{ text: 'It goes on.' }, { text: 'And it ends.' }] } });
      const cut = await seedRow(w, AGENT_ID, AT + 3 * HOUR, { text: 'A second thread.', thread: [{ text: 'Part two.' }, { text: 'Part three.' }], imageId: 'img_1', via: 'own', clientId: 'cli_0123456789abcdef' });
      w.setNow(AT + 1000);
      await sweepScheduled(w.ctx);
      expect(fake.calls[0]).toEqual({ actionId: id, text: 'A thread opens here.', thread: [{ text: 'It goes on.' }, { text: 'And it ends.' }] });
      const [whole] = await sentRows(w);
      expect(whole).toMatchObject({ action: { input: { text: 'A thread opens here.', thread: [{ text: 'It goes on.' }, { text: 'And it ends.' }] } }, result: { sent: 3, of: 3, parts: [{ n: 1 }, { n: 2 }, { n: 3 }] } });

      // a thread that is cut stays cut, used its slot, and is recorded as the sender reported it; who thought is carried over
      fake.cutAfter = 2;
      w.setNow(AT + 3 * HOUR + 1000);
      await sweepScheduled(w.ctx);
      expect(fake.calls[1]).toMatchObject({ actionId: cut, imageId: 'img_1' });
      const second = (await sentRows(w)).find((r) => r.actionId === `${cut}-sent`)!;
      expect(second).toMatchObject({ status: 'completed', action: { via: 'own', clientId: 'cli_0123456789abcdef', input: { imageId: 'img_1' } }, result: { sent: 2, of: 3, cut: { n: 3 } } });
      expect((await rowOf(w, cut)).status).toBe('sent');
      expect((await stateOf(w)).lastPostAt).toBe(AT + 3 * HOUR + 1000);
    } finally {
      await w.close();
    }
  });
});

describe('a post found `sending` after a crash, in each of its three states', () => {
  it('a receipt that says sent closes it: nothing is sent again', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      fake.next = 'crash_after';
      await sweepScheduled(w.ctx);
      expect((await rowOf(w, id)).status).toBe('sending');
      expect(await sentRows(w)).toHaveLength(0);
      fake.next = 'sent';
      w.setNow(AT + 2 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(fake.calls).toHaveLength(1);
      expect(await rowOf(w, id)).toMatchObject({ status: 'sent', postId: '7001' });
      expect(await sentRows(w)).toHaveLength(1);
      expect((await stateOf(w)).lastPostAt).toBe(AT + 2 * MIN);
    } finally {
      await w.close();
    }
  });

  it('no receipt at all means nothing was sent: it waits again and goes out', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      // the process died after the row was marked and before the sender saw anything
      fake.next = 'lost';
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, unknown: 1 });
      expect((await rowOf(w, id)).status).toBe('sending');
      expect(fake.written).toEqual([]);
      fake.next = 'sent';
      w.setNow(AT + 2 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(fake.written).toEqual([id]);
      expect(await rowOf(w, id)).toMatchObject({ status: 'sent', attempts: 2 });
      // the same for a row a dead process left marked with no call made at all
      const orphan = await seedRow(w, AGENT_ID, AT + 3 * HOUR, { status: 'sending' });
      w.setNow(AT + 3 * HOUR + 1000);
      await sweepScheduled(w.ctx);
      expect(fake.written).toEqual([id, orphan]);
    } finally {
      await w.close();
    }
  });

  it('an unknown outcome waits for the sender: never sent again, and nothing else of the coin goes out meanwhile', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      createApp(w.ctx);
      fake.next = 'unknown';
      expect(await sweepScheduled(w.ctx)).toMatchObject({ unknown: 1 });
      fake.next = 'sent';
      for (const later of [2, 30, 90, 600]) {
        w.setNow(AT + later * MIN);
        expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 0 });
      }
      // ten hours on it is still not sent again and not missed: only a receipt decides
      expect(fake.calls).toHaveLength(1);
      expect((await rowOf(w, id)).status).toBe('sending');
      // a post sent now would land on top of one that may be out: refused; a second scheduled post waits behind it
      expect(await postHooks.beforeOriginalNow(w.ctx, await agentRow(w), w.ctx.now())).toBe(postScheduledSoon(AT));
      const next = await seedRow(w, AGENT_ID, w.ctx.now() - MIN);
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(1);
      expect((await rowOf(w, next)).status).toBe('waiting');
      // the creator sees it in the list and cannot cancel it
      expect((await callTool(w, 'scheduled_cancel', { id })).kind).toBe('failed');

      // the sender's reconciler settles it as sent: closed from the receipt
      w.sender.receipts[id] = { status: 'sent', providerPostId: '8888', error: null };
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(await rowOf(w, id)).toMatchObject({ status: 'sent', postId: '8888' });
      expect(fake.written).toEqual([]);
      expect(await sentRows(w)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('an unknown outcome the sender settles as refused fails the post, and the agent is told once', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      fake.next = 'unknown';
      await sweepScheduled(w.ctx);
      w.sender.receipts[id] = { status: 'rejected', providerPostId: null, error: 'duplicate_content' };
      w.setNow(AT + 5 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1 });
      expect(await rowOf(w, id)).toMatchObject({ status: 'failed', error: 'sender_rejected:duplicate_content' });
      expect((await notSent(w)).map((f) => f.message)).toEqual([`your scheduled post ${id} was not sent: sender_rejected:duplicate_content`]);
    } finally {
      await w.close();
    }
  });
});

describe('the grace: late is missed, never sent late', () => {
  it('a post that cannot go out is tried again on later ticks, missed after the grace, and told once', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      // the X account is not connected: nothing is recorded at the sender, so the same post may be tried again
      fake.next = { error: 'sender:not_connected' };
      for (const later of [0, 10, 59]) {
        w.setNow(AT + later * MIN + 1000);
        expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 0, missed: 0 });
        expect((await rowOf(w, id)).status).toBe('waiting');
      }
      expect(fake.calls).toHaveLength(3);
      // one minute past the hour of grace: missed, and the account coming back changes nothing
      fake.next = 'sent';
      w.setNow(AT + 60 * MIN + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 1 });
      expect(await rowOf(w, id)).toMatchObject({ status: 'missed' });
      w.setNow(AT + 3 * HOUR);
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(3);
      expect(fake.written).toEqual([]);
      // the slot stayed open: the cadence anchor never moved
      expect((await stateOf(w)).lastPostAt ?? null).toBeNull();
      expect((await notSent(w)).map((f) => f.message)).toEqual([`your scheduled post ${id} was not sent: its time passed before it could go out`]);
      expect(await notSent(w)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('the supervisor away for two hours sends nothing late', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      w.setNow(AT + 2 * HOUR);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 1 });
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(w, id)).status).toBe('missed');
    } finally {
      await w.close();
    }
  });

  it('knows which refusals pass by themselves and which are for good', () => {
    for (const error of ['original_sender_not_mounted: nothing was sent', 'sender:not_connected', 'sender:revoked', 'sender:quota_exceeded', 'sender:consent_lookup_failed', 'sender:rate_limited', 'sender:http_503', 'sender:storage_unavailable', 'no_slot: the window is full']) expect(sendPasses(error), error).toBe(true);
    for (const error of ['sender_rejected:forbidden(403): not permitted', 'sender_rejected:policy:social_execution_command_forbidden', 'sender:action_id_conflict', 'sender:account_mismatch', 'sender:storage_unavailable_after_send', 'image_not_found: img_1', 'invalid_original_post: the post does not pass the publish gate', 'link_quota: at most 3 posts with a link per 24 hours']) expect(sendPasses(error), error).toBe(false);
  });
});

describe('refused for good at send time', () => {
  it('the row fails with the reason, nothing is posted or rewritten, the slot stays open and the agent is told once', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      fake.next = { error: 'sender_rejected:policy:social_execution_command_forbidden' };
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 1 });
      const row = await rowOf(w, id);
      expect(row).toMatchObject({ status: 'failed', error: 'sender_rejected:policy:social_execution_command_forbidden', text: 'The half past twelve thought.', postId: null });
      expect(fake.written).toEqual([]);
      expect(await sentRows(w)).toHaveLength(0);
      // no hold: the gate refused the words, not the account; and the slot is still the agent's
      const state = await stateOf(w);
      expect(state.lastPostAt ?? null).toBeNull();
      expect(state.postForbiddenUntil ?? null).toBeNull();
      // later ticks do not try again, with or without the gate's change of mind
      fake.next = 'sent';
      w.setNow(AT + 10 * MIN);
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(1);
      const told = await notSent(w);
      expect(told).toEqual([{ id, sendAt: iso(AT), text: 'The half past twelve thought.', message: `your scheduled post ${id} was not sent: sender_rejected:policy:social_execution_command_forbidden` }]);
      expect(await notSent(w)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('a 403 sets the hold and the creator\'s notice, as for a post sent now, and the coin\'s other posts wait behind the hold', async () => {
    const { w, fake, id } = await dueWorld({}, { postIntervalMs: 30 * MIN });
    try {
      const later = await seedRow(w, AGENT_ID, AT + 40 * MIN);
      fake.next = { error: 'sender_rejected:forbidden(403): You are not permitted to perform this action.' };
      expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1 });
      expect((await rowOf(w, id)).status).toBe('failed');
      const state = await stateOf(w);
      expect(state.postForbiddenUntil).toBe(AT + 1000 + 6 * HOUR);
      expect(state.postForbiddenStrikes).toBe(1);
      const open = await w.db.select().from(notifications).where(and(eq(notifications.agentId, AGENT_ID), eq(notifications.event, 'x_forbidden'), isNull(notifications.resolvedAt)));
      expect(open).toHaveLength(1);
      // while X refuses the account nothing more is handed to the sender; the later post is missed, not sent into the hold
      fake.next = 'sent';
      w.setNow(AT + 41 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0 });
      expect(fake.calls).toHaveLength(1);
      w.setNow(AT + 101 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ missed: 1 });
      expect((await rowOf(w, later)).status).toBe('missed');
    } finally {
      await w.close();
    }
  });

  it('X out of credits holds the account the same way', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      fake.next = { error: 'sender_rejected:http_402(402): credits depleted' };
      expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1 });
      expect((await rowOf(w, id)).status).toBe('failed');
      expect((await stateOf(w)).postCreditsUntil).toBe(AT + 1000 + 30 * MIN);
    } finally {
      await w.close();
    }
  });

  it('a used-up daily quota sets its hold; the post waits and goes out when the quota opens inside the grace', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      fake.next = { error: 'sender:quota_exceeded', retryAt: AT + 20 * MIN };
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 0 });
      expect((await rowOf(w, id)).status).toBe('waiting');
      expect((await stateOf(w)).postQuotaUntil).toBe(AT + 20 * MIN);
      // the quota is the sender's count, so the scheduled post added nothing to it; while the hold stands the sender is not asked
      fake.next = 'sent';
      w.setNow(AT + 10 * MIN);
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(1);
      w.setNow(AT + 21 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect((await stateOf(w)).postQuotaUntil ?? null).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('asks the question quota and the day\'s threads again at the moment of sending', async () => {
    const { w, fake } = await world({}, { postIntervalMs: 30 * MIN });
    try {
      const question = await schedule(w, 'What would you build first?', AT + 2 * HOUR);
      // between scheduling and sending, a post sent now asked a question
      await seedPost(w, AT, 'Builders, what is yours?');
      w.setNow(AT + 2 * HOUR + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1 });
      expect((await rowOf(w, question)).error).toMatch(/^question_quota: /);
      expect(fake.calls).toHaveLength(0);

      const thread = await seedRow(w, AGENT_ID, AT + 5 * HOUR, { text: 'A third thread of the day.', thread: [{ text: 'Its second part.' }] });
      await seedPost(w, AT + 3 * HOUR, 'First thread, sent now.', { thread: ['Two.'] });
      await seedPost(w, AT + 4 * HOUR, 'Second thread, sent now.', { thread: ['Two.'] });
      w.setNow(AT + 5 * HOUR + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1 });
      expect((await rowOf(w, thread)).error).toBe('thread_daily_cap: at most 2 threads per 24 hours; nothing was sent.');
      expect(fake.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });
});

describe('at send time a scheduled post passes what a post sent now passes', () => {
  it('a paused coin sends nothing; resumed inside the grace the post goes out, otherwise it is missed', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      await w.db.update(runtimes).set({ status: 'paused', pausedBy: 'guardian' }).where(eq(runtimes.agentId, AGENT_ID));
      await sweepScheduled(w.ctx);
      expect(await sendScheduled(w.ctx, id)).toBe('waits');
      expect(fake.calls).toHaveLength(0);
      // the creator sees it and can cancel it while the coin is paused
      expect((await rowOf(w, id)).status).toBe('waiting');
      await w.db.update(runtimes).set({ status: 'waiting', pausedBy: null }).where(eq(runtimes.agentId, AGENT_ID));
      w.setNow(AT + 20 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });

      const second = await seedRow(w, AGENT_ID, AT + 4 * HOUR);
      await w.db.update(runtimes).set({ status: 'paused', pausedBy: 'operator' }).where(eq(runtimes.agentId, AGENT_ID));
      w.setNow(AT + 4 * HOUR + 61 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 1 });
      expect((await rowOf(w, second)).status).toBe('missed');
      expect(fake.calls).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('waits while an X hold stands, while a live action waits for its receipt, and while the agent is not active', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      await patchState(w, { postForbiddenUntil: AT + 30 * MIN, postForbiddenStrikes: 1 });
      await sweepScheduled(w.ctx);
      expect(await sendScheduled(w.ctx, id)).toBe('waits');
      await patchState(w, { postForbiddenUntil: null, postCreditsUntil: AT + 30 * MIN });
      expect(await sendScheduled(w.ctx, id)).toBe('waits');
      await patchState(w, { postCreditsUntil: null });

      await w.db.update(runtimes).set({ status: 'held', pending: { id: 'act_live', status: 'held', action: { tool: 'publish_post', input: { text: 'x' } } } }).where(eq(runtimes.agentId, AGENT_ID));
      await sweepScheduled(w.ctx);
      expect(await sendScheduled(w.ctx, id)).toBe('waits');
      await w.db.update(runtimes).set({ status: 'waiting', pending: null }).where(eq(runtimes.agentId, AGENT_ID));

      expect(fake.calls).toHaveLength(0);
      w.setNow(AT + 5 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
    } finally {
      await w.close();
    }
  });

  it('waits while the power to post is off or the creator paused original posts', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      const caps = (await agentRow(w)).config.capabilities as object;
      await patchConfig(w, { capabilities: { ...caps, xPublish: false } });
      await sweepScheduled(w.ctx);
      expect(await sendScheduled(w.ctx, id)).toBe('waits');
      await patchConfig(w, { capabilities: caps, ownerRules: [{ id: 'original-posts-paused', text: 'no originals for now', enabled: true }] });
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(0);
      await patchConfig(w, { ownerRules: [] });
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
    } finally {
      await w.close();
    }
  });

  it('never races a turn or a switch: with the lease taken or a turn stored, the post waits', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      // somebody holds the runtime lease (a client's call, a runner switch, the tick on this coin)
      expect(await acquireLease(w.ctx, AGENT_ID, 'somebody-else')).not.toBeNull();
      await sweepScheduled(w.ctx);
      expect(await sendScheduled(w.ctx, id)).toBe('waits');
      await releaseLease(w.ctx, AGENT_ID, 'somebody-else');
      // a turn is stored: it began before this post would go out, and could post into the same slot after it
      await w.db.update(runtimes).set({ status: 'running', turn: { startedAt: AT, steps: 1, nudged: false, reasons: ['original_post_due'], messages: [], inbox: {}, recentSteps: [], postDue: true } }).where(eq(runtimes.agentId, AGENT_ID));
      await sweepScheduled(w.ctx);
      expect(await sendScheduled(w.ctx, id)).toBe('waits');
      expect(fake.calls).toHaveLength(0);
      await w.db.update(runtimes).set({ status: 'waiting', turn: null }).where(eq(runtimes.agentId, AGENT_ID));
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      // the sweep gave the lease back
      expect((await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.leaseToken).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('waits while the last original is younger than one interval, whoever sent it', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      // the creator asked for a post by hand a quarter of an hour before the scheduled one (a request may break the cadence, a scheduled post may not)
      await seedPost(w, AT - 15 * MIN, 'The post the creator asked for.', { anchor: false });
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(w, id)).status).toBe('waiting');
      // one interval after that post is past the grace of this one: missed, not squeezed in
      w.setNow(AT + 61 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ missed: 1 });
      expect(fake.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('respects the platform\'s window of original posts and its quiet hours', async () => {
    const { w, fake, id } = await dueWorld({ PLATFORM_QUIET_HOURS_UTC: '14-15' }, { postIntervalMs: 30 * MIN });
    try {
      // three originals of other agents in the last ten minutes: the window is full
      for (const n of [1, 2, 3]) await seedPost(w, AT - n * MIN, `Another agent's post ${n}.`, { agentId: `other${n}`, anchor: false });
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0 });
      expect(await sendScheduled(w.ctx, id)).toBe('window');
      expect(fake.calls).toHaveLength(0);
      w.setNow(AT + 11 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      // a post held up into the quiet hours waits them out, and is missed when they outlast its grace
      const late = await seedRow(w, AGENT_ID, Date.parse('2026-10-24T13:59:00Z'), { updatedAt: new Date(T0) });
      w.setNow(Date.parse('2026-10-24T14:00:30Z'));
      expect(await sendScheduled(w.ctx, late)).toBe('window');
      w.setNow(Date.parse('2026-10-24T15:00:30Z'));
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 1 });
      expect(fake.calls).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('approval mode switched on after scheduling: the post goes to the creator first, not to X', async () => {
    const { w, fake, id } = await dueWorld();
    try {
      await patchConfig(w, { requireApproval: true });
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, toReview: 1 });
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(w, id)).status).toBe('waiting_review');
      const item = await w.db.query.approvals.findFirst({ where: eq(approvals.id, id) });
      expect(item).toMatchObject({ kind: 'post', status: 'pending_approval', text: 'The half past twelve thought.', meta: { scheduled: { id, sendAt: iso(AT) } } });
    } finally {
      await w.close();
    }
  });

  it('with the posting workstream\'s sender not mounted nothing is sent and nothing is lost before the grace', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w, { runtime: { nextAt: new Date(T0 + 12 * HOUR) } });
      const id = await schedule(w, 'The half past twelve thought.', AT);
      w.setNow(AT + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 0, missed: 0 });
      expect(await rowOf(w, id)).toMatchObject({ status: 'waiting', error: 'original_sender_not_mounted: nothing was sent' });
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });
});

describe('the creator\'s list and cancel', () => {
  function api(w: TestWorld) {
    const nowSec = () => Math.floor(w.ctx.now() / 1000);
    const app = createApp(w.ctx, nowSec);
    const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      const res = await app.request(path, { method, ...(body === undefined ? {} : { body: text }), headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, method, path, text, nowSec()) } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { call, app };
  }

  it('lists the waiting posts with every part, and cancels one for the creator alone', async () => {
    const { w, fake } = await world();
    try {
      const { call, app } = api(w);
      const id = await schedule(w, 'A thread opens here.', AT, { more: { thread: [{ text: 'It goes on.' }] } });
      const other = await schedule(w, 'A later thought.', AT + 3 * HOUR);
      const list = await call('GET', `/internal/agents/${AGENT_ID}/scheduled`);
      expect(list).toEqual({
        status: 200,
        body: {
          items: [
            { id, sendAt: iso(AT), status: 'waiting', text: 'A thread opens here.', parts: 2, picture: false, thread: ['It goes on.'] },
            { id: other, sendAt: iso(AT + 3 * HOUR), status: 'waiting', text: 'A later thought.', parts: 1, picture: false, thread: [] },
          ],
          mayQueue: 4,
        },
      });
      // behind the HMAC like every internal route
      expect((await app.request(`/internal/agents/${AGENT_ID}/scheduled`)).status).toBe(401);
      expect((await call('GET', '/internal/agents/nobody/scheduled')).status).toBe(404);

      const path = `/internal/agents/${AGENT_ID}/scheduled/${id}/cancel`;
      expect((await call('POST', path, { by: '0x4000000000000000000000000000000000000009' })).status).toBe(403);
      expect((await call('POST', path, { by: 'nobody' })).status).toBe(400);
      expect((await call('POST', path, {})).status).toBe(400);
      expect((await call('POST', `/internal/agents/${AGENT_ID}/scheduled/not-an-id/cancel`, { by: CREATOR })).status).toBe(400);
      expect((await rowOf(w, id)).status).toBe('waiting');
      // another coin's creator route cannot reach this coin's post
      await seedCoin(w, 4);
      expect((await call('POST', `/internal/agents/coin4/scheduled/${id}/cancel`, { by: CREATOR })).status).toBe(404);

      const cancelled = await call('POST', path, { by: CREATOR });
      expect(cancelled.status).toBe(200);
      expect((cancelled.body.items as { id: string }[]).map((i) => i.id)).toEqual([other]);
      expect(cancelled.body.mayQueue).toBe(5);
      expect(await rowOf(w, id)).toMatchObject({ status: 'cancelled', error: 'cancelled by the creator' });
      expect((await call('POST', path, { by: CREATOR })).status).toBe(404);
      // it is never sent, and the agent hears once that its creator cancelled it
      w.setNow(AT + 1000);
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(0);
      expect((await notSent(w)).map((f) => f.message)).toEqual([`your scheduled post ${id} was not sent: your creator cancelled it`]);
      expect(await notSent(w)).toEqual([]);
    } finally {
      await w.close();
    }
  });
});

describe('many coins at once', () => {
  it('the platform\'s window bounds the sweep: three go out, the rest wait their turn, none twice', async () => {
    const { w, fake } = await world();
    try {
      const rows: string[] = [];
      for (let n = 1; n <= 12; n++) rows.push(await seedRow(w, await seedCoin(w, n), T0 - MIN));
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 3 });
      expect(fake.calls).toHaveLength(3);
      // the same minute again: the window is full, nobody is even asked
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0 });
      expect(fake.calls).toHaveLength(3);
      w.setNow(T0 + 11 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 3 });
      w.setNow(T0 + 22 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 3 });
      expect(new Set(fake.written).size).toBe(9);
      expect(fake.calls).toHaveLength(9);
      // the last three are past their grace by the time the window opens for them: missed, not sent late
      w.setNow(T0 + 60 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 3 });
      expect(fake.calls).toHaveLength(9);
      for (const id of rows) expect(['sent', 'missed']).toContain((await rowOf(w, id)).status);
    } finally {
      await w.close();
    }
  });

  it('one tick sends at most SCHEDULED_SENDS_PER_TICK', async () => {
    const { w, fake } = await world({ PLATFORM_POST_SLOTS_PER_10M: '50' });
    try {
      for (let n = 1; n <= 8; n++) await seedRow(w, await seedCoin(w, n), T0 - MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 5 });
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 3 });
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0 });
      expect(new Set(fake.written).size).toBe(8);
    } finally {
      await w.close();
    }
  });

  it('a crowd of paused coins takes no place in the line: the coin that can send goes out at once', async () => {
    const { w, fake } = await world({ PLATFORM_POST_SLOTS_PER_10M: '50' });
    try {
      for (let n = 1; n <= 80; n++) await seedRow(w, await seedCoin(w, n, { runtime: { status: 'paused', pausedBy: 'guardian' } }), T0 - 20 * MIN);
      const ready = await seedRow(w, await seedCoin(w, 900), T0 - MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(fake.written).toEqual([ready]);
    } finally {
      await w.close();
    }
  }, 60_000);

  it('coins that cannot send now do not starve the one that can: it is reached on the next tick at the latest', async () => {
    const { w, fake } = await world({ PLATFORM_POST_SLOTS_PER_10M: '50' });
    try {
      // sixty coins whose X quota is used up, each with a due post that was scheduled before the one coin that can send
      for (let n = 1; n <= 60; n++) await seedRow(w, await seedCoin(w, n, { state: { postQuotaUntil: T0 + 5 * HOUR } }), T0 - 20 * MIN);
      const ready = await seedRow(w, await seedCoin(w, 900), T0 - MIN);
      await sweepScheduled(w.ctx);
      w.setNow(T0 + MIN);
      await sweepScheduled(w.ctx);
      expect(fake.written).toEqual([ready]);
      // and nobody was asked to send for a coin on hold
      expect(fake.calls).toHaveLength(1);
    } finally {
      await w.close();
    }
  }, 60_000);

  it('a full queue of one coin cannot beat its cadence: one post per interval, however many are due', async () => {
    const { w, fake } = await world({}, { postIntervalMs: 30 * MIN });
    try {
      // two posts whose times both lie behind the clock (the supervisor was away for forty minutes)
      const first = await seedRow(w, AGENT_ID, T0 - 40 * MIN);
      const second = await seedRow(w, AGENT_ID, T0 - 5 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(fake.written).toEqual([first]);
      for (const later of [1, 10, 29]) {
        w.setNow(T0 + later * MIN);
        await sweepScheduled(w.ctx);
      }
      expect(fake.written).toEqual([first]);
      w.setNow(T0 + 30 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(fake.written).toEqual([first, second]);
      const times = (await sentRows(w)).map((r) => r.createdAt.getTime()).sort((a, b) => a - b);
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(30 * MIN);
      expect(INTERVAL).toBeGreaterThan(30 * MIN);
    } finally {
      await w.close();
    }
  });

  it('holds the rows of every coin apart', async () => {
    const { w, fake } = await world();
    try {
      const mine = await schedule(w, 'The test agent\'s thought.', AT);
      const coin = await seedCoin(w, 7);
      const theirs = await schedule(w, 'Another coin\'s thought.', AT, { agentId: coin });
      w.setNow(AT + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 2 });
      expect(fake.written.sort()).toEqual([mine, theirs].sort());
      expect((await rowsOf(w, coin)).map((r) => r.id)).toEqual([theirs]);
      expect((await sentRows(w, coin)).map((r) => r.actionId)).toEqual([`${theirs}-sent`]);
      expect((await stateOf(w, coin)).lastPostAt).toBe(AT + 1000);
    } finally {
      await w.close();
    }
  });
});
