import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runtimes } from '../src/db/schema.js';
import { SenderError, type SenderInboxItem } from '../src/sender-client.js';
import { processAgent } from '../src/tick.js';
import type { AgentRow } from '../src/context.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const H = 3_600_000;
const finish = () => finishResponse(T0 + H);

function mention(postId: string): SenderInboxItem {
  const authorId = `3${postId}`;
  return { postId, authorId, conversationId: postId, status: 'pending', observedAt: '2026-10-24T11:59:00Z', seenAt: null, deferredUntil: null, post: { id: postId, authorId, text: '@bootr_agent gm', conversationId: postId, author: { id: authorId, username: `user${authorId}`, verified: true, verifiedType: 'blue' } } };
}

type Post = { body: { messages: { content: string }[]; tools: { function: { name: string } }[] } };
const posts = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')) as unknown as Post[];
const lastTool = (p: Post) => JSON.parse(p.body.messages.at(-1)!.content) as Record<string, unknown>;

/** Records resolves, mirroring the sender: a resolved mention leaves the inbox; `failing` ids throw. */
function trackResolves(w: TestWorld, failing: Record<string, Error> = {}) {
  const resolved: { postId: string; outcome: string; reason: string; reviewAt?: string }[] = [];
  (w.sender.client as unknown as { resolve: unknown }).resolve = async (body: { postId: string; outcome: string; reason: string; reviewAt?: string }) => {
    const err = failing[body.postId];
    if (err) throw err;
    resolved.push(body);
    w.sender.items = w.sender.items.filter((i) => i.postId !== body.postId);
    return { item: {} };
  };
  return resolved;
}

async function run(w: TestWorld, agent: AgentRow) {
  const runtime = (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
  return processAgent(w.ctx, agent, runtime);
}

async function world(script: Response[]) {
  const w = await makeWorld({ script });
  const agent = await seedAgent(w);
  return { w, agent, resolved: trackResolves(w) };
}

describe('resolve_mentions', () => {
  it('closes the whole list in one step, with one outcome and reason, and is offered to the model next to resolve_mention', async () => {
    const { w, agent, resolved } = await world([toolCallResponse('resolve_mentions', { postIds: ['101', '102', '103', '102'], outcome: 'skip', reason: 'nothing to add' }), finish()]);
    try {
      w.sender.items = [mention('101'), mention('102'), mention('103')];
      const result = await run(w, agent);
      expect(result?.turn).toMatchObject({ outcome: 'finished', steps: 2 });
      expect(resolved.map((r) => r.postId).sort()).toEqual(['101', '102', '103']);
      expect(resolved.every((r) => r.outcome === 'skip' && r.reason === 'nothing to add')).toBe(true);
      expect(lastTool(posts(w)[1]!)).toEqual({ outcome: 'skip', resolved: ['101', '102', '103'], failed: [] });
      const names = posts(w)[0]!.body.tools.map((t) => t.function.name);
      expect(names).toEqual(expect.arrayContaining(['resolve_mention', 'resolve_mentions']));
    } finally {
      await w.close();
    }
  });

  it('passes defer and its reviewAt through to every id', async () => {
    const reviewAt = new Date(T0 + 2 * H).toISOString();
    const { w, agent, resolved } = await world([toolCallResponse('resolve_mentions', { postIds: ['101', '102'], outcome: 'defer', reason: 'later', reviewAt }), finish()]);
    try {
      await run(w, agent);
      expect(resolved).toHaveLength(2);
      expect(resolved.every((r) => r.outcome === 'defer' && r.reviewAt === reviewAt)).toBe(true);
    } finally {
      await w.close();
    }
  });

  it('on partial failure resolves the rest and names each id that failed, with its error', async () => {
    const { w, agent, resolved } = await world([toolCallResponse('resolve_mentions', { postIds: ['101', '102', '103'], outcome: 'skip', reason: 'noise' }), finish()]);
    try {
      const failing = trackResolves(w, { '102': new SenderError(409, 'already_replied', { error: 'already_replied' }, false) });
      w.sender.items = [mention('101'), mention('102'), mention('103')];
      const result = await run(w, agent);
      expect(result?.turn).toMatchObject({ outcome: 'finished', steps: 2 });
      expect(failing.map((r) => r.postId).sort()).toEqual(['101', '103']);
      expect(resolved).toHaveLength(0);
      expect(lastTool(posts(w)[1]!)).toEqual({ outcome: 'skip', resolved: ['101', '103'], failed: [{ postId: '102', error: 'sender:already_replied' }] });
    } finally {
      await w.close();
    }
  });

  it('when every id fails, the failure names each of them and the turn goes on', async () => {
    const { w, agent } = await world([toolCallResponse('resolve_mentions', { postIds: ['101', '102'], outcome: 'skip', reason: 'noise' }), finish()]);
    try {
      trackResolves(w, { '101': new SenderError(404, 'not_found', {}, false), '102': new SenderError(409, 'already_replied', {}, false) });
      const result = await run(w, agent);
      expect(result?.turn).toMatchObject({ outcome: 'finished', steps: 2 });
      const res = lastTool(posts(w)[1]!);
      expect(res.status).toBe('failed');
      expect(res.error).toContain('101: sender:not_found');
      expect(res.error).toContain('102: sender:already_replied');
    } finally {
      await w.close();
    }
  });

  it('a transport failure of the whole list is an unknown outcome, resumed later rather than reported as failed', async () => {
    const { w, agent } = await world([toolCallResponse('resolve_mentions', { postIds: ['101', '102'], outcome: 'skip', reason: 'noise' })]);
    try {
      trackResolves(w, { '101': new Error('fetch failed'), '102': new Error('fetch failed') });
      const result = await run(w, agent);
      expect(result?.turn).toMatchObject({ outcome: 'pending' });
      expect((await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.pending).toMatchObject({ status: 'sent', action: { tool: 'resolve_mentions' } });
    } finally {
      await w.close();
    }
  });

  it('resolve_mention keeps working for a turn already under way', async () => {
    const { w, agent, resolved } = await world([toolCallResponse('resolve_mention', { postId: '101', outcome: 'opt_out', reason: 'asked me to stop' }), finish()]);
    try {
      await run(w, agent);
      expect(resolved).toEqual([expect.objectContaining({ postId: '101', outcome: 'opt_out', reason: 'asked me to stop' })]);
      expect(lastTool(posts(w)[1]!)).toMatchObject({ postId: '101', outcome: 'opt_out' });
    } finally {
      await w.close();
    }
  });

  it('refuses a list over the bound as an invalid call, without touching the sender', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => String(1000 + i));
    const { w, agent, resolved } = await world([toolCallResponse('resolve_mentions', { postIds: ids, outcome: 'skip', reason: 'noise' }), finish()]);
    try {
      await run(w, agent);
      expect(resolved).toHaveLength(0);
      expect(lastTool(posts(w)[1]!)).toMatchObject({ error: 'invalid_tool_call' });
    } finally {
      await w.close();
    }
  });
});
