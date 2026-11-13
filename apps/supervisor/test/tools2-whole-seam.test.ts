/**
 * The agent tools of round two, whole (docs/design/agent-tools-2.md section 17.9): the four workstreams were built
 * apart and each tested its own piece against stand-ins for the others. Here they run together and through real code:
 * the supervisor's own database and tick, every route mounted (so both hooks of post-send.ts are the real ones), the
 * REAL sender app in the same process, and a fake X behind it that records what it was asked to post. A turn is a
 * hosted one (a scripted model) or an own agent's (a client calling `/internal/own/run/*` with a credential made by
 * the real grant routes).
 *
 * What is followed each time is what the rules promise at X: how many posts, under which post, with which text, and
 * what the coin's own counts say afterwards.
 */
import type { ActResult, TurnOpen } from '@bootr/shared/own-agent';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { json } from '../../sender/test/helpers.js';
import { agentActivity } from '../src/activity.js';
import { mentionNotEngaged, resetAccountChecks } from '../src/attributions.js';
import { executeAction } from '../src/broker/index.js';
import { COMMENT_LINK_FORBIDDEN, commentAuthorCap } from '../src/comment-posts.js';
import { actions, approvals, postMetrics, runtimes, scheduledPosts, whatWorks, type PostFeatures } from '../src/db/schema.js';
import { agentConfigOf } from '../src/onboarding.js';
import { switchRunner } from '../src/own/runner-switch.js';
import { publishesLast24h } from '../src/post-budget.js';
import { resetMetricsBackoff } from '../src/post-performance.js';
import { postHooks } from '../src/post-send.js';
import { recentPosts } from '../src/recent-posts.js';
import { jitterMs, slotsUsed } from '../src/rhythm.js';
import type { AgentState } from '../src/runtime.js';
import { beforeOriginalNow, postScheduledSoon } from '../src/scheduled.js';
import { sendOriginal, threadsInWindow } from '../src/thread-send.js';
import { tick } from '../src/tick.js';
import { resetWatchlistCache } from '../src/watchlist.js';
import { AGENT_ID, CREATOR, KERNEL, finishResponse, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { realEngine, RouteRefusal, withRoutes, type OwnWorld } from './own-helpers.js';
import { DAY, HOUR, POSTING_DEFAULTS, T0, brokerEnv, observed, pendingOf, storeTurn, wiredWorld, xIdAt, type WiredWorld } from './posting-helpers.js';
import { agentRow } from './scheduled-helpers.js';

const MIN = 60_000;
const INTERVAL = 2 * HOUR;
const JITTER = jitterMs(KERNEL, INTERVAL);
const iso = (ms: number) => new Date(ms).toISOString();

const PARTS = ['Fees on a Bootr coin are split at launch, and the split cannot be changed later.', 'The agent gets its share as fuel: it pays for its own thinking from it.', 'The creator gets a share too, and the platform keeps the rest.'];
const THREAD = { text: PARTS[0]!, thread: PARTS.slice(1).map((text) => ({ text })) };

type Seam = WiredWorld & Pick<OwnWorld, 'call' | 'run'>;
type ToolMessage = Record<string, unknown> & { error?: string };

/** A coin whose post slot is due, with every route mounted and every limit of the round at its default. `script` is the model's answers, in order, and may be added to between ticks. */
async function seam(opts: { script?: Response[]; config?: Record<string, string>; agent?: Record<string, unknown>; own?: boolean } = {}): Promise<Seam> {
  resetAccountChecks();
  resetWatchlistCache();
  resetMetricsBackoff();
  const wired = await wiredWorld({ script: opts.script ?? [], config: { ...POSTING_DEFAULTS, ...(opts.own ? { OWN_AGENT_ENABLED: 'true', OWN_LEASE_WAIT_MS: '0' } : {}), ...(opts.config ?? {}) } });
  await seedAgent(wired, { config: { socialStartedAt: iso(T0 - 10 * HOUR), ...(opts.own ? { runner: 'own' } : {}), ...(opts.agent ?? {}) } });
  const w = withRoutes(wired) as Seam;
  // the real send and the real "a scheduled post is due" check, as api.ts mounts them
  expect(postHooks.sendOriginal).toBe(sendOriginal);
  expect(postHooks.beforeOriginalNow).toBe(beforeOriginalNow);
  return w;
}

const thoughts = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
const requestOf = (w: TestWorld, n: number) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))[n]!.body as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };
const observationOf = (w: TestWorld, n = 0) => JSON.parse(requestOf(w, n).messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
/** The tool results the model had been given by the time of its `n`th call. */
const toldBy = (w: TestWorld, n: number): ToolMessage[] => requestOf(w, n).messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content) as ToolMessage);
const stateOf = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.state as unknown as AgentState;
const runtimeOf = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
const publishRows = async (w: TestWorld) => (await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => (r.action as { tool?: string }).tool === 'publish_post').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
const scheduledRows = async (w: TestWorld) => (await w.db.select().from(scheduledPosts).where(eq(scheduledPosts.agentId, AGENT_ID))).sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
const resultOf = (row: { result: unknown }) => (row.result as { result?: Record<string, unknown> }).result ?? (row.result as Record<string, unknown>);
const tapePosts = async (w: TestWorld) => (await agentActivity(w.ctx, await agentRow(w), await runtimeOf(w))).filter((t) => t.kind === 'post');
/** Moves both clocks to `at`. */
const at = (w: Seam, ms: number) => w.advance(ms - w.ctx.now());
const tickClean = async (w: Seam) => {
  const report = await tick(w.ctx);
  expect(report.errors).toEqual([]);
  return report;
};

