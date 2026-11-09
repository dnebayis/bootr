/**
 * Bounties stage A (bounties.ts): the templates and the task rules, `bounty_post` / `bounty_cancel` / `bounty_list`
 * through the broker, the review and slot waits, the entry rules one by one, the sweep end to end against a fake
 * sender and a scripted judge (winner -> proposal -> approve with tx -> paid reply; no winner -> public close;
 * invalid verdict -> no winner; 48 h expiry), the treasury clock, the social turn ignoring entries, and what the read
 * routes never carry (an author id, reply text, an ineligible entry's address).
 */
import { BOUNTY_MAX_CONSIDERED, DEFAULT_BOUNTIES_POLICY, parseAgentConfig, type AgentConfig } from '@bootr/agent-core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentActivity } from '../src/activity.js';
import { createApp } from '../src/api.js';
import {
  addressOf,
  amountMicroOf,
  bountiesSection,
  bountyBudget,
  bountyConversationIds,
  bountyJobId,
  CANCELLED_TEXT,
  coinPageLink,
  collectAndJudge,
  evaluateEntries,
  jobPostText,
  jobTextProblem,
  NO_WINNER_TEXT,
  NOTHING_PAID_TEXT,
  paidReplyText,
  payoutApprovalId,
  shortJobId,
  sniffImage,
  sweepBounties,
  usdc,
  utcDayStart,
  type EligibilityContext,
} from '../src/bounties.js';
import { executeAction, inboxViews, resolvePending, type BrokerEnv } from '../src/broker/index.js';
import { approvals, bountyEntries, bountyJobs, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { closeBountyEntries } from '../src/mention-close.js';
import { bountyJobClosed, treasuryTurnDue } from '../src/roles.js';
import { initialState, type AgentState } from '../src/runtime.js';
import type { SenderConversationReply, SenderInboxItem } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, agentConfig, CREATOR, KERNEL, makeWorld, seedAgent, SPENDER, SUPERVISOR_KEY, TOKEN, type TestWorld } from './helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const H = 3_600_000;
const TX = `0x${'ab'.repeat(32)}`;
/** A PNG signature with an IHDR chunk header: what `sniffImage` wants of a picture. */
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(17, 1)]);
const PNG2 = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(17, 2)]);
const ADDR_A = '0x1111111111111111111111111111111111111111';
const ADDR_B = '0x2222222222222222222222222222222222222222';
const ADDR_C = '0x3333333333333333333333333333333333333333';

const pending = (id: string, tool: string, input: Record<string, unknown>) => ({ id, cycleKey: 'cycle:test', action: { tool, input }, status: 'sending', createdAt: 0, attempts: 1 }) as unknown as Parameters<typeof executeAction>[3];
const env = (): BrokerEnv => ({ inbox: new Map(), eligibility: new Map() });

/** The seeded agent's config with the bounties power on and the given policy. */
function withBounties(bounties: Partial<AgentConfig['bounties']> = {}): Record<string, unknown> {
  const base = agentConfig(T0);
  return { ...base, capabilities: { ...(base.capabilities as object), bounties: true }, bounties: { ...DEFAULT_BOUNTIES_POLICY, ...bounties } };
}

const configOf = (raw: Record<string, unknown>) => parseAgentConfig(raw);

/** The treasury clock parked, so a tick in these tests never buys a treasury thought on its own. */
const restingRuntime = { state: { ...initialState(), lastPostAt: T0 - 60_000, treasuryNextAt: T0 + 24 * H, lastTreasuryTurnAt: T0 - 60_000 } as unknown as Record<string, unknown>, nextAt: new Date(T0 + 24 * H), lastDecisionAt: new Date(T0 - 60_000) };

const JOB_INPUT = { task: 'A square picture of a dot wearing a tiny hat, flat colours', criteria: ['It shows a single dot', 'The dot wears a hat'], deliverable: 'image' as const, amountUsdc: 0.5 };

/** The job post of the seeded agent for `JOB_INPUT`, as the template renders it at `now`. */
const jobsOf = async (w: TestWorld) => w.db.select().from(bountyJobs).where(eq(bountyJobs.agentId, AGENT_ID));
const published = (w: TestWorld) => w.sender.published as { actionId: string; text: string; replyTo?: string; attributions?: unknown[] }[];

function api(world: TestWorld) {
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  const send = (method: 'POST' | 'PUT', path: string, body: unknown) => {
    const text = JSON.stringify(body);
    return app.request(path, { method, body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, method, path, text, nowSec()) } });
  };
  return {
    get: (path: string) => app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } }),
    post: (path: string, body: unknown) => send('POST', path, body),
    put: (path: string, body: unknown) => send('PUT', path, body),
  };
}

/** A plain-text model answer (the judge's), with a receipt like the relay's. */
function judgeAnswer(body: unknown): Response {
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(JSON.stringify({ id: 'cmpl', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 60 } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-bootr-receipt': JSON.stringify({ requestId: 'r', quoteMicroUsdc: '9000', chargedMicroUsdc: '7000', paymentTxOrId: '0xtx', network: 'eip155:84532', usage: null }) },
  });
}

function reply(id: string, authorId: string, over: Partial<SenderConversationReply> = {}): SenderConversationReply {
  return {
    id,
    text: `my entry ${ADDR_A}`,
    authorId,
    createdAt: new Date(T0 + Number(id.slice(-2)) * 60_000).toISOString(),
    conversationId: '9001',
    inReplyToId: '9001',
    author: { id: authorId, username: `user${authorId}`, createdAt: '2024-01-01T00:00:00.000Z', verified: false, verifiedType: 'none' },
    urls: [],
    media: [{ mediaKey: `3_${id}`, type: 'photo', url: `https://pbs.twimg.com/media/${id}.png`, previewImageUrl: null }],
    ...over,
  };
}

/** Serves pictures and pages for the artefact fetches; everything else goes to the scripted relay. */
function serveArtefacts(w: TestWorld, files: Record<string, { body: Buffer | string; type: string; status?: number; location?: string }>) {
  const relay = w.ctx.fetch;
  w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const file = files[url];
    if (!file) return relay(input, init);
    return new Response(file.status && file.status >= 300 ? null : file.body, { status: file.status ?? 200, headers: { 'content-type': file.type, ...(file.location ? { location: file.location } : {}) } });
  }) as typeof fetch;
}

/** The fake sender's replies read: the conversation ids asked for are recorded. */
function serveReplies(w: TestWorld, items: SenderConversationReply[]) {
  const asked: string[] = [];
  (w.sender.client as unknown as { readReplies: (agentId: string, conversationId: string) => Promise<unknown> }).readReplies = async (_agentId, conversationId) => {
    asked.push(conversationId);
    return { items, fetched: items.length, truncated: false };
  };
  return asked;
}

async function postJob(w: TestWorld, agent: Awaited<ReturnType<typeof seedAgent>>, raw: Record<string, unknown>, id = 'act-post-1', input: Record<string, unknown> = JOB_INPUT) {
  return executeAction(w.ctx, agent, configOf(raw), pending(id, 'bounty_post', input), env());
}

