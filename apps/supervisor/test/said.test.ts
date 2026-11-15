/**
 * The said-ledger (docs/design/agent-behaviour.md section 6.2): one row per post that went out, written when its
 * publish completes, whichever way it went out and whoever thought; the stored history filled once, in bounded steps
 * that survive a restart; old rows deleted. The texts are the posts quoted in section 2.3 of the note.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../src/api.js';
import { queueForApproval } from '../src/approvals.js';
import { actions, cursors, gateShadow, said } from '../src/db/schema.js';
import { logGateHit } from '../src/gate-shadow.js';
import { signRequest } from '../src/hmac.js';
import { SAID_BACKFILL_CURSOR, SAID_OTHERS_MAX_ROWS, historyBatch, lastOriginals, recordSaid, resetSaidSweep, saidByOthers, saidRowsOf, sweepSaid, wordOverlap, wordSet } from '../src/said.js';
import { sweepScheduled } from '../src/scheduled.js';
import { reconcilePending, tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, SUPERVISOR_KEY, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { OTHER_AGENT_ID, act, connectClient, openSocial, ownWorld, seedOther, seedOwn } from './own-helpers.js';
import { POSTING_DEFAULTS } from './posting-off.limits.js';
import { postHooks, setPostHooks } from '../src/post-send.js';
import '../src/thread-send.js';
import { fakeSend, schedule } from './scheduled-helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const HOLDERS = '112 holders. the floor stops proving.';
const POOL = 'Day 10. 6 holders. Fee pool sits at $0.0475 WETH. last trade Nov 10.';
const ECO = 'Eco posted Dune data on 10 November: 1.15M agents have registered an onchain identity (ERC-8004) on Base, 1.02M of them between Oct 12 and 23.';

const ledger = async (w: TestWorld, agentId: string = AGENT_ID) => (await w.db.select().from(said).where(eq(said.agentId, agentId))).sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || (a.id < b.id ? -1 : 1));

/** A completed publish on the record, as the runtime leaves one. */
async function seedAction(w: TestWorld, id: string, at: number, action: Record<string, unknown>, result: Record<string, unknown>, over: Partial<typeof actions.$inferInsert> = {}): Promise<void> {
  await w.db.insert(actions).values({ actionId: id, agentId: AGENT_ID, cycleKey: `seed:${id}`, action, status: 'completed', result, createdAt: new Date(at), updatedAt: new Date(at), ...over });
}

/** The hooks as the modules above mounted them: a test that puts a stand-in for the send there hands the real one back. */
const mounted = { ...postHooks };
afterEach(() => setPostHooks(mounted));

