/**
 * The scheduler's send through the REAL `sendOriginal` (thread-send.ts) and the REAL sender app in the same process,
 * with a fake X behind it (posting-helpers.ts `wiredWorld`). The time workstream tested its sweep against a stand-in
 * for the send; here every answer the real send can give is followed into the bucket it belongs to
 * (scheduled.ts `sendBucket`):
 *
 *   - `waits`: nothing was left at the sender and the cause passes by itself; the post is tried again inside its grace;
 *   - `final`: a refusal for good; the post fails with the reason and the agent is told once;
 *   - `unknown`: the post may be on X; it is never sent again and only the sender's receipt decides, up to a bound.
 *
 * In every one of them X is asked to post at most once per scheduled post.
 */
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { revokeAccount, saveAccount } from '../../sender/src/accounts.js';
import { actions as senderActions } from '../../sender/src/db/schema.js';
import { reconcilePostActions } from '../../sender/src/reconcile.js';
import { acceptPosts, json, timeoutError } from '../../sender/test/helpers.js';
import { scheduledActivity } from '../src/activity.js';
import { createApp } from '../src/api.js';
import { actions } from '../src/db/schema.js';
import { postHooks } from '../src/post-send.js';
import { OUTCOME_UNKNOWN_ERROR, postScheduledSoon, scheduledSection, sweepScheduled } from '../src/scheduled.js';
import { SenderError } from '../src/sender-client.js';
import { sendOriginal } from '../src/thread-send.js';
import { AGENT_ID, seedAgent, type TestWorld } from './helpers.js';
import { DAY, HOUR, POSTING_DEFAULTS, T0, wiredWorld, type WiredWorld } from './posting-helpers.js';
import { MIN, agentRow, patchConfig, rowOf, schedule, stateOf } from './scheduled-helpers.js';

const AT = T0 + 30 * MIN;
const TEXT = 'The half past twelve thought.';

/** A coin with one post scheduled for `AT` (or what `make` schedules), the routes mounted so both hooks are the real ones, and both clocks a second past `AT`. */
async function dueWorld(make?: (w: WiredWorld) => Promise<string>): Promise<{ w: WiredWorld; id: string }> {
  // every limit of the posting rules at its default, whichever run this file is part of (the suite also runs with them switched off)
  const w = await wiredWorld({ config: POSTING_DEFAULTS });
  await seedAgent(w, { runtime: { nextAt: new Date(T0 + 12 * HOUR) } });
  createApp(w.ctx);
  expect(postHooks.sendOriginal).toBe(sendOriginal);
  const id = make ? await make(w) : await schedule(w, TEXT, AT);
  w.advance(30 * MIN + 1000);
  return { w, id };
}

const sentRows = async (w: TestWorld) => (await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => (r.action as { scheduled?: unknown }).scheduled);
const notSent = async (w: TestWorld) => ((await scheduledSection(w.ctx, AGENT_ID)) as { scheduled?: { notSent?: { id: string; message: string }[] } }).scheduled?.notSent ?? [];
const senderRow = async (w: WiredWorld, id: string) => (await w.senderRows()).find((r) => r.actionId === id) ?? null;
/** X finds the post on the agent's own timeline: what the sender's reconciler reads back. */
const onTimeline = (w: WiredWorld, text: string, at: number, id = '7001') => w.x.fake.on('GET', '/2/users/1000/tweets', () => json({ data: [{ id, author_id: '1000', text, created_at: new Date(at).toISOString() }], meta: { result_count: 1 } }));

let world: WiredWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

describe('sent', () => {
  it('a post goes to X once under the scheduled row\'s own id, and is an ordinary post on the record', async () => {
    const { w, id } = await dueWorld();
    world = w;
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1, failed: 0, unknown: 0 });
    expect(w.posted()).toEqual([{ text: TEXT, replyTo: null }]);
    const sender = await senderRow(w, id);
    expect(sender).toMatchObject({ actionId: id, status: 'sent', kind: 'post' });
    expect(await rowOf(w, id)).toMatchObject({ status: 'sent', postId: sender!.providerPostId, error: null });
    expect(await sentRows(w)).toMatchObject([{ actionId: `${id}-sent`, status: 'completed', action: { tool: 'publish_post', input: { text: TEXT }, scheduled: { id } } }]);
    expect((await stateOf(w)).lastPostAt).toBe(w.ctx.now());
    // a second sweep, and a second call of the send itself, write nothing more
    await sweepScheduled(w.ctx);
    expect(await sendOriginal(w.ctx, await agentRow(w), { actionId: id, text: TEXT })).toMatchObject({ kind: 'completed', result: { postId: sender!.providerPostId } });
    expect(w.posted()).toHaveLength(1);
  });

  it('a thread goes out whole, chained under its own parts, and the record says how many went', async () => {
    const { w, id } = await dueWorld((w) => schedule(w, 'A thought that needs room, part one.', AT, { more: { thread: [{ text: 'Part two goes on.' }, { text: 'Part three closes it.' }] } }));
    world = w;
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
    const rows = await w.senderRows();
    expect(rows.map((r) => [r.actionId, r.status, r.threadN])).toEqual([[id, 'sent', 1], [`${id}.t2`, 'sent', 2], [`${id}.t3`, 'sent', 3]]);
    const ids = rows.map((r) => r.providerPostId!);
    expect(w.posted().map((p) => p.replyTo)).toEqual([null, ids[0], ids[1]]);
    const [row] = await sentRows(w);
    expect(row!.result).toMatchObject({ postId: ids[0], parts: ids.map((postId, i) => ({ n: i + 1, postId })), sent: 3, of: 3, scheduledId: id });
  });
});

