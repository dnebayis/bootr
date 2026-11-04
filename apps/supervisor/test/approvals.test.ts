import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentActivity } from '../src/activity.js';
import { createApp } from '../src/api.js';
import { APPROVAL_TTL_MS, expireApprovals, queueForApproval, requiresApproval, takeFeedback, textHash } from '../src/approvals.js';
import type { BrokerEnv } from '../src/broker/index.js';
import { actions, approvals, images as imagesTable, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { DEFAULT_IMAGE_MODEL } from '../src/images.js';
import { tick } from '../src/tick.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { AGENT_ID, CREATOR, finishResponse, makeWorld, seedAgent, SUPERVISOR_KEY, toolCallResponse, type TestWorld } from './helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const REVIEWED = { requireApproval: true };

function api(world: TestWorld) {
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  const send = (method: 'POST' | 'PUT', path: string, body: unknown) => {
    const text = JSON.stringify(body);
    return app.request(path, { method, body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, method, path, text, nowSec()) } });
  };
  return {
    get: (path: string) => app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } }),
    post: (path: string, body: unknown) => send('POST', path, body),
    put: (path: string, body: unknown) => send('PUT', path, body),
  };
}

const env = (): BrokerEnv => ({ inbox: new Map(), eligibility: new Map(), cycle: 1 });
const pending = (id: string, tool: string, input: Record<string, unknown>) => ({ id, cycleKey: `cycle:${id}`, action: { tool, input }, status: 'sent', createdAt: 0, attempts: 1 }) as unknown as Parameters<typeof queueForApproval>[2];

const mention = (postId: string, authorId: string, text: string): SenderInboxItem => ({
  postId,
  authorId,
  conversationId: postId,
  status: 'pending',
  observedAt: '2026-10-24T11:59:00Z',
  seenAt: null,
  deferredUntil: null,
  post: { id: postId, authorId, text, createdAt: '2026-10-24T11:58:00Z', conversationId: postId, author: { id: authorId, username: `user${authorId}`, verified: true, verifiedType: 'blue' } },
});

async function runtimeRow(w: TestWorld) {
  return (await w.db.select().from(runtimes).where(eq(runtimes.agentId, AGENT_ID)))[0]!;
}

/** The first observation of the last turn (the user message after the system prompt). */
function lastObservation(w: TestWorld): Record<string, unknown> {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls[calls.length - 1]!.body as { messages: { role: string; content: string }[] };
  return JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
}

describe('requireApproval flag', () => {
  it('defaults to on for the platform agent and off for everyone else; the config API reads and writes it', async () => {
    expect(requiresApproval({ platform: true })).toBe(true);
    expect(requiresApproval({})).toBe(false);
    expect(requiresApproval({ platform: true, requireApproval: false })).toBe(false);
    expect(requiresApproval({ requireApproval: true })).toBe(true);
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const { get, put } = api(w);
      expect(((await (await get(`/internal/agents/${AGENT_ID}/config`)).json()) as { requireApproval: boolean }).requireApproval).toBe(false);
      const bad = await put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, requireApproval: 'yes' });
      expect(bad.status).toBe(400);
      const res = await put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, requireApproval: true });
      expect(res.status).toBe(200);
      expect((await res.json()) as object).toMatchObject({ requireApproval: true, revision: 2 });
      expect((await put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, requireApproval: true })).status).toBe(409);
      const rows = await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID));
      expect(rows[0]!.action).toMatchObject({ kind: 'config_updated', fields: ['requireApproval'] });
      const agent = (await w.db.query.agents.findFirst())!;
      const runtime = await runtimeRow(w);
      expect((await agentActivity(w.ctx, agent, runtime)).map((i) => i.summary)).toContain('Config updated: post review');
    } finally {
      await w.close();
    }
  });
});

