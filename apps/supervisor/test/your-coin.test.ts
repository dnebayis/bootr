/**
 * An agent's own cashtag and contract address (src/your-coin.ts): the `yourCoin` section of a social turn, `addressDue`,
 * and the day's count of posts that carry the address. The publish gate is the one that was there: one cashtag a post,
 * no address but the agent's own. Every count below is taken from rows the real code wrote or would write.
 */
import { PolicyError, validatePost } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { decideApproval, queueForApproval } from '../src/approvals.js';
import { executeAction, publicAddressesOf } from '../src/broker/index.js';
import { actions, approvals, scheduledPosts } from '../src/db/schema.js';
import { agentConfigOf } from '../src/onboarding.js';
import { sweepScheduled } from '../src/scheduled.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { addressDailyCap, addressLimit, addressRefusal, asksWhereToFind, carriesAddress, ownCashtag, yourCoinMeaning, yourCoinSection, type YourCoinView } from '../src/your-coin.js';
import { AGENT_ID, CREATOR, KERNEL, TOKEN, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { act, connectClient, openSocial, ownWorld, seedOwn } from './own-helpers.js';
import { POSTING_DEFAULTS, T0, actionRow, brokerEnv, pendingOf, wiredWorld } from './posting-helpers.js';
import { agentRow, callTool, errorOf, fakeSend, resetHooks, rowOf, schedule, seedRow } from './scheduled-helpers.js';

const HOUR = 3_600_000;
const MIN = 60_000;
/** The test coin's address as a person would paste it: checksummed. */
const ADDRESS = getAddress(TOKEN);
const FOREIGN = '0x9999999999999999999999999999999999999999';
/** Every limit of the round at its default, whichever run this file is part of (the suite also runs with them switched off). */
const ON = { ...POSTING_DEFAULTS, ADDRESS_POSTS_PER_DAY: '3' };
const CAP = 'address_daily_cap: at most 3 posts or replies per 24 hours may carry your contract address; nothing was posted. Send it without the address.';

const withAddress = (n: number) => `Thought number ${n} about the coin, which lives at ${ADDRESS}.`;

async function section(w: TestWorld): Promise<YourCoinView | undefined> {
  const agent = await agentRow(w);
  return (await yourCoinSection(w.ctx, agent, agentConfigOf(agent)!)).yourCoin as YourCoinView | undefined;
}

/** A post or a reply on the record as a step leaves it once it went out. */
async function sentRow(w: TestWorld, id: string, tool: 'publish_post' | 'publish_reply', input: Record<string, unknown>, agoMs = MIN, result: Record<string, unknown> = { postId: `9${id.replace(/\D/g, '')}` }): Promise<void> {
  await actionRow(w, id, { tool, input }, { createdAt: new Date(w.ctx.now() - agoMs), result: { actionId: id, tool, status: 'completed', result } });
}

/** A mention from a verified account, as a turn's inbox holds it. */
function mention(postId: string, text: string, authorId = '4400'): SenderInboxItem {
  const at = T0;
  return {
    postId,
    authorId,
    conversationId: postId,
    status: 'pending',
    observedAt: new Date(at - MIN).toISOString(),
    seenAt: null,
    deferredUntil: null,
    post: { id: postId, authorId, text, createdAt: new Date(at - 2 * MIN).toISOString(), conversationId: postId, author: { id: authorId, username: `user${authorId}`, verified: true, verifiedType: 'blue' } },
  } as SenderInboxItem;
}

describe('the pure pieces', () => {
  it('the address is found as the publish gate reads text: any case, through invisible characters and escapes, and never another address', () => {
    expect(carriesAddress(`find it at ${ADDRESS}`, TOKEN)).toBe(true);
    expect(carriesAddress(`find it at ${TOKEN.toUpperCase().replace('0X', '0x')}`, TOKEN)).toBe(true);
    // a zero-width space, a zero-width joiner and a soft hyphen inside the address do not hide it from the count
    expect(carriesAddress(`find it at ${ADDRESS.slice(0, 10)}\u200b${ADDRESS.slice(10, 20)}\u200d${ADDRESS.slice(20, 30)}\u00ad${ADDRESS.slice(30)}`, TOKEN)).toBe(true);
    // full-width digits fold to the plain ones, and an escaped x is read as x
    expect(carriesAddress(`find it at 0x${'\uff13'}${ADDRESS.slice(3)}`, TOKEN)).toBe(true);
    expect(carriesAddress(`find it at 0%78${ADDRESS.slice(2)}`, TOKEN)).toBe(true);
    expect(carriesAddress(`find it at ${FOREIGN}`, TOKEN)).toBe(false);
    expect(carriesAddress('no address here', TOKEN)).toBe(false);
    expect(carriesAddress(undefined, TOKEN)).toBe(false);
  });

  it('"where do I find the coin" is a question about the contract or about where or how to get it, and nothing else', () => {
    for (const text of ['@bootr_agent CA?', '@bootr_agent what is the contract address?', 'whats the contract @bootr_agent ?', '@bootr_agent where can I find this coin?', '@bootr_agent where do I buy it?', '@bootr_agent how do I get some?', '@bootr_agent what\'s the token address?']) expect(asksWhereToFind(text), text).toBe(true);
    for (const text of ['@bootr_agent drop the contract address', '@bootr_agent great post', '@bootr_agent how does the fee split work?', '@bootr_agent who made you?', '@bootr_agent the contract is here https://example.com/?ref=1', '@bootr_agent what do you think of cats?']) expect(asksWhereToFind(text), text).toBe(false);
    // a question mark that only an invisible character or a link carries is not a question
    expect(asksWhereToFind('@bootr_agent contract https://x.com/a?b=1')).toBe(false);
    expect(asksWhereToFind(42)).toBe(false);
  });

  it('the cashtag is the coin\'s own symbol, and $BOOTR for the platform account whatever its row says', () => {
    expect(ownCashtag({ platform: false, token: { symbol: 'TEST' } } as never)).toBe('$TEST');
    expect(ownCashtag({ platform: true, token: { symbol: 'TEST' } } as never)).toBe('$BOOTR');
    // a symbol that makes no cashtag (the gate would not count it as one) gives none
    expect(ownCashtag({ token: { symbol: '123' } } as never)).toBeNull();
    expect(ownCashtag({ token: { symbol: 'A B' } } as never)).toBeNull();
  });

  it('the gate is what it was: a second cashtag, a foreign cashtag for the platform account and a foreign address are refused; the own ones pass', () => {
    const code = (fn: () => void) => {
      try {
        fn();
        return null;
      } catch (err) {
        return err instanceof PolicyError ? err.code : String(err);
      }
    };
    const own = { publicAddresses: [TOKEN, KERNEL] };
    expect(code(() => validatePost(`$TEST is at ${ADDRESS}.`, [], 'original', false, own))).toBeNull();
    expect(code(() => validatePost(`$BOOTR is at ${ADDRESS}.`, [], 'original', false, { ...own, platform: true }))).toBeNull();
    expect(code(() => validatePost('$TEST and $OTHER in one post.', [], 'original', false, own))).toBe('x_post_requires_at_most_one_cashtag');
    expect(code(() => validatePost('$TEST once and $TEST twice.', [], 'original', false, own))).toBe('x_post_requires_at_most_one_cashtag');
    expect(code(() => validatePost('A word on $OTHER today.', [], 'original', false, { ...own, platform: true }))).toBe('platform_foreign_cashtag_forbidden');
    expect(code(() => validatePost(`Another coin lives at ${FOREIGN}.`, [], 'original', false, own))).toBe('social_private_address_forbidden');
  });
});

describe('the yourCoin section', () => {
  it('a coin agent is shown its cashtag, its checksummed contract address, that the address is due and what is left of the count', async () => {
    const w = await makeWorld({ config: ON });
    try {
      await seedAgent(w);
      expect(await section(w)).toEqual({ meaning: yourCoinMeaning(3, true), cashtag: '$TEST', contractAddress: ADDRESS, addressDue: true, addressLeftToday: 3 });
      const meaning = yourCoinMeaning(3, true);
      expect(meaning).toBe(
        "Your own coin's labels. Use the cashtag when a post is about your coin, and never more than one cashtag in a post. Give the contract address when someone asks where your coin is or how to find it, and put it in an original post when addressDue is true (none of your original posts of the last 24 hours carried it). Never another coin's cashtag or address. A cashtag or an address is a label, not a call to buy: the rules against price talk and against telling anyone to buy or sell are unchanged. At most 3 posts or replies per 24 hours may carry the address, and addressLeftToday says how many are left; a reply to someone who asked where to find your coin does not use one up. Past that, say it without the address.",
      );
    } finally {
      await w.close();
    }
  });

  it('the platform account is shown $BOOTR and its own token address', async () => {
    const w = await makeWorld({ config: ON });
    try {
      await seedAgent(w, { config: { platform: true, token: { address: TOKEN, symbol: 'BOOTR', name: 'Bootr', chainId: 84532 } } });
      expect(await section(w)).toMatchObject({ cashtag: '$BOOTR', contractAddress: ADDRESS, addressDue: true, addressLeftToday: 3 });
    } finally {
      await w.close();
    }
  });

  it('a hosted turn reads it in its first observation, and an agent that can neither post nor reply has none', async () => {
    const w = await makeWorld({ config: ON, script: [finishResponse(T0 + 3 * HOUR)] });
    try {
      await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString() } });
      expect((await tick(w.ctx)).errors).toEqual([]);
      const call = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!.body as { messages: { content: string }[] };
      const observation = JSON.parse(call.messages[1]!.content) as { yourCoin?: YourCoinView };
      expect(observation.yourCoin).toMatchObject({ cashtag: '$TEST', contractAddress: ADDRESS, addressDue: true, addressLeftToday: 3 });
      const agent = await agentRow(w);
      const config = agentConfigOf(agent)!;
      expect(await yourCoinSection(w.ctx, agent, { ...config, capabilities: { ...config.capabilities, xPublish: false, xReply: false } })).toEqual({});
      // replies only: the labels are shown, but no original post is due to carry the address
      expect((await yourCoinSection(w.ctx, agent, { ...config, capabilities: { ...config.capabilities, xPublish: false } })).yourCoin).toMatchObject({ addressDue: false, addressLeftToday: 3 });
    } finally {
      await w.close();
    }
  });

  it('addressDue flips once an original post carried the address, and comes back a day later', async () => {
    const w = await makeWorld({ config: ON });
    try {
      const agent = await seedAgent(w, { config: { socialStartedAt: new Date(T0 - 10 * HOUR).toISOString() } });
      const config = agentConfigOf(agent)!;
      expect(await section(w)).toMatchObject({ addressDue: true, addressLeftToday: 3 });
      // a reply with the address uses one of the count but is no original: the address is still due in a post
      await sentRow(w, 'act-yc-reply-01', 'publish_reply', { postId: '8001', text: `It is ${ADDRESS}.` });
      expect(await section(w)).toMatchObject({ addressDue: true, addressLeftToday: 2 });
      // the post itself, through the broker
      const id = 'act-yc-post-0001';
      await actionRow(w, id, { tool: 'publish_post', input: { text: withAddress(1) } }, { status: 'sending' });
      const out = await executeAction(w.ctx, agent, config, pendingOf(id, 'publish_post', { text: withAddress(1) }), brokerEnv());
      expect(out.kind).toBe('completed');
      await w.db.update(actions).set({ status: 'completed', result: { actionId: id, tool: 'publish_post', status: 'completed', result: (out as { result: Record<string, unknown> }).result } }).where(eq(actions.actionId, id));
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 1 });
      // a post without the address changes nothing
      await sentRow(w, 'act-yc-post-0002', 'publish_post', { text: 'A thought with no address in it.' });
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 1 });
      w.setNow(w.ctx.now() + 25 * HOUR);
      expect(await section(w)).toMatchObject({ addressDue: true, addressLeftToday: 3 });
    } finally {
      await w.close();
    }
  });
});