describe('the templates and the task rules', () => {
  it('renders the job post of section 3.3 word for word, the paid reply, and the fixed closes', () => {
    const link = 'https://bootr.fun/token/0xabc#bounty-0x01';
    expect(jobPostText({ task: 'A dot with a hat', amountMicroUsdc: 500_000n, deliverable: 'image', closesAt: Date.parse('2026-10-24T18:00:00Z'), handle: 'bootr_agent', link })).toBe(
      `Bounty: A dot with a hat. 0.5 USDC to the best entry. Reply with your image and your Base address by 2026-10-24 18:00 UTC; the first ${BOUNTY_MAX_CONSIDERED} entries are considered. By replying you let @bootr_agent repost your entry with credit. Details: ${link}`,
    );
    // a task that ends a sentence gets no second full stop; a link job says link; whole amounts print whole
    expect(jobPostText({ task: 'Compare two pools.', amountMicroUsdc: '1000000', deliverable: 'link', closesAt: T0, handle: 'a', link })).toMatch(/^Bounty: Compare two pools\. 1 USDC to the best entry\. Reply with your link and/);
    expect(paidReplyText({ amountMicroUsdc: 250_000n, reason: 'A single dot in a red hat.', txUrl: 'https://basescan.org/tx/0x1' })).toBe('Paid 0.25 USDC for this entry. Why: A single dot in a red hat. https://basescan.org/tx/0x1');
    expect(NO_WINNER_TEXT).toBe('No entry met the job; nothing paid.');
    expect(NOTHING_PAID_TEXT).toBe('Nothing paid.');
    expect(CANCELLED_TEXT).toBe('Cancelled by the agent.');
    expect(usdc(100_000)).toBe('0.1');
    expect(utcDayStart(Date.parse('2026-10-24T23:59:59Z'))).toBe(Date.parse('2026-10-24T00:00:00Z'));
  });

  it('amounts: 0.1 to 1 USDC with at most two decimals', () => {
    expect(amountMicroOf(0.5)).toBe(500_000n);
    expect(amountMicroOf(1)).toBe(1_000_000n);
    expect(amountMicroOf(0.1)).toBe(100_000n);
    expect(amountMicroOf(0.25)).toBe(250_000n);
    expect(amountMicroOf(0.09)).toBeNull();
    expect(amountMicroOf(1.01)).toBeNull();
    expect(amountMicroOf(0.123)).toBeNull();
    expect(amountMicroOf(Number.NaN)).toBeNull();
  });

  it('the job id is keccak256(kernel, nonce, taskHash) and changes with any of them', () => {
    const a = bountyJobId(KERNEL, 1, 'a dot');
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(bountyJobId(KERNEL, 1, 'a dot')).toBe(a);
    expect(bountyJobId(KERNEL, 2, 'a dot')).not.toBe(a);
    expect(bountyJobId(KERNEL, 1, 'a hat')).not.toBe(a);
    expect(bountyJobId(CREATOR, 1, 'a dot')).not.toBe(a);
  });

  it('refuses a job that asks for promotion, names an address or a foreign cashtag, fails the gate or outruns the account', () => {
    const config = configOf(agentConfig(T0));
    const check = (task: string, criteria: string[] = ['It is a dot'], premium: boolean | null = null) => {
      const text = jobPostText({ task, amountMicroUsdc: 500_000n, deliverable: 'image', closesAt: T0 + 6 * H, handle: config.xHandle, link: 'https://bootr.fun/token/x#bounty-0x1' });
      return jobTextProblem({ task, criteria, text, attributions: [{ username: config.xHandle, sourceUrl: 'https://bootr.fun/token/x#bounty-0x1' }], config, premium });
    };
    expect(check('A square picture of a dot wearing a tiny hat')).toBeNull();
    for (const word of ['buy', 'post', 'tweet', 'promote', 'shill', 'follow', 'like', 'retweet', 'Retweets', 'posting', 'promotion', 'bought', 'reposts']) expect(check(`Please ${word} something about the dot`), word).toMatch(/^bounty_asks_for_promotion/);
    expect(check('A poster-style picture of the dot, nothing else')).toBeNull(); // whole words only: "poster" is not "post"
    expect(check('A dot picture', ['Then follow the account'])).toMatch(/^bounty_asks_for_promotion: the criterion 1/);
    expect(check(`Send it to ${ADDR_A}`)).toMatch(/^bounty_address_forbidden/);
    expect(check(`A picture of ${TOKEN} as a dot`)).toMatch(/^bounty_address_forbidden/);
    expect(check('A picture of $DOGE as a dot')).toMatch(/^bounty_cashtag_forbidden/);
    expect(check('A picture of $TEST as a dot')).toBeNull();
    // the gate itself: a 32-byte hex reads as secret material for everyone, a foreign link is refused for the platform agent
    expect(check(`A dot with the number ${'ab'.repeat(32)}`)).toMatch(/^social_secret_material_forbidden: the job post does not pass the publish gate/);
    const platform = configOf({ ...agentConfig(T0), platform: true });
    const platformText = jobPostText({ task: 'A dot. Visit https://bootr-claim.com/x now', amountMicroUsdc: 500_000n, deliverable: 'image', closesAt: T0 + 6 * H, handle: platform.xHandle, link: 'https://bootr.fun/token/x#bounty-0x1' });
    expect(jobTextProblem({ task: 'A dot. Visit https://bootr-claim.com/x now', criteria: ['It is a dot'], text: platformText, attributions: [{ username: platform.xHandle, sourceUrl: 'https://bootr.fun/token/x#bounty-0x1' }], config: platform, premium: null })).toMatch(/^platform_link_forbidden/);
    expect(check('x'.repeat(200), ['It is a dot'], false)).toMatch(/^bounty_post_too_long/);
    expect(check('x'.repeat(200), ['It is a dot'], true)).toBeNull();
  });

  it('the public link and the page anchor carry the 16-hex prefix of the job id, never the 32-byte id the gate refuses', () => {
    const id = bountyJobId(KERNEL, 1, 'a dot');
    expect(shortJobId(id)).toBe(id.slice(0, 18));
    expect(coinPageLink('https://bootr.fun/', TOKEN, id)).toBe(`https://bootr.fun/token/${TOKEN.toLowerCase()}#bounty-${id.slice(0, 18)}`);
    expect(jobPostText({ task: 'A dot', amountMicroUsdc: 500_000n, deliverable: 'image', closesAt: T0, handle: 'a', link: coinPageLink('https://bootr.fun', TOKEN, id) })).not.toMatch(/0x[0-9a-f]{64}/i);
  });

  it('sniffs PNG, JPEG and WEBP and nothing else', () => {
    expect(sniffImage(PNG)).toEqual({ mime: 'image/png' });
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toEqual({ mime: 'image/jpeg' });
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toEqual({ mime: 'image/webp' });
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('bounty_post', () => {
  it('is refused with the power off, outside the bounds, past the daily cap and past the open-job cap; nothing is posted', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      expect(await postJob(w, agent, agentConfig(T0))).toMatchObject({ kind: 'failed', error: expect.stringMatching(/bounties_power_off/) });
      const raw = withBounties({ dailyCapMicroUsdc: 600_000, maxOpen: 1 });
      expect(await postJob(w, agent, raw, 'a-amt', { ...JOB_INPUT, amountUsdc: 0.123 })).toMatchObject({ kind: 'failed', error: expect.stringMatching(/bounty_amount_out_of_bounds/) });
      expect(await postJob(w, agent, raw, 'a-cap', { ...JOB_INPUT, amountUsdc: 1 })).toMatchObject({ kind: 'failed', error: expect.stringMatching(/bounty_daily_cap_reached: 0\.6 USDC of your 0\.6 USDC/) });
      expect(await postJob(w, agent, raw, 'a-word', { ...JOB_INPUT, task: 'Tweet about the dot' })).toMatchObject({ kind: 'failed', error: expect.stringMatching(/bounty_asks_for_promotion/) });
      expect(published(w)).toHaveLength(0);
      expect(await jobsOf(w)).toHaveLength(0);
      // one job fits the cap and the slot; the next one is refused by the slot, then (with more slots) by the cap
      const ok = await postJob(w, agent, raw, 'a-ok');
      expect(ok.kind).toBe('completed');
      expect(await postJob(w, agent, raw, 'a-slot', { ...JOB_INPUT, amountUsdc: 0.1 })).toMatchObject({ kind: 'failed', error: expect.stringMatching(/bounty_max_open_reached: 1 of your 1/) });
      expect(await postJob(w, agent, withBounties({ dailyCapMicroUsdc: 600_000, maxOpen: 3 }), 'a-day', { ...JOB_INPUT, amountUsdc: 0.2 })).toMatchObject({ kind: 'failed', error: expect.stringMatching(/bounty_daily_cap_reached: 0\.1 USDC of your 0\.6 USDC/) });
      const budget = await bountyBudget(w.ctx, AGENT_ID, { ...DEFAULT_BOUNTIES_POLICY, dailyCapMicroUsdc: 600_000, maxOpen: 3 });
      expect(budget).toMatchObject({ reservedTodayMicroUsdc: 500_000n, remainingTodayMicroUsdc: 100_000n, openJobs: 1, dayEndsAt: Date.parse('2026-10-25T00:00:00Z') });
      // the next UTC day frees the cap; a cancelled job frees its reservation and its slot
      w.setNow(Date.parse('2026-10-25T00:00:01Z'));
      expect((await bountyBudget(w.ctx, AGENT_ID, { ...DEFAULT_BOUNTIES_POLICY, dailyCapMicroUsdc: 600_000 })).remainingTodayMicroUsdc).toBe(600_000n);
      w.setNow(T0);
      const [job] = await jobsOf(w);
      await executeAction(w.ctx, agent, configOf(raw), pending('a-cancel', 'bounty_cancel', { jobId: job!.id }), env());
      expect(await bountyBudget(w.ctx, AGENT_ID, { ...DEFAULT_BOUNTIES_POLICY, dailyCapMicroUsdc: 600_000 })).toMatchObject({ reservedTodayMicroUsdc: 0n, openJobs: 0 });
    } finally {
      await w.close();
    }
  });

  it('posts the job from the template as an original post with the own-handle credit, stores the post, and is idempotent on the action id', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      const raw = withBounties();
      const out = await postJob(w, agent, raw);
      expect(out.kind).toBe('completed');
      const result = (out as { result: Record<string, unknown> }).result;
      const [job] = await jobsOf(w);
      expect(job).toMatchObject({ status: 'open', actionId: 'act-post-1', nonce: 1, task: JOB_INPUT.task, criteria: JOB_INPUT.criteria, deliverable: 'image', amountMicroUsdc: '500000', postId: '9001', conversationId: '9001', entriesReceived: 0 });
      expect(job!.id).toBe(bountyJobId(KERNEL, 1, JOB_INPUT.task));
      expect(job!.closesAt.getTime()).toBe(T0 + 6 * H);
      expect(result).toMatchObject({ jobId: job!.id, status: 'open', postId: '9001', amountUsdc: '0.5', closesAt: new Date(T0 + 6 * H).toISOString() });
      expect(String(result.note)).toMatch(/Never name a winner yourself/);
      const [post] = published(w);
      expect(post!.actionId).toBe(`bounty:${job!.id}:post`);
      expect(post!.replyTo).toBeUndefined();
      expect(post!.text).toBe(jobPostText({ task: JOB_INPUT.task, amountMicroUsdc: 500_000n, deliverable: 'image', closesAt: T0 + 6 * H, handle: 'bootr_agent', link: `https://bootr.fun/token/${TOKEN.toLowerCase()}#bounty-${shortJobId(job!.id)}` }));
      expect(post!.attributions).toEqual([{ username: 'bootr_agent', sourceUrl: `https://bootr.fun/token/${TOKEN.toLowerCase()}#bounty-${shortJobId(job!.id)}` }]);
      expect(job!.pageText).toBe(post!.text);
      // the same action again: the same job, no second post; a pending action resolves from the row
      const again = await postJob(w, agent, raw);
      expect(again).toMatchObject({ kind: 'completed', result: { jobId: job!.id, status: 'open' }, receipt: { postId: '9001' } });
      expect(published(w)).toHaveLength(1);
      expect(await jobsOf(w)).toHaveLength(1);
      expect(await resolvePending(w.ctx, agent, { ...pending('act-post-1', 'bounty_post', JOB_INPUT), status: 'sent' } as never)).toMatchObject({ resolved: true, outcome: { kind: 'completed', result: { jobId: job!.id } }, receipt: { postId: '9001' } });
      expect(await resolvePending(w.ctx, agent, { ...pending('act-none', 'bounty_post', JOB_INPUT), status: 'sent' } as never)).toMatchObject({ resolved: true, outcome: { kind: 'failed' } });
      // the custom window and the list
      const two = await postJob(w, agent, raw, 'act-post-2', { ...JOB_INPUT, task: 'A link to a page comparing two Base pools', deliverable: 'link', amountUsdc: 0.2, hoursOpen: 24 });
      expect(two).toMatchObject({ kind: 'completed', result: { status: 'open', closesAt: new Date(T0 + 24 * H).toISOString() } });
      const list = (await executeAction(w.ctx, agent, configOf(raw), pending('act-list', 'bounty_list', {}), env())) as { kind: string; result: { jobs: Record<string, unknown>[]; budget: Record<string, unknown> } };
      expect(list.kind).toBe('completed');
      expect(list.result.jobs.map((j) => j.status)).toEqual(['open', 'open']);
      expect(list.result.budget).toMatchObject({ reservedTodayUsdc: '0.7', remainingTodayUsdc: '4.3', openJobs: 2, maxOpen: 2 });
      expect(JSON.stringify(list.result)).not.toContain('authorId');
      // the tape and the treasury observation know the job
      const items = await agentActivity(w.ctx, agent, null);
      expect(items.filter((i) => i.kind === 'bounty').map((i) => i.summary).sort()).toEqual([`Posted a bounty for 0.2 USDC: A link to a page comparing two Base pools`, `Posted a bounty for 0.5 USDC: ${JOB_INPUT.task}`].sort());
      const section = (await bountiesSection(w.ctx, agent, configOf(raw))) as { bounties: Record<string, unknown> };
      expect(section.bounties).toMatchObject({ headroom: { openJobs: 2 }, policy: { dailyCapUsdc: '5', maxOpen: 2, cooldownDays: 7, review: false } });
      expect((section.bounties.openJobs as unknown[]).length).toBe(2);
      expect(await bountiesSection(w.ctx, agent, configOf(agentConfig(T0)))).toEqual({});
    } finally {
      await w.close();
    }
  });

  it('waits as a draft when the X quota is used up or the platform window is full, and the sweep posts it later; a refused post fails the job', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { runtime: restingRuntime });
      const raw = withBounties();
      w.sender.quotaExceeded = new Date(T0 + 2 * H).toISOString();
      const out = (await postJob(w, agent, raw)) as { kind: string; result: Record<string, unknown> };
      expect(out.kind).toBe('completed');
      expect(out.result).toMatchObject({ status: 'draft', queued: true, waiting: 'x_quota', until: new Date(T0 + 2 * H).toISOString() });
      expect(String(out.result.note)).toMatch(/do not post or rephrase it again/);
      let [job] = await jobsOf(w);
      expect(job).toMatchObject({ status: 'draft', postId: null });
      expect(job!.publishNotBefore?.getTime()).toBe(T0 + 2 * H);
      // the sweep leaves it alone before its time, posts it after, with the window counted from the real post time
      w.sender.quotaExceeded = null;
      expect(await sweepBounties(w.ctx)).toMatchObject({ posted: 0 });
      w.setNow(T0 + 2 * H + 1);
      expect(await sweepBounties(w.ctx)).toMatchObject({ posted: 1 });
      [job] = await jobsOf(w);
      expect(job).toMatchObject({ status: 'open', postId: '9001' });
      expect(job!.closesAt.getTime()).toBe(T0 + 2 * H + 1 + 6 * H);
      expect(published(w)[0]!.text).toContain(`by ${new Date(T0 + 8 * H + 1).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
      // a draft that outlives its day fails without a post
      w.setNow(T0);
      w.sender.quotaExceeded = new Date(T0 + 30 * H).toISOString();
      await postJob(w, agent, raw, 'act-post-2', { ...JOB_INPUT, task: 'Another dot picture' });
      w.setNow(T0 + 30 * H + 1);
      expect(await sweepBounties(w.ctx)).toMatchObject({ failed: 1 });
      const stale = (await jobsOf(w)).find((j) => j.actionId === 'act-post-2')!;
      expect(stale).toMatchObject({ status: 'failed', error: expect.stringMatching(/draft_expired/) });
      // a rejected publish fails the job and the tool says so
      w.setNow(T0);
      w.sender.quotaExceeded = null;
      w.sender.publishError = 'http_403(403): You are not permitted to perform this action';
      const bad = await postJob(w, agent, raw, 'act-post-3', { ...JOB_INPUT, task: 'A third dot picture' });
      expect(bad).toMatchObject({ kind: 'failed', error: expect.stringMatching(/bounty_post_failed: sender_rejected:http_403/) });
      expect((await jobsOf(w)).find((j) => j.actionId === 'act-post-3')).toMatchObject({ status: 'failed' });
      // failed and expired jobs hold no reservation
      expect((await bountyBudget(w.ctx, AGENT_ID, DEFAULT_BOUNTIES_POLICY)).reservedTodayMicroUsdc).toBe(500_000n);
    } finally {
      await w.close();
    }
  });

  it('with review on, the job text waits in the approval queue; approval posts it, rejection cancels it', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { runtime: restingRuntime });
      const raw = withBounties({ review: true });
      const out = (await postJob(w, agent, raw)) as { kind: string; result: Record<string, unknown> };
      expect(out.result).toMatchObject({ status: 'draft', queued: true, approvalId: 'act-post-1' });
      expect(published(w)).toHaveLength(0);
      const { get, post } = api(w);
      const queue = (await (await get(`/internal/agents/${AGENT_ID}/approvals`)).json()) as { items: Record<string, unknown>[]; pending: number };
      expect(queue.pending).toBe(1);
      expect(queue.items[0]).toMatchObject({ id: 'act-post-1', kind: 'bounty_job', status: 'pending_approval', bounty: { kind: 'job', task: JOB_INPUT.task, amountUsdc: '0.5' } });
      expect(String(queue.items[0]!.text)).toMatch(/^Bounty: /);
      // the sweep does not post a job under review
      expect(await sweepBounties(w.ctx)).toMatchObject({ posted: 0 });
      const approved = await post(`/internal/agents/${AGENT_ID}/approvals/act-post-1`, { decision: 'approve', by: CREATOR });
      expect(approved.status).toBe(200);
      expect((await approved.json()) as object).toMatchObject({ status: 'approved', postId: '9001' });
      expect((await jobsOf(w))[0]).toMatchObject({ status: 'open', postId: '9001' });
      expect(published(w)).toHaveLength(1);
      // a second job declined
      await postJob(w, agent, raw, 'act-post-2', { ...JOB_INPUT, task: 'A second dot picture' });
      const rejected = await post(`/internal/agents/${AGENT_ID}/approvals/act-post-2`, { decision: 'reject', by: CREATOR, note: 'not now' });
      expect(rejected.status).toBe(200);
      expect((await jobsOf(w)).find((j) => j.actionId === 'act-post-2')).toMatchObject({ status: 'cancelled', error: 'declined by the creator' });
      expect(published(w)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('bounty_cancel closes an open job with the template reply, releases it, and refuses anything else', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      const raw = withBounties();
      await postJob(w, agent, raw);
      const [job] = await jobsOf(w);
      expect(await executeAction(w.ctx, agent, configOf(raw), pending('c-none', 'bounty_cancel', { jobId: `0x${'9'.repeat(64)}` }), env())).toMatchObject({ kind: 'failed', error: expect.stringMatching(/bounty_not_found/) });
      const out = await executeAction(w.ctx, agent, configOf(raw), pending('c-1', 'bounty_cancel', { jobId: job!.id }), env());
      expect(out).toMatchObject({ kind: 'completed', result: { status: 'cancelled' } });
      const cancelled = (await jobsOf(w))[0]!;
      expect(cancelled).toMatchObject({ status: 'cancelled', closeReplyId: '9002' });
      expect(cancelled.closedAt).not.toBeNull();
      const [, close] = published(w);
      expect(close).toMatchObject({ actionId: `bounty:${job!.id}:cancel`, text: CANCELLED_TEXT, replyTo: '9001' });
      expect(await executeAction(w.ctx, agent, configOf(raw), pending('c-2', 'bounty_cancel', { jobId: job!.id }), env())).toMatchObject({ kind: 'completed', result: { status: 'cancelled' } });
      expect(published(w)).toHaveLength(2);
      expect((await agentActivity(w.ctx, agent, null)).filter((i) => i.kind === 'bounty').map((i) => i.summary).sort()).toEqual(['Bounty cancelled', `Posted a bounty for 0.5 USDC: ${JOB_INPUT.task}`]);
    } finally {
      await w.close();
    }
  });
});

describe('the entry rules', () => {
  const ctx: EligibilityContext = { kind: 'image', ownUserId: '1000', creatorUserId: '2000', creatorHandle: 'thecreator', reservedAddresses: [KERNEL, CREATOR, SPENDER], recentlyPaid: [ADDR_C], now: T0 };
  const reasons = (entries: ReturnType<typeof evaluateEntries>) => Object.fromEntries(entries.map((e) => [e.replyId, e.eligible ? 'eligible' : e.ineligibleReason]));

  it('finds exactly one checksummed address in the text', () => {
    expect(addressOf(`here ${ADDR_A.toLowerCase()} thanks`)).toEqual({ payee: ADDR_A });
    expect(addressOf('no address here')).toEqual({ reason: 'no_address' });
    expect(addressOf(`${ADDR_A} and ${ADDR_B}`)).toEqual({ reason: 'many_addresses' });
    // the same address twice is one address
    expect(addressOf(`${ADDR_A} ${ADDR_A.toLowerCase()}`)).toEqual({ payee: ADDR_A });
    expect(addressOf(`0x${'z'.repeat(40)}`)).toEqual({ reason: 'no_address' });
  });

  it('applies each rule of section 3.3 and keeps the rest eligible, oldest first', () => {
    const out = evaluateEntries(
      [
        reply('7001', '31'),
        reply('7002', '32', { media: [] }),
        reply('7003', '33', { text: 'an entry without an address' }),
        reply('7004', '34', { text: `${ADDR_A} or ${ADDR_B}` }),
        reply('7005', '1000'),
        reply('7006', '2000'),
        reply('7007', '36', { author: { id: '36', username: 'TheCreator', createdAt: '2024-01-01T00:00:00.000Z', verified: null, verifiedType: null } }),
        reply('7008', '37', { author: { id: '37', username: 'fresh', createdAt: new Date(T0 - 10 * 86_400_000).toISOString(), verified: false, verifiedType: 'none' } }),
        reply('7009', '38', { author: { id: '38', username: 'ageless', createdAt: null, verified: false, verifiedType: 'none' } }),
        reply('7010', '31', { text: `second from the same author ${ADDR_B}` }),
        reply('7011', '39', { text: `kernel ${KERNEL}` }),
        reply('7012', '40', { text: `creator ${CREATOR}` }),
        reply('7013', '41', { text: `spender ${SPENDER}` }),
        reply('7014', '42', { text: `paid last week ${ADDR_C}` }),
        reply('7015', '43', { text: `shared ${ADDR_B}` }),
        reply('7016', '44', { text: `shared too ${ADDR_B}` }),
        reply('7017', '45', { text: `fine ${'0x4444444444444444444444444444444444444444'}` }),
      ],
      ctx,
    );
    expect(reasons(out)).toEqual({
      '7001': 'eligible',
      '7002': 'no_artefact',
      '7003': 'no_address',
      '7004': 'many_addresses',
      '7005': 'own_account',
      '7006': 'creator_account',
      '7007': 'creator_account',
      '7008': 'account_too_new',
      '7009': 'account_age_unknown',
      '7010': 'repeat_author',
      '7011': 'reserved_address',
      '7012': 'reserved_address',
      '7013': 'reserved_address',
      '7014': 'address_in_cooldown',
      '7015': 'shared_address',
      '7016': 'shared_address',
      '7017': 'eligible',
    });
    expect(out.map((e) => e.replyId)).toEqual([...Array(17)].map((_, i) => String(7001 + i)));
    expect(out[0]).toMatchObject({ payee: ADDR_A, artefact: { url: 'https://pbs.twimg.com/media/7001.png', mediaKey: '3_7001' } });
    // the entry rows never carry the text
    expect(JSON.stringify(out)).not.toContain('my entry');
  });

  it('a link job takes the first public https url entity and skips X\'s own hosts', () => {
    const out = evaluateEntries(
      [
        reply('7001', '31', { media: [], urls: [{ url: 'https://t.co/a', expandedUrl: 'https://x.com/someone/status/1' }, { url: 'https://t.co/b', expandedUrl: 'http://insecure.example/page' }, { url: 'https://t.co/c', expandedUrl: 'https://Example.org/Page' }] }),
        reply('7002', '32', { media: [], urls: [{ url: 'https://t.co/d', expandedUrl: 'https://twitter.com/x/status/2' }] }),
        reply('7003', '33', { urls: [] }),
      ],
      { ...ctx, kind: 'link' },
    );
    expect(reasons(out)).toEqual({ '7001': 'eligible', '7002': 'no_artefact', '7003': 'no_artefact' });
    expect(out[0]!.artefact).toEqual({ url: 'https://example.org/Page', host: 'example.org' });
  });
});

describe('the sweep: collection, judgment, proposal, payment', () => {
  /** An open image job of the seeded agent whose window closed; `replies` are what X holds in its conversation. */
  async function closedJob(w: TestWorld, replies: SenderConversationReply[], files: Record<string, { body: Buffer | string; type: string; status?: number; location?: string }>, bounties: Partial<AgentConfig['bounties']> = {}) {
    const agent = await seedAgent(w, { config: withBounties(bounties), runtime: restingRuntime });
    await postJob(w, agent, agent.config);
    const [job] = await jobsOf(w);
    const asked = serveReplies(w, replies);
    serveArtefacts(w, files);
    w.setNow(T0 + 6 * H + 1);
    return { agent, job: job!, asked };
  }
  const png = (id: string, body: Buffer = PNG) => ({ [`https://pbs.twimg.com/media/${id}.png`]: { body, type: 'image/png' } });
  const verdict = (winner: number | null, n: number, reason = 'A single round dot in a small red hat on a plain background.') => ({ winner, perCriterion: Object.fromEntries([...Array(n)].map((_, i) => [String(i + 1), winner === i + 1 ? ['pass', 'pass'] : ['pass', 'fail']])), reason });

  it('collects once after the close, judges the first eligible entries with their pictures, proposes the winner, and the creator pays with a tx hash', async () => {
    const w = await makeWorld({ script: [judgeAnswer(verdict(2, 2))] });
    try {
      const { agent, job, asked } = await closedJob(
        w,
        [
          reply('7001', '31', { media: [] }),
          reply('7002', '32', { text: `entry two ${ADDR_B}` }),
          reply('7003', '33', { text: `entry three ${ADDR_A}`, media: [{ mediaKey: '3_7003', type: 'photo', url: 'https://pbs.twimg.com/media/7003.png', previewImageUrl: null }] }),
          reply('7004', '34', { text: `entry four ${'0x4444444444444444444444444444444444444444'}`, media: [{ mediaKey: '3_7004', type: 'photo', url: 'https://pbs.twimg.com/media/7004.svg', previewImageUrl: null }] }),
        ],
        { ...png('7002', PNG2), ...png('7003'), 'https://pbs.twimg.com/media/7004.svg': { body: '<svg/>', type: 'image/svg+xml' } },
      );
      expect(await bountyJobClosed(w.ctx, agent, { ...initialState(), lastTreasuryTurnAt: T0 }, w.ctx.now())).toBe(false);
      const report = await sweepBounties(w.ctx);
      expect(report).toMatchObject({ judged: 1 });
      expect(asked).toEqual(['9001']);
      const after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'proposed', entriesReceived: 4, entriesEligible: 2, entriesConsidered: 2, payee: ADDR_A, approvalId: payoutApprovalId(job.id) });
      expect(after.closedAt).not.toBeNull();
      expect(after.verdict).toMatchObject({ winner: 2, reason: expect.stringMatching(/red hat/), reasonHash: expect.stringMatching(/^[0-9a-f]{64}$/), deliveryHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const entries = await w.db.select().from(bountyEntries).where(eq(bountyEntries.jobId, job.id));
      expect(Object.fromEntries(entries.map((e) => [e.replyId, [e.eligible, e.ineligibleReason, e.considered, e.n]]))).toEqual({
        '7001': [false, 'no_artefact', false, null],
        '7002': [true, null, true, 1],
        '7003': [true, null, true, 2],
        '7004': [false, 'artefact_unreadable', false, null],
      });
      expect(entries.find((e) => e.replyId === '7003')!.artefact).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      // the judge saw two numbered pictures and nothing of the replies
      const request = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!.body as { messages: { role: string; content: { type: string; text?: string; image_url?: { url: string } }[] }[] };
      const parts = request.messages[1]!.content;
      const user = parts.map((p) => p.text ?? p.image_url?.url ?? '').join('\n');
      expect(parts[0]!.text).toContain('"n":1,"kind":"image"');
      expect(parts[0]!.text).toContain('"n":2,"kind":"image"');
      expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
      expect(user).toContain('data:image/png;base64,');
      expect(user).not.toContain(ADDR_A);
      expect(user).not.toContain('entry three');
      expect(user).not.toContain('user33');
      // the treasury clock sees a closed job; a second sweep asks nothing again
      expect(await bountyJobClosed(w.ctx, agent, { ...initialState(), lastTreasuryTurnAt: T0 }, w.ctx.now())).toBe(true);
      expect(await bountyJobClosed(w.ctx, agent, { ...initialState(), lastTreasuryTurnAt: w.ctx.now() + 1 }, w.ctx.now())).toBe(false);
      await sweepBounties(w.ctx);
      expect(asked).toEqual(['9001']);
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(1);
      // the proposal in the queue, with the payee and the entry link for the creator
      const { get, post } = api(w);
      const queue = (await (await get(`/internal/agents/${AGENT_ID}/approvals`)).json()) as { items: Record<string, unknown>[] };
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]).toMatchObject({ id: payoutApprovalId(job.id), kind: 'bounty_payout', bounty: { kind: 'payout', jobId: job.id, amountUsdc: '0.5', payee: ADDR_A, entryUrl: 'https://x.com/i/status/7003', txHashRequired: true } });
      // approving needs the paying tx
      const noTx = await post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(job.id)}`, { decision: 'approve', by: CREATOR });
      expect(noTx.status).toBe(400);
      expect(((await noTx.json()) as { error: string }).error).toBe('tx_hash_required');
      const badTx = await post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(job.id)}`, { decision: 'approve', by: CREATOR, txHash: '0x1234' });
      expect(badTx.status).toBe(400);
      expect((await jobsOf(w))[0]!.status).toBe('proposed');
      w.setNow(w.ctx.now() + 60_000);
      const paid = await post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(job.id)}`, { decision: 'approve', by: CREATOR, txHash: TX });
      expect(paid.status).toBe(200);
      expect((await paid.json()) as object).toMatchObject({ status: 'approved', postId: '9002' });
      const done = (await jobsOf(w))[0]!;
      expect(done).toMatchObject({ status: 'paid', txHash: TX, paidReplyId: '9002', payee: ADDR_A });
      const [, paidReply] = published(w);
      expect(paidReply).toMatchObject({ actionId: `bounty:${job.id}:paid`, replyTo: '7003', text: `Paid 0.5 USDC for this entry. Why: A single round dot in a small red hat on a plain background. https://sepolia.basescan.org/tx/${TX}` });
      // once only
      const again = await post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(job.id)}`, { decision: 'approve', by: CREATOR, txHash: TX });
      expect(again.status).toBe(409);
      expect(published(w)).toHaveLength(2);
      // the tape and the read routes: public fields only
      const tape = (await agentActivity(w.ctx, agent, null)).filter((i) => i.kind === 'bounty');
      expect(tape.map((i) => i.summary)).toEqual(['Paid 0.5 USDC for a bounty entry', 'Judged a bounty: entry 2 of 2 won', `Posted a bounty for 0.5 USDC: ${JOB_INPUT.task}`]);
      expect(tape[0]).toMatchObject({ txHash: TX, url: `https://sepolia.basescan.org/tx/${TX}` });
      expect(JSON.stringify(tape)).not.toContain(ADDR_A);
      const list = (await (await get(`/internal/agents/${AGENT_ID}/bounties`)).json()) as { jobs: Record<string, unknown>[] };
      expect(list.jobs).toHaveLength(1);
      const view = list.jobs[0]!;
      expect(view).toMatchObject({
        id: job.id,
        status: 'paid',
        task: JOB_INPUT.task,
        criteria: JOB_INPUT.criteria,
        deliverable: 'image',
        amountUsdc: '0.5',
        amountMicroUsdc: '500000',
        postedAt: new Date(T0).toISOString(),
        closesAt: new Date(T0 + 6 * H).toISOString(),
        shortId: shortJobId(job.id),
        postUrl: 'https://x.com/i/status/9001',
        pageUrl: `https://bootr.fun/token/${TOKEN.toLowerCase()}#bounty-${shortJobId(job.id)}`,
        entries: { received: 4, eligible: 2, considered: 2, ineligible: { no_artefact: 1, artefact_unreadable: 1 } },
        verdict: { winner: 2, winningEntryUrl: 'https://x.com/i/status/7003', perCriterion: { '1': ['pass', 'fail'], '2': ['pass', 'pass'] }, reason: expect.stringMatching(/red hat/), invalid: null },
        payment: { status: 'paid', payee: ADDR_A, amountUsdc: '0.5', txHash: TX, txUrl: `https://sepolia.basescan.org/tx/${TX}`, replyUrl: 'https://x.com/i/status/9002' },
      });
      const text = JSON.stringify(list);
      expect(text).not.toContain(ADDR_B); // the other eligible entry's address stays off the page
      expect(text).not.toContain('"authorId"');
      expect(text).not.toContain('entry three');
      expect(text).not.toContain('user3');
      const one = (await (await get(`/internal/agents/${AGENT_ID}/bounties/${job.id}`)).json()) as { job: Record<string, unknown> };
      expect(one.job).toEqual(view);
      const byPrefix = (await (await get(`/internal/agents/${AGENT_ID}/bounties/${shortJobId(job.id)}`)).json()) as { job: Record<string, unknown> };
      expect(byPrefix.job).toEqual(view);
      expect((await get(`/internal/agents/${AGENT_ID}/bounties/0x01`)).status).toBe(400);
      expect((await get(`/internal/agents/${AGENT_ID}/bounties/0x${'f'.repeat(64)}`)).status).toBe(404);
    } finally {
      await w.close();
    }
  });

  it('closes a job without a winner in public when nothing met it, when the verdict is refused in code, and when no entry was eligible; the creator may decline a proposal', async () => {
    const w = await makeWorld({ script: [judgeAnswer(verdict(null, 1)), judgeAnswer('not json at all'), judgeAnswer(verdict(1, 1))] });
    try {
      const { agent, job } = await closedJob(w, [reply('7001', '31')], png('7001'));
      await sweepBounties(w.ctx);
      let after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'no_winner', entriesConsidered: 1, closeReplyId: '9002', payee: null });
      expect(after.verdict).toMatchObject({ winner: null });
      expect(published(w)[1]).toMatchObject({ actionId: `bounty:${job.id}:close`, replyTo: '9001', text: NO_WINNER_TEXT });
      expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(0);
      expect((await agentActivity(w.ctx, agent, null)).filter((i) => i.kind === 'bounty')[0]!.summary).toBe('Bounty closed: no entry met the job (1 reply), nothing paid');
      // an invalid verdict (malformed answer): no winner, nothing proposed
      w.setNow(T0 + 7 * H);
      const second = await postJob(w, agent, agent.config, 'act-post-2', { ...JOB_INPUT, task: 'Another dot picture' });
      expect(second.kind).toBe('completed');
      serveReplies(w, [reply('7101', '41', { createdAt: new Date(T0 + 8 * H).toISOString() })]);
      serveArtefacts(w, png('7101'));
      w.setNow(T0 + 13 * H + 1);
      await sweepBounties(w.ctx);
      after = (await jobsOf(w)).find((j) => j.actionId === 'act-post-2')!;
      expect(after).toMatchObject({ status: 'no_winner' });
      expect(after.verdict).toMatchObject({ winner: null, invalid: 'malformed_answer' });
      // no eligible entry at all: closed without a thought
      w.setNow(T0 + 14 * H);
      await postJob(w, agent, agent.config, 'act-post-3', { ...JOB_INPUT, task: 'A third dot picture' });
      serveReplies(w, [reply('7201', '51', { media: [] })]);
      w.setNow(T0 + 20 * H + 1);
      const thoughtsBefore = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
      await sweepBounties(w.ctx);
      after = (await jobsOf(w)).find((j) => j.actionId === 'act-post-3')!;
      expect(after).toMatchObject({ status: 'no_winner', entriesReceived: 1, entriesEligible: 0 });
      expect(after.verdict).toMatchObject({ invalid: 'no_entries' });
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(thoughtsBefore);
      // a proposal the creator declines closes with "Nothing paid."
      w.setNow(T0 + 21 * H);
      await postJob(w, agent, agent.config, 'act-post-4', { ...JOB_INPUT, task: 'A fourth dot picture' });
      serveReplies(w, [reply('7301', '61', { createdAt: new Date(T0 + 22 * H).toISOString() })]);
      serveArtefacts(w, png('7301'));
      w.setNow(T0 + 27 * H + 1);
      await sweepBounties(w.ctx);
      const fourth = (await jobsOf(w)).find((j) => j.actionId === 'act-post-4')!;
      expect(fourth.status).toBe('proposed');
      const { post } = api(w);
      const declined = await post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(fourth.id)}`, { decision: 'reject', by: CREATOR, note: 'not that one' });
      expect(declined.status).toBe(200);
      const closed = (await jobsOf(w)).find((j) => j.actionId === 'act-post-4')!;
      expect(closed).toMatchObject({ status: 'no_winner', error: 'declined by the creator', payee: ADDR_A });
      expect(published(w).at(-1)).toMatchObject({ actionId: `bounty:${fourth.id}:close`, text: NOTHING_PAID_TEXT });
      const views = (await (await api(w).get(`/internal/agents/${AGENT_ID}/bounties`)).json()) as { jobs: { id: string; payment: unknown; status: string }[] };
      expect(views.jobs.find((j) => j.id === fourth.id)).toMatchObject({ status: 'no_winner', payment: null });
    } finally {
      await w.close();
    }
  });

  it('expires a proposal nobody acted on within 48 hours, withdraws it from the queue and says so in public', async () => {
    const w = await makeWorld({ script: [judgeAnswer(verdict(1, 1))] });
    try {
      const { agent, job } = await closedJob(w, [reply('7001', '31')], png('7001'));
      await sweepBounties(w.ctx);
      expect((await jobsOf(w))[0]!.status).toBe('proposed');
      w.setNow(T0 + 6 * H + 1 + 47 * H);
      expect(await sweepBounties(w.ctx)).toMatchObject({ expired: 0 });
      w.setNow(T0 + 6 * H + 1 + 48 * H + 1);
      expect(await sweepBounties(w.ctx)).toMatchObject({ expired: 1 });
      const expired = (await jobsOf(w))[0]!;
      expect(expired).toMatchObject({ status: 'expired', closeReplyId: '9002' });
      expect(published(w).at(-1)).toMatchObject({ actionId: `bounty:${job.id}:close`, text: NOTHING_PAID_TEXT });
      const [approval] = await w.db.select().from(approvals).where(eq(approvals.id, payoutApprovalId(job.id)));
      expect(approval).toMatchObject({ status: 'rejected', decidedBy: 'system', note: 'expired' });
      expect((await api(w).post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(job.id)}`, { decision: 'approve', by: CREATOR, txHash: TX })).status).toBe(409);
      expect((await agentActivity(w.ctx, agent, null)).filter((i) => i.kind === 'bounty')[0]!.summary).toBe('Bounty proposal expired unpaid');
      expect((await bountyBudget(w.ctx, AGENT_ID, DEFAULT_BOUNTIES_POLICY)).openJobs).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('retries a failed collection on the next tick and gives up after the bounded count; a duplicate picture and a redirecting link are not considered', async () => {
    const w = await makeWorld({ script: [judgeAnswer(verdict(1, 1))] });
    try {
      const { agent, job } = await closedJob(w, [reply('7001', '31'), reply('7002', '32', { text: `dup ${ADDR_B}` }), reply('7003', '33', { text: `third ${ADDR_C}`, media: [{ mediaKey: '3_7003', type: 'photo', url: 'https://pbs.twimg.com/media/7003.png', previewImageUrl: null }] })], { ...png('7001'), ...png('7002'), 'https://pbs.twimg.com/media/7003.png': { body: '', type: 'text/plain', status: 302, location: 'https://elsewhere.example/x' } });
      (w.sender.client as unknown as { readReplies: () => Promise<unknown> }).readReplies = async () => {
        throw new Error('fetch failed');
      };
      for (let i = 0; i < 4; i++) {
        await sweepBounties(w.ctx);
        w.setNow(w.ctx.now() + 16 * 60_000);
      }
      let after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'judging', attempts: 4, error: 'fetch failed' });
      // the sender comes back: the collection completes, the duplicate and the redirect are marked
      serveReplies(w, [reply('7001', '31'), reply('7002', '32', { text: `dup ${ADDR_B}` }), reply('7003', '33', { text: `third ${ADDR_C}`, media: [{ mediaKey: '3_7003', type: 'photo', url: 'https://pbs.twimg.com/media/7003.png', previewImageUrl: null }] })]);
      await sweepBounties(w.ctx);
      after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'proposed', entriesReceived: 3, entriesEligible: 1, entriesConsidered: 1 });
      const entries = await w.db.select().from(bountyEntries).where(eq(bountyEntries.jobId, job.id));
      expect(Object.fromEntries(entries.map((e) => [e.replyId, e.ineligibleReason]))).toEqual({ '7001': null, '7002': 'duplicate_media', '7003': 'link_redirect' });
      // a job that never collects fails after MAX_COLLECT_ATTEMPTS, closed unpaid in public
      w.setNow(T0 + 30 * H);
      await postJob(w, agent, agent.config, 'act-post-2', { ...JOB_INPUT, task: 'Another dot picture' });
      (w.sender.client as unknown as { readReplies: () => Promise<unknown> }).readReplies = async () => {
        throw new Error('fetch failed');
      };
      w.setNow(T0 + 36 * H + 1);
      for (let i = 0; i < 6; i++) {
        await sweepBounties(w.ctx);
        w.setNow(w.ctx.now() + 16 * 60_000);
      }
      const dead = (await jobsOf(w)).find((j) => j.actionId === 'act-post-2')!;
      expect(dead).toMatchObject({ status: 'failed', error: expect.stringMatching(/collection_failed after 5 attempts/) });
      expect(published(w).at(-1)).toMatchObject({ actionId: `bounty:${dead.id}:close`, text: NOTHING_PAID_TEXT });
    } finally {
      await w.close();
    }
  });

  it('collectAndJudge is resumable: a judging job asked again replays the stored verdict without a second thought', async () => {
    const w = await makeWorld({ script: [judgeAnswer(verdict(1, 1))] });
    try {
      const { agent, job } = await closedJob(w, [reply('7001', '31')], png('7001'));
      const first = await collectAndJudge(w.ctx, agent, configOf(agent.config), job);
      expect(first.job.status).toBe('proposed');
      const again = await collectAndJudge(w.ctx, agent, configOf(agent.config), { ...first.job, status: 'judging' });
      expect(again.job.status).toBe('proposed');
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(1);
      expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});

describe('the social turn and the entries', () => {
  function entry(postId: string, conversationId: string): SenderInboxItem {
    const authorId = `3${postId}`;
    return { postId, authorId, conversationId, status: 'pending', observedAt: new Date(T0).toISOString(), seenAt: null, deferredUntil: null, post: { id: postId, authorId, text: `@bootr_agent my entry ${ADDR_A}`, conversationId, author: { id: authorId, username: `user${authorId}`, verified: true, verifiedType: 'blue' } } };
  }

  it('marks replies in an open job\'s conversation ineligible as bounty_entry, closes them before the turn, and buys no thought for them', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
      await postJob(w, agent, agent.config);
      const config = configOf(agent.config);
      const conversations = await bountyConversationIds(w.ctx, AGENT_ID);
      expect([...conversations]).toEqual(['9001']);
      const items = [entry('7001', '9001'), entry('7002', '8888')];
      const views = inboxViews(config, items, T0, null, conversations);
      expect(views.map((v) => [v.postId, v.eligible, v.reason])).toEqual([
        ['7001', false, 'bounty_entry'],
        ['7002', true, undefined],
      ]);
      expect(inboxViews(config, items, T0, null).every((v) => v.eligible)).toBe(true);
      let resolved: unknown[] = [];
      (w.sender.client as unknown as { resolve: (b: unknown) => Promise<unknown> }).resolve = async (b) => {
        resolved.push(b);
        return {};
      };
      const kept = await closeBountyEntries(w.ctx, agent, items, conversations);
      expect(kept.map((i) => i.postId)).toEqual(['7002']);
      expect(resolved).toEqual([{ agentId: AGENT_ID, postId: '7001', outcome: 'skip', reason: 'bounty_entry' }]);
      // a tick with only an entry in the inbox wakes nothing (the mention would otherwise wake the social turn)
      resolved = [];
      w.sender.items = [entry('7003', '9001')];
      const report = await tick(w.ctx);
      expect(report.ran).toEqual([]);
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
      // a closed job's conversation is no longer special
      await executeAction(w.ctx, agent, config, pending('c-1', 'bounty_cancel', { jobId: (await jobsOf(w))[0]!.id }), env());
      expect((await bountyConversationIds(w.ctx, AGENT_ID)).size).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('the treasury clock comes forward for a closed job, never closer than a quarter of the interval to the last turn', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: withBounties(), runtime: { ...restingRuntime, state: { ...initialState(), treasuryNextAt: T0 + 2 * H, lastTreasuryTurnAt: T0 - 50 * 60_000 } as unknown as Record<string, unknown> } });
      await postJob(w, agent, agent.config);
      const runtime = (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      const state = runtime.state as unknown as AgentState;
      expect(await treasuryTurnDue(w.ctx, agent, runtime, state, T0)).toBeNull();
      await executeAction(w.ctx, agent, configOf(agent.config), pending('c-1', 'bounty_cancel', { jobId: (await jobsOf(w))[0]!.id }), env());
      // cancelled is not a verdict: the clock stays
      expect(await treasuryTurnDue(w.ctx, agent, runtime, state, T0)).toBeNull();
      await w.db.update(bountyJobs).set({ status: 'no_winner' }).where(and(eq(bountyJobs.agentId, AGENT_ID)));
      expect(await treasuryTurnDue(w.ctx, agent, runtime, state, T0)).toMatchObject({ reasons: ['treasury_job_closed'] });
      expect(await treasuryTurnDue(w.ctx, agent, runtime, { ...state, lastTreasuryTurnAt: T0 - 60_000 }, T0)).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('the config view carries the bounties block and the console sets it inside the ceilings', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const { get, put } = api(w);
      expect(((await (await get(`/internal/agents/${AGENT_ID}/config`)).json()) as { bounties: unknown }).bounties).toEqual(DEFAULT_BOUNTIES_POLICY);
      const over = await put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, bounties: { dailyCapMicroUsdc: 20_000_001 } });
      expect(over.status).toBe(400);
      expect(((await over.json()) as { error: string }).error).toBe('invalid_bounties');
      expect((await put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, bounties: { maxOpen: 6 } })).status).toBe(400);
      expect((await put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, bounties: { defaultHoursOpen: 0 } })).status).toBe(400);
      const ok = await put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, bounties: { dailyCapMicroUsdc: 2_000_000, review: true, cooldownSeconds: 0 }, worker: { capabilities: { bounties: true } } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { bounties: Record<string, unknown>; worker: { capabilities: Record<string, boolean> }; treasuryTurn: { active: boolean } };
      expect(body.bounties).toEqual({ ...DEFAULT_BOUNTIES_POLICY, dailyCapMicroUsdc: 2_000_000, review: true, cooldownSeconds: 0 });
      expect(body.worker.capabilities.bounties).toBe(true);
      expect(body.treasuryTurn.active).toBe(true);
      expect((await put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, bounties: { review: true } })).status).toBe(409);
    } finally {
      await w.close();
    }
  });
});