describe('saidRowsOf: what one completed publish gives the ledger', () => {
  const at = new Date(T0);

  it('a single post is one row with its fingerprints, the numbers as written, its opener and its words', () => {
    const rows = saidRowsOf({ agentId: '7', actionId: 'act_1', action: { tool: 'publish_post', input: { text: POOL } }, result: { actionId: 'act_1', tool: 'publish_post', status: 'completed', result: { postId: '9001' } }, at });
    expect(rows).toEqual([
      {
        id: 'act_1',
        agentId: '7',
        actionId: 'act_1',
        postId: '9001',
        kind: 'original',
        postedAt: at,
        fingerprints: ['fee:4.8e-2$', 'holders:6.0e0'],
        facts: [
          { s: 'holders', u: '', v: 6 },
          { s: 'fee', u: '$', v: 0.0475 },
        ],
        opener: 'day # #',
        words: expect.arrayContaining(['holders', 'fee', 'pool', '0.0475', 'weth']),
        recordIds: [],
      },
    ]);
    // No text is kept: the words are a set, sorted, without the common ones.
    expect(rows[0]!.words).not.toContain('at');
    expect(JSON.stringify(rows[0])).not.toContain('Fee pool sits');
  });

  it('a thread is one row per post that went out, and a cut thread stops at the cut', () => {
    const action = { tool: 'publish_post', input: { text: HOLDERS, thread: [{ text: 'Volume was $4.3k in the day.' }, { text: 'Third part, never sent.' }] } };
    // An approved or a scheduled post's row holds the result itself, not the runtime's envelope.
    const rows = saidRowsOf({ agentId: '7', actionId: 'sch_1-sent', action, result: { postId: '9001', parts: [{ n: 1, postId: '9001' }, { n: 2, postId: '9002' }], sent: 2, of: 3, cut: { n: 3, error: 'sender_rejected:x' } }, at });
    expect(rows.map((r) => [r.id, r.kind, r.postId, r.fingerprints])).toEqual([
      ['sch_1-sent', 'original', '9001', ['holders:1.1e2']],
      ['sch_1-sent.t2', 'thread_part', '9002', ['volume:4.3e3$']],
    ]);
    expect(rows.every((r) => r.actionId === 'sch_1-sent')).toBe(true);
  });

  it('a reply is one row of kind reply', () => {
    const rows = saidRowsOf({ agentId: '7', actionId: 'act_r', action: { tool: 'publish_reply', input: { postId: '55', text: '1.2% per trade goes to agent, creator, burn and platform.' } }, result: { status: 'completed', result: { postId: '9003', replyAuthorId: '42' } }, at });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'act_r', kind: 'reply', postId: '9003', fingerprints: ['trades:1.2e0%'] });
  });

  it('nothing for a post queued for review, for a tool that publishes nothing and for an empty text', () => {
    expect(saidRowsOf({ agentId: '7', actionId: 'act_q', action: { tool: 'publish_post', input: { text: HOLDERS } }, result: { status: 'completed', result: { queued: true, approvalId: 'act_q' } }, at })).toEqual([]);
    expect(saidRowsOf({ agentId: '7', actionId: 'act_s', action: { tool: 'schedule_post', input: { text: HOLDERS } }, result: { status: 'completed', result: { scheduledId: 'sch_x' } }, at })).toEqual([]);
    expect(saidRowsOf({ agentId: '7', actionId: 'act_f', action: { tool: 'finish', input: {} }, result: null, at })).toEqual([]);
    expect(saidRowsOf({ agentId: '7', actionId: 'act_e', action: { tool: 'publish_post', input: { text: '   ' } }, result: null, at })).toEqual([]);
    expect(saidRowsOf({ agentId: '7', actionId: 'act_c', action: { kind: 'config_updated' }, result: null, at })).toEqual([]);
  });

  it('keeps the records a post cited, read the forgiving way (recordSaid then keeps the ones the agent was handed)', () => {
    const rows = saidRowsOf({ agentId: '7', actionId: 'act_2', action: { tool: 'publish_post', input: { text: ECO, record: [{ id: 'r_00000000008f' }, { id: 'R_0000000011BC' }, { id: 'not a record' }] } }, result: { postId: '1' }, at });
    expect(rows[0]).toMatchObject({ recordIds: ['r_00000000008f', 'r_0000000011bc'], fingerprints: ['agents:1.0e6', 'agents:1.2e6'] });
  });
});

describe('wordSet and wordOverlap', () => {
  it('leaves links, handles and common words out and keeps numbers as words', () => {
    expect(wordSet('@base says the fee is 2.4% on Base. See https://base.org/x and $BOOTR.')).toEqual(['2.4%', 'base', 'bootr', 'fee', 'says', 'see']);
    expect(wordSet('')).toEqual([]);
  });

  it('is the share of words in both over the words in either', () => {
    expect(wordOverlap(['a1', 'b1', 'c1', 'd1'], ['a1', 'b1', 'c1', 'd1'])).toBe(1);
    expect(wordOverlap(['a1', 'b1', 'c1', 'd1'], ['a1', 'b1', 'x1', 'y1'])).toBeCloseTo(2 / 6);
    expect(wordOverlap([], ['a1'])).toBe(0);
  });
});

