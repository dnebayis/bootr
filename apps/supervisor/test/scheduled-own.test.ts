/**
 * Scheduled posts of an own agent (docs/design/agent-tools-2.md sections 5.5 and 5.6; byo-agent.md sections 5.3 and
 * 7.1): one turn of the creator's client queues the day and the tick sends each post at its time with no model and no
 * client. Through the real run routes with a credential made by the real grant routes; a model call throws.
 */
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { DueView } from '@bootr/shared/own-agent';
import { actions, approvals, runtimes } from '../src/db/schema.js';
import { switchRunner } from '../src/own/runner-switch.js';
import { sweepScheduled } from '../src/scheduled.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, seedAgent } from './helpers.js';
import { act, connectClient, finishInput, openSocial, ownWorld, quietRuntime, seedOwn, type OwnWorld } from './own-helpers.js';
import { HOUR, MIN, agentRow, fakeSend, iso, resetHooks, rowOf, rowsOf, schedule, seedRow, stateOf, type FakeSend } from './scheduled-helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');

/** An own coin with nothing due, one connected client, and a turn the creator asked for by hand. */
async function setup(agent: Record<string, unknown> = {}): Promise<{ w: OwnWorld; fake: FakeSend; credential: string; clientId: string; turnId: string }> {
  const w = await ownWorld();
  const quiet = quietRuntime(w.ctx.now());
  await seedOwn(w, { config: { ...quiet.config, ...agent }, runtime: quiet.runtime });
  const fake = fakeSend(w);
  const { credential, clientId } = await connectClient(w);
  const turn = await openSocial(w, credential, { reason: 'creator_asked' });
  return { w, fake, credential, clientId, turnId: turn.turnId };
}

const sentRows = async (w: OwnWorld) => (await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => (r.action as { scheduled?: unknown }).scheduled);

afterEach(() => resetHooks());

