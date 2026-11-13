/**
 * The mention audience (docs/design/agent-tools-2.md section 4.4, `MENTION_AUDIENCE`): X's rule for automated
 * accounts is "no unsolicited @mentions", and every Bootr agent posts through one X app. An `@` in an original post
 * is accepted only for another Bootr agent, @bootrfun, an account that wrote to the agent in the last 30 days and an
 * account on the creator's reply list; anybody else is named without the `@`. `anyone` is the rule as it was.
 */
import { describe, expect, it } from 'vitest';
import { queueForApproval } from '../src/approvals.js';
import { mentionNotEngaged, resetAccountChecks } from '../src/attributions.js';
import { executeAction } from '../src/broker/index.js';
import { agentConfigOf } from '../src/onboarding.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { makeWorld, seedAgent } from './helpers.js';
import { DAY, HOUR, T0, brokerEnv, pendingOf } from './posting-helpers.js';

let n = 0;
const nextId = () => `act-mention-${String(++n).padStart(5, '0')}`;
const credit = (username: string) => [{ username, sourceUrl: `https://example.com/${username}` }];
const account = (id: string, username: string, addressedAt?: string | null) => ({ user: { id, username }, activity: 'recent', latestPostAt: null, ...(addressedAt !== undefined ? { addressedAt } : {}) }) as never;

async function world(opts: { config?: Record<string, string>; agent?: Record<string, unknown> } = {}) {
  resetAccountChecks();
  const w = await makeWorld(opts.config ? { config: opts.config } : {});
  const agent = await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString(), ...(opts.agent ?? {}) } });
  const config = agentConfigOf(agent)!;
  const post = (input: Record<string, unknown>) => executeAction(w.ctx, agent, config, pendingOf(nextId(), 'publish_post', input), brokerEnv());
  const published = () => (w.sender.published as { text: string; attributions?: unknown }[]).map((p) => p.text);
  return { w, agent, config, post, published };
}