describe('the ledger is written when a publish completes', () => {
  it('a post a hosted turn sent at once', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: HOLDERS }), finishResponse(T0 + 2 * HOUR)] });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const rows = await ledger(w);
      expect(rows).toHaveLength(1);
      const [action] = (await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => (r.action as { tool?: string }).tool === 'publish_post');
      expect(rows[0]).toMatchObject({ id: action!.actionId, actionId: action!.actionId, kind: 'original', fingerprints: ['holders:1.1e2'], opener: '# holders the' });
      expect(rows[0]!.postId).toBe((action!.receipt as { postId: string }).postId);
    } finally {
      await w.close();
    }
  });

  it('a publish whose outcome was unknown, once its receipt says sent', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: HOLDERS })] });
    try {
      await seedAgent(w);
      w.sender.publishStatus = 'held';
      await tick(w.ctx);
      expect(await ledger(w)).toEqual([]);
      let runtime = (await w.db.query.runtimes.findFirst())!;
      const actionId = (runtime.pending as { id: string }).id;
      w.sender.receipts[actionId] = { status: 'sent', providerPostId: '777' };
      runtime = await reconcilePending(w.ctx, (await w.db.query.agents.findFirst())!, runtime);
      expect(await ledger(w)).toMatchObject([{ id: actionId, postId: '777', kind: 'original' }]);
      // Settling it again at the next turn's start writes nothing more.
      await reconcilePending(w.ctx, (await w.db.query.agents.findFirst())!, runtime);
      expect(await ledger(w)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('a post approved from the review queue, and not while it only waits there', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: { requireApproval: true } });
      const pending = { id: 'act_p1', cycleKey: 'cycle:act_p1', action: { tool: 'publish_post', input: { text: POOL } }, status: 'sent', createdAt: 0, attempts: 1 } as unknown as Parameters<typeof queueForApproval>[2];
      expect((await queueForApproval(w.ctx, agent, pending, { inbox: new Map(), eligibility: new Map(), cycle: 1 })).kind).toBe('completed');
      expect(await ledger(w)).toEqual([]);
      const nowSec = () => Math.floor(w.ctx.now() / 1000);
      const path = `/internal/agents/${AGENT_ID}/approvals/act_p1`;
      const body = JSON.stringify({ decision: 'approve', by: CREATOR });
      const res = await createApp(w.ctx, nowSec).request(path, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'POST', path, body, nowSec()) } });
      expect(res.status).toBe(200);
      expect(await ledger(w)).toMatchObject([{ id: 'act_p1-approved', actionId: 'act_p1-approved', kind: 'original', postId: '9001', fingerprints: ['fee:4.8e-2$', 'holders:6.0e0'] }]);
    } finally {
      await w.close();
    }
  });

  it('a post the scheduler sent, each post of its thread', async () => {
    const w = await makeWorld({ config: POSTING_DEFAULTS });
    try {
      await seedAgent(w, { runtime: { nextAt: new Date(T0 + 12 * HOUR) } });
      fakeSend(w);
      const id = await schedule(w, HOLDERS, T0 + HOUR, { more: { thread: [{ text: 'Volume was $4.3k in the day.' }] } });
      expect(await ledger(w)).toEqual([]);
      w.setNow(T0 + HOUR + 1000);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 1 });
      expect((await ledger(w)).map((r) => [r.id, r.kind, r.fingerprints])).toEqual([
        [`${id}-sent`, 'original', ['holders:1.1e2']],
        [`${id}-sent.t2`, 'thread_part', ['volume:4.3e3$']],
      ]);
    } finally {
      await w.close();
    }
  });

  it("an own agent's post and reply", async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const turn = await openSocial(w, credential);
      const post = await act(w, credential, turn.turnId, 'publish_post', { text: HOLDERS });
      expect(post.body.status).toBe('completed');
      expect(await ledger(w)).toMatchObject([{ id: post.body.actionId, kind: 'original', fingerprints: ['holders:1.1e2'] }]);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('writes nothing with the ledger switched off, and never throws into the publish', async () => {
    const w = await makeWorld({ config: { SAID_KEEP_DAYS: '0' }, script: [toolCallResponse('publish_post', { text: HOLDERS }), finishResponse(T0 + 2 * HOUR)] });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      expect(w.sender.published).toHaveLength(1);
      expect(await ledger(w)).toEqual([]);
      // A database that refuses the row is a warning: the caller gets 0 and goes on.
      const broken = { ...w.ctx, config: { ...w.ctx.config, SAID_KEEP_DAYS: 30 }, db: { insert: () => { throw new Error('the database is away'); } } } as unknown as typeof w.ctx;
      expect(await recordSaid(broken, { agentId: AGENT_ID, actionId: 'act_x', action: { tool: 'publish_post', input: { text: HOLDERS } }, result: { postId: '1' }, at: T0 })).toBe(0);
    } finally {
      await w.close();
    }
  });
});