let world: Seam | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

describe('a hosted turn posts a thread of three', () => {
  it('one slot, three of the day\'s posts, each post under the one before it, and one item everywhere a post is counted', async () => {
    const w = (world = await seam({ script: [toolCallResponse('publish_post', { ...THREAD, topic: 'fees' }), finishResponse(T0 + 3 * HOUR)] }));
    expect((await tickClean(w)).ran).toEqual([AGENT_ID]);

    // the turn held the tools and sections of all four workstreams at once
    const offered = requestOf(w, 0).tools.map((t) => t.function.name);
    for (const tool of ['publish_post', 'schedule_post', 'scheduled_list', 'scheduled_cancel', 'note_what_works']) expect(offered, tool).toContain(tool);
    const observation = observationOf(w);
    for (const section of ['scheduled', 'yourCoin', 'postBudget']) expect(observation, section).toHaveProperty(section);

    // X: three posts, the first an original, each later one a reply to the post before it
    const rows = await w.senderRows();
    const ids = rows.map((r) => r.providerPostId!);
    expect(w.posted()).toEqual([{ text: PARTS[0], replyTo: null }, { text: PARTS[1], replyTo: ids[0] }, { text: PARTS[2], replyTo: ids[1] }]);
    // three of the day's quota, at the sender and in the creator's budget
    expect((await w.ctx.sender.quota(AGENT_ID)).postsUsed24h).toBe(3);
    expect((await publishesLast24h(w.ctx, AGENT_ID)).count).toBe(3);
    // one slot: one action, one place in the platform's window, one step of the cadence, one thread of the day
    const [action, ...more] = await publishRows(w);
    expect(more).toEqual([]);
    expect(action!.status).toBe('completed');
    expect(resultOf(action!)).toEqual({ postId: ids[0], parts: ids.map((postId, i) => ({ n: i + 1, postId })), sent: 3, of: 3 });
    expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(1);
    expect((await stateOf(w)).lastPostAt).toBe(T0);
    expect(await threadsInWindow(w.ctx, AGENT_ID, 'none')).toBe(1);
    // the tape names it once, and "what you already said" shows every post of it
    expect((await tapePosts(w)).map((t) => [t.summary, t.url])).toEqual([['Posted a thread on X (3 posts)', `https://x.com/bootr_agent/status/${ids[0]}`]]);
    expect(await recentPosts(w.ctx, AGENT_ID)).toMatchObject([{ kind: 'post', status: 'sent', text: PARTS[0], more: [PARTS[1]!.slice(0, 80), PARTS[2]!.slice(0, 80)] }]);
    // the slot is used: nothing more is bought or posted until the next one
    at(w, T0 + 30 * MIN);
    expect((await tickClean(w)).ran).toEqual([]);
    expect(thoughts(w)).toBe(2);
    expect(w.posted()).toHaveLength(3);
  });
});