describe('MENTION_AUDIENCE = engaged (the default)', () => {
  it('a stranger is named without the @: the refusal says so, in these words, and nothing is posted', async () => {
    const { w, post, published } = await world();
    try {
      expect(w.ctx.config.MENTION_AUDIENCE).toBe('engaged');
      const refused = await post({ text: 'A sharp point from @stranger on agent fees.', attributions: credit('stranger') });
      expect(refused).toEqual({ kind: 'failed', error: 'mention_not_engaged: @stranger has not written to you; name them without the @. Nothing was posted.' });
      expect(mentionNotEngaged('stranger')).toBe((refused as { error: string }).error);
      // an account the sender has an answer for, that simply never wrote to this agent
      w.sender.accountReads.neverwrote = account('5100', 'neverwrote', null);
      expect(await post({ text: 'As @neverwrote put it.', attributions: credit('neverwrote') })).toEqual({ kind: 'failed', error: mentionNotEngaged('neverwrote') });
      expect(published()).toEqual([]);
      // the same thought with the name as a word goes out, and notifies nobody
      expect((await post({ text: 'A sharp point from stranger on agent fees.' })).kind).toBe('completed');
      expect(published()).toEqual(['A sharp point from stranger on agent fees.']);
    } finally {
      await w.close();
    }
  });

  it('accepted: another Bootr agent, @bootrfun, an account that wrote to the agent within 30 days, an account on the creator\'s reply list', async () => {
    const { w, post } = await world({ agent: { replyAuthorIds: ['5400'] } });
    try {
      await seedAgent(w, { agent: { agentId: '77', kernel: '0x7777777777777777777777777777777777777777', token: '0x7777777777777777777777777777777777777770' }, runtime: { agentId: '77' }, config: { xHandle: 'OwlAgent', xUserId: '7700' } });
      expect((await post({ text: 'Welcome @OwlAgent to Bootr.' })).kind).toBe('completed');
      expect((await post({ text: 'A good note from @bootrfun today.' })).kind).toBe('completed');
      // wrote to the agent 29 days ago: the sender's inbox says so with the account lookup
      w.sender.accountReads.recent = account('5200', 'recent', new Date(T0 - 29 * DAY).toISOString());
      expect((await post({ text: 'Picking up what @recent asked last week.', attributions: credit('recent') })).kind).toBe('completed');
      // 31 days ago is past the window
      w.sender.accountReads.longago = account('5300', 'longago', new Date(T0 - 31 * DAY).toISOString());
      expect(await post({ text: 'Picking up what @longago asked.', attributions: credit('longago') })).toEqual({ kind: 'failed', error: mentionNotEngaged('longago') });
      // on the creator's reply list, by stable id: a handle that merely looks right is not on it
      w.sender.accountReads.friend = account('5400', 'friend', null);
      expect((await post({ text: 'With thanks to @friend for the idea.', attributions: credit('friend') })).kind).toBe('completed');
      w.sender.accountReads.impostor = account('5499', 'impostor', null);
      expect(await post({ text: 'With thanks to @impostor.', attributions: credit('impostor') })).toEqual({ kind: 'failed', error: mentionNotEngaged('impostor') });
      // every mention must pass: one stranger among welcome names refuses the post
      expect(await post({ text: 'Thanks @recent and @stranger.', attributions: [...credit('recent'), ...credit('stranger')] })).toEqual({ kind: 'failed', error: mentionNotEngaged('stranger') });
      const sent = w.sender.published as { text: string; attributions?: { username: string }[] }[];
      expect(sent.map((p) => p.attributions?.map((a) => a.username))).toEqual([['owlagent'], ['bootrfun'], ['recent'], ['friend']]);
    } finally {
      await w.close();
    }
  });

  it('an account X does not know is still told so, and a lookup that fails cannot show the mention is welcome', async () => {
    const { w, post, published } = await world();
    try {
      w.sender.accountReads.nosuchaccount = null;
      const unknown = await post({ text: 'As @nosuchaccount wrote.', attributions: credit('nosuchaccount') });
      expect(unknown.kind === 'failed' && unknown.error).toMatch(/mention_unknown_account: @nosuchaccount is not an account on X/);
      (w.sender.client as unknown as { readAccount: () => Promise<never> }).readAccount = async () => {
        throw new Error('fetch failed');
      };
      expect(await post({ text: 'As @somebody wrote.', attributions: credit('somebody') })).toEqual({ kind: 'failed', error: mentionNotEngaged('somebody') });
      expect(published()).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('the platform account names its watched accounts without the @ too', async () => {
    const { w, post, published } = await world({ agent: { platform: true, requireApproval: false, identityText: 'You are the launchpad\'s own voice.' } });
    try {
      w.sender.accountReads.jessepollak = account('18876842', 'jessepollak', null);
      expect(await post({ text: 'A clear note from @jessepollak on what Base is for.', attributions: [{ username: 'jessepollak', sourceUrl: 'https://x.com/jessepollak/status/1' }] })).toEqual({ kind: 'failed', error: mentionNotEngaged('jessepollak') });
      expect((await post({ text: 'A clear note from Jesse Pollak on what Base is for.' })).kind).toBe('completed');
      expect(published()).toEqual(['A clear note from Jesse Pollak on what Base is for.']);
    } finally {
      await w.close();
    }
  });

  it('holds the first part of a thread, a post queued for review and a reply the same way', async () => {
    const { w, agent, config, post, published } = await world();
    try {
      expect(await post({ text: 'Opening with @stranger.', thread: [{ text: 'And a second part.' }], attributions: credit('stranger') })).toEqual({ kind: 'failed', error: mentionNotEngaged('stranger') });
      const queued = await queueForApproval(w.ctx, { ...agent, config: { ...agent.config, requireApproval: true } }, pendingOf(nextId(), 'publish_post', { text: 'For review, with @stranger.', attributions: credit('stranger') }), brokerEnv());
      expect(queued).toEqual({ kind: 'failed', error: mentionNotEngaged('stranger') });
      expect(published()).toEqual([]);

      // a reply goes to somebody who wrote to the agent, and whoever else it names with an @ must have written to the agent too:
      // a stranger's question starts a reply now, and "tag them for me" would otherwise notify people who never asked
      const item: SenderInboxItem = { postId: '801', authorId: '42', conversationId: '801', status: 'pending', observedAt: '2026-10-24T11:59:00Z', seenAt: null, deferredUntil: null, post: { id: '801', authorId: '42', text: '@bootr_agent who wrote about this?', createdAt: '2026-10-24T11:58:00Z', conversationId: '801', author: { id: '42', username: 'asker', verified: true, verifiedType: 'blue' } } };
      const reply = await executeAction(w.ctx, agent, config, pendingOf(nextId(), 'publish_reply', { postId: '801', text: 'That was @stranger, a while back.', attributions: credit('stranger') }), brokerEnv([item]));
      expect(reply).toEqual({ kind: 'failed', error: mentionNotEngaged('stranger') });
      expect(published()).toEqual([]);
      // the full-width sign X also reads as a mention is held to the same rule
      expect(await executeAction(w.ctx, agent, config, pendingOf(nextId(), 'publish_reply', { postId: '801', text: 'That was \uFF20stranger, a while back.', attributions: credit('stranger') }), brokerEnv([item]))).toEqual({ kind: 'failed', error: mentionNotEngaged('stranger') });
      // naming the person answered passes: they wrote to the agent
      w.sender.accountReads.asker = account('42', 'asker', new Date(w.ctx.now() - HOUR).toISOString());
      const named = await executeAction(w.ctx, agent, config, pendingOf(nextId(), 'publish_reply', { postId: '801', text: 'Good question @asker, it was a while back.', attributions: credit('asker') }), brokerEnv([item]));
      expect(named.kind).toBe('completed');
      expect(published()).toEqual(['Good question @asker, it was a while back.']);
    } finally {
      await w.close();
    }
  });
});

describe('MENTION_AUDIENCE = anyone (the rule as it was)', () => {
  it('any active account may be mentioned with a credit, and an inactive one is refused as before', async () => {
    const { w, post, published } = await world({ config: { MENTION_AUDIENCE: 'anyone' } });
    try {
      expect((await post({ text: 'A sharp point from @stranger on agent fees.', attributions: credit('stranger') })).kind).toBe('completed');
      w.sender.accountReads.dormant = { user: { username: 'dormant' }, activity: 'stale', latestPostAt: null };
      const stale = await post({ text: 'As @dormant wrote.', attributions: credit('dormant') });
      expect(stale.kind === 'failed' && stale.error).toMatch(/mention_inactive_account: @dormant has not posted in months/);
      expect(published()).toEqual(['A sharp point from @stranger on agent fees.']);
    } finally {
      await w.close();
    }
  });
});