describe('the stored history is filled once, in bounded steps, and old rows go', () => {
  async function history(w: TestWorld): Promise<void> {
    // Five publishes of the last 30 days, one older than that, one queued for review, one failed, and a tool that publishes nothing.
    for (let i = 1; i <= 5; i++) await seedAction(w, `act_h${i}`, T0 - i * DAY, { tool: 'publish_post', input: { text: `${100 + i} holders today.` } }, { actionId: `act_h${i}`, tool: 'publish_post', status: 'completed', result: { postId: `80${i}` } });
    await seedAction(w, 'act_old', T0 - 31 * DAY, { tool: 'publish_post', input: { text: '90 holders today.' } }, { status: 'completed', result: { postId: '700' } });
    await seedAction(w, 'act_queued', T0 - 2 * DAY - HOUR, { tool: 'publish_post', input: { text: 'Queued, not said.' } }, { status: 'completed', result: { queued: true } });
    await seedAction(w, 'act_failed', T0 - 2 * DAY - 2 * HOUR, { tool: 'publish_post', input: { text: 'Refused.' } }, { status: 'failed', error: 'sender_rejected:x' }, { status: 'failed' });
    await seedAction(w, 'act_reply', T0 - 3 * HOUR, { tool: 'publish_reply', input: { postId: '5', text: 'There are 112 holders.' } }, { status: 'completed', result: { postId: '901' } });
    await seedAction(w, 'act_read', T0 - HOUR, { tool: 'read_mentions', input: {} }, { status: 'completed', result: {} });
  }

  it('reads a batch a tick, oldest first, and stops when the history is in', async () => {
    const w = await makeWorld({ config: { SAID_BACKFILL_PER_TICK: '2' } });
    try {
      await seedAgent(w);
      await history(w);
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 2, written: 2, done: false });
      expect((await ledger(w)).map((r) => r.id)).toEqual(['act_h5', 'act_h4']);
      // The post that only waited in the review queue is read and gives no row.
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 2, written: 1, done: false });
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 2, written: 2, done: false });
      // The last batch is short, so the history is in.
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 1, written: 1, done: true });
      expect((await ledger(w)).map((r) => [r.id, r.kind])).toEqual([['act_h5', 'original'], ['act_h4', 'original'], ['act_h3', 'original'], ['act_h2', 'original'], ['act_h1', 'original'], ['act_reply', 'reply']]);
      expect((await ledger(w))[0]).toMatchObject({ postedAt: new Date(T0 - 5 * DAY), postId: '805', fingerprints: ['holders:1.1e2'], facts: [{ s: 'holders', u: '', v: 105 }] });
      // Done: later ticks read nothing, not even the cursor.
      expect(await sweepSaid(w.ctx)).toEqual({ read: 0, written: 0, done: true, pruned: 0, shadowPruned: 0 });
    } finally {
      await w.close();
    }
  });

  it('goes on after a restart where the last tick stopped, and a finished history is never read again', async () => {
    const w = await makeWorld({ config: { SAID_BACKFILL_PER_TICK: '3' } });
    try {
      await seedAgent(w);
      await history(w);
      await sweepSaid(w.ctx);
      expect((await ledger(w)).map((r) => r.id)).toEqual(['act_h5', 'act_h4', 'act_h3']);
      // A restart: the process forgets, the cursor row does not. A publish that completes meanwhile is written by its own path.
      resetSaidSweep(w.ctx.config);
      await seedAction(w, 'act_new', T0 + 1000, { tool: 'publish_post', input: { text: 'After the start: 120 holders.' } }, { status: 'completed', result: { postId: '999' } });
      w.setNow(T0 + 60_000);
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 3, written: 2, done: false });
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 1, written: 1, done: true });
      // Everything of the history, nothing twice, and nothing created after the first sweep began.
      expect((await ledger(w)).map((r) => r.id)).toEqual(['act_h5', 'act_h4', 'act_h3', 'act_h2', 'act_h1', 'act_reply']);
      const cursor = JSON.parse((await w.db.query.cursors.findFirst({ where: eq(cursors.name, SAID_BACKFILL_CURSOR) }))!.value) as { done: boolean; until: string };
      expect(cursor).toMatchObject({ done: true, until: new Date(T0).toISOString() });
      resetSaidSweep(w.ctx.config);
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 0, done: true });
    } finally {
      await w.close();
    }
  });

  it('reads the history agent by agent, each from where it stopped, within the tick\'s bound', async () => {
    const w = await makeWorld({ config: { SAID_BACKFILL_PER_TICK: '4' } });
    try {
      await seedAgent(w);
      await seedOther(w);
      await history(w);
      // The other coin: three publishes, one of them written by the database's own clock to the microsecond.
      for (let i = 1; i <= 2; i++) await seedAction(w, `act_o${i}`, T0 - i * DAY - HOUR, { tool: 'publish_post', input: { text: `${40 + i} holders on the other coin.` } }, { status: 'completed', result: { postId: `70${i}` } }, { agentId: OTHER_AGENT_ID });
      await w.db.insert(actions).values({ actionId: 'act_o3', agentId: OTHER_AGENT_ID, cycleKey: 'seed:act_o3', action: { tool: 'publish_post', input: { text: '44 holders on the other coin.' } }, status: 'completed', result: { status: 'completed', result: { postId: '703' } } });
      w.setNow(Date.now() + 60_000);

      // Agent 7 first (ids in order), four of its seven publishes; then its other three and the first of agent 8; then the rest.
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 4, done: false });
      expect(await ledger(w, OTHER_AGENT_ID)).toEqual([]);
      const mid = JSON.parse((await w.db.query.cursors.findFirst({ where: eq(cursors.name, SAID_BACKFILL_CURSOR) }))!.value) as { agentId: string; afterId: string };
      expect(mid).toMatchObject({ agentId: AGENT_ID, afterId: 'act_queued' });
      // A restart in between changes nothing: the cursor names the agent and the publish it stopped at.
      resetSaidSweep(w.ctx.config);
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 4, done: false });
      expect((await ledger(w)).map((r) => r.id)).toEqual(['act_h5', 'act_h4', 'act_h3', 'act_h2', 'act_h1', 'act_reply']);
      expect((await ledger(w, OTHER_AGENT_ID)).map((r) => r.id)).toEqual(['act_o2']);
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 2, written: 2, done: true });
      expect((await ledger(w, OTHER_AGENT_ID)).map((r) => r.id)).toEqual(['act_o2', 'act_o1', 'act_o3']);
      // Nothing was written twice, and nothing is read again.
      expect(await w.db.select().from(said)).toHaveLength(9);
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 0, done: true });
    } finally {
      await w.close();
    }
  });

  it('a batch is a range of the (agent, created_at) index: the planner is given both bounds as index conditions', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await history(w);
      const cursor = { agentId: AGENT_ID, after: new Date(T0 - 3 * DAY).toISOString(), afterId: 'act_h3', until: new Date(T0).toISOString() };
      expect((await historyBatch(w.ctx.db, cursor, 10)).map((r) => r.actionId)).toEqual(['act_queued', 'act_h2', 'act_h1', 'act_reply']);
      // With so few rows the planner would read the table whole; told not to, it shows what the index can take.
      await w.db.execute(sql`set enable_seqscan = off`);
      const plan = (await w.db.execute(sql`explain ${historyBatch(w.ctx.db, cursor, 10).getSQL()}`)) as unknown as { rows: Record<string, string>[] };
      const text = plan.rows.map((r) => Object.values(r)[0]).join('\n');
      expect(text).toContain('sv_actions_agent_created_idx');
      const condition = /Index Cond: (.*)/.exec(text)?.[1] ?? '';
      expect(condition).toContain('agent_id');
      expect(condition).toMatch(/created_at >= /);
      expect(condition).toMatch(/created_at <= /);
    } finally {
      await w.close();
    }
  });

  it('a cursor from before the history was read agent by agent begins again; a finished one stays finished', async () => {
    const w = await makeWorld({ config: { SAID_BACKFILL_PER_TICK: '50' } });
    try {
      await seedAgent(w);
      await history(w);
      await w.db.insert(cursors).values({ name: SAID_BACKFILL_CURSOR, value: JSON.stringify({ until: new Date(T0).toISOString(), after: new Date(T0 - 2 * DAY).toISOString(), afterId: 'act_h2', done: false }) });
      expect(await sweepSaid(w.ctx)).toMatchObject({ read: 7, written: 6, done: true });
      const done = await makeWorld();
      try {
        await seedAgent(done);
        await history(done);
        await done.db.insert(cursors).values({ name: SAID_BACKFILL_CURSOR, value: JSON.stringify({ until: new Date(T0).toISOString(), after: new Date(T0).toISOString(), afterId: 'x', done: true }) });
        expect(await sweepSaid(done.ctx)).toMatchObject({ read: 0, done: true });
        expect(await ledger(done)).toEqual([]);
      } finally {
        await done.close();
      }
    } finally {
      await w.close();
    }
  });

  it('deletes rows past their age, once an hour', async () => {
    const w = await makeWorld({ config: { SAID_BACKFILL_PER_TICK: '0' } });
    try {
      await seedAgent(w);
      for (const [id, age] of [['act_a', 29 * DAY], ['act_b', 31 * DAY]] as const) await recordSaid(w.ctx, { agentId: AGENT_ID, actionId: id, action: { tool: 'publish_post', input: { text: HOLDERS } }, result: { postId: id }, at: T0 - age });
      expect(await sweepSaid(w.ctx)).toMatchObject({ pruned: 1 });
      expect((await ledger(w)).map((r) => r.id)).toEqual(['act_a']);
      w.setNow(T0 + 2 * DAY);
      // Within the hour nothing is asked; after it the row that is now too old goes.
      resetSaidSweep(w.ctx.config);
      expect(await sweepSaid(w.ctx)).toMatchObject({ pruned: 1 });
      expect(await sweepSaid(w.ctx)).toMatchObject({ pruned: 0 });
      expect(await ledger(w)).toEqual([]);
    } finally {
      await w.close();
    }
  });
});