describe('the count of posts that carry the address', () => {
  it('the fourth in 24 hours is refused in plain words and nothing is sent; the same thought without the address goes out', async () => {
    const w = await makeWorld({ config: ON });
    try {
      const agent = await seedAgent(w);
      const config = agentConfigOf(agent)!;
      await sentRow(w, 'act-yc-0001', 'publish_post', { text: withAddress(1) }, 20 * HOUR);
      await sentRow(w, 'act-yc-0002', 'publish_reply', { postId: '8002', text: `Here: ${ADDRESS}` }, 10 * HOUR);
      await sentRow(w, 'act-yc-0003', 'publish_post', { text: withAddress(3) }, 5 * HOUR);
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 0 });

      const post = await executeAction(w.ctx, agent, config, pendingOf('act-yc-0004', 'publish_post', { text: withAddress(4) }), brokerEnv());
      expect(post).toEqual({ kind: 'failed', error: CAP });
      expect(addressDailyCap(3)).toBe(CAP);
      // a reply to a mention that asked something else is counted like any post
      const item = mention('8005', '@bootr_agent how does the fee split work?');
      const reply = await executeAction(w.ctx, agent, config, pendingOf('act-yc-0005', 'publish_reply', { postId: '8005', text: `Half goes to the agent. The coin is ${ADDRESS}.` }), brokerEnv([item]));
      expect(reply).toEqual({ kind: 'failed', error: CAP });
      expect(w.sender.published).toEqual([]);

      const plain = await executeAction(w.ctx, agent, config, pendingOf('act-yc-0006', 'publish_post', { text: 'Thought number 4 about the coin, without its address.' }), brokerEnv());
      expect(plain.kind).toBe('completed');
      expect(w.sender.published).toHaveLength(1);

      // the oldest drops out of the 24 hours: one more may go
      w.setNow(w.ctx.now() + 5 * HOUR);
      const later = await executeAction(w.ctx, agent, config, pendingOf('act-yc-0007', 'publish_post', { text: withAddress(7) }), brokerEnv());
      expect(later.kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('an address hidden behind invisible characters or another spelling is counted all the same', async () => {
    const w = await makeWorld({ config: ON });
    try {
      const agent = await seedAgent(w);
      const hidden = `${ADDRESS.slice(0, 12)}\u200b${ADDRESS.slice(12)}`;
      await sentRow(w, 'act-yc-0011', 'publish_post', { text: `It lives at ${hidden}.` }, 3 * HOUR);
      await sentRow(w, 'act-yc-0012', 'publish_post', { text: `It lives at ${TOKEN.toLowerCase()}.` }, 2 * HOUR);
      await sentRow(w, 'act-yc-0013', 'publish_reply', { postId: '8013', text: `It lives at ${ADDRESS.toUpperCase().replace('0X', '0x')}.` }, HOUR);
      expect(await section(w)).toMatchObject({ addressLeftToday: 0 });
      expect(await addressRefusal(w.ctx, agent, 'act-yc-0014', [`Once more: ${hidden}`])).toBe(CAP);
    } finally {
      await w.close();
    }
  });

  it('each part of a thread that carries the address is one of the count, and a thread that would pass it is refused whole', async () => {
    const w = await makeWorld({ config: ON });
    try {
      const agent = await seedAgent(w);
      const config = agentConfigOf(agent)!;
      // a thread of three parts, two of them with the address, on the record as it went out
      await sentRow(w, 'act-yc-0021', 'publish_post', { text: `One. ${ADDRESS}`, thread: [{ text: 'Two, without it.' }, { text: `Three. ${ADDRESS}` }] }, 2 * HOUR, { postId: '9021', parts: [{ n: 1, postId: '9021' }, { n: 2, postId: '9022' }, { n: 3, postId: '9023' }], sent: 3, of: 3 });
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 1 });
      const two = { text: `First part with ${ADDRESS}.`, thread: [{ text: `Second part with ${ADDRESS} too.` }] };
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-yc-0022', 'publish_post', two), brokerEnv())).toEqual({ kind: 'failed', error: CAP });
      expect(w.sender.published).toEqual([]);
      // the address in one part only fits the one that is left
      expect(await addressRefusal(w.ctx, agent, 'act-yc-0023', [`First part with ${ADDRESS}.`, 'Second part without it.'])).toBeNull();
      // a thread alone cannot carry it more often than the day allows
      await w.db.delete(actions);
      expect(await addressRefusal(w.ctx, agent, 'act-yc-0024', [1, 2, 3, 4].map((n) => `Part ${n}: ${ADDRESS}`))).toBe(CAP);
      expect(await addressRefusal(w.ctx, agent, 'act-yc-0025', [1, 2, 3].map((n) => `Part ${n}: ${ADDRESS}`))).toBeNull();
      // a thread that was cut counts the parts that went out
      await sentRow(w, 'act-yc-0026', 'publish_post', { text: `One. ${ADDRESS}`, thread: [{ text: `Two. ${ADDRESS}` }, { text: `Three. ${ADDRESS}` }] }, HOUR, { postId: '9026', parts: [{ n: 1, postId: '9026' }], sent: 1, of: 3, cut: { n: 2, error: 'sender_rejected:test' } });
      expect(await section(w)).toMatchObject({ addressLeftToday: 2 });
    } finally {
      await w.close();
    }
  });

  it('a reply to somebody who asked where to find the coin is not counted, also when the count is used up; any other reply is', async () => {
    const w = await makeWorld({ config: ON });
    try {
      const agent = await seedAgent(w);
      const config = agentConfigOf(agent)!;
      for (const n of [1, 2, 3]) await sentRow(w, `act-yc-003${n}`, 'publish_post', { text: withAddress(n) }, n * HOUR);
      const asked = mention('8034', '@bootr_agent what is the contract address?');
      const id = 'act-yc-0034';
      await actionRow(w, id, { tool: 'publish_reply', input: { postId: '8034', text: `It is ${ADDRESS}.` } }, { status: 'sending' });
      const out = await executeAction(w.ctx, agent, config, pendingOf(id, 'publish_reply', { postId: '8034', text: `It is ${ADDRESS}.` }), brokerEnv([asked]));
      expect(out.kind).toBe('completed');
      expect(w.sender.published).toHaveLength(1);
      await w.db.update(actions).set({ status: 'completed' }).where(eq(actions.actionId, id));
      // the step's row carries the mark, and the reply is in no count
      expect(((await w.db.query.actions.findFirst({ where: eq(actions.actionId, id) }))!.action as { addressAsked?: unknown }).addressAsked).toBe(true);
      await w.db.delete(actions).where(eq(actions.actionId, 'act-yc-0031'));
      expect(await section(w)).toMatchObject({ addressLeftToday: 1 });
      // a reply to a statement, or to a mention the turn was not shown, is counted
      const statement = mention('8035', '@bootr_agent nice coin');
      await sentRow(w, 'act-yc-0036', 'publish_post', { text: withAddress(6) }, 30 * MIN);
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-yc-0035', 'publish_reply', { postId: '8035', text: `Thanks. ${ADDRESS}` }), brokerEnv([statement]))).toEqual({ kind: 'failed', error: CAP });
      expect(await addressRefusal(w.ctx, agent, 'act-yc-0037', [`Thanks. ${ADDRESS}`], { replyTo: null })).toBe(CAP);
      expect(w.sender.published).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('a post waiting in the creator\'s review counts while it waits and once when it is approved, never twice', async () => {
    const w = await makeWorld({ config: ON });
    try {
      fakeSend(w);
      const agent = await seedAgent(w, { config: { requireApproval: true } });
      const id = 'act-yc-0041';
      const input = { text: withAddress(41) };
      await actionRow(w, id, { tool: 'publish_post', input }, { status: 'sending' });
      const queued = await queueForApproval(w.ctx, agent, pendingOf(id, 'publish_post', input), brokerEnv());
      expect(queued).toMatchObject({ kind: 'completed', result: { queued: true } });
      await w.db.update(actions).set({ status: 'completed', result: { actionId: id, tool: 'publish_post', status: 'completed', result: (queued as { result: Record<string, unknown> }).result } }).where(eq(actions.actionId, id));
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 2 });

      // two more wait; the fourth is refused before the creator sees it
      for (const n of [42, 43]) expect((await queueForApproval(w.ctx, agent, pendingOf(`act-yc-00${n}`, 'publish_post', { text: withAddress(n) }), brokerEnv())).kind).toBe('completed');
      expect(await queueForApproval(w.ctx, agent, pendingOf('act-yc-0044', 'publish_post', { text: withAddress(44) }), brokerEnv())).toEqual({ kind: 'failed', error: CAP });
      expect(await w.db.select().from(approvals)).toHaveLength(3);

      const decided = await decideApproval(w.ctx, agent, id, { by: CREATOR, decision: 'approve' });
      expect(decided.ok).toBe(true);
      // the turn's row, the review item and the row of the approved post are one post
      expect(await section(w)).toMatchObject({ addressLeftToday: 0 });
      await w.db.update(approvals).set({ status: 'rejected' }).where(eq(approvals.id, 'act-yc-0042'));
      await w.db.update(approvals).set({ status: 'rejected' }).where(eq(approvals.id, 'act-yc-0043'));
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 2 });

      // a queued answer to "where do I find it" is not counted, waiting or approved
      const asked = mention('8045', '@bootr_agent CA?');
      const replyId = 'act-yc-0045';
      const reply = { postId: '8045', text: `Here it is: ${ADDRESS}` };
      await actionRow(w, replyId, { tool: 'publish_reply', input: reply }, { status: 'sending' });
      expect((await queueForApproval(w.ctx, agent, pendingOf(replyId, 'publish_reply', reply), brokerEnv([asked]))).kind).toBe('completed');
      await w.db.update(actions).set({ status: 'completed', result: { actionId: replyId, tool: 'publish_reply', status: 'completed', result: { queued: true } } }).where(eq(actions.actionId, replyId));
      expect(await section(w)).toMatchObject({ addressLeftToday: 2 });
      expect((await decideApproval(w.ctx, agent, replyId, { by: CREATOR, decision: 'approve' })).ok).toBe(true);
      expect(await section(w)).toMatchObject({ addressLeftToday: 2 });
    } finally {
      resetHooks();
      await w.close();
    }
  });
});

