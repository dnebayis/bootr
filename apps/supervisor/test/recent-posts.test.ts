import { describe, expect, it } from 'vitest';
import { actions, approvals } from '../src/db/schema.js';
import { recentPosts, recentPostsSection } from '../src/recent-posts.js';
import { AGENT_ID, makeWorld, seedAgent } from './helpers.js';

describe('recentPosts', () => {
  it('lists what the agent said in the last day, newest first, with the creator\'s rejection note, and nothing older', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const now = w.ctx.now();
      await w.db.insert(approvals).values([
        { id: 'act_a1', agentId: AGENT_ID, kind: 'post', text: 'Nothing much moved on Bootr in the last day.', textHash: 'h1', status: 'rejected', note: 'Today is launch day. Write in lowercase.', createdAt: new Date(now - 3 * 3_600_000) },
        { id: 'act_a2', agentId: AGENT_ID, kind: 'reply', text: 'each coin gets its own wallet and x account.', textHash: 'h2', status: 'pending_approval', createdAt: new Date(now - 60_000) },
        { id: 'act_old', agentId: AGENT_ID, kind: 'post', text: 'from two days ago', textHash: 'h3', status: 'approved', createdAt: new Date(now - 72 * 3_600_000) },
      ]);
      await w.db.insert(actions).values([
        { actionId: 'act_s1', agentId: AGENT_ID, cycleKey: 'c1', action: { tool: 'publish_post', input: { text: 'basecat launched on bootr today; its agent is @basecatagent.' } }, status: 'completed', attempts: 1, createdAt: new Date(now - 2 * 3_600_000), updatedAt: new Date(now - 2 * 3_600_000) },
        { actionId: 'act_s2', agentId: AGENT_ID, cycleKey: 'c2', action: { tool: 'read_coin', input: { symbolOrAddress: 'BASECAT' } }, status: 'completed', attempts: 1, createdAt: new Date(now - 2 * 3_600_000), updatedAt: new Date(now - 2 * 3_600_000) },
      ] as never);
      const items = await recentPosts(w.ctx, AGENT_ID);
      expect(items.map((i) => [i.kind, i.status, i.text.slice(0, 20)])).toEqual([
        ['reply', 'pending_review', 'each coin gets its o'],
        ['post', 'sent', 'basecat launched on '],
        ['post', 'rejected', 'Nothing much moved o'],
      ]);
      expect(items[2]!.note).toBe('Today is launch day. Write in lowercase.');
      expect(items[0]!.note).toBeUndefined();
      const section = await recentPostsSection(w.ctx, AGENT_ID);
      expect(section.recentPosts).toMatchObject({ items: expect.any(Array) });
      expect(await recentPostsSection(w.ctx, 'nobody')).toEqual({});
    } finally {
      await w.close();
    }
  });
});
