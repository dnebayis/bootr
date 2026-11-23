/**
 * Bounties stage A (bounties.ts): the templates and the task rules, `bounty_post` / `bounty_cancel` / `bounty_list`
 * through the broker, the review and slot waits, the entry rules one by one, the sweep end to end against a fake
 * sender and a scripted judge (winner -> proposal -> approve with tx -> paid reply; no winner -> public close;
 * invalid verdict -> no winner; 48 h expiry), the treasury clock, the social turn ignoring entries, and what the read
 * routes never carry (an author id, reply text, an ineligible entry's address).
 */
import { BOUNTY_MAX_CONSIDERED, DEFAULT_BOUNTIES_POLICY, parseAgentConfig, type AgentConfig } from '@bootr/agent-core';
import { and, eq } from 'drizzle-orm';
import { postFinding } from '@bootr/agent-core';
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
  bountyJobViews,
  BOUNTY_GOOD_JOBS,
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
  payoutPostText,
  pickApprovalId,
  publishPayoutPost,
  requiredOfJob,
  reruleJob,
  RERULE_WINDOW_MS,
  sameJob,
  shortJobId,
  sniffImage,
  sweepBounties,
  taskRuleProblem,
  usdc,
  utcDayStart,
  type EligibilityContext,
} from '../src/bounties.js';
import { executeAction, inboxViews, resolvePending, type BrokerEnv } from '../src/broker/index.js';
import { approvals, bountyEntries, bountyJobs, inference as inferenceTable, runtimes } from '../src/db/schema.js';
import { judgeKey, reasonProblem } from '../src/judge.js';
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

/** Other jobs of the same agent: different work each, since a job in the words of an earlier one is refused. */
const TASK2 = 'A round picture of a cat asleep on a ledger, pencil sketch';
const TASK3 = 'A wide picture of three boats on a green lake at dawn';
const TASK4 = 'A tall picture of a lighthouse made of stacked coins, in ink';
const JOB_INPUT = { task: 'A square picture of a dot wearing a tiny hat, flat colours', criteria: ['It shows a single dot', 'The dot wears a hat'], deliverable: 'image' as const, amountUsdc: 0.5 };