describe('a hosted turn comments on a post of an account the platform account follows', () => {
  const SOURCE = xIdAt(T0 - 2 * HOUR, 5);
  const jesse = { id: '18876842', username: 'jessepollak', name: 'Jesse Pollak', verified: true, verified_type: 'blue' };
  const COMMENT = 'Jesse Pollak makes a fair point: a holder should see where every fee went. On Bootr the coin page shows it.';

  async function platform(script: Response[]) {
    const w = await seam({ script, config: { PLATFORM_WATCHLIST: 'jessepollak' }, agent: { platform: true, requireApproval: false, token: { address: '0x3000000000000000000000000000000000000003', symbol: 'BOOTR', name: 'Bootr', chainId: 84532 } } });
    w.x.fake.on('GET', '/2/users/by/username/jessepollak', () => json({ data: jesse }));
    w.x.fake.on('GET', `/2/users/${jesse.id}/tweets`, () => json({ data: [{ id: SOURCE, text: 'A holder should be able to see where every fee went.', author_id: jesse.id, created_at: iso(T0 - 2 * HOUR) }], meta: { result_count: 1 } }));
    return w;
  }

  it('the post is its own original with `about`: the author named in words, no @ and no link, and it counts once for that author', async () => {
    const w = (world = await platform([toolCallResponse('publish_post', { text: COMMENT, about: { postId: SOURCE }, topic: 'fees' }), finishResponse(T0 + 3 * HOUR)]));
    expect((await tickClean(w)).ran).toEqual([AGENT_ID]);

    // the turn was shown the watched account's post, with words that match what the broker now takes
    const watchlist = observationOf(w).watchlist as { meaning: string; accounts: { handle: string; latestPosts: { postId: string }[] }[] };
    expect(watchlist.accounts).toMatchObject([{ handle: 'jessepollak', latestPosts: [{ postId: SOURCE }] }]);
    expect(watchlist.meaning).toContain('pass about: {postId}');
    expect(watchlist.meaning).toContain('Name the author in words, without the @, and do not link their post.');
    // ...and its pinned prompt no longer tells it to credit the author with an @handle and a link
    const system = requestOf(w, 0).messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('Name the author by name, without the @, and do not link their post');
    expect(system).not.toContain('credits the author with their @handle');

    // X: one original post, nothing that makes it a reply, a quote or a mention
    const sent = w.x.fake.calls.filter((c) => c.method === 'POST' && c.path === '/2/tweets').map((c) => c.body as Record<string, unknown>);
    expect(sent).toEqual([{ text: COMMENT }]);
    expect(COMMENT).not.toMatch(/@|https?:\/\//);
    const [row] = await publishRows(w);
    expect(resultOf(row!)).toMatchObject({ postId: expect.stringMatching(/^\d+$/), about: { postId: SOURCE, authorId: jesse.id, handle: 'jessepollak' } });
    // the tape says whose post it was about, with the link to it for the coin page (the link is not on X)
    expect(await tapePosts(w)).toMatchObject([{ summary: 'Commented on a post by @jessepollak', about: { handle: 'jessepollak', postId: SOURCE, url: `https://x.com/jessepollak/status/${SOURCE}` }, url: expect.stringMatching(/^https:\/\/x\.com\/bootr_agent\/status\/\d+$/) }]);

    // counted per author: a second comment on a post of the same account the same day is refused, whichever post it is
    const agent = await agentRow(w);
    const config = agentConfigOf(agent)!;
    await storeTurn(w, observed({ watchlist: { accounts: [{ handle: 'jessepollak', latestPosts: [{ postId: xIdAt(T0 - HOUR, 6), at: iso(T0 - HOUR) }] }] } }));
    at(w, T0 + 3 * HOUR);
    expect(await executeAction(w.ctx, agent, config, pendingOf('act-seam-again-01', 'publish_post', { text: 'One more thought on what Jesse Pollak said.', about: { postId: xIdAt(T0 - HOUR, 6) } }), brokerEnv())).toEqual({ kind: 'failed', error: commentAuthorCap(1, 'day') });
    expect(w.posted()).toHaveLength(1);
  });

  it('with an @ for the author, or a link to the post, the comment is refused in words that say what to do, and nothing is posted', async () => {
    const w = (world = await platform([]));
    const agent = await agentRow(w);
    const config = agentConfigOf(agent)!;
    await storeTurn(w, observed({ watchlist: { accounts: [{ handle: 'jessepollak', latestPosts: [{ postId: SOURCE, at: iso(T0 - 2 * HOUR) }] }] } }));
    const comment = (id: string, input: Record<string, unknown>) => executeAction(w.ctx, agent, config, pendingOf(id, 'publish_post', { about: { postId: SOURCE }, ...input }), brokerEnv());
    // Jesse Pollak never wrote to this agent: an @ would notify a stranger
    expect(await comment('act-seam-at-00001', { text: 'A fair point from @jessepollak on fees.', attributions: [{ username: 'jessepollak', sourceUrl: `https://x.com/jessepollak/status/${SOURCE}` }] })).toEqual({ kind: 'failed', error: mentionNotEngaged('jessepollak') });
    expect(await comment('act-seam-link-0001', { text: `A fair point on fees: https://x.com/jessepollak/status/${SOURCE}` })).toEqual({ kind: 'failed', error: COMMENT_LINK_FORBIDDEN });
    expect(w.posted()).toEqual([]);
    // the same thought with the name as a word goes out
    expect((await comment('act-seam-ok-000001', { text: COMMENT })).kind).toBe('completed');
    expect(w.posted()).toEqual([{ text: COMMENT, replyTo: null }]);
  });
});

describe('a hosted agent schedules two posts and the tick sends them', () => {
  const A = 'The half past twelve thought: three new holders since this morning.';
  const B = 'The afternoon note: where the fees of today went, in one line.';
  const AT_A = T0 + 30 * MIN;
  const AT_B = T0 + 2 * HOUR + 30 * MIN;

  it('each goes out once at its time through the real send, the cadence moves with each, a post sent now is refused while one is due, and no thought is bought for a slot a scheduled post took', async () => {
    const script = [toolCallResponse('schedule_post', { text: A, sendAt: iso(AT_A) }, 'call_a'), toolCallResponse('schedule_post', { text: B, sendAt: iso(AT_B), topic: 'fees' }, 'call_b'), toolCallResponse('publish_post', { text: 'And one more right now.' }, 'call_now'), finishResponse(T0 + HOUR)];
    const w = (world = await seam({ script }));
    expect((await tickClean(w)).ran).toEqual([AGENT_ID]);

    // both wait; the post sent now was refused because A holds the slot of this moment; nothing went to X
    const [rowA, rowB] = await scheduledRows(w);
    expect([rowA, rowB]).toMatchObject([{ text: A, status: 'waiting', sendAt: new Date(AT_A) }, { text: B, status: 'waiting', sendAt: new Date(AT_B), topic: 'fees' }]);
    const told = toldBy(w, 3);
    expect(told[0]).toMatchObject({ scheduledId: rowA!.id, status: 'waiting', waiting: 1, mayQueue: 5 });
    expect(told[1]).toMatchObject({ scheduledId: rowB!.id, status: 'waiting', waiting: 2, mayQueue: 4 });
    expect(told[2]!.error).toBe(postScheduledSoon(AT_A));
    expect(told[2]!.error).toBe(`post_scheduled_soon: your next post is already scheduled for ${iso(AT_A)}; nothing was posted. Replies may still go out.`);
    expect(w.posted()).toEqual([]);
    expect(thoughts(w)).toBe(4);
    // the agent's own wake is the slot after its last scheduled post, not the old slot the two posts cover
    const runtime = await runtimeOf(w);
    expect(runtime.nextAt.getTime()).toBe(AT_B + INTERVAL + JITTER);
    expect((toldBy(w, 3)).length).toBe(3);

    // before A's time nothing goes out and nobody is woken
    at(w, AT_A - MIN);
    expect((await tickClean(w)).ran).toEqual([]);
    expect(w.posted()).toEqual([]);

    // A's time: sent by the tick through the real sender, with no thought
    at(w, AT_A + 1000);
    expect((await tickClean(w)).ran).toEqual([]);
    expect(w.posted()).toEqual([{ text: A, replyTo: null }]);
    expect((await stateOf(w)).lastPostAt).toBe(AT_A + 1000);
    expect((await scheduledRows(w))[0]).toMatchObject({ status: 'sent', postId: expect.stringMatching(/^\d+$/) });
    expect((await w.senderRows()).map((r) => r.actionId)).toEqual([rowA!.id]);
    // a second tick sends nothing twice
    await tickClean(w);
    expect(w.posted()).toHaveLength(1);

    // between the two: a post sent now would land within one interval of B, so it is refused in B's name; no slot is due
    at(w, AT_A + 80 * MIN);
    const agent = await agentRow(w);
    expect(await executeAction(w.ctx, agent, agentConfigOf(agent)!, pendingOf('act-seam-now-0001', 'publish_post', { text: 'A post in between.' }), brokerEnv())).toEqual({ kind: 'failed', error: postScheduledSoon(AT_B) });
    expect((await tickClean(w)).ran).toEqual([]);
    // the old slot time (one interval and the jitter after the turn) comes and goes: B covers it, and no thought is bought
    at(w, T0 + INTERVAL + JITTER + MIN);
    expect((await tickClean(w)).ran).toEqual([]);
    expect(thoughts(w)).toBe(4);

    // B's time
    at(w, AT_B + 1000);
    expect((await tickClean(w)).ran).toEqual([]);
    expect(w.posted()).toEqual([{ text: A, replyTo: null }, { text: B, replyTo: null }]);
    expect((await stateOf(w)).lastPostAt).toBe(AT_B + 1000);
    expect(thoughts(w)).toBe(4);

    // on the record each is an ordinary post that says it was scheduled, and the tape and the day's count see two posts
    const sent = (await publishRows(w)).filter((r) => r.status === 'completed');
    expect(sent.map((r) => [r.actionId, (r.action as { scheduled?: { id: string } }).scheduled?.id, (r.action as { input: { text: string; topic?: string } }).input.text])).toEqual([[`${rowA!.id}-sent`, rowA!.id, A], [`${rowB!.id}-sent`, rowB!.id, B]]);
    expect((await tapePosts(w)).map((t) => t.summary)).toEqual(['Posted on X', 'Posted on X']);
    expect((await publishesLast24h(w.ctx, AGENT_ID)).count).toBe(2);

    // the next slot after B is the agent's own again: it is woken for it and may post
    script.push(toolCallResponse('publish_post', { text: 'The evening post, written when its slot came.' }, 'call_evening'), finishResponse(AT_B + 6 * HOUR));
    at(w, AT_B + 1000 + INTERVAL + JITTER + MIN);
    expect((await tickClean(w)).ran).toEqual([AGENT_ID]);
    expect(w.posted().map((p) => p.text)).toEqual([A, B, 'The evening post, written when its slot came.']);
  });
});

describe('the same through an own agent\'s client', () => {
  const SOURCE = xIdAt(T0 + 5 * HOUR, 7);
  const alice = { id: '4201', username: 'alice', name: 'Alice', verified: true, verified_type: 'blue' };

  it('a thread is the turn\'s one original, posts written ahead are apart from it and go out with no client and no model, a comment needs its own slot, and every post is in the day\'s counts', async () => {
    const w = (world = await seam({ own: true }));
    const client = await realEngine(w);

    // turn one: the slot is due
    expect(await client.due('social')).toMatchObject({ due: true, reasons: expect.arrayContaining(['original_post_due']) });
    const turn: TurnOpen = await client.open('social');
    for (const tool of ['bootr_agent_publish_post', 'bootr_agent_schedule_post', 'bootr_agent_scheduled_list', 'bootr_agent_scheduled_cancel']) expect(turn.tools, tool).toContain(tool);
    for (const section of ['scheduled', 'yourCoin']) expect(turn.observation, section).toHaveProperty(section);

    const thread: ActResult = await client.act('publish_post', { ...THREAD });
    expect(thread).toMatchObject({ status: 'completed', result: { sent: 3, of: 3 } });
    const ids = (await w.senderRows()).map((r) => r.providerPostId!);
    expect(w.posted()).toEqual([{ text: PARTS[0], replyTo: null }, { text: PARTS[1], replyTo: ids[0] }, { text: PARTS[2], replyTo: ids[1] }]);
    // one original per turn: the thread used the slot the turn was opened for, so a second post is refused and told when the next slot is
    const again = await client.act('publish_post', { text: 'A second original in the same turn.' });
    expect(again.status).toBe('failed');
    expect(again.error).toBe(`post_slot_not_due: an original post needs a due slot or an open request from your creator; your next slot is at ${iso(T0 + INTERVAL + JITTER)}. Replies may still go out.`);
    // posts written ahead are not that one original: two are queued in the same turn, each one interval from the last
    const first = await client.act('schedule_post', { text: 'Written this morning for the early afternoon.', sendAt: iso(T0 + INTERVAL + 10 * MIN) });
    const second = await client.act('schedule_post', { text: 'Written this morning for the late afternoon.', sendAt: iso(T0 + 2 * INTERVAL + 20 * MIN) });
    expect([first, second]).toMatchObject([{ status: 'completed', result: { status: 'waiting', waiting: 1 } }, { status: 'completed', result: { status: 'waiting', waiting: 2 } }]);
    // too close to the thread that just went out: refused with the nearest time that can be taken
    const close = await client.act('schedule_post', { text: 'Too soon after the thread.', sendAt: iso(T0 + 30 * MIN) });
    expect(close.status).toBe('failed');
    expect(close.error).toMatch(/^schedule_time: sendAt is less than one post interval \(2 hours\) after your last post; the nearest time you can take is /);
    await client.finish();
    expect(w.posted()).toHaveLength(3);

    // the creator's machine is off: the tick sends each at its time, and nobody thinks
    at(w, T0 + INTERVAL + 10 * MIN + 1000);
    await tickClean(w);
    at(w, T0 + 2 * INTERVAL + 20 * MIN + 1000);
    await tickClean(w);
    expect(w.posted().slice(3)).toEqual([{ text: 'Written this morning for the early afternoon.', replyTo: null }, { text: 'Written this morning for the late afternoon.', replyTo: null }]);
    expect(thoughts(w)).toBe(0);
    // who thought is on the record: the two rows carry the mark of the client that wrote them
    const sent = (await publishRows(w)).filter((r) => (r.action as { scheduled?: unknown }).scheduled);
    expect(sent.map((r) => (r.action as { via?: string; clientId?: string }).via)).toEqual(['own', 'own']);
    expect((await tapePosts(w)).filter((t) => t.summary.startsWith('Posted on X')).every((t) => t.summary !== 'Posted on X')).toBe(true);

    // no slot is due while a scheduled post covered it; the one after the last post is
    expect(await client.due('social')).toMatchObject({ due: false });
    at(w, T0 + 2 * INTERVAL + 20 * MIN + 1000 + INTERVAL + JITTER + MIN);
    expect(await client.due('social')).toMatchObject({ due: true });

    // turn two: read a post, then comment on it as the turn's one original
    w.x.fake.on('GET', `/2/tweets/${SOURCE}`, () => json({ data: { id: SOURCE, text: 'Fees should be on the coin page, where a holder can see them.', author_id: alice.id, conversation_id: SOURCE, created_at: iso(T0 + 5 * HOUR) }, includes: { users: [alice] } }));
    await client.open('social');
    // a post it did not read in this turn cannot be commented on
    expect(await client.act('publish_post', { text: 'A thought about a post nobody showed me.', about: { postId: SOURCE } })).toMatchObject({ status: 'failed', error: 'comment_source_unread: you can comment only on a post you read in this turn; nothing was posted.' });
    expect((await client.act('read_x_thread', { postId: SOURCE })).status).toBe('completed');
    const comment = await client.act('publish_post', { text: 'Alice is right that a holder should see the fees; on this coin the page shows them.', about: { postId: SOURCE } });
    expect(comment).toMatchObject({ status: 'completed', result: { about: { postId: SOURCE, authorId: alice.id, handle: 'alice' } } });
    const another = await client.act('publish_post', { text: 'And another original.' });
    expect(another.status).toBe('failed');
    expect(another.error).toMatch(/^post_slot_not_due: /);
    await client.finish();
    expect(w.posted()[5]).toEqual({ text: 'Alice is right that a holder should see the fees; on this coin the page shows them.', replyTo: null });

    // the day's counts: six posts at X and in the creator's budget (three of the thread, two written ahead, the comment),
    // two threads' worth of slots... one thread, one comment for its author, and two turns and their steps for the client
    expect(w.posted()).toHaveLength(6);
    expect((await w.ctx.sender.quota(AGENT_ID)).postsUsed24h).toBe(6);
    expect((await publishesLast24h(w.ctx, AGENT_ID)).count).toBe(6);
    expect(await threadsInWindow(w.ctx, AGENT_ID, 'none')).toBe(1);
    const usage = (await stateOf(w)).ownUsage!;
    const sum = (buckets: [number, number][] | undefined) => (buckets ?? []).reduce((n, [, count]) => n + count, 0);
    expect(sum(usage.turns)).toBe(2);
    expect(sum(usage.steps)).toBeGreaterThanOrEqual(11);
    expect(thoughts(w)).toBe(0);
  });

  it('the day\'s turns are counted for the coin: past the limit a turn is refused, and what was written ahead still goes out', async () => {
    const w = (world = await seam({ own: true, config: { OWN_TURNS_PER_DAY: '1' } }));
    const client = await realEngine(w);
    await client.open('social');
    expect((await client.act('schedule_post', { text: 'Written in the one turn of the day.', sendAt: iso(T0 + 3 * HOUR) })).status).toBe('completed');
    await client.finish();
    at(w, T0 + 2 * HOUR + 30 * MIN);
    const refused = await client.open('social').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(RouteRefusal);
    at(w, T0 + 3 * HOUR + 1000);
    await tickClean(w);
    expect(w.posted()).toEqual([{ text: 'Written in the one turn of the day.', replyTo: null }]);
  });
});

describe('approval mode and a thread written ahead', () => {
  const AT = T0 + HOUR;

  it('the creator is shown every post and the time, approves, and the thread goes out whole at its time and not before', async () => {
    const script = [toolCallResponse('schedule_post', { ...THREAD, sendAt: iso(AT) }), finishResponse(T0 + 3 * HOUR)];
    const w = (world = await seam({ script, agent: { requireApproval: true } }));
    await tickClean(w);
    const [row] = await scheduledRows(w);
    expect(row).toMatchObject({ status: 'waiting_review', text: PARTS[0] });
    expect(toldBy(w, 1)[0]).toMatchObject({ scheduledId: row!.id, status: 'waiting_review' });

    // the creator's list: the first post in `text`, the later ones in `thread`, the time, and when it runs out
    const path = `/internal/agents/${AGENT_ID}/approvals`;
    const list = await w.call<{ items: Record<string, unknown>[] }>('GET', path);
    expect(list.body.items).toEqual([expect.objectContaining({ id: row!.id, kind: 'post', status: 'pending_approval', text: PARTS[0], thread: [PARTS[1], PARTS[2]], scheduledFor: iso(AT), expiresAt: iso(AT + HOUR) })]);
    // unreviewed, nothing goes out at its time
    at(w, T0 + 20 * MIN);
    const approved = await w.call<Record<string, unknown>>('POST', `${path}/${row!.id}`, { decision: 'approve', by: CREATOR });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ id: row!.id, status: 'approved', postId: null, thread: [PARTS[1], PARTS[2]], scheduledFor: iso(AT) });
    // approving is not sending
    await tickClean(w);
    expect(w.posted()).toEqual([]);

    at(w, AT + 1000);
    await tickClean(w);
    const ids = (await w.senderRows()).map((r) => r.providerPostId!);
    expect(w.posted()).toEqual([{ text: PARTS[0], replyTo: null }, { text: PARTS[1], replyTo: ids[0] }, { text: PARTS[2], replyTo: ids[1] }]);
    expect(await w.db.query.approvals.findFirst({ where: eq(approvals.id, row!.id) })).toMatchObject({ status: 'approved', postId: ids[0] });
    expect((await scheduledRows(w))[0]).toMatchObject({ status: 'sent', postId: ids[0] });
    expect((await tapePosts(w)).map((t) => t.summary)).toContain('Posted a thread on X (3 posts)');
    expect(thoughts(w)).toBe(2);
  });
});

