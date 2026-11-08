import { describe, expect, it } from 'vitest';
import { actions } from '../src/db/schema.js';
import { POST_BUDGET_WINDOW_MS, postBudgetSection, postBudgetView, postsPerDayOf, publishesLast24h } from '../src/post-budget.js';
import { AGENT_ID, agentConfig, makeWorld, seedAgent } from './helpers.js';

describe('postBudget', () => {
  it("counts the day's publishes against the creator's budget and says when a used-up budget opens", () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    expect(postBudgetView(24, { count: 0, oldest: null }, now)).toMatchObject({ postsPerDay: 24, usedLast24h: 0, remaining: 24 });
    expect(postBudgetView(24, { count: 20, oldest: now - 3_600_000 }, now)).toMatchObject({ remaining: 4 });
    expect(postBudgetView(24, { count: 20, oldest: now - 3_600_000 }, now).meaning).toMatch(/keep the last few for replies/);
    expect(postBudgetView(24, { count: 10, oldest: now - 3_600_000 }, now).meaning).not.toMatch(/keep the last few/);
    const full = postBudgetView(6, { count: 6, oldest: now - 20 * 3_600_000 }, now);
    expect(full).toMatchObject({ remaining: 0, opensAt: new Date(now - 20 * 3_600_000 + POST_BUDGET_WINDOW_MS).toISOString() });
    expect(full.meaning).toMatch(/used up/);
    // more publishes than the budget (a budget lowered today) never goes negative
    expect(postBudgetView(2, { count: 5, oldest: now - 3_600_000 }, now).remaining).toBe(0);
    expect(postsPerDayOf({})).toBe(24);
    expect(postsPerDayOf({ postsPerDay: 7 })).toBe(7);
    expect(postsPerDayOf({ postsPerDay: 0 })).toBe(24);
  });

  it("reads the agent's own posts and replies of the last day that are in flight or sent, and skips an agent that neither posts nor replies", async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const now = w.ctx.now();
      const row = (id: string, ageMs: number, tool: string, status: string) => ({ actionId: id, agentId: AGENT_ID, cycleKey: id, action: { tool, input: { text: 't' } }, status, attempts: 1, createdAt: new Date(now - ageMs), updatedAt: new Date(now - ageMs) });
      await w.db.insert(actions).values([
        row('a', 3_600_000, 'publish_post', 'completed'),
        row('b', 2 * 3_600_000, 'publish_reply', 'sent'),
        row('c', 60_000, 'publish_reply', 'sending'),
        row('d', 3_600_000, 'publish_post', 'failed'),
        row('e', 25 * 3_600_000, 'publish_post', 'completed'),
        row('f', 3_600_000, 'read_market', 'completed'),
      ] as never);
      expect(await publishesLast24h(w.ctx, AGENT_ID)).toEqual({ count: 3, oldest: now - 2 * 3_600_000 });
      const config = agentConfig(now, { postsPerDay: 4 }) as never;
      expect(await postBudgetSection(w.ctx, AGENT_ID, config)).toEqual({ postBudget: expect.objectContaining({ postsPerDay: 4, usedLast24h: 3, remaining: 1 }) });
      const caps = (config as { capabilities: Record<string, boolean> }).capabilities;
      expect(await postBudgetSection(w.ctx, AGENT_ID, { ...(config as object), capabilities: { ...caps, xPublish: false, xReply: false } } as never)).toEqual({});
    } finally {
      await w.close();
    }
  });
});