describe('scheduled posts', () => {
  it('a scheduled post with the address counts at the time it is due: the fourth in one day is refused when it is scheduled, and so is a post sent now that would share that day', async () => {
    const w = await makeWorld({ config: ON });
    try {
      fakeSend(w);
      const agent = await seedAgent(w);
      const config = agentConfigOf(agent)!;
      const now = w.ctx.now();
      for (const [n, h] of [[1, 3], [2, 6], [3, 9]] as const) await schedule(w, withAddress(n), now + h * HOUR);
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 0 });

      const fourth = await callTool(w, 'schedule_post', { text: withAddress(4), sendAt: new Date(now + 12 * HOUR).toISOString() });
      expect(errorOf(fourth)).toBe('address_daily_cap: at most 3 posts or replies per 24 hours may carry your contract address; nothing was scheduled. Schedule it without the address.');
      // without the address the same time is taken
      expect((await callTool(w, 'schedule_post', { text: 'Thought number 4, with no address.', sendAt: new Date(now + 12 * HOUR).toISOString() })).kind).toBe('completed');
      // one a day later is another day's
      expect((await callTool(w, 'schedule_post', { text: withAddress(5), sendAt: new Date(now + 34 * HOUR).toISOString() })).kind).toBe('completed');
      expect(await w.db.select().from(scheduledPosts)).toHaveLength(5);

      // a reply sent now would be the fourth of the day the three scheduled ones are in
      const item = mention('8051', '@bootr_agent tell me more');
      expect(await executeAction(w.ctx, agent, config, pendingOf('act-yc-0051', 'publish_reply', { postId: '8051', text: `More: ${ADDRESS}` }), brokerEnv([item]))).toEqual({ kind: 'failed', error: CAP });
    } finally {
      resetHooks();
      await w.close();
    }
  });

  it('a scheduled thread counts once per part that carries the address, and a sent one is counted from its own row', async () => {
    const w = await makeWorld({ config: ON });
    try {
      const fake = fakeSend(w);
      await seedAgent(w, { config: { socialStartedAt: new Date(T0 - 10 * HOUR).toISOString() } });
      const now = w.ctx.now();
      const id = await schedule(w, `Part one: ${ADDRESS}`, now + 15 * MIN, { more: { thread: [{ text: 'Part two has none.' }, { text: `Part three: ${ADDRESS}` }] } });
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 1 });
      // two more parts with the address do not fit beside it
      const more = await callTool(w, 'schedule_post', { text: `Again: ${ADDRESS}`, thread: [{ text: `And again: ${ADDRESS}` }], sendAt: new Date(now + 4 * HOUR).toISOString() });
      expect(errorOf(more)).toMatch(/^address_daily_cap: /);

      w.setNow(now + 16 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1, failed: 0 });
      expect(fake.written).toEqual([id]);
      expect((await rowOf(w, id)).status).toBe('sent');
      // the queue no longer holds it and the post's own row does: still two, not four and not none
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 1 });
    } finally {
      resetHooks();
      await w.close();
    }
  });

  it('at its time a scheduled post is asked again: with the day\'s count used up meanwhile it is not sent and the agent is told why', async () => {
    const w = await makeWorld({ config: ON });
    try {
      const fake = fakeSend(w);
      await seedAgent(w, { config: { socialStartedAt: new Date(T0 - 10 * HOUR).toISOString() } });
      const now = w.ctx.now();
      const id = await seedRow(w, AGENT_ID, now - MIN, { text: withAddress(60) });
      // three replies with the address went out since it was scheduled (say, the limit was lowered, or the creator approved a batch)
      for (const n of [1, 2, 3]) await sentRow(w, `act-yc-006${n}`, 'publish_reply', { postId: `806${n}`, text: `Here: ${ADDRESS}` }, n * HOUR);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 1 });
      expect(fake.calls).toEqual([]);
      const row = await rowOf(w, id);
      expect(row.status).toBe('failed');
      expect(row.error).toBe(CAP);
    } finally {
      resetHooks();
      await w.close();
    }
  });
});