describe('a switch between the Bootr agent and an own agent with posts waiting', () => {
  it('what waits is the coin\'s: it goes out at its time whoever runs the agent then, and the record says who wrote it', async () => {
    const A = 'Scheduled by the Bootr agent before the switch.';
    const B = 'Scheduled by the creator\'s own client before the switch back.';
    const script = [toolCallResponse('schedule_post', { text: A, sendAt: iso(T0 + 30 * MIN) }), finishResponse(T0 + 3 * HOUR)];
    const w = (world = await seam({ script, config: { OWN_AGENT_ENABLED: 'true', OWN_LEASE_WAIT_MS: '0' } }));
    await tickClean(w);
    expect(thoughts(w)).toBe(2);

    // the creator hands the coin to their own client
    at(w, T0 + 5 * MIN);
    const hosted = await agentRow(w);
    expect(await switchRunner(w.ctx, hosted, { runner: 'own', by: CREATOR, allowedModels: [String(hosted.config.model)] }, { leaseWaitMs: 60, leasePollMs: 10 })).toMatchObject({ ok: true, response: { runner: 'own' } });
    expect((await scheduledRows(w)).map((r) => r.status)).toEqual(['waiting']);
    // A goes out at its time with no client connected and no model called
    at(w, T0 + 30 * MIN + 1000);
    await tickClean(w);
    expect(w.posted()).toEqual([{ text: A, replyTo: null }]);
    expect(thoughts(w)).toBe(2);

    // the client writes one ahead, and the creator switches back before its time
    const client = await realEngine(w);
    await client.open('social', { forced: true });
    expect((await client.act('schedule_post', { text: B, sendAt: iso(T0 + 3 * HOUR) })).status).toBe('completed');
    await client.finish();
    at(w, T0 + 2 * HOUR + 50 * MIN);
    const own = await agentRow(w);
    expect(await switchRunner(w.ctx, own, { runner: 'hosted', by: CREATOR, allowedModels: [String(own.config.model)] }, { leaseWaitMs: 60, leasePollMs: 10 })).toMatchObject({ ok: true, response: { runner: 'hosted' } });
    expect((await scheduledRows(w)).map((r) => r.status)).toEqual(['sent', 'waiting']);
    at(w, T0 + 3 * HOUR + 1000);
    // the Bootr agent is back and may be woken by its own clock in this tick; the post goes out either way, once
    script.push(finishResponse(T0 + 9 * HOUR), finishResponse(T0 + 9 * HOUR));
    await tickClean(w);
    await tickClean(w);
    expect(w.posted()).toEqual([{ text: A, replyTo: null }, { text: B, replyTo: null }]);
    const sent = (await publishRows(w)).filter((r) => (r.action as { scheduled?: unknown }).scheduled);
    expect(sent.map((r) => (r.action as { via?: string }).via ?? 'bootr')).toEqual(['bootr', 'own']);
  });
});

