import { describe, expect, it } from 'vitest';
import { actions, approvals } from '../src/db/schema.js';
import { THREAD_PART_EXCERPT, asksQuestion, questionBudget, questionQuotaRefusal, recentPosts, recentPostsSection } from '../src/recent-posts.js';
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

describe('recentPosts and a thread', () => {
  const THREAD = [{ text: 'The second post of the thread goes on about the split of the fees between the agent, the creator and the platform, at some length.' }, { text: 'The third closes it.' }, { text: 'A fourth that never went out.' }];
  const row = (id: string, minutesAgo: number, now: number, input: Record<string, unknown>, result: Record<string, unknown> = { postId: '9001' }) => ({ actionId: id, agentId: AGENT_ID, cycleKey: id, action: { tool: 'publish_post', input }, status: 'completed', attempts: 1, result: { actionId: id, tool: 'publish_post', status: 'completed', result }, createdAt: new Date(now - minutesAgo * 60_000), updatedAt: new Date(now - minutesAgo * 60_000) });

  it('is one item: the first post in text, the start of each later post in more, and for a cut one only the posts that went out', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const now = w.ctx.now();
      await w.db.insert(actions).values([
        row('act_t1', 30, now, { text: 'A whole thread, first post.', thread: THREAD.slice(0, 2) }, { postId: '9001', parts: [{ n: 1, postId: '9001' }, { n: 2, postId: '9002' }, { n: 3, postId: '9003' }], sent: 3, of: 3 }),
        row('act_t2', 60, now, { text: 'A thread that was cut, first post.', thread: THREAD }, { postId: '9010', parts: [{ n: 1, postId: '9010' }, { n: 2, postId: '9011' }], sent: 2, of: 4, cut: { n: 3, error: 'sender_held' } }),
        row('act_t3', 90, now, { text: 'A thread cut after its first post.', thread: THREAD.slice(0, 1) }, { postId: '9020', parts: [{ n: 1, postId: '9020' }], sent: 1, of: 2, cut: { n: 2, error: 'x' } }),
        row('act_p1', 120, now, { text: 'A single post.' }),
      ] as never);
      await w.db.insert(approvals).values([{ id: 'act_q1', agentId: AGENT_ID, kind: 'post', text: 'A thread in the review queue, first post.', textHash: 'hq', status: 'pending_approval', meta: { thread: THREAD.slice(1, 2) }, createdAt: new Date(now - 10 * 60_000) }]);
      const items = await recentPosts(w.ctx, AGENT_ID);
      expect(items.map((i) => ({ text: i.text, more: i.more, of: i.of }))).toEqual([
        { text: 'A thread in the review queue, first post.', more: ['The third closes it.'], of: undefined },
        { text: 'A whole thread, first post.', more: [THREAD[0]!.text.slice(0, 80), 'The third closes it.'], of: undefined },
        { text: 'A thread that was cut, first post.', more: [THREAD[0]!.text.slice(0, 80)], of: 4 },
        { text: 'A thread cut after its first post.', more: undefined, of: 2 },
        { text: 'A single post.', more: undefined, of: undefined },
      ]);
      expect(THREAD_PART_EXCERPT).toBe(80);
      expect(items[1]!.more![0]).toHaveLength(80);
      // the words say what more and of are only while a thread is listed
      const section = (await recentPostsSection(w.ctx, AGENT_ID)) as { recentPosts: { meaning: string } };
      expect(section.recentPosts.meaning).toBe("what you already said in the last two days, newest first; never repeat a fact or a phrasing from here, and a rejected item carries the creator's note. A thread is one item: text is its first post and more holds the start of each post after it (with of, the thread was cut and only these went out)");
      // a whole day of the most a coin may thread stays small: two threads of four posts are 2 x (140 + 3 x 80) characters of text
      expect(JSON.stringify(items.slice(0, 2)).length).toBeLessThan(900);
    } finally {
      await w.close();
    }
  });

  it('a coin that never wrote a thread reads the section as it always was', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await w.db.insert(actions).values([row('act_p1', 20, w.ctx.now(), { text: 'A single post.' })] as never);
      expect((await recentPostsSection(w.ctx, AGENT_ID)).recentPosts).toEqual({ meaning: "what you already said in the last two days, newest first; never repeat a fact or a phrasing from here, and a rejected item carries the creator's note", items: [{ at: new Date(w.ctx.now() - 20 * 60_000).toISOString(), kind: 'post', status: 'sent', text: 'A single post.' }] });
    } finally {
      await w.close();
    }
  });

  it('the question quota already reads every post of a thread: a question in a later one counts', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await w.db.insert(actions).values([row('act_t1', 20, w.ctx.now(), { text: 'A statement first.', thread: [{ text: 'And then, what do you think?' }] }, { postId: '9001', sent: 2, of: 2 })] as never);
      expect(await questionBudget(w.ctx, AGENT_ID)).toMatchObject({ recentWithQuestion: 1, mayAskNow: false });
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