describe('waits: nothing was left at the sender, and the cause passes by itself', () => {
  it('the day\'s quota used up: the post waits with the hold of a post sent now, and goes out when the quota opens inside its grace', async () => {
    const { w, id } = await dueWorld();
    world = w;
    // the one post of the day went out 23 hours and 50 minutes before this one's time
    await w.ctx.sender.setQuota(AGENT_ID, { postsPerDay: 1 });
    expect((await sendOriginal(w.ctx, await agentRow(w), { actionId: 'act-earlier-00001', text: 'The one post of the day.' })).kind).toBe('completed');
    const earlier = new Date(AT + 10 * MIN - DAY);
    // (the sender holds this one row and no other yet)
    await w.x.db.update(senderActions).set({ createdAt: earlier, sentAt: earlier });

    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 0, unknown: 0 });
    expect(await rowOf(w, id)).toMatchObject({ status: 'waiting', error: 'sender:quota_exceeded', attempts: 1 });
    expect(await senderRow(w, id)).toBeNull();
    expect(w.posted()).toHaveLength(1);
    // the hold a post sent now would have set: no thought is bought and no post tried until the quota opens
    expect((await stateOf(w)).postQuotaUntil).toBe(AT + 10 * MIN);
    w.advance(5 * MIN);
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0 });
    expect(w.posted()).toHaveLength(1);
    // the quota opens ten minutes after its time, inside the hour of grace: it goes out, once
    w.advance(6 * MIN);
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
    expect(w.posted().map((p) => p.text)).toEqual(['The one post of the day.', TEXT]);
    expect(await rowOf(w, id)).toMatchObject({ status: 'sent', error: null });
    expect(await notSent(w)).toEqual([]);
  });

  it('the X account is not connected: tried again on later ticks, sent when the creator reconnects in time', async () => {
    const { w, id } = await dueWorld();
    world = w;
    await revokeAccount(w.x.ctx, AGENT_ID);
    for (const later of [0, 10, 20]) {
      if (later) w.advance(10 * MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 0, missed: 0, unknown: 0 });
      expect(await rowOf(w, id)).toMatchObject({ status: 'waiting', error: 'sender:revoked' });
    }
    expect((await rowOf(w, id)).attempts).toBe(3);
    expect(await senderRow(w, id)).toBeNull();
    expect(w.posted()).toEqual([]);
    // no hold for it: the account coming back is all it waits for
    const state = await stateOf(w);
    expect([state.postForbiddenUntil ?? null, state.postQuotaUntil ?? null, state.postCreditsUntil ?? null]).toEqual([null, null, null]);
    await saveAccount(w.x.ctx, AGENT_ID, { accessToken: 'access-token-2', refreshToken: 'refresh-token-2', expiresAt: new Date(w.x.clock.now().getTime() + 30 * DAY), scopes: 'tweet.read tweet.write users.read offline.access media.write' }, { id: '1000', username: 'bootr_agent' }, { replace: true });
    w.advance(5 * MIN);
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
    expect(w.posted()).toEqual([{ text: TEXT, replyTo: null }]);
  });

  it('still not connected when the grace ends: missed, never sent late, and the agent is told once', async () => {
    const { w, id } = await dueWorld();
    world = w;
    await revokeAccount(w.x.ctx, AGENT_ID);
    await sweepScheduled(w.ctx);
    w.advance(60 * MIN);
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 1 });
    expect((await rowOf(w, id)).status).toBe('missed');
    expect((await notSent(w)).map((f) => f.message)).toEqual([`your scheduled post ${id} was not sent: its time passed before it could go out`]);
    expect(w.posted()).toEqual([]);
  });
});