describe('queueing', () => {
  it('holds a publish_post for review instead of sending it; the turn goes on as if posted', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: 'First dated fact of the day.' }), finishResponse(T0 + 3_600_000)] });
    try {
      await seedAgent(w, { config: REVIEWED });
      const res = await tick(w.ctx);
      expect(res.ran).toEqual([AGENT_ID]);
      expect(w.sender.published).toHaveLength(0);
      const rows = await w.db.select().from(approvals);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agentId: AGENT_ID, kind: 'post', text: 'First dated fact of the day.', status: 'pending_approval', imageId: null, inReplyTo: null, textHash: textHash('first dated  fact of the day. ') });
      // the action settled as completed with the queued note, the runtime moved on and the schedule treats it as posted
      const act = (await w.db.select().from(actions).where(eq(actions.actionId, rows[0]!.id)))[0]!;
      expect(act.status).toBe('completed');
      expect(act.result).toMatchObject({ status: 'completed', result: { queued: true, approvalId: rows[0]!.id, status: 'pending_approval' } });
      const runtime = await runtimeRow(w);
      expect(runtime.status).toBe('waiting');
      expect((runtime.state as { lastPostAt: number }).lastPostAt).toBe(T0);
      // the model was told about review mode in the observation and in the tool result
      const first = lastObservation(w);
      expect(first.review).toMatchObject({ enabled: true, pending: 0 });
      const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
      const toolMsg = (calls[1]!.body as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === 'tool')!;
      expect(toolMsg.content).toContain("creator's review");
      // the tape shows it waiting, not as a post
      const agent = (await w.db.query.agents.findFirst())!;
      const tape = await agentActivity(w.ctx, agent, runtime);
      expect(tape.map((t) => [t.kind, t.summary])).toContainEqual(['approval_pending', "A post is waiting for the creator's review"]);
      expect(tape.find((t) => t.kind === 'post')).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it('refuses the same text again within 24 h, is idempotent on the action id, and keeps a reply\'s eligibility', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: REVIEWED });
      const first = await queueForApproval(w.ctx, agent, pending('act_p1', 'publish_post', { text: 'Holders passed 300 today.' }), env());
      expect(first).toMatchObject({ kind: 'completed', result: { queued: true, approvalId: 'act_p1' } });
      const again = await queueForApproval(w.ctx, agent, pending('act_p1', 'publish_post', { text: 'Holders passed 300 today.' }), env());
      expect(again).toEqual(first);
      const dup = await queueForApproval(w.ctx, agent, pending('act_p2', 'publish_post', { text: '  holders PASSED 300 today.' }), env());
      expect(dup).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^approval_duplicate: .*act_p1/) });
      expect(await w.db.select().from(approvals)).toHaveLength(1);
      // a day later the same text is a new item
      w.setNow(T0 + 25 * 3_600_000);
      const later = await queueForApproval(w.ctx, agent, pending('act_p3', 'publish_post', { text: 'Holders passed 300 today.' }), env());
      expect(later.kind).toBe('completed');
      // an unknown image is refused before anything is stored
      const noImage = await queueForApproval(w.ctx, agent, pending('act_p4', 'publish_post', { text: 'With a picture.', imageId: 'img_nope' }), env());
      expect(noImage).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_not_found/) });
      // a reply keeps what the sender will need: the target, its author and the eligibility decided when it was observed
      const e = env();
      e.inbox.set('1001', mention('1001', '42', '@bootr_agent what is your plan?'));
      e.eligibility.set('1001', { eligible: true });
      const reply = await queueForApproval(w.ctx, agent, pending('act_r1', 'publish_reply', { postId: '1001', text: 'Claim fees, swap, post. That is the plan.' }), e);
      expect(reply.kind).toBe('completed');
      const row = (await w.db.select().from(approvals).where(eq(approvals.id, 'act_r1')))[0]!;
      expect(row).toMatchObject({ kind: 'reply', inReplyTo: '1001', meta: { replyAuthorId: '42', replyEligibility: { eligible: true } } });
    } finally {
      await w.close();
    }
  });
});