describe('the note on what works, through a hosted turn', () => {
  const features = (over: Partial<PostFeatures> = {}): PostFeatures => ({ form: 'post', picture: false, chars: 'medium', hour: 12, scheduled: false, ...over });
  let seq = 0;
  async function measured(w: TestWorld, n: number, likes: number, over: Partial<PostFeatures> = {}) {
    const now = w.ctx.now();
    await w.db.insert(postMetrics).values(Array.from({ length: n }, (_, i) => ({ postId: String(600_000 + seq++), agentId: AGENT_ID, kind: 'post' as const, excerpt: `post ${seq}`, postedAt: new Date(now - 2 * DAY - i * 1000), measuredAt: new Date(now - HOUR), likes, features: features(over) })));
  }
  const FIRST = 'Posts with a picture drew more responses than posts without one.';
  const SECOND = 'Short posts did better than long ones; pictures still help.';

  it('is kept when it is due, refused in the middle of the week with the time it may be revised, and kept again a week and ten measured posts later', async () => {
    const script = [toolCallResponse('note_what_works', { text: FIRST }), finishResponse(T0 + 3 * HOUR)];
    const w = (world = await seam({ script }));
    await measured(w, 12, 9, { picture: true });
    await measured(w, 12, 2);
    await tickClean(w);
    // the facts were there, the section said the note may be written, and it was kept
    type Section = { facts: { lines: string[] }; note: { text: string | null; reviseNow: boolean; nextRevisionAt?: string } };
    const first = observationOf(w, 0).whatWorks as Section;
    expect(first.note).toMatchObject({ text: null, reviseNow: true });
    expect(first.facts.lines).toContain('with a picture: 12 posts, median 9 responses; without: 12 posts, median 2');
    expect(toldBy(w, 1)[0]).toEqual({ kept: true, nextRevisionAt: iso(T0 + 7 * DAY) });
    expect((await w.db.select().from(whatWorks)).map((r) => r.text)).toEqual([FIRST]);

    // three days on, with more posts measured: the section says not yet, and the tool refuses with the time
    at(w, T0 + 3 * DAY);
    await measured(w, 12, 5);
    script.push(toolCallResponse('note_what_works', { text: SECOND }), finishResponse(T0 + 3 * DAY + 3 * HOUR));
    await tickClean(w);
    const midWeek = observationOf(w, 2).whatWorks as Section;
    expect(midWeek.note).toMatchObject({ text: FIRST, reviseNow: false, nextRevisionAt: iso(T0 + 7 * DAY) });
    expect(toldBy(w, 3)[0]).toMatchObject({ error: `what_works_not_due: your note can be revised again at ${iso(T0 + 7 * DAY)}; nothing was changed.` });
    expect((await w.db.select().from(whatWorks)).map((r) => r.text)).toEqual([FIRST]);

    // a week after the first note, with ten and more posts measured since: due again, and the new note replaces the old one
    at(w, T0 + 7 * DAY + HOUR);
    script.push(toolCallResponse('note_what_works', { text: SECOND }), finishResponse(T0 + 7 * DAY + 4 * HOUR));
    await tickClean(w);
    expect((observationOf(w, 4).whatWorks as Section).note).toMatchObject({ text: FIRST, reviseNow: true });
    expect(toldBy(w, 5)[0]).toMatchObject({ kept: true });
    expect((await w.db.select().from(whatWorks)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((r) => r.text)).toEqual([FIRST, SECOND]);
  });
});
