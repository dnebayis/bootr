import { describe, expect, it } from 'vitest';
import { actions, approvals } from '../src/db/schema.js';
import { asksQuestion, questionBudget, questionQuotaRefusal, recentPosts, recentPostsSection } from '../src/recent-posts.js';
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

describe('the question quota', () => {
  const post = (id: string, text: string, minutesAgo: number, now: number, tool = 'publish_post', status = 'completed') => ({
    actionId: id,
    agentId: AGENT_ID,
    cycleKey: id,
    action: { tool, input: { text } },
    status,
    attempts: 1,
    createdAt: new Date(now - minutesAgo * 60_000),
    updatedAt: new Date(now - minutesAgo * 60_000),
  });

  it('reads a question mark outside links only', () => {
    expect(asksQuestion('Builders, what is yours? 🙂')).toBe(true);
    expect(asksQuestion('Fee splits are locked at launch. https://bootr.fun/docs/fees?tab=split')).toBe(false);
    expect(asksQuestion('A plain statement.')).toBe(false);
  });

  it('allows one question in five original posts, ignores replies and failed posts, and says so in the observation', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const now = w.ctx.now();
      // nothing yet: a question may go, and an agent with no posts gets no section
      expect(await questionBudget(w.ctx, AGENT_ID)).toEqual({ recentWithQuestion: 0, lookback: 4, mayAskNow: true });
      expect(questionQuotaRefusal('What would you build?', await questionBudget(w.ctx, AGENT_ID))).toBeNull();

      await w.db.insert(actions).values([
        post('p1', 'Builders, what would your agent turn down first?', 300, now),
        post('p2', 'Fee splits are locked at launch.', 240, now),
        post('r1', 'Good question, what made you ask?', 200, now, 'publish_reply'),
        post('f1', 'Did this go out?', 190, now, 'publish_post', 'failed'),
        post('p3', '$BOOTR has 504 holders today.', 180, now),
      ] as never);
      let budget = await questionBudget(w.ctx, AGENT_ID);
      expect(budget).toEqual({ recentWithQuestion: 1, lookback: 4, mayAskNow: false });
      expect(questionQuotaRefusal('Builders, what is yours?', budget)).toMatch(/^question_quota: 1 of your last 4 original posts/);
      expect(questionQuotaRefusal('A burn is the creator\'s choice, locked at launch.', budget)).toBeNull();
      const section = await recentPostsSection(w.ctx, AGENT_ID);
      expect(section.questions).toMatchObject({ recentWithQuestion: 1, mayAskNow: false });

      // four statements later the question has aged out of the window
      await w.db.insert(actions).values([post('p4', 'One.', 120, now), post('p5', 'Two.', 90, now), post('p6', 'Three.', 60, now)] as never);
      budget = await questionBudget(w.ctx, AGENT_ID);
      expect(budget).toEqual({ recentWithQuestion: 0, lookback: 4, mayAskNow: true });

      // the action being decided is not counted against itself
      await w.db.insert(actions).values([post('p7', 'Is this the one?', 1, now)] as never);
      expect((await questionBudget(w.ctx, AGENT_ID, { excludeActionId: 'p7' })).mayAskNow).toBe(true);
      expect((await questionBudget(w.ctx, AGENT_ID)).mayAskNow).toBe(false);
    } finally {
      await w.close();
    }
  });
});