describe('decisions', () => {
  it('approve sends the post once through the sender (with its image) and records the real post', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: REVIEWED });
      await w.db.insert(imagesTable).values({ id: 'img_1', agentId: AGENT_ID, actionId: 'act_img1', alt: 'A fox', mime: 'image/png', bytes: PNG_BYTES, sizeBytes: PNG_BYTES.length, model: DEFAULT_IMAGE_MODEL, createdAt: new Date(T0) });
      await queueForApproval(w.ctx, agent, pending('act_p1', 'publish_post', { text: 'A fox for you all.', imageId: 'img_1' }), env());
      const { get, post } = api(w);
      // the queue carries the image for the creator's preview
      const list = (await (await get(`/internal/agents/${AGENT_ID}/approvals`)).json()) as { items: { id: string; image: { data: string; alt: string } }[]; pending: number };
      expect(list.pending).toBe(1);
      expect(list.items[0]).toMatchObject({ id: 'act_p1', kind: 'post', text: 'A fox for you all.', status: 'pending_approval', image: { id: 'img_1', alt: 'A fox', mime: 'image/png', data: PNG_BYTES.toString('base64') } });
      expect((await get(`/internal/agents/${AGENT_ID}/approvals?status=nope`)).status).toBe(400);

      expect((await post(`/internal/agents/${AGENT_ID}/approvals/act_p1`, { decision: 'approve', by: '0x9000000000000000000000000000000000000009' })).status).toBe(403);
      expect((await post(`/internal/agents/${AGENT_ID}/approvals/act_p1`, { decision: 'maybe', by: CREATOR })).status).toBe(400);
      expect((await post(`/internal/agents/${AGENT_ID}/approvals/act_nope`, { decision: 'approve', by: CREATOR })).status).toBe(404);

      w.setNow(T0 + 60_000);
      const res = await post(`/internal/agents/${AGENT_ID}/approvals/act_p1`, { decision: 'approve', by: CREATOR.toLowerCase(), note: 'good' });
      expect(res.status).toBe(200);
      const view = (await res.json()) as Record<string, unknown>;
      expect(view).toMatchObject({ id: 'act_p1', status: 'approved', decision: 'approve', decidedBy: CREATOR, note: 'good', postId: '9001', url: 'https://x.com/bootr_agent/status/9001', decidedAt: new Date(T0 + 60_000).toISOString() });
      expect((view.image as { data?: string }).data).toBeUndefined();
      expect(w.sender.published).toHaveLength(1);
      expect(w.sender.published[0]).toMatchObject({ agentId: AGENT_ID, actionId: 'act_p1', text: 'A fox for you all.', media: { data: PNG_BYTES.toString('base64'), mime: 'image/png', alt: 'A fox' }, xUserId: '1000' });
      // the real post is an sv_actions row; the tape shows the approval and the post with its link
      const posted = (await w.db.select().from(actions).where(eq(actions.actionId, 'act_p1-approved')))[0]!;
      expect(posted).toMatchObject({ status: 'completed', cycleKey: 'approval:act_p1', action: { tool: 'publish_post', input: { text: 'A fox for you all.', imageId: 'img_1' }, approval: { id: 'act_p1', by: CREATOR } }, result: { postId: '9001', approvalId: 'act_p1' } });
      const tape = await agentActivity(w.ctx, agent, await runtimeRow(w));
      expect(tape.map((t) => [t.kind, t.summary, t.url ?? null])).toEqual(expect.arrayContaining([
        ['approval_approved', 'Post approved by the creator', 'https://x.com/bootr_agent/status/9001'],
        ['post', 'Posted on X', 'https://x.com/bootr_agent/status/9001'],
      ]));
      expect(tape.find((t) => t.kind === 'approval_pending')).toBeUndefined();
      // decided once
      const twice = await post(`/internal/agents/${AGENT_ID}/approvals/act_p1`, { decision: 'reject', by: CREATOR });
      expect([twice.status, ((await twice.json()) as { error: string }).error]).toEqual([409, 'already_decided']);
      expect(w.sender.published).toHaveLength(1);
      const all = (await (await get(`/internal/agents/${AGENT_ID}/approvals?status=all`)).json()) as { items: unknown[]; pending: number };
      expect(all.items).toHaveLength(1);
      expect(all.pending).toBe(0);
      expect(await takeFeedback(w.ctx, AGENT_ID)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('approving a reply sends the target, its author and the stored eligibility', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: REVIEWED });
      const e = env();
      e.inbox.set('1001', mention('1001', '42', '@bootr_agent what is your plan?'));
      e.eligibility.set('1001', { eligible: true });
      await queueForApproval(w.ctx, agent, pending('act_r1', 'publish_reply', { postId: '1001', text: 'Claim fees, swap, post.' }), e);
      const res = await api(w).post(`/internal/agents/${AGENT_ID}/approvals/act_r1`, { decision: 'approve', by: CREATOR });
      expect(res.status).toBe(200);
      expect(w.sender.published[0]).toMatchObject({ actionId: 'act_r1', text: 'Claim fees, swap, post.', replyTo: '1001', replyAuthorId: '42', replyEligibility: { eligible: true } });
      const posted = (await w.db.select().from(actions).where(eq(actions.actionId, 'act_r1-approved')))[0]!;
      expect(posted.action).toMatchObject({ tool: 'publish_reply', input: { postId: '1001' } });
      expect(posted.result).toMatchObject({ postId: '9001', replyAuthorId: '42' });
    } finally {
      await w.close();
    }
  });

  it('a sender that cannot take the post keeps the item pending (503); a sender rejection marks it failed and tells the agent', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: REVIEWED });
      await queueForApproval(w.ctx, agent, pending('act_p1', 'publish_post', { text: 'Soon.' }), env());
      await queueForApproval(w.ctx, agent, pending('act_p2', 'publish_post', { text: 'cc @quietperson', attributions: [{ username: 'quietperson', sourceUrl: 'https://x.com/quietperson/status/1' }] }), env());
      const { post } = api(w);
      w.sender.consentLookupFails = '2026-10-24T12:10:00Z';
      const later = await post(`/internal/agents/${AGENT_ID}/approvals/act_p1`, { decision: 'approve', by: CREATOR });
      expect([later.status, ((await later.json()) as { error: string }).error]).toEqual([503, 'sender_unavailable']);
      expect((await w.db.select().from(approvals).where(eq(approvals.id, 'act_p1')))[0]!.status).toBe('pending_approval');
      w.sender.consentLookupFails = null;
      w.sender.optedOutHandles.add('quietperson');
      const refused = await post(`/internal/agents/${AGENT_ID}/approvals/act_p2`, { decision: 'approve', by: CREATOR });
      expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([409, 'publish_failed']);
      expect((await w.db.select().from(approvals).where(eq(approvals.id, 'act_p2')))[0]).toMatchObject({ status: 'failed', decision: 'approve', note: 'sender_rejected:policy:mention_opted_out' });
      const feedback = await takeFeedback(w.ctx, AGENT_ID);
      expect(feedback.map((f) => f.message)).toEqual(['your post act_p2 was approved but could not be sent: sender_rejected:policy:mention_opted_out']);
    } finally {
      await w.close();
    }
  });

  it('reject marks the item and the agent hears the note once, on its next turn', async () => {
    const w = await makeWorld({ script: [finishResponse(T0 + 2 * 3_600_000), finishResponse(T0 + 3 * 3_600_000)] });
    try {
      const agent = await seedAgent(w, { config: REVIEWED });
      await queueForApproval(w.ctx, agent, pending('act_p1', 'publish_post', { text: 'Buy now, this is going up.' }), env());
      await queueForApproval(w.ctx, agent, pending('act_p2', 'publish_post', { text: 'Second one stays pending.' }), env());
      const res = await api(w).post(`/internal/agents/${AGENT_ID}/approvals/act_p1`, { decision: 'reject', by: CREATOR, note: 'too salesy' });
      expect(res.status).toBe(200);
      expect((await res.json()) as object).toMatchObject({ status: 'rejected', decision: 'reject', decidedBy: CREATOR, note: 'too salesy', postId: null, url: null });
      expect(w.sender.published).toHaveLength(0);
      // next turn: the observation carries the rejection and the pending count
      await tick(w.ctx);
      const obs = lastObservation(w);
      expect(obs.review).toMatchObject({ enabled: true, pending: 1, rejected: [{ approvalId: 'act_p1', kind: 'post', text: 'Buy now, this is going up.', note: 'too salesy', message: 'your post act_p1 was rejected: too salesy' }] });
      expect((await w.db.select().from(approvals).where(eq(approvals.id, 'act_p1')))[0]!.feedbackAt).not.toBeNull();
      // the turn after: told once
      await w.db.update(runtimes).set({ nextAt: new Date(w.ctx.now() - 1) }).where(eq(runtimes.agentId, AGENT_ID));
      w.setNow(T0 + 2 * 3_600_000 + 1);
      await tick(w.ctx);
      expect((lastObservation(w).review as { rejected?: unknown }).rejected).toBeUndefined();
      const tape = await agentActivity(w.ctx, agent, await runtimeRow(w));
      expect(tape.map((t) => [t.kind, t.summary])).toEqual(expect.arrayContaining([['approval_rejected', 'Post rejected by the creator'], ['approval_pending', "A post is waiting for the creator's review"]]));
    } finally {
      await w.close();
    }
  });

  it('expires pending items after 48 h as rejected by the system', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: REVIEWED });
      await queueForApproval(w.ctx, agent, pending('act_p1', 'publish_post', { text: 'Old news.' }), env());
      w.setNow(T0 + APPROVAL_TTL_MS - 1);
      expect(await expireApprovals(w.ctx, AGENT_ID)).toBe(0);
      w.setNow(T0 + APPROVAL_TTL_MS + 1);
      const list = (await (await api(w).get(`/internal/agents/${AGENT_ID}/approvals?status=all`)).json()) as { items: Record<string, unknown>[]; pending: number };
      expect(list.pending).toBe(0);
      expect(list.items[0]).toMatchObject({ id: 'act_p1', status: 'rejected', decision: 'reject', decidedBy: 'system', note: 'expired', decidedAt: new Date(T0 + APPROVAL_TTL_MS + 1).toISOString() });
      const late = await api(w).post(`/internal/agents/${AGENT_ID}/approvals/act_p1`, { decision: 'approve', by: CREATOR });
      expect(late.status).toBe(409);
      expect((await takeFeedback(w.ctx, AGENT_ID)).map((f) => f.message)).toEqual(['your post act_p1 was rejected: expired']);
      const tape = await agentActivity(w.ctx, agent, await runtimeRow(w));
      expect(tape.map((t) => t.summary)).toContain('Post expired without review');
    } finally {
      await w.close();
    }
  });

  it('a publish queued before a crash resumes from its approval row, not from the sender', async () => {
    const w = await makeWorld({ script: [finishResponse(T0 + 3_600_000)] });
    try {
      const agent = await seedAgent(w, { config: REVIEWED });
      await queueForApproval(w.ctx, agent, pending('act_p1', 'publish_post', { text: 'Queued, then the process died.' }), env());
      const stuck = { id: 'act_p1', cycleKey: 'cycle:act_p1', action: { tool: 'publish_post', input: { text: 'Queued, then the process died.' } }, status: 'sent', createdAt: T0, attempts: 1 };
      await w.db.insert(actions).values({ actionId: 'act_p1', agentId: AGENT_ID, cycleKey: 'cycle:act_p1', action: stuck.action, status: 'sent', createdAt: new Date(T0), updatedAt: new Date(T0) });
      const turn = { startedAt: T0, steps: 1, nudged: false, reasons: ['test'], messages: [{ role: 'system', content: 's' }, { role: 'user', content: '{}' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'publish_post', arguments: '{}' } }] }], inbox: {}, recentSteps: [] };
      await w.db.update(runtimes).set({ pending: stuck, turn, status: 'waiting' }).where(eq(runtimes.agentId, AGENT_ID));
      await tick(w.ctx);
      expect(w.sender.published).toHaveLength(0);
      expect((await w.db.select().from(actions).where(eq(actions.actionId, 'act_p1')))[0]).toMatchObject({ status: 'completed', result: { result: { queued: true, approvalId: 'act_p1' } } });
      expect((await runtimeRow(w)).status).toBe('waiting');
    } finally {
      await w.close();
    }
  });
});

