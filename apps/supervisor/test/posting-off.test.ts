/**
 * Every limit of the posting workstream at "off" (docs/design/agent-tools-2.md section 17.1 rule 4): the tool an agent
 * is shown, what the broker sends and what it refuses are what they were before threads, comments, the mention
 * audience and the open reply audience existed. This file states the switched-off state piece by piece; the whole
 * suite is run in it by `vitest run -c vitest.posting-off.config.ts`, which is what shows that nothing else moved.
 */
import { toFunctionDefinitions } from '@bootr/agent-core';
import { describe, expect, it } from 'vitest';
import { agentDirectory } from '../src/agent-directory.js';
import { availableTools, executeAction, inboxViews, publishPostOptions } from '../src/broker/index.js';
import { agentConfigOf } from '../src/onboarding.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { WEEKLY_DIGEST_INSTRUCTION, WEEKLY_DIGEST_INSTRUCTION_NO_THREAD, weeklyDigestSection, type WeeklyDigestPlan } from '../src/weekly-digest.js';
import { finishResponse, makeWorld, seedAgent, toolCallResponse } from './helpers.js';
import { HOUR, POSTING_DEFAULTS, POSTING_OFF, T0, actionRow, brokerEnv, pendingOf, storeTurn } from './posting-helpers.js';

/** `publish_post` as it read, and the fields it took, before this round. */
const BEFORE = 'Publish one original post when the supplied schedule says it is due. Fresh content in your own voice, up to 4000 characters, no templates and no catch-up bursts. imageId (optional) attaches a picture you made this turn with generate_image.';
const BEFORE_KEYS = ['text', 'attributions', 'imageId'];
const plan: WeeklyDigestPlan = { week: '2026-W43', slotAt: T0, from: T0 - 7 * 24 * HOUR, to: T0, facts: {} as never };

type Fn = { function: { name: string; description: string; parameters: { properties: Record<string, unknown> } } };

