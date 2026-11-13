/**
 * Scheduled posts in approval mode (docs/design/agent-tools-2.md section 5.5): the creator reads a post ahead of its
 * time. Approved in time it goes out at its time; approved inside the grace, at once; not approved by the end of the
 * grace it expires; rejected, it is cancelled and the agent hears the note. Through the real approvals route.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { listApprovals, takeFeedback, textHash } from '../src/approvals.js';
import { actions, approvals, notifications } from '../src/db/schema.js';
import { scheduledSection, sweepScheduled } from '../src/scheduled.js';
import { AGENT_ID, CREATOR, makeWorld, seedAgent } from './helpers.js';
import { withRoutes } from './own-helpers.js';
import { HOUR, MIN, agentRow, callTool, errorOf, fakeSend, iso, patchConfig, resetHooks, resultOf, rowOf, rowsOf, schedule, stateOf } from './scheduled-helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const AT = T0 + 2 * HOUR;
const TEXT = 'A thought the creator reads before it goes out.';

async function setup() {
  const w = withRoutes(await makeWorld());
  await seedAgent(w, { config: { requireApproval: true }, runtime: { nextAt: new Date(T0 + 12 * HOUR) } });
  const fake = fakeSend(w);
  const id = await schedule(w, TEXT, AT);
  const decide = (decision: 'approve' | 'reject', body: Record<string, unknown> = {}) => w.call<Record<string, unknown>>('POST', `/internal/agents/${AGENT_ID}/approvals/${id}`, { decision, by: CREATOR, ...body });
  const item = async () => (await w.db.query.approvals.findFirst({ where: eq(approvals.id, id) }))!;
  const notSent = async () => ((await scheduledSection(w.ctx, AGENT_ID)) as { scheduled?: { notSent?: unknown[] } }).scheduled?.notSent ?? [];
  return { w, fake, id, decide, item, notSent };
}

afterEach(() => resetHooks());

describe('a scheduled post in approval mode', () => {
  it('goes to the creator\'s review when it is scheduled, and is not sent unreviewed when its time comes', async () => {
    const { w, fake, id, item } = await setup();
    try {
      const row = await rowOf(w, id);
      expect(row.status).toBe('waiting_review');
      // one item in the review queue, under the post's own id, marked as a scheduled one
      expect(await item()).toMatchObject({ id, agentId: AGENT_ID, kind: 'post', text: TEXT, status: 'pending_approval', meta: { scheduled: { id, sendAt: iso(AT) } } });
      expect((await listApprovals(w.ctx, await agentRow(w))).items.map((i) => i.id)).toEqual([id]);
      // the creator is told at once that something waits, through the notice that exists for it
      expect(await w.db.select().from(notifications).where(and(eq(notifications.agentId, AGENT_ID), eq(notifications.event, 'review_waiting'), isNull(notifications.resolvedAt)))).toHaveLength(1);
      // what the agent is told, and what its list shows
      const again = await callTool(w, 'schedule_post', { text: 'A second one for the evening.', sendAt: iso(AT + 4 * HOUR) });
      expect(resultOf(again)).toMatchObject({ status: 'waiting_review', waiting: 2, mayQueue: 4 });
      expect(resultOf<{ note: string }>(again).note).toContain("your creator's review");
      expect(resultOf<{ items: { status: string }[] }>(await callTool(w, 'scheduled_list', {})).items.map((i) => i.status)).toEqual(['waiting_review', 'waiting_review']);

      w.setNow(AT + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 0, missed: 0 });
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(w, id)).status).toBe('waiting_review');
    } finally {
      await w.close();
    }
  });

  it('reviewed in time: it goes out at its time, not before', async () => {
    const { w, fake, id, decide, item } = await setup();
    try {
      w.setNow(T0 + 10 * MIN);
      const approved = await decide('approve');
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ id, kind: 'post', status: 'approved', decision: 'approve', postId: null, text: TEXT });
      expect((await rowOf(w, id)).status).toBe('waiting');
      // approving is not sending: the post waits for its own time
      expect(fake.calls).toHaveLength(0);
      w.setNow(AT - MIN);
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(0);
      // a second decision changes nothing
      expect((await decide('approve')).status).toBe(409);
      expect((await decide('reject')).status).toBe(409);

      w.setNow(AT + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(fake.written).toEqual([id]);
      expect(await rowOf(w, id)).toMatchObject({ status: 'sent', postId: '7001' });
      // the review item carries the post, so the tape's "approved" row links it
      expect(await item()).toMatchObject({ status: 'approved', postId: '7001' });
      expect((await stateOf(w)).lastPostAt).toBe(AT + 1000);
    } finally {
      await w.close();
    }
  });

  it('reviewed inside the grace: it goes out at once', async () => {
    const { w, fake, id, decide } = await setup();
    try {
      w.setNow(AT + 20 * MIN);
      const approved = await decide('approve');
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: 'approved', postId: '7001' });
      expect(fake.written).toEqual([id]);
      expect(await rowOf(w, id)).toMatchObject({ status: 'sent', postId: '7001' });
      const sent = await w.db.query.actions.findFirst({ where: eq(actions.actionId, `${id}-sent`) });
      expect(sent).toMatchObject({ status: 'completed', action: { tool: 'publish_post', scheduled: { id } } });
      // the tick finds nothing left to do
      w.setNow(AT + 21 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0 });
      expect(fake.calls).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('reviewed inside the grace while it cannot go this moment: approved, and the tick sends it when it can', async () => {
    const { w, fake, id, decide } = await setup();
    try {
      w.setNow(AT + 20 * MIN);
      fake.next = { error: 'sender:not_connected' };
      expect((await decide('approve')).body).toMatchObject({ status: 'approved', postId: null });
      expect((await rowOf(w, id)).status).toBe('waiting');
      fake.next = 'sent';
      w.setNow(AT + 25 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect(fake.written).toEqual([id]);
    } finally {
      await w.close();
    }
  });

  it('too late: approving after the grace sends nothing, and the agent hears that it expired', async () => {
    const { w, fake, id, decide, item, notSent } = await setup();
    try {
      w.setNow(AT + 61 * MIN);
      const late = await decide('approve');
      expect(late.status).toBe(409);
      expect(late.body.error).toBe('scheduled_expired');
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(w, id)).status).toBe('missed');
      expect(await item()).toMatchObject({ status: 'rejected', decidedBy: 'system', note: 'expired: its time passed before it was reviewed' });
      // told once, the way a review that ran out is told
      expect((await takeFeedback(w.ctx, AGENT_ID)).map((f) => f.message)).toEqual([`your post ${id} was rejected: expired: its time passed before it was reviewed`]);
      expect(await notSent()).toEqual([]);
      expect(await takeFeedback(w.ctx, AGENT_ID)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('too late, with the tick first: the item has left the queue by the time the creator looks', async () => {
    const { w, fake, id, decide, item } = await setup();
    try {
      w.setNow(AT + 61 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 1 });
      expect((await rowOf(w, id)).status).toBe('missed');
      expect((await item()).status).toBe('rejected');
      expect((await listApprovals(w.ctx, await agentRow(w))).pending).toBe(0);
      const late = await decide('approve');
      expect(late.status).toBe(409);
      expect(late.body.error).toBe('already_decided');
      expect(fake.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('rejected: it is cancelled, never sent, and the agent hears the creator\'s note once', async () => {
    const { w, fake, id, decide, item, notSent } = await setup();
    try {
      const rejected = await decide('reject', { note: 'too salesy' });
      expect(rejected.status).toBe(200);
      expect(rejected.body).toMatchObject({ id, status: 'rejected', decision: 'reject', note: 'too salesy' });
      expect(await rowOf(w, id)).toMatchObject({ status: 'cancelled', error: 'rejected by the creator' });
      expect((await item()).status).toBe('rejected');
      w.setNow(AT + 1000);
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(0);
      expect((await takeFeedback(w.ctx, AGENT_ID)).map((f) => f.message)).toEqual([`your post ${id} was rejected: too salesy`]);
      // not told a second time from the schedule's side
      expect(await notSent()).toEqual([]);
      // its time is free again
      expect((await callTool(w, 'schedule_post', { text: 'A better thought for the same hour.', sendAt: iso(AT + 2 * HOUR) })).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('only the creator decides', async () => {
    const { w, id, fake } = await setup();
    try {
      const path = `/internal/agents/${AGENT_ID}/approvals/${id}`;
      expect((await w.call('POST', path, { decision: 'approve', by: '0x4000000000000000000000000000000000000009' })).status).toBe(403);
      expect((await w.call('POST', path, { decision: 'approve', by: 'nobody' })).status).toBe(400);
      expect((await w.call('POST', path, { decision: 'maybe', by: CREATOR })).status).toBe(400);
      expect((await rowOf(w, id)).status).toBe('waiting_review');
      expect(fake.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('review rows count against the six, and the queue\'s own refusals leave no row behind', async () => {
    const { w } = await setup();
    try {
      for (let i = 1; i <= 5; i++) await schedule(w, `Review thought ${i}, each its own.`, AT + i * 2 * HOUR);
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'A seventh for review.', sendAt: iso(AT + 13 * HOUR) }))).toMatch(/^schedule_full: 6 posts are already waiting/);
      expect((await rowsOf(w)).every((r) => r.status === 'waiting_review')).toBe(true);
      await callTool(w, 'scheduled_cancel', { id: (await rowsOf(w))[5]!.id });
      // the same text as an item of the review queue of the last day is refused there, and nothing is stored here
      await w.db.insert(approvals).values({ id: 'act_live_post', agentId: AGENT_ID, kind: 'post', text: 'Said in a post sent for review.', textHash: textHash('Said in a post sent for review.'), status: 'rejected', createdAt: new Date(T0 - HOUR) });
      const dup = await callTool(w, 'schedule_post', { text: 'Said in a post sent for review.', sendAt: iso(AT + 13 * HOUR) });
      expect(errorOf(dup)).toMatch(/^approval_duplicate: /);
      expect(await rowsOf(w)).toHaveLength(6);
      expect((await rowsOf(w)).filter((r) => r.status === 'waiting_review')).toHaveLength(5);
    } finally {
      await w.close();
    }
  });

  it('a cancel closes the review item with the post, before and after the approval', async () => {
    const { w, fake, id, decide, item } = await setup();
    try {
      // the agent thinks better of it while the creator has not looked yet
      expect((await callTool(w, 'scheduled_cancel', { id })).kind).toBe('completed');
      expect(await item()).toMatchObject({ status: 'rejected', decidedBy: 'system', note: 'cancelled' });
      expect((await listApprovals(w.ctx, await agentRow(w))).pending).toBe(0);
      expect((await decide('approve')).status).toBe(409);
      // nothing about it reaches the agent as a rejection: it cancelled it itself
      expect(await takeFeedback(w.ctx, AGENT_ID)).toEqual([]);

      // approved, then cancelled by the creator before its time: never sent, and the item says so
      const second = await schedule(w, 'Approved first, cancelled after.', AT + 4 * HOUR);
      expect((await w.call('POST', `/internal/agents/${AGENT_ID}/approvals/${second}`, { decision: 'approve', by: CREATOR })).status).toBe(200);
      expect((await w.call('POST', `/internal/agents/${AGENT_ID}/scheduled/${second}/cancel`, { by: CREATOR })).status).toBe(200);
      expect(await w.db.query.approvals.findFirst({ where: eq(approvals.id, second) })).toMatchObject({ status: 'failed', note: 'cancelled before it went out', postId: null });
      w.setNow(AT + 4 * HOUR + 1000);
      await sweepScheduled(w.ctx);
      expect(fake.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('approved and then refused for good at its time: the item shows it was not sent and the agent is told once', async () => {
    const { w, fake, decide, item, notSent } = await setup();
    try {
      await decide('approve');
      fake.next = { error: 'sender_rejected:policy:x_post_requires_at_most_one_cashtag' };
      w.setNow(AT + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1 });
      expect(await item()).toMatchObject({ status: 'failed', note: 'sender_rejected:policy:x_post_requires_at_most_one_cashtag' });
      expect(await notSent()).toHaveLength(1);
      // one voice, not two: the review queue's own failure note is marked told
      expect(await takeFeedback(w.ctx, AGENT_ID)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('approval mode switched off again: a post already handed to the creator stays theirs to decide', async () => {
    const { w, fake, id } = await setup();
    try {
      await patchConfig(w, { requireApproval: false });
      w.setNow(AT + 1000);
      await sweepScheduled(w.ctx);
      // it was handed to the creator, and stays theirs to decide
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(w, id)).status).toBe('waiting_review');
    } finally {
      await w.close();
    }
  });
});