describe('an own agent queues its day in one turn', () => {
  it('schedule_post needs no due slot and is not the turn\'s one original; the tick sends each post with no client and no model', async () => {
    const { w, fake, credential, clientId, turnId } = await setup();
    try {
      // the turn holds the three tools
      const again = await openSocial(w, credential);
      for (const tool of ['schedule_post', 'scheduled_list', 'scheduled_cancel']) expect(again.tools).toContain(`bootr_agent_${tool}`);
      expect(again.observation).toHaveProperty('scheduled');

      const times = [T0 + HOUR, T0 + 3 * HOUR, T0 + 5 * HOUR];
      const ids: string[] = [];
      for (const [i, at] of times.entries()) {
        const res = await act(w, credential, turnId, 'schedule_post', { text: `Thought ${i + 1} of the day, each its own.`, sendAt: iso(at) });
        expect(res.body).toMatchObject({ status: 'completed', result: { status: 'waiting', sendAt: iso(at), waiting: i + 1 } });
        ids.push((res.body.result as { scheduledId: string }).scheduledId);
      }
      // an original sent now still needs its slot: scheduling opened no door for it
      const now = await act(w, credential, turnId, 'publish_post', { text: 'And one right now, please.' });
      expect(now.body.status).toBe('failed');
      expect(now.body.error).toMatch(/^post_slot_not_due: /);
      // the spacing is held for a client as for a model: a fourth one too near the third is a failed result, in the contract's words
      const near = await act(w, credential, turnId, 'schedule_post', { text: 'Squeezed in between.', sendAt: iso(T0 + 4 * HOUR) });
      expect(near.body.status).toBe('failed');
      expect(near.body.error).toMatch(/^schedule_time: sendAt is less than one post interval \(2 hours\) from your scheduled post sch_[0-9a-f]{16} at /);
      // who thought is on the row
      for (const row of await rowsOf(w)) expect(row).toMatchObject({ via: 'own', clientId, status: 'waiting' });
      expect((await w.run('finish', credential, { turnId, ...finishInput(w) })).status).toBe(200);
      expect(w.sender.published).toHaveLength(0);

      // the client is gone; the tick sends each post at its time
      for (const [i, at] of times.entries()) {
        w.setNow(at + 1000);
        await tick(w.ctx);
        expect(fake.written).toEqual(ids.slice(0, i + 1));
      }
      expect(w.modelCalls()).toBe(0);
      const sent = await sentRows(w);
      expect(sent).toHaveLength(3);
      for (const row of sent) expect(row.action).toMatchObject({ tool: 'publish_post', via: 'own', clientId });
      expect((await stateOf(w)).lastPostAt).toBe(times[2]! + 1000);
      // no turn was opened for any of it
      expect((await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.turn).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('a client that repeats the same call makes one row, and one that scripts the routes cannot fill the queue past six', async () => {
    const { w, credential, turnId } = await setup({ postIntervalMs: 30 * MIN });
    try {
      const input = { text: 'Said once, however often it is sent.', sendAt: iso(T0 + HOUR) };
      const first = await act(w, credential, turnId, 'schedule_post', input);
      const second = await act(w, credential, turnId, 'schedule_post', input);
      expect(second.body).toMatchObject({ status: 'completed', actionId: first.body.actionId });
      expect(await rowsOf(w)).toHaveLength(1);
      // more steps than a turn has are refused by the engine; more posts than six by the queue, across turns
      for (let i = 1; i <= 5; i++) await seedRow(w, AGENT_ID, T0 + HOUR + i * HOUR, { via: 'own' });
      const seventh = await act(w, credential, turnId, 'schedule_post', { text: 'A seventh one.', sendAt: iso(T0 + 10 * HOUR) });
      expect(seventh.body).toMatchObject({ status: 'failed', error: 'schedule_full: 6 posts are already waiting, the most allowed; nothing was scheduled. Cancel one or wait.' });
      // another coin's post is not this client's to cancel
      const foreign = await seedRow(w, 'somebody-else', T0 + 2 * HOUR);
      expect((await act(w, credential, turnId, 'scheduled_cancel', { id: foreign })).body).toMatchObject({ status: 'failed', error: `scheduled_not_found: you have no waiting post ${foreign}.` });
      expect((await rowOf(w, foreign)).status).toBe('waiting');
    } finally {
      await w.close();
    }
  });

  it('in approval mode every scheduled post goes to the creator, without the one-per-slot rule of posts sent now', async () => {
    const { w, fake, credential, turnId } = await setup({ requireApproval: true });
    try {
      for (const [i, h] of [1, 3, 5].entries()) {
        const res = await act(w, credential, turnId, 'schedule_post', { text: `For review, thought ${i + 1}.`, sendAt: iso(T0 + h * HOUR) });
        expect(res.body).toMatchObject({ status: 'completed', result: { status: 'waiting_review' } });
      }
      const queued = await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID));
      expect(queued.map((a) => [a.kind, a.status])).toEqual([['post', 'pending_approval'], ['post', 'pending_approval'], ['post', 'pending_approval']]);
      await w.run('finish', credential, { turnId, ...finishInput(w) });
      // the creator approves the first; it goes out at its time with the client away
      const first = (await rowsOf(w))[0]!;
      expect((await w.call('POST', `/internal/agents/${AGENT_ID}/approvals/${first.id}`, { decision: 'approve', by: CREATOR })).status).toBe(200);
      w.setNow(T0 + HOUR + 1000);
      await sweepScheduled(w.ctx);
      expect(fake.written).toEqual([first.id]);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });
});

describe('an own agent\'s slot and its turn', () => {
  it('a slot that a scheduled post covers is not told to the client as due', async () => {
    const w = await ownWorld();
    try {
      // the slot is due: the coin never posted
      await seedOwn(w, { runtime: { nextAt: new Date(T0 + 6 * HOUR) } });
      const { credential } = await connectClient(w);
      const open = await w.run<DueView>('due', credential);
      expect(open.body.social).toMatchObject({ due: true });
      expect(open.body.social.reasons).toContain('original_post_due');
      await seedRow(w, AGENT_ID, T0 + 90 * MIN, { via: 'own' });
      w.setNow(T0 + MIN);
      const covered = await w.run<DueView>('due', credential);
      expect(covered.body.social.reasons).not.toContain('original_post_due');
      expect(covered.body.social.due).toBe(false);
      // and a turn cannot be opened for it
      expect((await w.run('turn', credential, { role: 'social' })).status).not.toBe(200);
    } finally {
      await w.close();
    }
  });

  it('while the client\'s turn is open nothing is sent under it; once it is finished the post goes out', async () => {
    const { w, fake, credential, turnId } = await setup();
    try {
      const id = await seedRow(w, AGENT_ID, T0 + MIN, { via: 'own' });
      w.setNow(T0 + 2 * MIN);
      await sweepScheduled(w.ctx);
      await tick(w.ctx);
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(w, id)).status).toBe('waiting');
      expect((await w.run('finish', credential, { turnId, ...finishInput(w) })).status).toBe(200);
      w.setNow(T0 + 3 * MIN);
      await sweepScheduled(w.ctx);
      expect(fake.written).toEqual([id]);
      // the next turn finds the slot used: an original sent now is refused
      const next = await openSocial(w, credential, { reason: 'creator_asked' });
      expect((await act(w, credential, next.turnId, 'publish_post', { text: 'One more right after.' })).body.error).toMatch(/^post_slot_not_due: /);
    } finally {
      await w.close();
    }
  });
});

describe('who runs the coin', () => {
  it('with the own-agent flag off an own coin is silent: its waiting posts wait and are missed', async () => {
    const w = await ownWorld({ flag: false });
    try {
      await seedOwn(w, { runtime: { nextAt: new Date(T0 + 6 * HOUR) } });
      const fake = fakeSend(w);
      const id = await seedRow(w, AGENT_ID, T0 + 10 * MIN, { via: 'own' });
      for (const later of [11, 30, 69]) {
        w.setNow(T0 + later * MIN);
        await tick(w.ctx);
      }
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(w, id)).status).toBe('waiting');
      w.setNow(T0 + 71 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 1 });
      expect((await rowOf(w, id)).status).toBe('missed');
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('a switch between the Bootr agent and an own agent changes nothing in the queue', async () => {
    const w = await ownWorld();
    try {
      const hosted = await seedAgent(w, { runtime: { nextAt: new Date(T0 + 12 * HOUR) } });
      const fake = fakeSend(w);
      const first = await schedule(w, 'Scheduled by the Bootr agent, part one.', T0 + HOUR);
      const second = await schedule(w, 'Scheduled by the Bootr agent, part two.', T0 + 4 * HOUR);
      const before = await rowsOf(w);

      // to the creator's own client: no client is connected, the coin is silent, and the queue is as it was
      const toOwn = await switchRunner(w.ctx, hosted, { runner: 'own', by: CREATOR, allowedModels: [String(hosted.config.model)] }, { leaseWaitMs: 60, leasePollMs: 10 });
      expect(toOwn.ok).toBe(true);
      expect(await rowsOf(w)).toEqual(before);
      // the switch gave the lease back, and the post goes out at its time: sending needs no model and no client
      w.setNow(T0 + HOUR + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(fake.written).toEqual([first]);
      expect(w.modelCalls()).toBe(0);

      // and back to the Bootr agent: the second post is still the coin's
      const toHosted = await switchRunner(w.ctx, await agentRow(w), { runner: 'hosted', by: CREATOR, allowedModels: [String(hosted.config.model)] }, { leaseWaitMs: 60, leasePollMs: 10 });
      expect(toHosted.ok).toBe(true);
      expect((await rowOf(w, second)).status).toBe('waiting');
      w.setNow(T0 + 4 * HOUR + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(fake.written).toEqual([first, second]);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('a switch in progress holds the lease, so the post waits for it and is sent after', async () => {
    const w = await ownWorld();
    try {
      await seedAgent(w, { runtime: { nextAt: new Date(T0 + 12 * HOUR) } });
      const fake = fakeSend(w);
      const id = await seedRow(w, AGENT_ID, T0 - MIN);
      // the lease as the switch takes it (own/runner-switch.ts)
      await w.db.update(runtimes).set({ leaseToken: 'runner-switch:test', leaseUntil: new Date(T0 + 5 * MIN) }).where(eq(runtimes.agentId, AGENT_ID));
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(0);
      await w.db.update(runtimes).set({ leaseToken: null, leaseUntil: null }).where(eq(runtimes.agentId, AGENT_ID));
      await sweepScheduled(w.ctx);
      expect(fake.written).toEqual([id]);
    } finally {
      await w.close();
    }
  });
});
