/**
 * The question habit (2026-11-10): the platform agent closed about one original post in two with a question to the
 * audience ("Builders, what's yours?"). The broker now refuses an original post that asks something when one of the
 * agent's last four sent originals already did (recent-posts.ts `questionQuotaRefusal`): the refusal is an ordinary
 * tool error, nothing reaches the sender, and the model rewrites the post as a statement in the same turn.
 */
import { describe, expect, it } from 'vitest';
import { actions } from '../src/db/schema.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const T0 = Date.parse('2026-10-24T12:00:00Z');
const ASKS = 'A burn on a coin is the creator\'s choice, locked at launch. Builders, would you pick one?';
const SAYS = 'A burn on a coin is the creator\'s choice, locked at launch, and it shows on the coin page.';

type Call = { body: { messages: { role: string; content: string }[] } };
const inferenceCalls = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')) as unknown as Call[];

describe('the question quota on original posts', () => {
  it('refuses a question when one of the last four originals asked one; the statement that follows goes out', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: ASKS }, 'call_q'), toolCallResponse('publish_post', { text: SAYS }, 'call_s'), finishResponse(T0 + 3 * H)] });
    try {
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: new Date(now - 10 * H).toISOString() } });
      await w.db.insert(actions).values([
        { actionId: 'old_q', agentId: AGENT_ID, cycleKey: 'old_q', action: { tool: 'publish_post', input: { text: 'What would your agent turn down first?' } }, status: 'completed', attempts: 1, createdAt: new Date(now - 5 * H), updatedAt: new Date(now - 5 * H) },
      ] as never);
      const r = await tick(w.ctx);
      expect(r.ran).toEqual([AGENT_ID]);
      expect(r.errors).toEqual([]);

      const calls = inferenceCalls(w);
      expect(calls).toHaveLength(3);
      // the observation already said no question now
      const observation = JSON.parse(calls[0]!.body.messages[1]!.content) as { questions?: { mayAskNow: boolean; recentWithQuestion: number } };
      expect(observation.questions).toMatchObject({ mayAskNow: false, recentWithQuestion: 1 });
      // the question was refused before the sender, the statement went out
      const tools = calls[2]!.body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content) as { error?: string; status?: string; postId?: string });
      expect(tools[0]).toMatchObject({ status: 'failed' });
      expect(tools[0]!.error).toMatch(/^question_quota: 1 of your last 4 original posts already asked something/);
      expect(tools[1]!.postId).toMatch(/^\d+$/);
      expect(w.sender.published.map((p) => (p as { text: string }).text)).toEqual([SAYS]);
    } finally {
      await w.close();
    }
  });

  it('lets a question through when the last four originals were statements', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: ASKS }, 'call_q'), finishResponse(T0 + 3 * H)] });
    try {
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: new Date(now - 10 * H).toISOString() } });
      await w.db.insert(actions).values(
        ['one', 'two', 'three', 'four'].map((t, i) => ({ actionId: `s_${t}`, agentId: AGENT_ID, cycleKey: `s_${t}`, action: { tool: 'publish_post', input: { text: `Statement ${t}.` } }, status: 'completed', attempts: 1, createdAt: new Date(now - (5 + i) * H), updatedAt: new Date(now - (5 + i) * H) })) as never,
      );
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      expect(w.sender.published.map((p) => (p as { text: string }).text)).toEqual([ASKS]);
    } finally {
      await w.close();
    }
  });
});