describe('final: a refusal for good', () => {
  it('X refuses the account (403): the post fails with X\'s words, the account is held as for a post sent now, and nothing is sent again', async () => {
    const { w, id } = await dueWorld();
    world = w;
    w.x.fake.on('POST', '/2/tweets', () => json({ title: 'Forbidden', detail: 'You are not permitted to perform this action.' }, 403));
    expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1, sent: 0 });
    const row = await rowOf(w, id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^sender_rejected:forbidden\(403\)/);
    expect(await senderRow(w, id)).toMatchObject({ status: 'rejected' });
    expect((await stateOf(w)).postForbiddenUntil).toBeGreaterThan(w.ctx.now());
    expect((await notSent(w)).map((f) => f.message)).toEqual([`your scheduled post ${id} was not sent: ${row.error}`]);
    acceptPosts(w.x.fake, w.x.clock);
    w.advance(10 * MIN);
    await sweepScheduled(w.ctx);
    expect(w.posted()).toHaveLength(1);
    expect(w.x.fake.posted).toEqual([]);
  });

  it('the day\'s count of posts with a link: nothing is left at the sender, and it is still final for this post, with no hold', async () => {
    const { w, id } = await dueWorld((w) => schedule(w, 'Read the docs at https://bootr.fun/docs today.', AT));
    world = w;
    w.x.ctx.defaults.linkPostsPerDay = 1;
    expect((await sendOriginal(w.ctx, await agentRow(w), { actionId: 'act-link-000001', text: 'A link from this morning: https://bootr.fun/a/1' })).kind).toBe('completed');
    expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1, sent: 0 });
    expect(await rowOf(w, id)).toMatchObject({ status: 'failed', error: 'link_quota: at most 1 posts with a link per 24 hours; nothing was posted. Post it without the link.' });
    expect(await senderRow(w, id)).toBeNull();
    const state = await stateOf(w);
    expect([state.postForbiddenUntil ?? null, state.postQuotaUntil ?? null, state.postCreditsUntil ?? null]).toEqual([null, null, null]);
    // the slot stays open for the agent to say it again without the link
    expect(state.lastPostAt ?? null).toBeNull();
    expect(await postHooks.beforeOriginalNow(w.ctx, await agentRow(w), w.ctx.now())).toBeNull();
    w.advance(5 * MIN);
    await sweepScheduled(w.ctx);
    expect(w.posted()).toHaveLength(1);
  });

  it('a thread that no longer fits the coin\'s day: refused whole by the posting rules\' own gate before anything is sent', async () => {
    const { w, id } = await dueWorld((w) => schedule(w, 'A thought that needs room, part one.', AT, { more: { thread: [{ text: 'Part two goes on.' }, { text: 'Part three closes it.' }] } }));
    world = w;
    // the creator lowered the coin's posts per day after it was scheduled: a thread never has more parts than that
    await patchConfig(w, { postsPerDay: 2 });
    expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1, sent: 0 });
    expect(await rowOf(w, id)).toMatchObject({ status: 'failed', error: 'thread_too_long: a thread has at most 2 posts; nothing was posted. Say it in fewer.' });
    expect(await w.senderRows()).toEqual([]);
    expect(w.posted()).toEqual([]);
  });
});