describe("the gates' shadow log is trimmed by the same hourly sweep", () => {
  const hit = (text: string) => ({ agentId: AGENT_ID, gate: 'G1' as const, code: 'repeat_fact', actionId: 'act_1', text, enforced: false });
  const left = async (w: TestWorld) => (await w.db.select().from(gateShadow)).map((r) => r.createdAt.getTime()).sort((a, b) => a - b);

  it('deletes rows older than GATE_SHADOW_KEEP_DAYS (90 by default), once an hour, and leaves the rest', async () => {
    const w = await makeWorld({ config: { SAID_BACKFILL_PER_TICK: '0' } });
    try {
      await seedAgent(w);
      expect(w.ctx.config.GATE_SHADOW_KEEP_DAYS).toBe(90);
      for (const [text, age] of [['a post of 91 days ago', 91 * DAY], ['a post of 89 days ago', 89 * DAY], ['a post of today', 0]] as const) {
        w.setNow(T0 - age);
        await logGateHit(w.ctx, hit(text));
      }
      w.setNow(T0);
      expect(await sweepSaid(w.ctx)).toMatchObject({ shadowPruned: 1, pruned: 0 });
      expect(await left(w)).toEqual([T0 - 89 * DAY, T0]);
      // Inside the hour nothing is asked again; two days on, the row that is now too old goes.
      w.setNow(T0 + 30 * 60_000);
      await logGateHit({ ...w.ctx, now: () => T0 - 200 * DAY }, hit('a row written late for an old time'));
      expect(await sweepSaid(w.ctx)).toMatchObject({ shadowPruned: 0 });
      expect(await left(w)).toHaveLength(3);
      w.setNow(T0 + 2 * DAY);
      expect(await sweepSaid(w.ctx)).toMatchObject({ shadowPruned: 2 });
      expect(await left(w)).toEqual([T0]);
    } finally {
      await w.close();
    }
  });

  it('GATE_SHADOW_KEEP_DAYS=0 keeps every row, and the log is trimmed with the ledger switched off', async () => {
    const keep = await makeWorld({ config: { GATE_SHADOW_KEEP_DAYS: '0' } });
    try {
      await seedAgent(keep);
      keep.setNow(T0 - 400 * DAY);
      await logGateHit(keep.ctx, hit('a very old post'));
      keep.setNow(T0);
      expect(await sweepSaid(keep.ctx)).toMatchObject({ shadowPruned: 0 });
      expect(await left(keep)).toHaveLength(1);
    } finally {
      await keep.close();
    }
    const off = await makeWorld({ config: { SAID_KEEP_DAYS: '0', GATE_SHADOW_KEEP_DAYS: '30' } });
    try {
      await seedAgent(off);
      off.setNow(T0 - 31 * DAY);
      await logGateHit(off.ctx, hit('a post of 31 days ago'));
      off.setNow(T0);
      expect(await sweepSaid(off.ctx)).toEqual({ read: 0, written: 0, done: false, pruned: 0, shadowPruned: 1 });
      expect(await left(off)).toEqual([]);
    } finally {
      await off.close();
    }
  });
});