describe('an own agent', () => {
  it('reads the same section when its client opens a turn, and its posts are held to the same count', async () => {
    const w = await ownWorld({ config: ON });
    try {
      const now = w.ctx.now();
      await seedOwn(w, { config: { socialStartedAt: new Date(now - 10 * HOUR).toISOString() } });
      const { credential } = await connectClient(w);
      for (const n of [1, 2, 3]) await sentRow(w, `act-yc-007${n}`, 'publish_reply', { postId: `807${n}`, text: `Here: ${ADDRESS}` }, n * HOUR);
      const turn = await openSocial(w, credential);
      expect((turn as unknown as { observation: { yourCoin?: YourCoinView } }).observation.yourCoin).toEqual({ meaning: yourCoinMeaning(3, true), cashtag: '$TEST', contractAddress: ADDRESS, addressDue: false, addressLeftToday: 0 });
      const refused = await act(w, credential, turn.turnId, 'publish_post', { text: withAddress(74) });
      expect(refused.body).toMatchObject({ status: 'failed', error: CAP });
      expect(w.sender.published).toEqual([]);
      const plain = await act(w, credential, turn.turnId, 'publish_post', { text: 'The same thought, without the address.' });
      expect(plain.body.status).toBe('completed');
      expect(w.sender.published).toHaveLength(1);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('with room in the count its post with the address goes out and the address is no longer due', async () => {
    const w = await ownWorld({ config: ON });
    try {
      await seedOwn(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString() } });
      const { credential } = await connectClient(w);
      const turn = await openSocial(w, credential);
      expect((turn as unknown as { observation: { yourCoin?: YourCoinView } }).observation.yourCoin).toMatchObject({ addressDue: true, addressLeftToday: 3 });
      const sent = await act(w, credential, turn.turnId, 'publish_post', { text: `$TEST lives at ${ADDRESS}.` });
      expect(sent.body.status).toBe('completed');
      expect(await section(w)).toMatchObject({ addressDue: false, addressLeftToday: 2 });
    } finally {
      await w.close();
    }
  });
});

describe('the real sender behind the broker', () => {
  it('a post with the own cashtag and address goes out; a foreign address and a second cashtag are refused there as before', async () => {
    const w = await wiredWorld({ config: ON });
    try {
      const agent = await seedAgent(w);
      const config = agentConfigOf(agent)!;
      expect(publicAddressesOf(config)).toEqual([TOKEN, KERNEL]);
      const own = await executeAction(w.ctx, agent, config, pendingOf('act-yc-0081', 'publish_post', { text: `$TEST lives at ${ADDRESS}.` }), brokerEnv());
      expect(own.kind).toBe('completed');
      expect(w.posted().map((p) => p.text)).toEqual([`$TEST lives at ${ADDRESS}.`]);
      const foreign = await executeAction(w.ctx, agent, config, pendingOf('act-yc-0082', 'publish_post', { text: `Another coin lives at ${FOREIGN}.` }), brokerEnv());
      expect(foreign).toMatchObject({ kind: 'failed' });
      expect(errorOf(foreign)).toContain('social_private_address_forbidden');
      const twice = await executeAction(w.ctx, agent, config, pendingOf('act-yc-0083', 'publish_post', { text: '$TEST and $OTHER in one post.' }), brokerEnv());
      expect(errorOf(twice)).toContain('x_post_requires_at_most_one_cashtag');
      expect(w.posted()).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});

describe('ADDRESS_POSTS_PER_DAY=0', () => {
  it('there is no section and no count: a turn\'s observation, its tools and its prompt are what they are without the piece', async () => {
    const run = async (limit: string) => {
      const w = await makeWorld({ config: { ADDRESS_POSTS_PER_DAY: limit }, script: [toolCallResponse('publish_post', { text: withAddress(99) }), finishResponse(T0 + 3 * HOUR)] });
      try {
        await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * HOUR).toISOString() } });
        for (const n of [1, 2, 3, 4, 5]) await sentRow(w, `act-yc-009${n}`, 'publish_reply', { postId: `809${n}`, text: `Here: ${ADDRESS}` }, n * HOUR);
        expect((await tick(w.ctx)).errors).toEqual([]);
        const call = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!.body as { messages: { content: string }[]; tools: unknown[] };
        return { system: call.messages[0]!.content, observation: JSON.parse(call.messages[1]!.content) as Record<string, unknown>, tools: call.tools, published: w.sender.published.length, limit: addressLimit(w.ctx) };
      } finally {
        await w.close();
      }
    };
    const off = await run('0');
    const on = await run('3');
    expect(off.limit).toBe(0);
    expect(off.observation).not.toHaveProperty('yourCoin');
    expect(JSON.stringify(off.observation)).not.toContain('addressDue');
    // five replies with the address on the record and the post with it still goes out: nothing counts
    expect(off.published).toBe(1);
    expect(on.published).toBe(0);
    // the piece adds one section and nothing else: not a word of the prompt, not a tool, not a field of a tool
    expect(on.observation).toHaveProperty('yourCoin');
    const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'yourCoin' && k !== 'observedAt'));
    expect(strip(on.observation)).toEqual(strip(off.observation));
    expect(on.system).toBe(off.system);
    expect(on.tools).toEqual(off.tools);
  });

  it('the guard reads nothing and refuses nothing, at every place it is asked', async () => {
    const w = await makeWorld({ config: { ADDRESS_POSTS_PER_DAY: '0' } });
    try {
      const agent = await seedAgent(w);
      for (const n of [1, 2, 3, 4]) await sentRow(w, `act-yc-010${n}`, 'publish_post', { text: withAddress(n) }, n * HOUR);
      expect(await addressRefusal(w.ctx, agent, 'act-yc-0105', [withAddress(5)])).toBeNull();
      expect(await addressRefusal(w.ctx, agent, 'act-yc-0106', [withAddress(6)], { at: w.ctx.now() + HOUR, done: 'scheduled' })).toBeNull();
      expect(await addressRefusal(w.ctx, agent, 'act-yc-0107', [withAddress(7)], { sending: true })).toBeNull();
      expect(await section(w)).toBeUndefined();
    } finally {
      await w.close();
    }
  });
});