/** The job post of the seeded agent for `JOB_INPUT`, as the template renders it at `now`. */
const jobsOf = async (w: TestWorld) => w.db.select().from(bountyJobs).where(eq(bountyJobs.agentId, AGENT_ID));
const bountyJobViewsOf = async (w: TestWorld) => bountyJobViews(w.ctx, (await w.db.query.agents.findFirst({ where: (t, { eq: eqf }) => eqf(t.agentId, AGENT_ID) }))!);
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
function judgeAnswer(body: unknown, finishReason = 'stop'): Response {
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(JSON.stringify({ id: 'cmpl', choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }], usage: { prompt_tokens: 900, completion_tokens: 60 } }), {
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
      return jobTextProblem({ task, criteria, deliverable: 'image', text, attributions: [{ username: config.xHandle, sourceUrl: 'https://bootr.fun/token/x#bounty-0x1' }], config, premium });
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
    const platformText = jobPostText({ task: 'A square picture of a dot. Visit https://bootr-claim.com/x now', amountMicroUsdc: 500_000n, deliverable: 'image', closesAt: T0 + 6 * H, handle: platform.xHandle, link: 'https://bootr.fun/token/x#bounty-0x1' });
    expect(jobTextProblem({ task: 'A square picture of a dot. Visit https://bootr-claim.com/x now', criteria: ['It is a dot'], deliverable: 'image', text: platformText, attributions: [{ username: platform.xHandle, sourceUrl: 'https://bootr.fun/token/x#bounty-0x1' }], config: platform, premium: null })).toMatch(/^platform_link_forbidden/);
    expect(check(`A square picture of a dot ${'x'.repeat(180)}`, ['It is a dot'], false)).toMatch(/^bounty_post_too_long/);
    expect(check(`A square picture of a dot ${'x'.repeat(180)}`, ['It is a dot'], true)).toBeNull();
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
      const two = await postJob(w, agent, raw, 'act-post-2', { ...JOB_INPUT, task: 'A CSV of the ten largest Base pools by volume with name and volume', deliverable: 'link', amountUsdc: 0.2, hoursOpen: 24 });
      expect(two).toMatchObject({ kind: 'completed', result: { status: 'open', closesAt: new Date(T0 + 24 * H).toISOString() } });
      const list = (await executeAction(w.ctx, agent, configOf(raw), pending('act-list', 'bounty_list', {}), env())) as { kind: string; result: { jobs: Record<string, unknown>[]; budget: Record<string, unknown> } };
      expect(list.kind).toBe('completed');
      expect(list.result.jobs.map((j) => j.status)).toEqual(['open', 'open']);
      expect(list.result.budget).toMatchObject({ reservedTodayUsdc: '0.7', remainingTodayUsdc: '4.3', openJobs: 2, maxOpen: 2 });
      expect(JSON.stringify(list.result)).not.toContain('authorId');
      // the tape and the treasury observation know the job
      const items = await agentActivity(w.ctx, agent, null);
      expect(items.filter((i) => i.kind === 'bounty').map((i) => i.summary).sort()).toEqual([`Posted a bounty for 0.2 USDC: A CSV of the ten largest Base pools by volume with name and volume`, `Posted a bounty for 0.5 USDC: ${JOB_INPUT.task}`].sort());
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
      await postJob(w, agent, raw, 'act-post-2', { ...JOB_INPUT, task: TASK2 });
      w.setNow(T0 + 30 * H + 1);
      expect(await sweepBounties(w.ctx)).toMatchObject({ failed: 1 });
      const stale = (await jobsOf(w)).find((j) => j.actionId === 'act-post-2')!;
      expect(stale).toMatchObject({ status: 'failed', error: expect.stringMatching(/draft_expired/) });
      // a rejected publish fails the job and the tool says so
      w.setNow(T0);
      w.sender.quotaExceeded = null;
      w.sender.publishError = 'http_403(403): You are not permitted to perform this action';
      const bad = await postJob(w, agent, raw, 'act-post-3', { ...JOB_INPUT, task: TASK3 });
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
      await postJob(w, agent, raw, 'act-post-2', { ...JOB_INPUT, task: TASK2 });
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
      // the payment is also a post of the agent's own, from the template: the job, the amount, the transaction, the entry; nobody named
      const [, , payoutPost] = published(w);
      expect(payoutPost).toMatchObject({ actionId: `bounty:${job.id}:payout`, text: `Bounty paid: 0.5 USDC to the winning entry. The job: ${JOB_INPUT.task}. Payment: https://sepolia.basescan.org/tx/${TX} Entry: https://x.com/i/status/7003` });
      expect(payoutPost!.replyTo).toBeUndefined();
      expect(payoutPost!.text).not.toContain('@');
      expect(payoutPost!.text).not.toContain(ADDR_A);
      expect(done.payoutPostId).toBe('9003');
      // once only: a second approval is refused, a second ask and the sweep post nothing more
      const again = await post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(job.id)}`, { decision: 'approve', by: CREATOR, txHash: TX });
      expect(again.status).toBe(409);
      expect((await publishPayoutPost(w.ctx, agent, configOf(agent.config), (await jobsOf(w))[0]!)).payoutPostId).toBe('9003');
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('announced');
      expect(published(w)).toHaveLength(3);
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
        payment: { status: 'paid', payee: ADDR_A, amountUsdc: '0.5', txHash: TX, txUrl: `https://sepolia.basescan.org/tx/${TX}`, replyUrl: 'https://x.com/i/status/9002', postUrl: 'https://x.com/i/status/9003' },
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

  it('closes a job without a winner in public when no entry passed the required criterion and when no entry was eligible; an entry that fails only a scored criterion is proposed; the creator may decline a proposal', async () => {
    const w = await makeWorld({ script: [judgeAnswer({ winner: null, perCriterion: { '1': ['fail', 'pass'] }, reason: 'It shows two dots, not one.' }), judgeAnswer({ winner: 1, perCriterion: { '1': ['pass', 'fail'] }, reason: 'A dot.' }), judgeAnswer(verdict(1, 1))] });
    try {
      const { agent, job } = await closedJob(w, [reply('7001', '31')], png('7001'));
      await sweepBounties(w.ctx);
      let after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'no_winner', entriesConsidered: 1, closeReplyId: '9002', payee: null });
      expect(after.verdict).toMatchObject({ winner: null });
      expect(published(w)[1]).toMatchObject({ actionId: `bounty:${job.id}:close`, replyTo: '9001', text: NO_WINNER_TEXT });
      expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(0);
      expect((await agentActivity(w.ctx, agent, null)).filter((i) => i.kind === 'bounty')[0]!.summary).toBe('Bounty closed: no entry met the job (1 reply), nothing paid');
      // an entry that passes the required criterion (the first) and fails the scored one wins: proposed, with the judge's reason, on one thought
      w.setNow(T0 + 7 * H);
      const second = await postJob(w, agent, agent.config, 'act-post-2', { ...JOB_INPUT, task: TASK2 });
      expect(second.kind).toBe('completed');
      serveReplies(w, [reply('7101', '41', { createdAt: new Date(T0 + 8 * H).toISOString() })]);
      serveArtefacts(w, png('7101'));
      w.setNow(T0 + 13 * H + 1);
      await sweepBounties(w.ctx);
      after = (await jobsOf(w)).find((j) => j.actionId === 'act-post-2')!;
      expect(after).toMatchObject({ status: 'proposed', payee: ADDR_A, approvalId: payoutApprovalId(after.id) });
      expect(after.verdict).toMatchObject({ winner: 1, modelWinner: 1, required: [1], reason: 'A dot.', reasonBy: 'judge', perCriterion: { '1': ['pass', 'fail'] } });
      expect(after.verdict).not.toHaveProperty('invalid');
      expect((after.verdict as { thoughts: unknown[] }).thoughts).toHaveLength(1);
      // no eligible entry at all: closed without a thought
      w.setNow(T0 + 14 * H);
      await postJob(w, agent, agent.config, 'act-post-3', { ...JOB_INPUT, task: TASK3 });
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
      await postJob(w, agent, agent.config, 'act-post-4', { ...JOB_INPUT, task: TASK4 });
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
      await postJob(w, agent, agent.config, 'act-post-2', { ...JOB_INPUT, task: TASK2 });
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

describe('a judge that gives no usable answer: the second thought, the creator\'s pick, the second ruling', () => {
  const png = (id: string, body: Buffer = PNG) => ({ [`https://pbs.twimg.com/media/${id}.png`]: { body, type: 'image/png' } });
  const good = (winner: number | null, n: number, reason = 'A single round dot in a small red hat on a plain background.') => ({ winner, perCriterion: Object.fromEntries([...Array(n)].map((_, i) => [String(i + 1), winner === i + 1 ? ['pass', 'pass'] : ['pass', 'fail']])), reason });
  const thoughtCalls = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;

  /** An open image job whose window closed with two eligible entries: 7001 pays ADDR_A, 7002 pays ADDR_B. */
  async function closedJobWithTwo(w: TestWorld) {
    const agent = await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
    await postJob(w, agent, agent.config);
    const [job] = await jobsOf(w);
    serveReplies(w, [reply('7001', '31'), reply('7002', '32', { text: `entry two ${ADDR_B}` })]);
    serveArtefacts(w, { ...png('7001'), ...png('7002', PNG2) });
    w.setNow(T0 + 6 * H + 1);
    return { agent, job: job! };
  }

  /**
   * Rewrites a job the judge failed on to what the code before the second thought left behind: closed `no_winner` on
   * the refused answer, one thought on record, "No entry met the job; nothing paid." already said in public.
   */
  async function asClosedByOldCode(w: TestWorld, jobId: string, over: { closedAt?: number; keepThoughts?: boolean } = {}) {
    const [row] = await w.db.select().from(bountyJobs).where(eq(bountyJobs.id, jobId));
    const rest = { ...(row!.verdict as Record<string, unknown> & { thoughts?: { key: string }[] }) };
    const thoughts = rest.thoughts;
    delete rest.thoughts;
    delete rest.manualPick;
    delete rest.rejudged;
    await w.db.delete(approvals).where(eq(approvals.id, pickApprovalId(jobId)));
    if (!over.keepThoughts) await w.db.delete(inferenceTable).where(eq(inferenceTable.idempotencyKey, judgeKey(AGENT_ID, jobId, 2)));
    const at = new Date(over.closedAt ?? w.ctx.now());
    await w.db
      .update(bountyJobs)
      .set({ status: 'no_winner', verdict: { ...rest, winner: null, invalid: 'malformed_answer', thought: thoughts?.[0] ?? rest.thought, ...(over.keepThoughts ? { thoughts } : {}) }, approvalId: null, judgeRaw: null, closeReplyId: '9990', closedAt: at, updatedAt: at })
      .where(eq(bountyJobs.id, jobId));
  }

  it('an answer that is no verdict buys one more thought under a new key; the refused text is kept on the row and stays off every public read', async () => {
    const w = await makeWorld({ script: [judgeAnswer('Entry 2 has the hat, entry 1 does not. I would pick the second one.'), judgeAnswer('```json\n' + JSON.stringify(good(2, 2)) + '\n```')] });
    try {
      const { agent, job } = await closedJobWithTwo(w);
      expect(await sweepBounties(w.ctx)).toMatchObject({ judged: 1 });
      const after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'proposed', payee: ADDR_B, approvalId: payoutApprovalId(job.id) });
      const stored = after.verdict as { winner: number; thoughts: { key: string; outcome: string }[]; thought: { key: string } };
      expect(stored.winner).toBe(2);
      expect(stored.thoughts.map((t) => t.key)).toEqual([judgeKey(AGENT_ID, job.id), judgeKey(AGENT_ID, job.id, 2)]);
      expect(stored.thought.key).toBe(judgeKey(AGENT_ID, job.id, 2));
      expect(thoughtCalls(w)).toBe(2);
      expect(after.judgeRaw).toMatch(/^\[attempt 1: malformed_answer; finish stop; 60 output tokens\]\nEntry 2 has the hat/);
      // nothing was said in public about a failed ruling, and the model's text is on no read route
      expect(published(w)).toHaveLength(1);
      const read = JSON.stringify(await (await api(w).get(`/internal/agents/${AGENT_ID}/bounties`)).json()) + JSON.stringify(await (await api(w).get(`/internal/agents/${AGENT_ID}/approvals`)).json()) + JSON.stringify(await agentActivity(w.ctx, agent, null));
      expect(read).not.toContain('Entry 2 has the hat');
      expect(read).not.toContain('judgeRaw');
      // resumed or swept again: both thoughts replay, nothing more is bought
      await collectAndJudge(w.ctx, agent, configOf(agent.config), { ...after, status: 'judging' });
      expect(thoughtCalls(w)).toBe(2);
    } finally {
      await w.close();
    }
  });

  it('two answers that are no verdict do not close the job in public: the creator picks an entry and pays it, with the tx hash and the entry number', async () => {
    const w = await makeWorld({ script: [judgeAnswer('I looked at both pictures.'), judgeAnswer('{"winner": 2, "perCriterion": {"1": ["pass", "pa', 'length'), judgeAnswer(good(1, 2))] });
    try {
      const { agent, job } = await closedJobWithTwo(w);
      expect(await sweepBounties(w.ctx)).toMatchObject({ judged: 1 });
      let after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'proposed', payee: null, approvalId: pickApprovalId(job.id), closeReplyId: null, entriesConsidered: 2 });
      expect(after.verdict).toMatchObject({ winner: null, invalid: 'malformed_answer', manualPick: true });
      expect((after.verdict as { thoughts: unknown[] }).thoughts).toHaveLength(2);
      expect(after.judgeRaw).toContain('[attempt 1: malformed_answer; finish stop;');
      expect(after.judgeRaw).toContain('[attempt 2: malformed_answer; finish length;');
      expect(after.judgeRaw).toContain('I looked at both pictures.');
      // two thoughts, never a third; no "No entry met the job" under the job post
      expect(thoughtCalls(w)).toBe(2);
      await sweepBounties(w.ctx);
      expect(thoughtCalls(w)).toBe(2);
      expect(published(w)).toHaveLength(1);
      expect(published(w).some((p) => p.text === NO_WINNER_TEXT)).toBe(false);
      // the queue item: every considered entry with its links and its address, for the creator's eyes
      const { get, post } = api(w);
      const queue = (await (await get(`/internal/agents/${AGENT_ID}/approvals`)).json()) as { items: Record<string, unknown>[] };
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]).toMatchObject({
        id: pickApprovalId(job.id),
        kind: 'bounty_pick',
        bounty: {
          kind: 'pick',
          jobId: job.id,
          amountUsdc: '0.5',
          why: 'malformed_answer',
          txHashRequired: true,
          entryRequired: true,
          candidates: [
            { n: 1, payee: ADDR_A, entryUrl: 'https://x.com/i/status/7001', artefactUrl: 'https://pbs.twimg.com/media/7001.png' },
            { n: 2, payee: ADDR_B, entryUrl: 'https://x.com/i/status/7002', artefactUrl: 'https://pbs.twimg.com/media/7002.png' },
          ],
        },
      });
      // the tape says where it stands, with no address; the public job view shows no payment yet
      const waiting = (await agentActivity(w.ctx, agent, null)).filter((i) => i.kind === 'bounty').map((i) => i.summary);
      expect(waiting[0]).toBe("Bounty: the judge gave no ruling, 2 entries wait for the creator's pick");
      const view = ((await (await get(`/internal/agents/${AGENT_ID}/bounties`)).json()) as { jobs: { payment: unknown; status: string }[] }).jobs[0]!;
      expect(view).toMatchObject({ status: 'proposed', payment: null });
      // approving needs the hash and the number of one of the listed entries
      const url = `/internal/agents/${AGENT_ID}/approvals/${pickApprovalId(job.id)}`;
      expect(((await (await post(url, { decision: 'approve', by: CREATOR, entry: 2 })).json()) as { error: string }).error).toBe('tx_hash_required');
      expect(((await (await post(url, { decision: 'approve', by: CREATOR, txHash: TX })).json()) as { error: string }).error).toBe('entry_required');
      expect(((await (await post(url, { decision: 'approve', by: CREATOR, txHash: TX, entry: 5 })).json()) as { error: string }).error).toBe('entry_required');
      expect((await jobsOf(w))[0]!.status).toBe('proposed');
      w.setNow(w.ctx.now() + 60_000);
      const paid = await post(url, { decision: 'approve', by: CREATOR, txHash: TX, entry: 2 });
      expect(paid.status).toBe(200);
      after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'paid', payee: ADDR_B, txHash: TX, paidReplyId: '9002', payoutPostId: '9003' });
      expect(after.verdict).toMatchObject({ winner: 2, pickedBy: 'creator', judgeInvalid: 'malformed_answer' });
      expect(after.verdict).not.toHaveProperty('invalid');
      expect(after.verdict).not.toHaveProperty('manualPick');
      expect(published(w)[1]).toMatchObject({ actionId: `bounty:${job.id}:paid`, replyTo: '7002', text: `Paid 0.5 USDC for this entry. https://sepolia.basescan.org/tx/${TX}` });
      expect(published(w)[2]).toMatchObject({ actionId: `bounty:${job.id}:payout`, text: `Bounty paid: 0.5 USDC to the winning entry. The job: ${JOB_INPUT.task}. Payment: https://sepolia.basescan.org/tx/${TX} Entry: https://x.com/i/status/7002` });
      expect((await post(url, { decision: 'approve', by: CREATOR, txHash: TX, entry: 1 })).status).toBe(409);
      const tape = (await agentActivity(w.ctx, agent, null)).filter((i) => i.kind === 'bounty').map((i) => i.summary);
      expect(tape).toEqual(['Paid 0.5 USDC for a bounty entry', 'Bounty: the judge gave no ruling, the creator picked entry 2 of 2', `Posted a bounty for 0.5 USDC: ${JOB_INPUT.task}`]);
      expect(JSON.stringify(tape)).not.toContain(ADDR_B);
    } finally {
      await w.close();
    }
  });

  it('a pick the creator declines closes the job as a declined payout does; a failed thought counts like a refused answer', async () => {
    const w = await makeWorld({ script: [judgeAnswer('no ruling here'), new Response(JSON.stringify({ error: { code: 'upstream_rejected' } }), { status: 502, headers: { 'content-type': 'application/json' } })] });
    try {
      const { job } = await closedJobWithTwo(w);
      await sweepBounties(w.ctx);
      let after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'proposed', approvalId: pickApprovalId(job.id) });
      expect(after.verdict).toMatchObject({ invalid: 'thought_failed', manualPick: true });
      const declined = await api(w).post(`/internal/agents/${AGENT_ID}/approvals/${pickApprovalId(job.id)}`, { decision: 'reject', by: CREATOR, note: 'none of them' });
      expect(declined.status).toBe(200);
      after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'no_winner', error: 'declined by the creator', payee: null, closeReplyId: '9002' });
      expect(published(w).at(-1)).toMatchObject({ actionId: `bounty:${job.id}:close`, text: NOTHING_PAID_TEXT });
      // declined is final: the sweep does not judge it again
      w.setNow(w.ctx.now() + 20 * 60_000);
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('rejudged');
    } finally {
      await w.close();
    }
  });

  it('a job that closed on a refused answer in the last seven days is judged once more by the sweep; a winner becomes a normal proposal and nothing is said in public twice', async () => {
    const script = [judgeAnswer('I looked at both pictures.'), judgeAnswer('Still thinking about it.')];
    const w = await makeWorld({ script });
    try {
      const { agent, job } = await closedJobWithTwo(w);
      await sweepBounties(w.ctx);
      await asClosedByOldCode(w, job.id);
      expect((await jobsOf(w))[0]).toMatchObject({ status: 'no_winner', closeReplyId: '9990', approvalId: null });
      expect((await jobsOf(w))[0]!.verdict).not.toHaveProperty('thoughts');
      // spaced from the last touch of the row, then judged from the stored entry rows: X is not read again
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('rejudged');
      const asked = serveReplies(w, []);
      w.setNow(w.ctx.now() + 16 * 60_000);
      script.push(judgeAnswer(good(2, 2)));
      expect(await sweepBounties(w.ctx)).toMatchObject({ rejudged: 1 });
      expect(asked).toEqual([]);
      const after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'proposed', payee: ADDR_B, approvalId: payoutApprovalId(job.id), closeReplyId: '9990', error: null });
      expect(after.verdict).toMatchObject({ winner: 2, rejudged: { outcome: 'proposed' } });
      expect(after.verdict).not.toHaveProperty('invalid');
      // the first thought was replayed (its answer is still no verdict, and is now kept), the second was bought: three calls in all, two for the job's two keys
      expect((after.verdict as { thoughts: { key: string }[] }).thoughts.map((t) => t.key)).toEqual([judgeKey(AGENT_ID, job.id), judgeKey(AGENT_ID, job.id, 2)]);
      expect(thoughtCalls(w)).toBe(3);
      expect(after.judgeRaw).toContain('I looked at both pictures.');
      const queue = (await (await api(w).get(`/internal/agents/${AGENT_ID}/approvals`)).json()) as { items: Record<string, unknown>[] };
      expect(queue.items[0]).toMatchObject({ id: payoutApprovalId(job.id), kind: 'bounty_payout', bounty: { kind: 'payout', payee: ADDR_B, entryUrl: 'https://x.com/i/status/7002' } });
      // only the job post is in public: no second "nothing paid", and none when the creator declines either
      expect(published(w)).toHaveLength(1);
      w.setNow(w.ctx.now() + 16 * 60_000);
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('rejudged');
      expect(thoughtCalls(w)).toBe(3);
      expect((await api(w).post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(job.id)}`, { decision: 'reject', by: CREATOR })).status).toBe(200);
      expect((await jobsOf(w))[0]).toMatchObject({ status: 'no_winner', closeReplyId: '9990' });
      expect(published(w)).toHaveLength(1);
      // the creator can still pay it: approve path of another run is covered above; here the treasury clock saw the proposal
      expect(await bountyJobClosed(w.ctx, agent, { ...initialState(), lastTreasuryTurnAt: T0 }, w.ctx.now())).toBe(true);
    } finally {
      await w.close();
    }
  });

  it('not judged again: a job that closed more than seven days ago, and one that already had two thoughts; a stored answer today\'s parser can read costs nothing', async () => {
    const script = [judgeAnswer('I looked at both pictures.'), judgeAnswer('Still thinking about it.')];
    const w = await makeWorld({ script });
    try {
      const { job } = await closedJobWithTwo(w);
      await sweepBounties(w.ctx);
      const closedAt = w.ctx.now();
      // (a) two thoughts already: never a third
      await asClosedByOldCode(w, job.id, { keepThoughts: true });
      w.setNow(closedAt + 20 * 60_000);
      script.push(judgeAnswer(good(1, 2)));
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('rejudged');
      expect((await jobsOf(w))[0]!.status).toBe('no_winner');
      // (b) one thought, but closed eight days ago
      await asClosedByOldCode(w, job.id, { closedAt: w.ctx.now() - 8 * 24 * H });
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('rejudged');
      expect((await jobsOf(w))[0]!.status).toBe('no_winner');
      expect(thoughtCalls(w)).toBe(2);
      // (c) one thought, closed an hour ago, and its stored answer was a verdict in a code fence the old parser refused
      await asClosedByOldCode(w, job.id, { closedAt: w.ctx.now() - H });
      await w.db
        .update(inferenceTable)
        .set({ response: { id: 'cmpl', choices: [{ message: { role: 'assistant', content: 'Here is my ruling:\n```json\n' + JSON.stringify(good(1, 2)) + '\n```' }, finish_reason: 'stop' }] } })
        .where(eq(inferenceTable.idempotencyKey, judgeKey(AGENT_ID, job.id)));
      expect(await sweepBounties(w.ctx)).toMatchObject({ rejudged: 1 });
      const after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'proposed', payee: ADDR_A, approvalId: payoutApprovalId(job.id) });
      expect(after.verdict).toMatchObject({ winner: 1, rejudged: { outcome: 'proposed' } });
      expect(thoughtCalls(w)).toBe(2);
    } finally {
      await w.close();
    }
  });

  it('a second ruling without a winner leaves the job closed and silent; a second failure asks the creator to pick', async () => {
    const script = [judgeAnswer('I looked at both pictures.'), judgeAnswer('Still thinking about it.')];
    const w = await makeWorld({ script });
    try {
      const { job } = await closedJobWithTwo(w);
      await sweepBounties(w.ctx);
      await asClosedByOldCode(w, job.id);
      w.setNow(w.ctx.now() + 16 * 60_000);
      script.push(judgeAnswer({ winner: null, perCriterion: { '1': ['fail', 'pass'], '2': ['fail', 'fail'] }, reason: 'Neither shows a single dot.' }));
      expect(await sweepBounties(w.ctx)).toMatchObject({ rejudged: 1 });
      let after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'no_winner', closeReplyId: '9990', approvalId: null, payee: null });
      expect(after.verdict).toMatchObject({ winner: null, rejudged: { outcome: 'no_winner' } });
      expect(after.verdict).not.toHaveProperty('invalid');
      expect(published(w)).toHaveLength(1);
      expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(0);
      w.setNow(w.ctx.now() + 16 * 60_000);
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('rejudged');
      expect(thoughtCalls(w)).toBe(3);
      // the same job, had its second thought failed too: the creator's pick, not a second silent close
      await asClosedByOldCode(w, job.id);
      script.push(judgeAnswer('And again no JSON.'));
      w.setNow(w.ctx.now() + 16 * 60_000);
      expect(await sweepBounties(w.ctx)).toMatchObject({ rejudged: 1 });
      after = (await jobsOf(w))[0]!;
      expect(after).toMatchObject({ status: 'proposed', approvalId: pickApprovalId(job.id), payee: null });
      expect(after.verdict).toMatchObject({ manualPick: true, invalid: 'malformed_answer', rejudged: { outcome: 'manual_pick' } });
      expect(published(w)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});

describe('required and scored criteria: code picks the winner', () => {
  const png = (id: string, body: Buffer = PNG) => ({ [`https://pbs.twimg.com/media/${id}.png`]: { body, type: 'image/png' } });
  const JOB3 = { task: 'A square image showing how a trade fee is split among its four recipients', criteria: ['Shows exactly four recipients with the right shares', 'Square image, flat style, readable text', 'Flows from one trade to the four recipients, no other brands'], deliverable: 'image' as const, amountUsdc: 0.5 };
  const thoughtCalls = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;

  it('bounty_post stores required: [1] when left out, one or two numbers when given, and refuses a number past the criteria, a repeat, none and three', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: withBounties({ maxOpen: 5 }), runtime: restingRuntime });
      const raw = agent.config;
      expect((await postJob(w, agent, raw, 'act-1', JOB3)).kind).toBe('completed');
      expect((await postJob(w, agent, raw, 'act-2', { ...JOB3, task: TASK2, required: [3, 1] })).kind).toBe('completed');
      expect((await postJob(w, agent, raw, 'act-3', { ...JOB_INPUT, task: TASK3, required: [2] })).kind).toBe('completed');
      const jobs = await jobsOf(w);
      const byAction = (id: string) => jobs.find((j) => j.actionId === id)!;
      expect(byAction('act-1').required).toEqual([1]);
      expect(byAction('act-2').required).toEqual([1, 3]);
      expect(byAction('act-3').required).toEqual([2]);
      // out of range for this job (two criteria), a repeat: refused by code with the reason; nothing drafted
      const past = await postJob(w, agent, raw, 'act-4', { ...JOB_INPUT, task: TASK4, required: [3] });
      expect(past).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^bounty_required_out_of_range: .*from 1 to 2 for this job/) });
      const twice = await postJob(w, agent, raw, 'act-5', { ...JOB_INPUT, task: TASK4, required: [1, 1] });
      expect(twice).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^bounty_required_out_of_range/) });
      // not a list of one or two whole numbers from 1 to 4: refused as an invalid call before any check
      for (const [i, required] of [[], [1, 2, 3], [0], [5], [1.5], 'first'].entries()) {
        const bad = await postJob(w, agent, raw, `act-bad-${i}`, { ...JOB_INPUT, task: TASK4, required });
        expect(bad.kind, JSON.stringify(required)).toBe('failed');
      }
      expect(await jobsOf(w)).toHaveLength(3);
      // the public view, the agent's own list and the judge's input all read the stored numbers
      const views = await bountyJobViewsOf(w);
      expect(views.find((v) => v.id === byAction('act-2').id)).toMatchObject({ required: [1, 3], criteria: JOB3.criteria });
      const list = (await executeAction(w.ctx, agent, configOf(raw), pending('act-list', 'bounty_list', {}), env())) as { result: { jobs: { jobId: string; required: number[] }[] } };
      expect(list.result.jobs.find((j) => j.jobId === byAction('act-3').id)!.required).toEqual([2]);
    } finally {
      await w.close();
    }
  });

  it('a job that stored no required criteria (every job from before the split) reads as [1], on the row, the page and the judge\'s input', async () => {
    const w = await makeWorld({ script: [judgeAnswer({ winner: null, perCriterion: { '1': ['fail', 'pass', 'pass'] }, reason: 'Three recipients, not four.' })] });
    try {
      const agent = await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
      await postJob(w, agent, agent.config, 'act-1', { ...JOB3, required: [2, 3] });
      const [job] = await jobsOf(w);
      await w.db.update(bountyJobs).set({ required: null }).where(eq(bountyJobs.id, job!.id));
      const [old] = await jobsOf(w);
      expect(old!.required).toBeNull();
      expect(requiredOfJob(old!)).toEqual([1]);
      expect((await bountyJobViewsOf(w))[0]).toMatchObject({ required: [1] });
      // malformed stored values read as [1] too
      for (const bad of [[], [4], [1, 2, 3], [0]]) expect(requiredOfJob({ required: bad, criteria: JOB3.criteria })).toEqual([1]);
      serveReplies(w, [reply('7001', '31')]);
      serveArtefacts(w, png('7001'));
      w.setNow(T0 + 6 * H + 1);
      await sweepBounties(w.ctx);
      const asked = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))[0] as unknown as { body: { messages: { content: { text?: string }[] }[] } };
      const data = JSON.parse(asked.body.messages[1]!.content[0]!.text!) as { requiredCriteria: number[]; criteria: { kind: string }[] };
      expect(data.requiredCriteria).toEqual([1]);
      expect(data.criteria.map((c) => c.kind)).toEqual(['required', 'scored', 'scored']);
      // entry 1 fails the required criterion: no winner, though it passes the two scored ones
      expect((await jobsOf(w))[0]).toMatchObject({ status: 'no_winner' });
      expect((await jobsOf(w))[0]!.verdict).toMatchObject({ winner: null, required: [1], reason: 'Three recipients, not four.', reasonBy: 'judge' });
    } finally {
      await w.close();
    }
  });

  it('the judge marks, code picks: the model names nobody, the marks give the earlier of two tied entries, and the proposal carries a reason written by code', async () => {
    // entry 1 fails the required criterion; 2 and 3 pass it and tie on two passes; the model, reading the old way, names nobody
    const marks = { '1': ['fail', 'pass', 'pass'], '2': ['pass', 'fail', 'pass'], '3': ['pass', 'pass', 'fail'] };
    const w = await makeWorld({ script: [judgeAnswer({ winner: null, perCriterion: marks, reason: 'No entry met every criterion.' })] });
    try {
      const agent = await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
      await postJob(w, agent, agent.config, 'act-1', JOB3);
      serveReplies(w, [reply('7001', '31'), reply('7002', '32', { text: `entry two ${ADDR_B}` }), reply('7003', '33', { text: `entry three ${ADDR_C}` })]);
      serveArtefacts(w, { ...png('7001'), ...png('7002', PNG2), ...png('7003', Buffer.concat([PNG, Buffer.from([3])])) });
      w.setNow(T0 + 6 * H + 1);
      expect(await sweepBounties(w.ctx)).toMatchObject({ judged: 1 });
      const [job] = await jobsOf(w);
      expect(job).toMatchObject({ status: 'proposed', payee: ADDR_B, approvalId: payoutApprovalId(job!.id) });
      expect(job!.verdict).toMatchObject({ winner: 2, modelWinner: null, required: [1], reasonBy: 'code', reason: 'Entry 2 met the required criterion and 2 of 3 overall.', perCriterion: marks });
      expect(thoughtCalls(w)).toBe(1);
      // nothing closed the job in public; the creator's item shows the criteria, which are required, and the winner's marks
      expect(published(w)).toHaveLength(1);
      const queue = (await (await api(w).get(`/internal/agents/${AGENT_ID}/approvals`)).json()) as { items: Record<string, unknown>[] };
      expect(queue.items[0]).toMatchObject({ kind: 'bounty_payout', bounty: { kind: 'payout', payee: ADDR_B, reason: 'Entry 2 met the required criterion and 2 of 3 overall.', criteria: JOB3.criteria, required: [1], winner: 2, marks: ['pass', 'fail', 'pass'], entryUrl: 'https://x.com/i/status/7002' } });
      expect(JSON.stringify(queue.items[0])).not.toContain('No entry met every criterion');
      // the creator pays: the reply under entry 2 carries code's reason, which passes the publish gate
      const paid = await api(w).post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(job!.id)}`, { decision: 'approve', by: CREATOR, txHash: TX });
      expect(paid.status).toBe(200);
      const said = published(w).find((p) => p.actionId === `bounty:${job!.id}:paid`)!;
      expect(said).toMatchObject({ replyTo: '7002' });
      expect(said.text).toContain('Why: Entry 2 met the required criterion and 2 of 3 overall.');
    } finally {
      await w.close();
    }
  });

  it('with two required criteria an entry must pass both; the review item of a job text shows which are required', async () => {
    const marks = { '1': ['pass', 'fail', 'pass'], '2': ['pass', 'pass', 'fail'] };
    const w = await makeWorld({ script: [judgeAnswer({ winner: 1, perCriterion: marks, reason: 'The right shares and a clean flow.' })] });
    try {
      const agent = await seedAgent(w, { runtime: restingRuntime });
      const raw = withBounties({ review: true });
      await postJob(w, agent, raw, 'act-1', { ...JOB3, required: [1, 2] });
      const { get, post } = api(w);
      const queue = (await (await get(`/internal/agents/${AGENT_ID}/approvals`)).json()) as { items: Record<string, unknown>[] };
      expect(queue.items[0]).toMatchObject({ kind: 'bounty_job', bounty: { kind: 'job', criteria: JOB3.criteria, required: [1, 2] } });
      expect((await post(`/internal/agents/${AGENT_ID}/approvals/act-1`, { decision: 'approve', by: CREATOR })).status).toBe(200);
      serveReplies(w, [reply('7001', '31'), reply('7002', '32', { text: `entry two ${ADDR_B}` })]);
      serveArtefacts(w, { ...png('7001'), ...png('7002', PNG2) });
      w.setNow(T0 + 6 * H + 1);
      await sweepBounties(w.ctx);
      const [job] = await jobsOf(w);
      // the model named entry 1, which fails required criterion 2; entry 2 passes both
      expect(job).toMatchObject({ status: 'proposed', payee: ADDR_B });
      expect(job!.verdict).toMatchObject({ winner: 2, modelWinner: 1, required: [1, 2], reasonBy: 'code', reason: 'Entry 2 met the required criteria and 2 of 3 overall.' });
    } finally {
      await w.close();
    }
  });
});

describe('a job that closed with no winner under the every-criterion rule is ruled again from its stored marks', () => {
  /** The platform agent's fee-split job as production holds it: seven entries, a ruling that stood, nobody passing all three. */
  const PROD_JOB = '0x42996a0622a79ed5409bb252214cf2688e33e4c53fce96412984226f722934e0';
  const PROD_MARKS = { '1': ['fail', 'fail', 'pass'], '2': ['pass', 'fail', 'pass'], '3': ['pass', 'fail', 'pass'], '4': ['fail', 'fail', 'fail'], '5': ['fail', 'fail', 'fail'], '6': ['fail', 'fail', 'fail'], '7': ['fail', 'fail', 'fail'] };
  const CRITERIA = ['Shows exactly four recipients with the right shares', 'Square image, flat or hand-drawn style, readable text', 'Flows from one trade to the four recipients, no other brands'];
  const JUDGED = Date.parse('2026-11-23T07:32:00Z');
  const NOW = Date.parse('2026-11-23T17:00:00Z');
  const payeeOf = (n: number) => `0x${String(n).repeat(40)}`;
  const thoughtCalls = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
  const fetches = (w: TestWorld) => w.inference.calls.length;

  /** A closed job written straight to the rows, as the code before the split left it: `no_winner`, its close already said in public. */
  async function closedJob(w: TestWorld, over: { id?: string; marks?: Record<string, string[]>; verdict?: Record<string, unknown>; closedAt?: number; error?: string | null; entries?: number; payees?: Record<number, string | null>; required?: number[] | null; closeReplyId?: string | null } = {}) {
    const id = over.id ?? PROD_JOB;
    const closedAt = new Date(over.closedAt ?? JUDGED);
    const marks = over.marks ?? PROD_MARKS;
    const n = over.entries ?? 7;
    await w.db.insert(bountyJobs).values({
      id,
      agentId: AGENT_ID,
      actionId: `act-${id.slice(2, 10)}`,
      nonce: 1,
      task: 'A square image that shows how one trade fee is split among its four recipients',
      criteria: CRITERIA,
      required: over.required ?? null,
      deliverable: 'image',
      amountMicroUsdc: '500000',
      status: 'no_winner',
      createdAt: new Date(closedAt.getTime() - 7 * H),
      openedAt: new Date(closedAt.getTime() - 7 * H),
      closesAt: new Date(closedAt.getTime() - H),
      postId: '9001',
      conversationId: '9001',
      pageText: 'Bounty: ...',
      verdict: { winner: null, perCriterion: marks, reason: 'No entry met every criterion.', deliveryHash: 'ab'.repeat(32), reasonHash: 'cd'.repeat(32), judgedAt: closedAt.toISOString(), thought: { key: judgeKey(AGENT_ID, id), model: 'openai/gpt-4.1-mini', outcome: 'ok', replayed: false, chargedMicroUsdc: '7000' }, ...over.verdict },
      judgedAt: closedAt,
      closeReplyId: over.closeReplyId === undefined ? '9990' : over.closeReplyId,
      entriesReceived: n,
      entriesEligible: n,
      entriesConsidered: n,
      closedAt,
      error: over.error ?? null,
      updatedAt: closedAt,
    });
    await w.db.insert(bountyEntries).values(
      [...Array(n)].map((_, i) => ({
        id: `${id}:${7001 + i}`,
        jobId: id,
        agentId: AGENT_ID,
        replyId: String(7001 + i),
        authorId: String(31 + i),
        receivedAt: new Date(closedAt.getTime() - 6 * H + i * 60_000),
        kind: 'image' as const,
        artefact: { url: `https://pbs.twimg.com/media/${7001 + i}.png`, sha256: String(i + 1).repeat(64) },
        payee: over.payees && i + 1 in over.payees ? over.payees[i + 1]! : payeeOf(i + 1),
        eligible: true,
        considered: true,
        n: i + 1,
        createdAt: closedAt,
      })),
    );
    return id;
  }
  const jobOf = async (w: TestWorld, id: string) => (await w.db.select().from(bountyJobs).where(eq(bountyJobs.id, id)))[0]!;
  const queueOf = async (w: TestWorld) => w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID));

  it('job 0x42996a06 of production (marks as stored, judged 2026-11-23 07:32 UTC) becomes a payout proposal for entry 2, from the marks alone: no thought, no fetch, no public reply, once', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
      const id = await closedJob(w);
      w.setNow(NOW);
      expect(await sweepBounties(w.ctx)).toMatchObject({ reruled: 1 });
      const job = await jobOf(w, id);
      // entries 2 and 3 pass the required criterion (the first) with two passes each; entry 2 came in first
      expect(job).toMatchObject({ status: 'proposed', payee: payeeOf(2), approvalId: payoutApprovalId(id), error: null, closeReplyId: '9990' });
      expect(job.closedAt!.getTime()).toBe(NOW);
      expect(job.judgedAt!.getTime()).toBe(JUDGED);
      expect(job.verdict).toMatchObject({
        winner: 2,
        perCriterion: PROD_MARKS,
        reason: 'Entry 2 met the required criterion and 2 of 3 overall.',
        reasonBy: 'code',
        required: [1],
        deliveryHash: 'ab'.repeat(32),
        rerule: { at: new Date(NOW).toISOString(), outcome: 'proposed', required: [1], was: { winner: null, reason: 'No entry met every criterion.', reasonHash: 'cd'.repeat(32) } },
      });
      expect(job.verdict).not.toHaveProperty('invalid');
      expect(reasonProblem((job.verdict as { reason: string }).reason)).toBeNull();
      // the proposal is an ordinary payout item: the payee is entry 2's own row's, the reason is code's
      const queue = await queueOf(w);
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ id: payoutApprovalId(id), kind: 'bounty_payout', status: 'pending_approval', meta: { bounty: 'payout', jobId: id, payee: payeeOf(2), replyId: '7002', entryUrl: 'https://x.com/i/status/7002', winner: 2, marks: ['pass', 'fail', 'pass'], criteria: CRITERIA, required: [1], reason: 'Entry 2 met the required criterion and 2 of 3 overall.' } });
      // nothing was asked of any model, nothing was fetched, nothing was said in public
      expect(thoughtCalls(w)).toBe(0);
      expect(fetches(w)).toBe(0);
      expect(published(w)).toHaveLength(0);
      // once: the next sweeps change nothing and make no second item
      const stamp = job.updatedAt.getTime();
      w.setNow(NOW + 20 * 60_000);
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('reruled');
      expect((await jobOf(w, id)).updatedAt.getTime()).toBe(stamp);
      expect(await reruleJob(w.ctx, (await w.db.query.agents.findFirst())!, await jobOf(w, id))).toBeNull();
      expect(await queueOf(w)).toHaveLength(1);
      // the page shows a proposed payment to entry 2
      const [view] = await bountyJobViewsOf(w);
      expect(view).toMatchObject({ status: 'proposed', required: [1], verdict: { winner: 2, winningEntryUrl: 'https://x.com/i/status/7002', invalid: null }, payment: { status: 'proposed', payee: payeeOf(2) } });
      // the creator pays by hand: the paid reply goes under entry 2 with code's reason, and the job is paid
      const paid = await api(w).post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(id)}`, { decision: 'approve', by: CREATOR, txHash: TX });
      expect(paid.status).toBe(200);
      expect(await jobOf(w, id)).toMatchObject({ status: 'paid', txHash: TX, payee: payeeOf(2) });
      const said = published(w).find((p) => p.actionId === `bounty:${id}:paid`)!;
      expect(said).toMatchObject({ replyTo: '7002' });
      expect(said.text).toContain('Why: Entry 2 met the required criterion and 2 of 3 overall.');
      expect(thoughtCalls(w)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('is ruled all the same when the row still carries the error of a collection tried again (job 0x42996a06 kept sender:x_http_402), and the proposal clears it', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
      const id = await closedJob(w, { error: 'sender:x_http_402', verdict: { rejudged: { at: '2026-11-23T07:32:18.323Z', outcome: 'no_winner' } } });
      w.setNow(NOW);
      expect(await sweepBounties(w.ctx)).toMatchObject({ reruled: 1 });
      expect(await jobOf(w, id)).toMatchObject({ status: 'proposed', payee: payeeOf(2), error: null });
      expect(await queueOf(w)).toHaveLength(1);
      expect(thoughtCalls(w)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('a job closed long before the proposal gets its full 48 hours from the re-rule, expires like any proposal, and a decline closes it without a second public close; neither is ruled again', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w, { config: withBounties({ maxOpen: 5 }), runtime: restingRuntime });
      // closed six days ago: far past the 48 hours a proposal has, inside the seven days of the re-rule
      const a = await closedJob(w, { closedAt: NOW - 6 * 24 * H });
      const b = await closedJob(w, { id: `0x${'b'.repeat(64)}`, closedAt: NOW - 6 * 24 * H });
      w.setNow(NOW);
      expect(await sweepBounties(w.ctx)).toMatchObject({ reruled: 2, expired: 0 });
      expect(await jobOf(w, a)).toMatchObject({ status: 'proposed' });
      // declined: closed unpaid as a declined payout is; the close already said in public is not said again
      const declined = await api(w).post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(a)}`, { decision: 'reject', by: CREATOR, note: 'no' });
      expect(declined.status).toBe(200);
      expect(await jobOf(w, a)).toMatchObject({ status: 'no_winner', error: 'declined by the creator', closeReplyId: '9990' });
      expect(published(w)).toHaveLength(0);
      w.setNow(NOW + 47 * H);
      expect(await sweepBounties(w.ctx)).toMatchObject({ expired: 0 });
      expect(await jobOf(w, b)).toMatchObject({ status: 'proposed' });
      w.setNow(NOW + 48 * H + 1);
      const report = await sweepBounties(w.ctx);
      expect(report).toMatchObject({ expired: 1 });
      expect(report).not.toHaveProperty('reruled');
      expect(await jobOf(w, b)).toMatchObject({ status: 'expired', closeReplyId: '9990' });
      expect((await queueOf(w)).map((r) => r.status).sort()).toEqual(['rejected', 'rejected']);
      expect(await jobOf(w, a)).toMatchObject({ status: 'no_winner', error: 'declined by the creator' });
      expect(published(w)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('is left alone: a job closed more than seven days ago, a verdict that did not stand, a payout the creator declined, a job with no entries', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
      const hex = (c: string) => `0x${c.repeat(64)}`;
      const old = await closedJob(w, { id: hex('1'), closedAt: NOW - RERULE_WINDOW_MS - 60_000 });
      // refused in code (both thoughts used, so it is not judged again either), judged by nobody, a winner with no address
      const malformed = await closedJob(w, { id: hex('2'), verdict: { invalid: 'malformed_answer', thoughts: [{ key: 'a' }, { key: 'b' }] } });
      const absent = await closedJob(w, { id: hex('3'), verdict: { invalid: 'judge_absent', perCriterion: {} } });
      const oldRule = await closedJob(w, { id: hex('4'), verdict: { invalid: 'winner_not_passing' } });
      // a payout the creator declined keeps its winner and says why it closed
      const declined = await closedJob(w, { id: hex('5'), verdict: { winner: 2 }, error: 'declined by the creator' });
      const before = await Promise.all([old, malformed, absent, oldRule, declined].map((id) => jobOf(w, id)));
      w.setNow(NOW);
      const report = await sweepBounties(w.ctx);
      expect(report).not.toHaveProperty('reruled');
      expect(report).not.toHaveProperty('rejudged');
      for (const row of before) {
        const after = await jobOf(w, row.id);
        expect(after.status, row.id).toBe('no_winner');
        expect(after.verdict, row.id).toEqual(row.verdict);
        expect(after.updatedAt.getTime(), row.id).toBe(row.updatedAt.getTime());
      }
      expect(await queueOf(w)).toHaveLength(0);
      expect(thoughtCalls(w)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('marks, once, a job its marks still give no winner, one whose marks are not whole and one whose winner has no address; none is proposed and none is asked again', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
      const hex = (c: string) => `0x${c.repeat(64)}`;
      // nobody passes the required criterion
      const none = await closedJob(w, { id: hex('1'), entries: 2, marks: { '1': ['fail', 'pass', 'pass'], '2': ['insufficient_evidence', 'pass', 'pass'] } });
      // a row of marks short of a criterion, marks for an entry the job does not have, a mark that is no mark
      const short = await closedJob(w, { id: hex('2'), entries: 2, marks: { '1': ['pass', 'pass'], '2': ['pass', 'pass', 'pass'] } });
      const stray = await closedJob(w, { id: hex('3'), entries: 2, marks: { '1': ['pass', 'fail', 'fail'], '9': ['pass', 'pass', 'pass'] } });
      const word = await closedJob(w, { id: hex('4'), entries: 2, marks: { '1': ['pass', 'yes', 'fail'], '2': ['fail', 'fail', 'fail'] } });
      // the entry the marks pick left no address on its row
      const noPayee = await closedJob(w, { id: hex('5'), entries: 2, marks: { '1': ['pass', 'pass', 'fail'], '2': ['pass', 'fail', 'fail'] }, payees: { 1: null } });
      // the job stored its own required criteria: entry 2 passes criterion 1 but not the required 2
      const stored = await closedJob(w, { id: hex('6'), entries: 2, required: [2], marks: { '1': ['fail', 'fail', 'pass'], '2': ['pass', 'fail', 'pass'] } });
      w.setNow(NOW);
      for (let i = 0; i < 3; i++) expect(await sweepBounties(w.ctx)).not.toHaveProperty('reruled');
      const outcome = async (id: string) => ((await jobOf(w, id)).verdict as { rerule?: { outcome: string; at: string } }).rerule;
      expect(await outcome(none)).toMatchObject({ outcome: 'no_winner', at: new Date(NOW).toISOString() });
      expect(await outcome(short)).toMatchObject({ outcome: 'marks_incomplete' });
      expect(await outcome(stray)).toMatchObject({ outcome: 'marks_incomplete' });
      expect(await outcome(word)).toMatchObject({ outcome: 'marks_incomplete' });
      expect(await outcome(noPayee)).toMatchObject({ outcome: 'winner_without_payee' });
      expect(await outcome(stored)).toMatchObject({ outcome: 'no_winner', required: [2] });
      for (const id of [none, short, stray, word, noPayee, stored]) {
        const row = await jobOf(w, id);
        expect(row).toMatchObject({ status: 'no_winner', payee: null, approvalId: null });
        expect((row.verdict as { winner: unknown }).winner).toBeNull();
        // marked in one sweep and never touched again
        expect(row.updatedAt.getTime()).toBe(NOW);
        expect(await reruleJob(w.ctx, agent, row)).toBeNull();
      }
      expect(await queueOf(w)).toHaveLength(0);
      expect(published(w)).toHaveLength(0);
      expect(thoughtCalls(w)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('an own-agent coin\'s job is ruled again the same way: from the marks its creator\'s client gave, with no thought', async () => {
    const w = await makeWorld();
    try {
      const base = withBounties();
      await seedAgent(w, { config: { ...base, runner: 'own' }, runtime: restingRuntime });
      const id = await closedJob(w, { entries: 3, marks: { '1': ['fail', 'pass', 'pass'], '2': ['pass', 'pass', 'fail'], '3': ['pass', 'pass', 'pass'] }, verdict: { thought: { key: judgeKey(AGENT_ID, PROD_JOB), model: 'own-agent', outcome: 'none', replayed: false, chargedMicroUsdc: null } } });
      w.setNow(NOW);
      expect(await sweepBounties(w.ctx)).toMatchObject({ reruled: 1 });
      expect(await jobOf(w, id)).toMatchObject({ status: 'proposed', payee: payeeOf(3) });
      expect((await jobOf(w, id)).verdict).toMatchObject({ winner: 3, reason: 'Entry 3 met the required criterion and 3 of 3 overall.', rerule: { outcome: 'proposed' } });
      expect(thoughtCalls(w)).toBe(0);
    } finally {
      await w.close();
    }
  });
});

describe('the payout post', () => {
  it('is the fixed template, fits a 280-character account by dropping the entry link and then cutting the task, and passes the platform agent\'s gate', () => {
    const txUrl = `https://basescan.org/tx/${TX}`;
    const entryUrl = 'https://x.com/i/status/1990000000000000001';
    const text = payoutPostText({ task: 'A square image showing how a trade fee is split, with the labels creator, agent and platform', amountMicroUsdc: 500_000n, txUrl, entryUrl, limit: 4000 });
    expect(text).toBe(`Bounty paid: 0.5 USDC to the winning entry. The job: A square image showing how a trade fee is split, with the labels creator, agent and platform. Payment: ${txUrl} Entry: ${entryUrl}`);
    // a task that ends its own sentence gets no second full stop; no entry on record, no entry link
    expect(payoutPostText({ task: 'Compare two pools.', amountMicroUsdc: '1000000', txUrl, limit: 4000 })).toBe(`Bounty paid: 1 USDC to the winning entry. The job: Compare two pools. Payment: ${txUrl}`);
    const short = payoutPostText({ task: 'A square image showing how a trade fee is split, with the labels creator, agent and platform', amountMicroUsdc: 500_000n, txUrl, entryUrl, limit: 280 });
    expect([...short].length).toBeLessThanOrEqual(280);
    expect(short).toBe(`Bounty paid: 0.5 USDC to the winning entry. The job: A square image showing how a trade fee is split, with the labels creator, agent and platform. Payment: ${txUrl}`);
    const cut = payoutPostText({ task: `A square image showing ${'many things and '.repeat(12)}a dot`, amountMicroUsdc: 500_000n, txUrl, entryUrl, limit: 280 });
    expect([...cut].length).toBeLessThanOrEqual(280);
    expect(cut).toMatch(/^Bounty paid: 0\.5 USDC to the winning entry\. The job: A square image showing many things .*… Payment: https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}$/);
    // the launchpad's own account: the amount, the explorer link and the entry link are all allowed, nobody is named
    for (const t of [text, short, cut]) {
      expect(postFinding(t, [], 'original', false, { platform: true, publicAddresses: [TOKEN, KERNEL] })).toBeNull();
      expect(t).not.toContain('@');
    }
  });

  it('waits for the sweep when the agent cannot post at the moment of the approval, goes out once, and a refused post is final', async () => {
    const verdict = { winner: 1, perCriterion: { '1': ['pass', 'pass'] }, reason: 'A single round dot in a small red hat.' };
    const w = await makeWorld({ script: [judgeAnswer(verdict), judgeAnswer(verdict)] });
    try {
      const agent = await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
      await postJob(w, agent, agent.config);
      const [job] = await jobsOf(w);
      serveReplies(w, [reply('7001', '31')]);
      serveArtefacts(w, { 'https://pbs.twimg.com/media/7001.png': { body: PNG, type: 'image/png' } });
      w.setNow(T0 + 6 * H + 1);
      await sweepBounties(w.ctx);
      // the day's X quota is used up when the creator approves: the payment is recorded, the post is owed
      w.sender.quotaExceeded = new Date(w.ctx.now() + H).toISOString();
      const paid = await api(w).post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(job!.id)}`, { decision: 'approve', by: CREATOR, txHash: TX });
      expect(paid.status).toBe(200);
      expect((await jobsOf(w))[0]).toMatchObject({ status: 'paid', txHash: TX, payoutPostId: null, payoutPostError: null });
      expect(published(w)).toHaveLength(1);
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('announced');
      w.sender.quotaExceeded = null;
      expect(await sweepBounties(w.ctx)).toMatchObject({ announced: 1 });
      const done = (await jobsOf(w))[0]!;
      expect(done.payoutPostId).toBe('9002');
      expect(published(w).at(-1)).toMatchObject({ actionId: `bounty:${job!.id}:payout`, text: `Bounty paid: 0.5 USDC to the winning entry. The job: ${JOB_INPUT.task}. Payment: https://sepolia.basescan.org/tx/${TX} Entry: https://x.com/i/status/7001` });
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('announced');
      expect(published(w)).toHaveLength(2);
      // a post the sender refuses is not tried again, and one older than the window is never made
      w.setNow(T0 + 7 * H);
      await postJob(w, agent, agent.config, 'act-post-2', { ...JOB_INPUT, task: TASK2 });
      const second = (await jobsOf(w)).find((j) => j.actionId === 'act-post-2')!;
      serveReplies(w, [reply('7101', '41', { text: `another entry ${ADDR_B}`, createdAt: new Date(T0 + 8 * H).toISOString() })]);
      serveArtefacts(w, { 'https://pbs.twimg.com/media/7101.png': { body: PNG2, type: 'image/png' } });
      w.setNow(T0 + 13 * H + 1);
      await sweepBounties(w.ctx);
      w.sender.publishError = 'http_403(403): You are not permitted to perform this action';
      expect((await api(w).post(`/internal/agents/${AGENT_ID}/approvals/${payoutApprovalId(second.id)}`, { decision: 'approve', by: CREATOR, txHash: TX })).status).toBe(200);
      expect((await jobsOf(w)).find((j) => j.id === second.id)).toMatchObject({ status: 'paid', payoutPostId: null, payoutPostError: expect.stringMatching(/^sender_rejected:http_403/) });
      w.sender.publishError = null;
      const before = published(w).length;
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('announced');
      await w.db.update(bountyJobs).set({ payoutPostError: null, paidAt: new Date(w.ctx.now() - 49 * H) }).where(eq(bountyJobs.id, second.id));
      expect(await sweepBounties(w.ctx)).not.toHaveProperty('announced');
      expect(published(w)).toHaveLength(before);
    } finally {
      await w.close();
    }
  });
});

describe('what a job may ask for', () => {
  const image = (task: string, criteria: string[] = ['It is square', 'The three labels are in it']) => taskRuleProblem({ task, criteria, deliverable: 'image' });
  const link = (task: string, criteria: string[] = ['It has 20 rows', 'Every row has the three columns']) => taskRuleProblem({ task, criteria, deliverable: 'link' });

  it('refuses a web page, a site, an app or an article as the work, for either deliverable', () => {
    // the three jobs the platform agent posted at 0.30 USDC, each with zero entries
    expect(link('A public web page that explains how fee splits work on Base')).toMatch(/^bounty_asks_to_build: the task asks for "web page" as the thing to hand in; a job never asks a stranger to build, design, write or publish a web page, a site, an app or an article/);
    expect(link('A short public page that lists this coin\'s milestones from its launch to today, with dates')).toMatch(/^bounty_asks_to_build/);
    expect(link('A simple website about agent coins on Base')).toMatch(/^bounty_asks_to_build/);
    expect(link('An article on how session keys bound an agent, with sources and data')).toMatch(/^bounty_asks_to_build/);
    expect(link('Build a small dashboard of Base token launches with a table')).toMatch(/^bounty_asks_to_build: the task says "Build a small dashboard"/);
    expect(image('Design a landing page for the coin and send a screenshot of it')).toMatch(/^bounty_asks_to_build: the task says "Design a landing page"/);
    expect(image('Write a short article about Base fees and screenshot it as one image')).toMatch(/^bounty_asks_to_build: the task says "Write a short article"/);
    expect(image('A square image of a dot in a hat', ['It is square', 'You also publish a thread about it'])).toMatch(/^bounty_asks_to_build: the criterion 2 says "publish a thread"/);
    // a link job has to name data
    expect(link('Something useful about Base that we can cite later on')).toMatch(/^bounty_link_needs_data/);
  });

  it('accepts a picture and data that exists or is quick to put together', () => {
    expect(link('A CSV of the 20 largest Base token launches this week with name, address and launch block')).toBeNull();
    expect(link('A Dune query that returns the number of new Base tokens per day for the last 30 days')).toBeNull();
    expect(link('A gist with the list of Base apps that take x402 payments and the source for each')).toBeNull();
    expect(link('The transaction in which the first Clanker v5 coin was launched on Base, with its source')).toBeNull();
    expect(link('A sheet of the ten largest Base pools by volume with name and volume')).toBeNull();
    expect(image('A square image showing how a trade fee is split, with the labels creator, agent and platform')).toBeNull();
    // a picture may show a page or an app: it is not asked to build one
    expect(image('A square diagram showing how the app sends a fee to the agent wallet')).toBeNull();
    expect(image('A hand-drawn map of how a fee becomes a burn')).toBeNull();
    // every example the treasury turn is shown passes the rules it is shown them for
    for (const example of BOUNTY_GOOD_JOBS) {
      const task = /"([^"]+)"/.exec(example)![1]!;
      expect(taskRuleProblem({ task, criteria: ['It has 20 rows'], deliverable: example.includes('deliverable link') ? 'link' : 'image' }), task).toBeNull();
    }
  });

  it('wants a task that names its subject and criteria a judge can check', () => {
    expect(image('A cool picture')).toMatch(/^bounty_task_too_vague: the task is 3 words/);
    expect(image('A square image of a dot in a hat', ['It looks good'])).toMatch(/^bounty_criterion_not_checkable: criterion 1 says "good"/);
    expect(image('A square image of a dot in a hat', ['It is square', 'High quality and creative'])).toMatch(/^bounty_criterion_not_checkable: criterion 2 says "High quality"/);
    expect(image('A square image of a dot in a hat', ['It is square', 'The hat is red'])).toBeNull();
  });

  it('knows a reworded job from a different one', () => {
    expect(sameJob('A square image showing how a trade fee is split, with the labels creator, agent and platform', 'An image that explains how the trade fee is split between creator, agent and platform')).toBe(true);
    expect(sameJob('A public web page that explains how Base fees are set', 'A page explaining how fees on Base are set')).toBe(true);
    expect(sameJob('A square picture of a dot wearing a tiny hat, flat colours', 'A square picture of a dot that wears a tiny hat, flat colours please')).toBe(true);
    expect(sameJob('A square picture of a dot wearing a tiny hat, flat colours', TASK2)).toBe(false);
    expect(sameJob('A CSV of the 20 largest Base token launches this week with name, address and launch block', 'A Dune query that returns the number of new Base tokens per day for the last 30 days')).toBe(false);
  });

  it('bounty_post refuses a web page job and a job the agent asked in the last 30 days, naming the earlier one and how it ended; the lists show what drew no entries', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: withBounties(), runtime: restingRuntime });
      const raw = agent.config;
      const page = await postJob(w, agent, raw, 'a-page', { task: 'A public web page that explains how fee splits work on Base', criteria: ['It names the three parties'], deliverable: 'link', amountUsdc: 0.3 });
      expect(page).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^bounty_asks_to_build/) });
      expect(published(w)).toHaveLength(0);
      expect(await jobsOf(w)).toHaveLength(0);
      expect(await postJob(w, agent, raw)).toMatchObject({ kind: 'completed', result: { status: 'open' } });
      const [first] = await jobsOf(w);
      // the same work in other words, while the first is open
      const reworded = { ...JOB_INPUT, task: 'A square picture of a dot that wears a tiny hat, flat colours please' };
      const repeat = (await postJob(w, agent, raw, 'a-rep', reworded)) as { kind: string; error: string };
      expect(repeat.kind).toBe('failed');
      expect(repeat.error).toBe(`bounty_repeats_earlier_job: this is substantially the job ${shortJobId(first!.id)} you posted on 2026-10-24 ("${JOB_INPUT.task}"), which is open now. A job is not asked twice inside 30 days, reworded or not: ask for different work, or post nothing`);
      expect(await jobsOf(w)).toHaveLength(1);
      // nobody enters; the job closes with no entries, and asking it again is refused with that outcome
      serveReplies(w, []);
      w.setNow(T0 + 6 * H + 1);
      await sweepBounties(w.ctx);
      expect((await jobsOf(w))[0]).toMatchObject({ status: 'no_winner', entriesReceived: 0 });
      expect(await postJob(w, agent, raw, 'a-rep-2', reworded)).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^bounty_repeats_earlier_job: .* which drew no entries\. /) });
      // both turns are shown what drew nothing
      const list = (await executeAction(w.ctx, agent, configOf(raw), pending('act-list', 'bounty_list', {}), env())) as { result: { jobs: Record<string, unknown>[]; drewNoEntries: { meaning: string; jobs: Record<string, unknown>[] } } };
      expect(list.result.jobs[0]).toMatchObject({ jobId: first!.id, outcome: 'drew no entries' });
      expect(list.result.drewNoEntries.jobs).toEqual([{ jobId: first!.id, task: JOB_INPUT.task, amountUsdc: '0.5', deliverable: 'image', postedAt: new Date(T0).toISOString() }]);
      expect(list.result.drewNoEntries.meaning).toMatch(/Do not ask for any of them again/);
      const section = (await bountiesSection(w.ctx, agent, configOf(raw))) as { bounties: { drewNoEntries: { jobs: { jobId: string }[] }; lastVerdicts: { outcome: string }[] } };
      expect(section.bounties.drewNoEntries.jobs.map((j) => j.jobId)).toEqual([first!.id]);
      expect(section.bounties.lastVerdicts[0]!.outcome).toBe('drew no entries');
      // different work is fine; a draft that never reached the public does not block its task
      expect(await postJob(w, agent, raw, 'a-other', { ...JOB_INPUT, task: TASK2 })).toMatchObject({ kind: 'completed', result: { status: 'open' } });
      // 31 days on the first task may be asked again, and the list of unanswered jobs no longer names it
      w.setNow(T0 + 31 * 24 * H);
      expect(await postJob(w, agent, raw, 'a-later', reworded)).toMatchObject({ kind: 'completed' });
      const later = (await executeAction(w.ctx, agent, configOf(raw), pending('act-list-2', 'bounty_list', {}), env())) as { result: Record<string, unknown> };
      expect(later.result).not.toHaveProperty('drewNoEntries');
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
