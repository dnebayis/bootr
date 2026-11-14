/**
 * WAKE_MODE=ping (owner's decision of 2026-11-14): the wake an agent asked for at its last finish buys no turn by
 * itself; somebody writing to the agent, or a due post slot, does. The loop of before is `WAKE_MODE=loop`, the default
 * in code (the deployment sets `ping`).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runtimes } from '../src/db/schema.js';
import type { AgentState } from '../src/runtime.js';
import { processAgent } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const runtimeRow = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
const thoughts = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
const mention = (postId: string) => ({
  postId,
  authorId: `3${postId}`,
  conversationId: postId,
  status: 'pending',
  observedAt: '2026-10-24T11:59:00Z',
  seenAt: null,
  deferredUntil: null,
  post: { id: postId, authorId: `3${postId}`, text: `@bootr_agent gm ${postId}`, conversationId: postId, author: { id: `3${postId}`, username: `user${postId}`, verified: true, verifiedType: 'blue' as const } },
});

/** An agent whose first turn already ran: no config change to wake for, its post slot not due, its asked-for wake in the past. */
async function settled(mode: 'ping' | 'loop') {
  const w = await makeWorld({ config: { WAKE_MODE: mode }, script: [finishResponse(Date.parse('2026-10-24T14:00:00Z')), finishResponse(Date.parse('2026-10-24T16:00:00Z'))] });
  const agent = await seedAgent(w);
  const now = w.ctx.now();
  const rt = await runtimeRow(w);
  const config = (agent.config as { revision?: number }).revision ?? 0;
  await w.db
    .update(runtimes)
    .set({ state: { ...(rt.state as unknown as AgentState), lastPostAt: now - MINUTE } as unknown as Record<string, unknown>, nextAt: new Date(now - MINUTE), lastDecisionAt: new Date(now - HOUR), lastDecisionRevision: config, configRevision: config })
    .where(eq(runtimes.agentId, AGENT_ID));
  return { w, agent };
}

describe('WAKE_MODE', () => {
  it('ping: an arrived wake with no cause buys no thought and moves the row one tick on; a mention then wakes the agent at once', async () => {
    const { w, agent } = await settled('ping');
    try {
      expect(w.ctx.config.WAKE_MODE).toBe('ping');
      const before = w.ctx.now();
      const idle = await processAgent(w.ctx, agent, await runtimeRow(w));
      expect(idle?.ran).toBe(false);
      expect(thoughts(w)).toBe(0);
      expect((await runtimeRow(w)).nextAt.getTime()).toBe(before + w.ctx.config.SUPERVISOR_TICK_MS);

      // somebody writes: the moved wake is still ahead, and the turn runs anyway
      w.sender.items = [mention('1001')];
      const pinged = await processAgent(w.ctx, agent, await runtimeRow(w));
      expect(pinged?.ran).toBe(true);
      expect(pinged?.reasons).toContain('pending_mention');
      expect(thoughts(w)).toBeGreaterThan(0);
    } finally {
      await w.close();
    }
  });

  it('loop (the default in code): the same arrived wake runs a turn by itself', async () => {
    const { w, agent } = await settled('loop');
    try {
      const ran = await processAgent(w.ctx, agent, await runtimeRow(w));
      expect(ran?.ran).toBe(true);
      expect(ran?.reasons).toEqual(['scheduled']);
    } finally {
      await w.close();
    }
  });
});