describe('queueForApproval checks what the sender will check', () => {
  it('drops credits that name nobody in the text and refuses a text the publish gate rejects', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: REVIEWED });
      // credited what it read (a bootrfun tweet) without naming it: queued without the credit
      const credits = [{ username: 'bootrfun', sourceUrl: 'https://x.com/bootrfun/status/1' }];
      const ok = await queueForApproval(w.ctx, agent, pending('act_c1', 'publish_post', { text: 'bootr is where every coin gets an agent.', attributions: credits }), env());
      expect(ok.kind).toBe('completed');
      const row = (await w.db.query.approvals.findFirst())!;
      expect((row.meta as { attributions?: unknown }).attributions).toBeUndefined();
      // a credit for a handle the text mentions stays
      const kept = await queueForApproval(w.ctx, agent, pending('act_c2', 'publish_post', { text: 'good question from @bootrfun today.', attributions: credits }), env());
      expect(kept.kind).toBe('completed');
      const rows = await w.db.select().from(approvals);
      expect((rows.find((r) => r.id === 'act_c2')!.meta as { attributions?: unknown }).attributions).toEqual(credits);
      // a mention of another Bootr agent is credited with that coin's page (the directory knows it)
      const seeded = await seedAgent(w, { agent: { agentId: '77', kernel: '0x7777777777777777777777777777777777777777', token: '0x7777777777777777777777777777777777777770' }, runtime: { agentId: '77' }, config: { xHandle: 'OwlAgent', xUserId: '7700' } });
      expect(seeded.agentId).toBe('77');
      const peer = await queueForApproval(w.ctx, agent, pending('act_c4', 'publish_post', { text: 'welcome @OwlAgent to bootr.' }), env());
      expect(peer.kind).toBe('completed');
      const peerRow = (await w.db.select().from(approvals)).find((r) => r.id === 'act_c4')!;
      expect((peerRow.meta as { attributions?: unknown }).attributions).toEqual([{ username: 'owlagent', sourceUrl: 'https://bootr.fun/token/0x7777777777777777777777777777777777777770' }]);
      // a text the gate refuses never reaches the queue: the agent gets the code back
      const bad = await queueForApproval(w.ctx, agent, pending('act_c3', 'publish_post', { text: 'cc @nobody_credited' }), env());
      expect(bad.kind).toBe('failed');
      expect((bad as { error: string }).error).toMatch(/publish gate/);
      expect(await w.db.select().from(approvals)).toHaveLength(3);
    } finally {
      await w.close();
    }
  });
});
