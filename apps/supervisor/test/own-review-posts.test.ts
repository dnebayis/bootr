/**
 * Own agents, after the security review of the engine (docs/design/byo-agent.md "Limits added after review"): what an
 * own coin may do to the posting rhythm every Bootr agent shares, and to its own queue of posts. Through the real
 * internal routes, with a credential made by the real grant routes.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POST_ALREADY_SENT_THIS_TURN, postAlreadyQueued } from '../src/broker/index.js';
import { fileRequest } from '../src/creator-requests.js';
import { actions, approvals } from '../src/db/schema.js';
import { originalPostGate, slotsUsed } from '../src/rhythm.js';
import { AGENT_ID, CREATOR } from './helpers.js';
import { act, connectClient, finishInput, mention, openSocial, ownWorld, quietRuntime, seedOwn } from './own-helpers.js';

const HOUR = 3_600_000;

async function setup(agent: Record<string, unknown> = {}) {
  const w = await ownWorld();
  const quiet = quietRuntime(w.ctx.now());
  await seedOwn(w, { config: { ...quiet.config, ...agent }, runtime: quiet.runtime });
  const { credential } = await connectClient(w);
  return { w, credential };
}

describe('own agent: one coin cannot close the posting window of every agent', () => {
  it('a post queued for review takes no platform slot; an approved post takes one when it is sent', async () => {
    const { w, credential } = await setup({ requireApproval: true });
    try {
      await fileRequest(w.ctx, AGENT_ID, { text: 'Post about the new coin page.', turn: 'social' });
      const turn = await openSocial(w, credential);
      const first = await act(w, credential, turn.turnId, 'publish_post', { text: 'The coin page got a new look this week. Have a look around.' });
      expect(first.body).toMatchObject({ status: 'completed', result: { queued: true } });
      // Nothing reached X, so the window every agent shares is as open as it was.
      expect(w.sender.published).toHaveLength(0);
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(0);
      expect(await originalPostGate(w.ctx, w.ctx.now())).toEqual({ open: true });

      // The creator approves: the post goes out now, and now it is a used slot.
      const approvalId = first.body.actionId!;
      const decided = await w.call('POST', `/internal/agents/${AGENT_ID}/approvals/${approvalId}`, { decision: 'approve', by: CREATOR });
      expect(decided.status).toBe(200);
      expect(w.sender.published).toHaveLength(1);
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('the same holds for a hosted coin in approval mode: its queued row is no slot, the row of its approved post is one', async () => {
    const w = await ownWorld();
    try {
      const now = w.ctx.now();
      const at = new Date(now - 60_000);
      const post = { tool: 'publish_post', input: { text: 'A hosted post the creator reads first.' } };
      await w.db.insert(actions).values({ actionId: 'h1', agentId: 'agent-h', cycleKey: 'k:h1', action: post, status: 'completed', result: { actionId: 'h1', tool: 'publish_post', status: 'completed', result: { queued: true, approvalId: 'h1', status: 'pending_approval' } }, createdAt: at, updatedAt: at });
      expect(await slotsUsed(w.ctx, now)).toBe(0);
      await w.db.insert(actions).values({ actionId: 'h1-approved', agentId: 'agent-h', cycleKey: 'approval:h1', action: post, status: 'completed', result: { postId: '9001', approvalId: 'h1', senderStatus: 'sent' }, createdAt: at, updatedAt: at });
      expect(await slotsUsed(w.ctx, now)).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('with a creator request open, a turn in approval mode queues one original post, not as many as it has steps', async () => {
    const { w, credential } = await setup({ requireApproval: true });
    try {
      await fileRequest(w.ctx, AGENT_ID, { text: 'Post about the new coin page.', turn: 'social' });
      const turn = await openSocial(w, credential);
      const texts = ['The coin page got a new look this week.', 'A second thought about the coin page, worded anew.', 'A third thought, nothing like the first two.', 'And a fourth one for good measure.'];
      const answers = [];
      for (const text of texts) answers.push((await act(w, credential, turn.turnId, 'publish_post', { text })).body);
      expect(answers.map((a) => a.status)).toEqual(['completed', 'failed', 'failed', 'failed']);
      expect(answers[1]!.error).toBe(POST_ALREADY_SENT_THIS_TURN);
      const queued = await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID));
      expect(queued.map((a) => [a.kind, a.status])).toEqual([['post', 'pending_approval']]);
      // Three coins' worth of queued posts once filled the window (limit 3); now none of them is a slot.
      expect(await originalPostGate(w.ctx, w.ctx.now())).toEqual({ open: true });
      await w.run('finish', credential, { turnId: turn.turnId, ...finishInput(w) });

      // A later turn, the request still open and the first post still waiting: nothing more is queued for this slot.
      w.setNow(w.ctx.now() + 60_000);
      const again = await openSocial(w, credential, { reason: 'creator_asked' });
      const more = await act(w, credential, again.turnId, 'publish_post', { text: 'A fifth thought, in a turn of its own.' });
      expect(more.body).toMatchObject({ status: 'failed', error: postAlreadyQueued(queued[0]!.id) });
      expect(await w.db.select().from(approvals)).toHaveLength(1);
      await w.run('finish', credential, { turnId: again.turnId, ...finishInput(w) });

      // Once the creator has decided it, the next ask may queue one again.
      expect((await w.call('POST', `/internal/agents/${AGENT_ID}/approvals/${queued[0]!.id}`, { decision: 'reject', by: CREATOR })).status).toBe(200);
      w.setNow(w.ctx.now() + 60_000);
      const third = await openSocial(w, credential, { reason: 'creator_asked' });
      expect((await act(w, credential, third.turnId, 'publish_post', { text: 'A sixth thought, after the creator said no to the first.' })).body).toMatchObject({ status: 'completed', result: { queued: true } });
      expect(w.sender.published).toHaveLength(0);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('a queued original that is older than the coin\'s post interval no longer stands in the way of the next slot', async () => {
    const { w, credential } = await setup({ requireApproval: true });
    try {
      await fileRequest(w.ctx, AGENT_ID, { text: 'Post about the new coin page.', turn: 'social' });
      const turn = await openSocial(w, credential);
      expect((await act(w, credential, turn.turnId, 'publish_post', { text: 'The coin page got a new look this week.' })).body.status).toBe('completed');
      await w.run('finish', credential, { turnId: turn.turnId, ...finishInput(w) });
      // Well past the interval (two hours for the test coin, plus its jitter): the slot is due again.
      w.setNow(w.ctx.now() + 3 * HOUR);
      const next = await openSocial(w, credential);
      expect(next.reasons).toContain('original_post_due');
      expect((await act(w, credential, next.turnId, 'publish_post', { text: 'A new slot, a new post for the creator to read.' })).body).toMatchObject({ status: 'completed', result: { queued: true } });
      expect(await w.db.select().from(approvals)).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('without approval mode a creator request lets one original post out in a turn, and replies still go out', async () => {
    const { w, credential } = await setup();
    try {
      w.sender.items = [mention('1001')];
      await fileRequest(w.ctx, AGENT_ID, { text: 'Post about the new coin page.', turn: 'social' });
      const turn = await openSocial(w, credential);
      expect((await act(w, credential, turn.turnId, 'publish_post', { text: 'The coin page got a new look this week.' })).body.status).toBe('completed');
      const second = await act(w, credential, turn.turnId, 'publish_post', { text: 'And another post, because the request is still open.' });
      expect(second.body).toMatchObject({ status: 'failed', error: POST_ALREADY_SENT_THIS_TURN });
      expect((await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' })).body.status).toBe('completed');
      expect(w.sender.published).toHaveLength(2);
      const posts = (await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => (r.action as { tool?: string }).tool === 'publish_post');
      expect(posts.map((r) => r.status).sort()).toEqual(['completed', 'failed']);
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(1);
    } finally {
      await w.close();
    }
  });
});