describe('unknown: the post may be on X, and only the receipt decides', () => {
  it('X does not answer: the sender holds it, nothing is sent again, and the sender\'s own reconciler closes it as sent', async () => {
    const { w, id } = await dueWorld();
    world = w;
    const accept = w.x.fake.routes.get('POST /2/tweets')!;
    w.x.fake.on('POST', '/2/tweets', () => timeoutError());
    expect(await sweepScheduled(w.ctx)).toMatchObject({ unknown: 1, sent: 0, failed: 0 });
    expect(await rowOf(w, id)).toMatchObject({ status: 'sending', error: 'sender_held' });
    expect(await senderRow(w, id)).toMatchObject({ status: 'held' });
    // X answers again, and still nothing is sent a second time; the coin's other originals wait behind it
    w.x.fake.on('POST', '/2/tweets', accept);
    w.advance(5 * MIN);
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 0 });
    expect(w.posted()).toHaveLength(1);
    expect(await postHooks.beforeOriginalNow(w.ctx, await agentRow(w), w.ctx.now())).toBe(postScheduledSoon(AT));
    // X did take it: the sender's reconciler finds it on the agent's timeline a quarter of an hour later
    w.advance(11 * MIN);
    onTimeline(w, TEXT, AT + 2000);
    expect((await reconcilePostActions(w.x.ctx)).settled).toBe(1);
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
    expect(await rowOf(w, id)).toMatchObject({ status: 'sent', postId: '7001', error: null });
    expect(await sentRows(w)).toHaveLength(1);
    expect(w.posted()).toHaveLength(1);
  });

  it('the sender\'s answer is lost after it posted: the row is settled from the receipt, and X got the post once', async () => {
    const { w, id } = await dueWorld();
    world = w;
    const publish = w.ctx.sender.publish.bind(w.ctx.sender);
    w.ctx.sender.publish = async (input) => {
      await publish(input);
      throw new TypeError('fetch failed');
    };
    expect(await sweepScheduled(w.ctx)).toMatchObject({ unknown: 1, sent: 0 });
    expect(await rowOf(w, id)).toMatchObject({ status: 'sending', error: 'TypeError: fetch failed' });
    w.ctx.sender.publish = publish;
    w.advance(MIN);
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
    expect(w.posted()).toEqual([{ text: TEXT, replyTo: null }]);
    expect(await sentRows(w)).toHaveLength(1);
  });

  it('an answer that is not the sender\'s own (a 502 from what stands in front of it): asked at the sender, which never saw it, so it goes out on the next tick', async () => {
    const { w, id } = await dueWorld();
    world = w;
    const publish = w.ctx.sender.publish.bind(w.ctx.sender);
    w.ctx.sender.publish = async () => {
      throw new SenderError(502, 'http_502', { raw: 'Bad Gateway' }, false);
    };
    expect(await sweepScheduled(w.ctx)).toMatchObject({ unknown: 1, sent: 0, failed: 0 });
    expect(await rowOf(w, id)).toMatchObject({ status: 'sending', error: 'sender:http_502' });
    expect(w.posted()).toEqual([]);
    w.ctx.sender.publish = publish;
    w.advance(MIN);
    // no receipt at all: nothing was sent; it waits again and the same sweep sends it
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
    expect(w.posted()).toEqual([{ text: TEXT, replyTo: null }]);
    expect((await rowOf(w, id)).attempts).toBe(2);
  });

  it('the same 502 after the sender did post: the receipt says sent, and nothing is sent again', async () => {
    const { w, id } = await dueWorld();
    world = w;
    const publish = w.ctx.sender.publish.bind(w.ctx.sender);
    w.ctx.sender.publish = async (input) => {
      await publish(input);
      throw new SenderError(502, 'http_502', { raw: 'Bad Gateway' }, false);
    };
    expect(await sweepScheduled(w.ctx)).toMatchObject({ unknown: 1 });
    w.ctx.sender.publish = publish;
    w.advance(MIN);
    expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
    expect(w.posted()).toHaveLength(1);
    expect((await rowOf(w, id)).attempts).toBe(1);
  });

  it('never settled: past its grace and an hour more it is closed with no known outcome, the coin posts again, and a receipt that comes later still puts it on the record', async () => {
    const { w, id } = await dueWorld();
    world = w;
    const accept = w.x.fake.routes.get('POST /2/tweets')!;
    w.x.fake.on('POST', '/2/tweets', () => timeoutError());
    w.x.fake.on('GET', '/2/users/1000/tweets', () => json({ data: [], meta: { result_count: 0 } }));
    await sweepScheduled(w.ctx);
    w.x.fake.on('POST', '/2/tweets', accept);
    // the sender's reconciler looks on X and finds nothing, again and again
    for (const later of [16, 80]) {
      w.advance(AT + later * MIN - w.ctx.now());
      await reconcilePostActions(w.x.ctx);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, failed: 0 });
      expect((await rowOf(w, id)).status).toBe('sending');
    }
    w.advance(42 * MIN);
    expect(w.ctx.now()).toBeGreaterThan(AT + 121 * MIN);
    expect(await sweepScheduled(w.ctx)).toMatchObject({ failed: 1, sent: 0 });
    expect(await rowOf(w, id)).toMatchObject({ status: 'failed', error: OUTCOME_UNKNOWN_ERROR });
    expect(w.posted()).toHaveLength(1);
    // the sender still holds it: nothing there was touched, and it is never resent or rejected by Bootr
    expect(await senderRow(w, id)).toMatchObject({ status: 'held' });
    expect(await postHooks.beforeOriginalNow(w.ctx, await agentRow(w), w.ctx.now())).toBeNull();
    expect((await notSent(w)).map((f) => f.message)).toEqual([expect.stringContaining(`your scheduled post ${id} has no known outcome`)]);
    expect((await scheduledActivity(w.ctx, await agentRow(w), 10)).map((t) => t.summary)).toEqual(['A scheduled post went to X at its time and X never confirmed it; it is not sent again']);
    // hours later the post shows on the agent's timeline after all
    onTimeline(w, TEXT, AT + 2000);
    w.advance(2 * HOUR);
    expect((await reconcilePostActions(w.x.ctx)).settled).toBe(1);
    await sweepScheduled(w.ctx);
    expect(await rowOf(w, id)).toMatchObject({ status: 'sent', postId: '7001', error: null });
    expect(await sentRows(w)).toMatchObject([{ actionId: `${id}-sent`, status: 'completed' }]);
    expect(w.posted()).toHaveLength(1);
  });
});