describe('reading the ledger', () => {
  it('lastOriginals: newest first, a thread as one, replies left out; saidByOthers: the other agents only, inside the window', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const post = (id: string, at: number, text: string, more: Record<string, unknown> = {}, agentId = AGENT_ID, tool = 'publish_post') => recordSaid(w.ctx, { agentId, actionId: id, action: { tool, input: { text, ...more } }, result: { postId: `p_${id}`, ...(more.thread ? { parts: [{ n: 1, postId: `p_${id}` }, { n: 2, postId: `p_${id}_2` }], sent: 2 } : {}) }, at });
      await post('act_1', T0 - 5 * HOUR, HOLDERS);
      await post('act_2', T0 - 4 * HOUR, 'Fee pool: $0.05 WETH.', { thread: [{ text: '6 holders. No trades today.' }] });
      await post('act_3', T0 - 3 * HOUR, 'There are 112 holders.', {}, AGENT_ID, 'publish_reply');
      await post('act_o1', T0 - 2 * HOUR, 'A post of another agent about 40 holders.', {}, '8');
      await post('act_o2', T0 - 50 * HOUR, 'An older post of another agent.', {}, '8');

      const mine = await lastOriginals(w.ctx, AGENT_ID, 20);
      expect(mine.map((o) => [o.actionId, o.opener, o.postId])).toEqual([
        ['act_2', 'fee pool #', 'p_act_2'],
        ['act_1', '# holders the', 'p_act_1'],
      ]);
      expect(mine[0]!.facts).toEqual(expect.arrayContaining([{ s: 'fee', u: '$', v: 0.05 }, { s: 'holders', u: '', v: 6 }]));
      expect((await lastOriginals(w.ctx, AGENT_ID, 1)).map((o) => o.actionId)).toEqual(['act_2']);
      expect((await lastOriginals(w.ctx, AGENT_ID, 20, 'act_2')).map((o) => o.actionId)).toEqual(['act_1']);

      const others = await saidByOthers(w.ctx, AGENT_ID, T0 - 48 * HOUR);
      expect(others.truncated).toBe(false);
      expect(others.posts.map((o) => [o.agentId, o.postId])).toEqual([['8', 'p_act_o1']]);
      expect(others.posts[0]!.words).toContain('holders');
      // The other way round: the two originals and the second post of the thread, and not the reply.
      expect((await saidByOthers(w.ctx, '8', T0 - 48 * HOUR)).posts.map((o) => o.postId)).toEqual(['p_act_2', 'p_act_2_2', 'p_act_1']);
    } finally {
      await w.close();
    }
  });

  it('saidByOthers is bounded by its time, however many posts that is, and says so when it meets its ceiling', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      // 450 posts of 45 other agents inside the 48 hours (more than the 400 rows the read once stopped at), and one before them.
      const rows = Array.from({ length: 450 }, (_, i) => ({ id: `act_m${i}`, agentId: `coin${i % 45}`, actionId: `act_m${i}`, postId: `p_m${i}`, kind: 'original' as const, postedAt: new Date(T0 - (i + 1) * 6 * 60_000), words: ['some', 'words'] }));
      await w.db.insert(said).values([...rows, { id: 'act_before', agentId: 'coin1', actionId: 'act_before', postId: 'p_before', kind: 'original' as const, postedAt: new Date(T0 - 49 * HOUR), words: [] }]);
      const all = await saidByOthers(w.ctx, AGENT_ID, T0 - 48 * HOUR);
      expect(SAID_OTHERS_MAX_ROWS).toBeGreaterThanOrEqual(2000);
      expect(all.truncated).toBe(false);
      expect(all.posts).toHaveLength(450);
      expect(all.posts.at(-1)!.postedAt).toBe(T0 - 45 * HOUR);
      // At the ceiling the newest are read, the oldest of the window are not, and the caller is told.
      const cut = await saidByOthers(w.ctx, AGENT_ID, T0 - 48 * HOUR, 100);
      expect(cut.truncated).toBe(true);
      expect(cut.posts.map((o) => o.postId)).toEqual(Array.from({ length: 100 }, (_, i) => `p_m${i}`));
      expect((await saidByOthers(w.ctx, AGENT_ID, T0 - 48 * HOUR, 450)).truncated).toBe(false);
    } finally {
      await w.close();
    }
  });
});