describe('every posting limit at off', () => {
  it('publish_post is shown without thread and about; with the facts off too it is byte for byte what it was', async () => {
    const w = await makeWorld({ config: POSTING_OFF });
    try {
      const agent = await seedAgent(w);
      const config = agentConfigOf(agent)!;
      expect(publishPostOptions(w.ctx, config)).toEqual({ threadMore: 0, comments: false, topic: true });
      const tool = availableTools(w.ctx, config).find((t) => t.name === 'publish_post')!;
      expect(tool.description).toBe(`${BEFORE} topic (optional) is your own one word for what the post is about.`);
      const [shown] = toFunctionDefinitions([tool]) as unknown as Fn[];
      expect(Object.keys(shown!.function.parameters.properties)).toEqual([...BEFORE_KEYS, 'topic']);

      // `topic` feeds the facts of another workstream: with that piece off as well, nothing of this round is left in the tool
      const allOff = { config: { ...w.ctx.config, LEARN_WINDOW_DAYS: 0 } } as unknown as typeof w.ctx;
      const before = availableTools(allOff, config).find((t) => t.name === 'publish_post')!;
      expect(before.description).toBe(BEFORE);
      expect(Object.keys((toFunctionDefinitions([before]) as unknown as Fn[])[0]!.function.parameters.properties)).toEqual(BEFORE_KEYS);
      // every other tool is the catalog's own object
      const defaults = await makeWorld({ config: POSTING_DEFAULTS });
      try {
        const on = availableTools(defaults.ctx, config);
        expect(availableTools(w.ctx, config).filter((t) => t.name !== 'publish_post')).toEqual(on.filter((t) => t.name !== 'publish_post'));
        expect(on.find((t) => t.name === 'publish_post')!.description).toContain(' thread (optional) adds up to 3 more connected posts');
        expect(publishPostOptions(defaults.ctx, config)).toEqual({ threadMore: 3, comments: true, topic: true });
      } finally {
        await defaults.close();
      }
    } finally {
      await w.close();
    }
  });

  it('a hosted turn is offered that tool, and a plain post reaches the sender with the fields it always had', async () => {
    const w = await makeWorld({ config: POSTING_OFF, script: [toolCallResponse('publish_post', { text: 'A plain post, as before.' }), finishResponse(T0 + 3 * HOUR)] });
    try {
      await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString() } });
      const r = await tick(w.ctx);
      expect(r.errors).toEqual([]);
      const request = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!.body as { tools: Fn[] };
      const offered = request.tools.find((t) => t.function.name === 'publish_post')!;
      expect(offered.function.description).not.toMatch(/thread \(optional\)|about \(optional\)/);
      expect(Object.keys(offered.function.parameters.properties)).toEqual([...BEFORE_KEYS, 'topic']);
      expect(w.sender.published).toHaveLength(1);
      expect(Object.keys(w.sender.published[0] as object).sort()).toEqual(['actionId', 'agentId', 'publicAddresses', 'text', 'xUserId']);
    } finally {
      await w.close();
    }
  });

  it('a thread and a comment are refused whole, in the words of their limit, and nothing is sent', async () => {
    const w = await makeWorld({ config: POSTING_OFF });
    try {
      const agent = await seedAgent(w);
      const config = agentConfigOf(agent)!;
      const thread = await executeAction(w.ctx, agent, config, pendingOf('act-off-00000001', 'publish_post', { text: 'First.', thread: [{ text: 'Second.' }] }), brokerEnv());
      expect(thread).toEqual({ kind: 'failed', error: 'thread_too_long: a thread has at most 1 posts; nothing was posted. Say it in fewer.' });
      await storeTurn(w, { seen: [{ postId: '501', authorId: '42', handle: 'alice', verified: true, verifiedType: 'blue', at: new Date(T0 - HOUR).toISOString(), via: 'thread' }] });
      const comment = await executeAction(w.ctx, agent, config, pendingOf('act-off-00000002', 'publish_post', { text: 'A thought.', about: { postId: '501' } }), brokerEnv());
      expect(comment).toEqual({ kind: 'failed', error: 'comment_daily_cap: at most 0 comments per 24 hours; nothing was posted.' });
      expect(w.sender.published).toEqual([]);
      // `topic` rides along and changes nothing
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-off-00000003', 'publish_post', { text: 'A post with a topic.', topic: 'fees' }), brokerEnv())).toMatchObject({ kind: 'completed' });
    } finally {
      await w.close();
    }
  });

  it('any active account may be mentioned with a credit, and an unverified reply under the agent\'s own post is closed, as before', async () => {
    const w = await makeWorld({ config: POSTING_OFF });
    try {
      // the coin asks for the open audience; with the count at 0 nobody has it
      const agent = await seedAgent(w, { config: { replyAudience: 'own_threads' } });
      const config = agentConfigOf(agent)!;
      const mention = await executeAction(w.ctx, agent, config, pendingOf('act-off-00000004', 'publish_post', { text: 'A sharp point from @stranger.', attributions: [{ username: 'stranger', sourceUrl: 'https://example.com/s' }] }), brokerEnv());
      expect(mention.kind).toBe('completed');
      await actionRow(w, 'own-post-000001', { tool: 'publish_post', input: { text: 'own' } }, { result: { actionId: 'own-post-000001', tool: 'publish_post', status: 'completed', result: { postId: '9001' } } });
      const item: SenderInboxItem = { postId: '8101', authorId: '4300', conversationId: '9001', status: 'pending', observedAt: new Date(T0).toISOString(), seenAt: null, deferredUntil: null, post: { id: '8101', authorId: '4300', text: '@bootr_agent how?', inReplyToUserId: '1000', referencedPosts: [{ type: 'replied_to', id: '9001' }], author: { id: '4300', username: 'user4300', verified: false } } };
      const directory = await agentDirectory(w.ctx, { fresh: true });
      expect(directory.openReplies.size).toBe(0);
      expect(inboxViews(config, [item], w.ctx.now(), directory)[0]).toMatchObject({ eligible: false, reason: 'verified_audience_required' });
    } finally {
      await w.close();
    }
  });

  it('the weekly digest says "there are no threads" exactly while the tool offers none', async () => {
    const off = await makeWorld({ config: POSTING_OFF });
    const on = await makeWorld({ config: POSTING_DEFAULTS });
    try {
      const agent = await seedAgent(off, { config: { platform: true, identityText: 'The launchpad\'s own voice.' } });
      const config = agentConfigOf(agent)!;
      const instructionOf = (tools: Parameters<typeof weeklyDigestSection>[2]) => (weeklyDigestSection(config, plan, tools).weeklyDigest as { instruction: string }).instruction;
      expect(instructionOf(availableTools(off.ctx, config))).toBe(WEEKLY_DIGEST_INSTRUCTION);
      expect(WEEKLY_DIGEST_INSTRUCTION).toContain('One post only (publish_post makes one post; there are no threads). ');
      expect(instructionOf(availableTools(on.ctx, config))).toBe(WEEKLY_DIGEST_INSTRUCTION_NO_THREAD);
      expect(WEEKLY_DIGEST_INSTRUCTION_NO_THREAD).toContain('One post only (one post, no thread). ');
      expect(WEEKLY_DIGEST_INSTRUCTION_NO_THREAD).not.toContain('there are no threads');
      // a caller that hands over names alone gets the sentence as it was
      expect(instructionOf([{ name: 'publish_post' }])).toBe(WEEKLY_DIGEST_INSTRUCTION);
    } finally {
      await off.close();
      await on.close();
    }
  });
});
