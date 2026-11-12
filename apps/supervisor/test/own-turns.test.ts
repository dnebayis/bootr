/**
 * Own agents (docs/design/byo-agent.md sections 1.6, 2 and 13.4): the turn engine. A creator's client opens a turn,
 * feeds it one tool call at a time and closes it; the server keeps every guard. These tests are about the guards that
 * no hosted loop stands in front of any more: what is due, one turn per coin, the step cap, the idle rule, and above
 * all that nothing is ever done twice, whether a client retries, a request is replayed or a process dies mid-step.
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { beginAction, markSent, parseAction, type PendingAction } from '@bootr/agent-core';
import { OWN_ERRORS, type ActResult, type DueView, type OwnErrorBody, type TurnOpen } from '@bootr/shared/own-agent';
import { IMAGE_NOT_FROM_THIS_TURN, ownGuard, postSlotNotDue, readUrlDailyCap, searchDailyCap } from '../src/broker/index.js';
import { fileRequest } from '../src/creator-requests.js';
import { actions, approvals, images, memories, notifications, runtimes } from '../src/db/schema.js';
import { registerOwnRole, type OwnRoleHandler } from '../src/own/registry.js';
import { STALE_MENTION_REASON, TURN_ENDED_ERROR } from '../src/own/turns.js';
import { acquireLease, releaseLease, type Turn } from '../src/runtime.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, seedAgent } from './helpers.js';
import { act, connectClient, finishInput, mention, openSocial, ownWorld, patchState, quietRuntime, runtimeOf, seedOwn, stateOf, turnOf, type OwnWorld } from './own-helpers.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** What X answered on 2026-11-08, as the sender's receipt carries it. */
const FORBIDDEN = 'forbidden(403): You are not permitted to perform this action.';

async function setup(opts: { config?: Record<string, string>; agent?: Record<string, unknown>; quiet?: boolean; mentions?: ReturnType<typeof mention>[] } = {}) {
  const w = await ownWorld({ config: opts.config ?? {} });
  const quiet = opts.quiet ? quietRuntime(w.ctx.now()) : null;
  await seedOwn(w, { config: { ...(quiet?.config ?? {}), ...(opts.agent ?? {}) }, ...(quiet ? { runtime: quiet.runtime } : {}) });
  if (opts.mentions) w.sender.items = opts.mentions;
  const { credential, clientId } = await connectClient(w);
  return { w, credential, clientId };
}

const finish = (w: OwnWorld, credential: string, turnId: string, over: Record<string, unknown> = {}) => w.run<ActResult & OwnErrorBody>('finish', credential, { turnId, ...finishInput(w, over) });
const actionRows = async (w: OwnWorld, tool: string) => (await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => (r.action as { tool?: string }).tool === tool);

describe('own agent: what is due', () => {
  it('says what is due, per role, with the reasons the tick logs, and when to look again', async () => {
    const { w, credential } = await setup({ mentions: [mention('1001')] });
    try {
      const due = await w.run<DueView>('due', credential);
      expect(due.status).toBe(200);
      expect(due.body.coin).toMatchObject({ agentId: AGENT_ID, symbol: 'TEST' });
      expect(due.body.social.on).toBe(true);
      expect(due.body.social.due).toBe(true);
      expect(due.body.social.reasons).toEqual(expect.arrayContaining(['scheduled', 'pending_mention', 'original_post_due']));
      // The treasury and judge roles are another workstream's: with none registered they are simply off.
      expect(due.body.treasury).toEqual({ on: false, due: false, reasons: [], nextAt: null });
      expect(due.body.judge).toEqual({ on: false, due: false, reasons: [], nextAt: null });
      expect(due.body.openTurn).toBeNull();
      expect(due.body.holds).toEqual([]);
      // Something is due now: the next look is the floor, never sooner.
      expect(Date.parse(due.body.nextCheckAt)).toBe(w.ctx.now() + 20_000);
      // Asking is not acting: no turn, no model, nothing published.
      expect(await turnOf(w)).toBeNull();
      expect(w.modelCalls()).toBe(0);
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('refuses a turn when nothing is due, with the time; a turn the creator asks for opens anyway, a few a day, and still may not post', async () => {
    const { w, credential } = await setup({ quiet: true, config: { OWN_FORCED_TURNS_PER_DAY: '2' } });
    try {
      const t0 = w.ctx.now();
      const due = await w.run<DueView>('due', credential);
      expect(due.body.social).toMatchObject({ on: true, due: false, reasons: [] });
      // The next look is when the sender reads mentions again, well before the schedule.
      expect(Date.parse(due.body.nextCheckAt)).toBe(t0 + 5 * MIN);

      const refused = await w.run<OwnErrorBody>('turn', credential, { role: 'social' });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('not_due');
      expect(refused.body.message).toBe(OWN_ERRORS.not_due.message);
      expect(Date.parse(refused.body.retryAt!)).toBeGreaterThan(t0);
      expect(await turnOf(w)).toBeNull();
      // Only the social role can be asked for outside its schedule, and only with the one reason.
      expect((await w.run<OwnErrorBody>('turn', credential, { role: 'treasury', reason: 'creator_asked' })).body.error).toBe('not_due');
      expect((await w.run<OwnErrorBody>('turn', credential, { role: 'social', reason: 'because' })).body.error).toBe('invalid_request');
      expect((await w.run<OwnErrorBody>('turn', credential, { role: 'owner' })).body.error).toBe('invalid_request');

      for (let n = 1; n <= 2; n++) {
        const turn = await openSocial(w, credential, { reason: 'creator_asked' });
        expect(turn.reasons).toEqual(['creator_asked']);
        expect((await turnOf(w))?.own?.forced).toBe(true);
        expect((await stateOf(w)).ownForced).toEqual({ day: '2026-10-24', count: n });
        // It can read; an original post still needs its slot.
        expect((await act(w, credential, turn.turnId, 'read_market')).body.status).toBe('completed');
        const post = await act(w, credential, turn.turnId, 'publish_post', { text: `a post outside the slot ${n}` });
        expect(post.body.status).toBe('failed');
        expect(post.body.error).toMatch(/^post_slot_not_due: /);
        expect((await finish(w, credential, turn.turnId)).body.turnEnded).toBe(true);
      }
      const third = await w.run<OwnErrorBody>('turn', credential, { role: 'social', reason: 'creator_asked' });
      expect(third.status).toBe(429);
      expect(third.body.error).toBe('forced_turns_used');
      expect(third.body.retryAt).toBeDefined();
      expect(w.sender.published).toHaveLength(0);

      // The allowance is per UTC day.
      w.setNow(Date.parse('2026-10-25T00:00:01Z'));
      await patchState(w, { lastPostAt: w.ctx.now() - MIN });
      await w.db.update(runtimes).set({ nextAt: new Date(w.ctx.now() + HOUR) }).where(eq(runtimes.agentId, AGENT_ID));
      await openSocial(w, credential, { reason: 'creator_asked' });
      expect((await stateOf(w)).ownForced).toEqual({ day: '2026-10-25', count: 1 });
    } finally {
      await w.close();
    }
  });

  it('a creator request still open after a switch is a reason of its own, and is shown to the turn', async () => {
    const { w, credential } = await setup({ quiet: true });
    try {
      const request = await fileRequest(w.ctx, AGENT_ID, { text: 'Post about the new coin page tomorrow morning.', turn: 'social' });
      const due = await w.run<DueView>('due', credential);
      expect(due.body.social).toMatchObject({ due: true, reasons: ['creator_request'] });
      const turn = await openSocial(w, credential);
      expect(turn.reasons).toEqual(['creator_request']);
      expect(JSON.stringify(turn.observation.creatorRequests)).toContain(request.id);
      // The request lets an original post out although no slot is due.
      const post = await act(w, credential, turn.turnId, 'publish_post', { text: 'The coin page got a new look this week. Have a look around.' });
      expect(post.body.status).toBe('completed');
      expect(w.sender.published).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});

describe('own agent: one turn per coin', () => {
  it('opens a turn with the brief, the hosted observation and its tools, and stores no conversation', async () => {
    const { w, credential, clientId } = await setup({ mentions: [mention('1001')] });
    try {
      const turn = await openSocial(w, credential);
      expect(turn.turnId).toMatch(/^otn_[0-9a-f]{32}$/);
      expect(turn).toMatchObject({ role: 'social', resumed: false, stepBudget: 8, stepsUsed: 0 });
      expect(Date.parse(turn.expiresAt)).toBe(w.ctx.now() + 10 * MIN);
      expect(turn.brief).toContain('You are the social voice of Test Coin ($TEST) on X as @bootr_agent');
      expect(turn.brief).toContain('BOOTR RULES');
      // No economy mode: the client's model is the only mind.
      expect(turn.brief).not.toContain('ECONOMY MODE');
      const social = turn.observation.social as { messages: { postId: string }[]; originalPost: { due: boolean } };
      expect(social.messages.map((m) => m.postId)).toEqual(['1001']);
      expect(social.originalPost.due).toBe(true);
      expect(turn.observation.instructionAuthority).toBe(false);
      expect(turn.observation.stepBudget).toBe(8);
      // The MCP names: every catalog tool the powers allow, finish, and never generate_image.
      expect(turn.tools).toEqual(expect.arrayContaining(['bootr_agent_read_mentions', 'bootr_agent_publish_post', 'bootr_agent_publish_reply', 'bootr_agent_treasury_read', 'bootr_agent_finish']));
      expect(turn.tools).not.toContain('bootr_agent_generate_image');
      expect(turn.tools).not.toContain('bootr_agent_upload_picture');
      expect(turn.tools.filter((t) => t === 'bootr_agent_finish')).toHaveLength(1);
      // Nothing private in what the client is handed.
      const text = JSON.stringify(turn);
      expect(text).not.toContain(credential);
      expect(text).not.toMatch(/rpc\.test|sender\.test|inference\.test/);

      const stored = (await turnOf(w))!;
      expect(stored.messages).toEqual([]);
      expect(stored.own).toMatchObject({ turnId: turn.turnId, clientId, forced: false });
      expect(stored.postDue).toBe(true);
      const runtime = await runtimeOf(w);
      expect(runtime.status).toBe('running');
      expect(runtime.leaseToken).toBeNull();
      expect(runtime.lastDecisionRevision).toBe(1);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('the same role gets the open turn back as it was opened; another role is told a turn is open', async () => {
    const { w, credential } = await setup({ mentions: [mention('1001')] });
    try {
      // A second role, standing in for the treasury turn another workstream registers.
      const opened: string[] = [];
      const treasury: OwnRoleHandler = {
        role: 'treasury',
        due: async () => ({ on: true, due: true, reasons: ['treasury_interval'], nextAt: null }),
        open: async (call, opts) => {
          opened.push('treasury');
          const turn: Turn = { role: 'treasury', startedAt: call.now, steps: 0, nudged: false, reasons: opts.reasons, messages: [], inbox: {}, recentSteps: [] };
          return { turn, brief: 'treasury brief', observation: { role: 'treasury' }, tools: ['treasury_read', 'finish'] };
        },
        finish: async () => ({ result: { checkpointed: true } }),
      };
      registerOwnRole(treasury);

      const first = await openSocial(w, credential);
      await act(w, credential, first.turnId, 'read_market');
      w.setNow(w.ctx.now() + 3 * MIN);
      // A second client of the same coin (or the same one after a restart) asks for the same role.
      const other = await connectClient(w, { label: 'second machine' });
      const again = await openSocial(w, other.credential);
      expect(again.resumed).toBe(true);
      expect(again.turnId).toBe(first.turnId);
      expect(again.stepsUsed).toBe(1);
      expect(again.observation).toEqual(first.observation);
      expect(again.brief).toBe(first.brief);
      // Asking again is a call: the idle clock starts over.
      expect(Date.parse(again.expiresAt)).toBe(w.ctx.now() + 10 * MIN);

      const refused = await w.run<OwnErrorBody>('turn', credential, { role: 'treasury' });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('turn_open');
      expect(refused.body.retryAt).toBe(again.expiresAt);
      expect(opened).toEqual([]);
      const due = await w.run<DueView>('due', credential);
      expect(due.body.openTurn).toEqual({ turnId: first.turnId, role: 'social', expiresAt: again.expiresAt });
      expect(due.body.social).toEqual({ on: true, due: true, reasons: ['continuation'], nextAt: null });
      expect(due.body.treasury.due).toBe(true);

      // A social turn never holds what its role does not: the treasury turn's tool list is its own.
      expect((await finish(w, credential, first.turnId)).body.status).toBe('completed');
      const t = await w.run<TurnOpen>('turn', credential, { role: 'treasury' });
      expect(t.body.role).toBe('treasury');
      expect(t.body.tools).toEqual(['bootr_agent_treasury_read', 'bootr_agent_finish']);
      const x = await act(w, credential, t.body.turnId, 'publish_post', { text: 'a post from the treasury turn' });
      expect(x.status).toBe(409);
      expect((x.body as unknown as OwnErrorBody).error).toBe('tool_unavailable');
      const read = await act(w, credential, t.body.turnId, 'treasury_read');
      expect(read.body.status).toBe('completed');
      // The treasury turn's rows carry their role, like a hosted treasury turn's.
      expect(((await actionRows(w, 'treasury_read'))[0]!.action as { role?: string }).role).toBe('treasury');
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('refuses a tool that is not part of the turn, and an input that is not valid, before anything runs', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      for (const tool of ['generate_image', 'bounty_post', 'x402_fetch', 'upload_picture', 'make_coffee']) {
        const res = await act(w, credential, turn.turnId, tool, { prompt: 'a fox', altText: 'a fox' });
        expect([tool, res.status, (res.body as unknown as OwnErrorBody).error]).toEqual([tool, 409, 'tool_unavailable']);
      }
      const invalid = await act(w, credential, turn.turnId, 'publish_reply', { text: 'no post id' });
      expect(invalid.status).toBe(400);
      const body = invalid.body as unknown as OwnErrorBody;
      expect(body.error).toBe('invalid_tool_call');
      expect(body.message.startsWith(OWN_ERRORS.invalid_tool_call.message)).toBe(true);
      expect(body.field).toBe('postId');
      expect((await w.run<OwnErrorBody>('act', credential, { turnId: turn.turnId, tool: 'publish_post', input: 'text' })).body.error).toBe('invalid_request');
      expect((await w.run<OwnErrorBody>('act', credential, { turnId: turn.turnId, tool: '../etc', input: {} })).body.error).toBe('invalid_request');
      // None of it was a step, an action row or a post.
      expect((await turnOf(w))?.steps).toBe(0);
      expect((await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => 'tool' in r.action)).toHaveLength(0);
      expect(w.sender.published).toHaveLength(0);
      // A power the creator turns off mid-turn takes its tools with it.
      const config = (await w.db.query.agents.findFirst())!.config as { capabilities: Record<string, boolean> };
      await (await import('./own-helpers.js')).patchConfig(w, { capabilities: { ...config.capabilities, xPublish: false } });
      expect(((await act(w, credential, turn.turnId, 'publish_post', { text: 'after the power went off' })).body as unknown as OwnErrorBody).error).toBe('tool_unavailable');
    } finally {
      await w.close();
    }
  });

  it('runs nothing while the agent is paused, by the creator or the platform', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      await w.db.update(runtimes).set({ status: 'paused', pausedBy: 'guardian' }).where(eq(runtimes.agentId, AGENT_ID));
      for (const [op, body] of [
        ['act', { turnId: turn.turnId, tool: 'publish_post', input: { text: 'posted while paused' } }],
        ['finish', { turnId: turn.turnId, ...finishInput(w) }],
        ['turn', { role: 'social' }],
      ] as const) {
        const res = await w.run<OwnErrorBody>(op, credential, body);
        expect([op, res.status, res.body.error]).toEqual([op, 409, 'agent_paused']);
      }
      const due = await w.run<DueView>('due', credential);
      expect(due.body.social.due).toBe(false);
      expect(due.body.holds.map((h) => h.reason)).toEqual(['paused_by_creator']);
      expect(w.sender.published).toHaveLength(0);
      // The idle rule still closes the turn, and leaves the pause alone.
      w.setNow(w.ctx.now() + 11 * MIN);
      await w.run<DueView>('due', credential);
      const runtime = await runtimeOf(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.status).toBe('paused');
    } finally {
      await w.close();
    }
  });
});

describe('own agent: nothing is done twice', () => {
  it('a retried call returns the same action and sends nothing twice; a read is simply read again', async () => {
    const { w, credential, clientId } = await setup({ mentions: [mention('1001')] });
    try {
      const turn = await openSocial(w, credential);
      const reply = { postId: '1001', text: 'It is the coin of a small test agent that posts about its day.' };
      const first = await act(w, credential, turn.turnId, 'publish_reply', reply);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ turnId: turn.turnId, tool: 'publish_reply', status: 'completed', stepsUsed: 1, stepsLeft: 7, turnEnded: false });
      expect(first.body.actionId).toMatch(/^act_[0-9a-f]{32}$/);
      expect(w.sender.published).toHaveLength(1);

      // The answer was lost on the way: the client sends the same call again, and again.
      for (let n = 0; n < 3; n++) {
        const again = await act(w, credential, turn.turnId, 'publish_reply', reply);
        expect(again.status).toBe(200);
        expect(again.body).toEqual(first.body);
      }
      expect(w.sender.published).toHaveLength(1);
      expect(await actionRows(w, 'publish_reply')).toHaveLength(1);
      expect((await turnOf(w))?.steps).toBe(1);

      // The same holds for a post and for a note, later in the turn and out of order: a replayed request repeats nothing.
      const post = { text: 'Good morning from the test coin. Nothing to report but a clear sky.' };
      const posted = await act(w, credential, turn.turnId, 'publish_post', post);
      expect(posted.body.status).toBe('completed');
      const note = { text: 'user42 asked what the coin does on 2026-10-24' };
      const noted = await act(w, credential, turn.turnId, 'remember', note);
      expect((await act(w, credential, turn.turnId, 'publish_reply', reply)).body.actionId).toBe(first.body.actionId);
      expect((await act(w, credential, turn.turnId, 'publish_post', post)).body.actionId).toBe(posted.body.actionId);
      expect((await act(w, credential, turn.turnId, 'remember', note)).body.actionId).toBe(noted.body.actionId);
      expect(w.sender.published).toHaveLength(2);
      expect(await w.db.select().from(memories)).toHaveLength(1);
      expect((await turnOf(w))?.steps).toBe(3);

      // A read is not an act: it runs again and is a step of its own.
      const r1 = await act(w, credential, turn.turnId, 'read_market');
      const r2 = await act(w, credential, turn.turnId, 'read_market');
      expect(r2.body.actionId).not.toBe(r1.body.actionId);
      expect(r2.body.stepsUsed).toBe(5);

      // Every row says who thought, and which client.
      const row = (await actionRows(w, 'publish_reply'))[0]!;
      expect(row.action).toMatchObject({ tool: 'publish_reply', via: 'own', clientId });
      expect(row.status).toBe('completed');
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('a finish that already closed the turn is answered again from its row; anything else with that id is told the turn is over', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      const input = finishInput(w, { memory: 'kept', agenda: 'next: say good morning', summary: 'a quiet turn' });
      const done = await w.run<ActResult>('finish', credential, { turnId: turn.turnId, ...input });
      expect(done.body).toMatchObject({ tool: 'finish', status: 'completed', turnEnded: true, stepsUsed: 1 });
      const state = await stateOf(w);
      expect(state).toMatchObject({ memory: 'kept', agenda: 'next: say good morning', summary: 'a quiet turn', phase: 'social' });
      expect(state.ownLastTurnAt).toBe(w.ctx.now());
      // The post slot was due and passed on: it is spent, as for a hosted turn.
      expect(state.lastSlotSkippedAt).toBe(w.ctx.now());
      const runtime = await runtimeOf(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.status).toBe('waiting');
      // The wake is the cadence floor, not what the client asked for.
      expect(runtime.nextAt.getTime()).toBeGreaterThan(w.ctx.now() + HOUR);

      const again = await w.run<ActResult>('finish', credential, { turnId: turn.turnId, ...input });
      expect(again.status).toBe(200);
      expect(again.body).toEqual(done.body);
      expect(await actionRows(w, 'finish')).toHaveLength(1);
      // Another checkpoint for the closed turn changes nothing.
      const other = await w.run<OwnErrorBody>('finish', credential, { turnId: turn.turnId, ...input, memory: 'rewritten after the fact' });
      expect(other.status).toBe(410);
      expect(other.body.error).toBe('turn_closed');
      expect(((await act(w, credential, turn.turnId, 'publish_post', { text: 'a post after the end' })).body as unknown as OwnErrorBody).error).toBe('turn_closed');
      expect((await stateOf(w)).memory).toBe('kept');
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('a finish that is not a checkpoint is refused, one the role refuses fails as a result, and either way the turn stays open', async () => {
    const { w, credential } = await setup();
    try {
      // A role whose checkpoint can be refused, standing in for one another workstream registers.
      let refuse = true;
      registerOwnRole({
        role: 'treasury',
        due: async () => ({ on: true, due: true, reasons: ['treasury_interval'], nextAt: null }),
        open: async (call, opts) => ({ turn: { role: 'treasury', startedAt: call.now, steps: 0, nudged: false, reasons: opts.reasons, messages: [], inbox: {}, recentSteps: [] }, brief: 'b', observation: {}, tools: ['treasury_read'] }),
        finish: async (call) => {
          if (refuse) throw new Error('checkpoint_too_large: keep concise notes and archive details with remember');
          call.state.treasuryNextAt = call.now + HOUR;
          return { result: { checkpointed: true } };
        },
      });
      const turn = await w.run<TurnOpen>('turn', credential, { role: 'treasury' });
      const before = await runtimeOf(w);
      const shape = await w.run<OwnErrorBody>('finish', credential, { turnId: turn.body.turnId, memory: 42 });
      expect(shape.status).toBe(400);
      expect(shape.body.error).toBe('invalid_tool_call');
      expect((await w.run<OwnErrorBody>('finish', credential, { turnId: turn.body.turnId, ...finishInput(w, { nextAt: 'tomorrow-ish' }) })).body.error).toBe('invalid_tool_call');
      expect((await turnOf(w))?.steps).toBe(0);

      const bad = await finish(w, credential, turn.body.turnId);
      expect(bad.status).toBe(200);
      expect(bad.body).toMatchObject({ tool: 'finish', status: 'failed', turnEnded: false, stepsUsed: 1, error: 'checkpoint_too_large: keep concise notes and archive details with remember' });
      expect((await turnOf(w))?.own?.turnId).toBe(turn.body.turnId);
      expect((await runtimeOf(w)).pending).toBeNull();
      refuse = false;
      const done = await finish(w, credential, turn.body.turnId);
      expect(done.body).toMatchObject({ status: 'completed', turnEnded: true, stepsUsed: 2 });
      // A role that names no wake leaves the social schedule where it was.
      const after = await runtimeOf(w);
      expect(after.nextAt.getTime()).toBe(before.nextAt.getTime());
      expect(after.lastDecisionAt?.getTime()).toBe(before.lastDecisionAt?.getTime());
      expect((await stateOf(w)).treasuryNextAt).toBe(w.ctx.now() + HOUR);
      expect((await actionRows(w, 'finish')).map((r) => [r.status, (r.action as { role?: string }).role])).toEqual([['failed', 'treasury'], ['completed', 'treasury']]);
    } finally {
      await w.close();
    }
  });

  it('while the tick or another call holds the runtime, a call is refused whole and may be repeated', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      expect(await acquireLease(w.ctx, AGENT_ID, 'the-tick')).not.toBeNull();
      for (const [op, body] of [
        ['act', { turnId: turn.turnId, tool: 'publish_post', input: { text: 'a post while the tick holds the lease' } }],
        ['finish', { turnId: turn.turnId, ...finishInput(w) }],
        ['turn', { role: 'social' }],
        ['due', {}],
      ] as const) {
        const res = await w.run<OwnErrorBody>(op, credential, body);
        expect([op, res.status, res.body.error]).toEqual([op, 409, 'runtime_busy']);
        expect(Date.parse(res.body.retryAt!)).toBeGreaterThan(w.ctx.now());
      }
      expect(w.sender.published).toHaveLength(0);
      expect((await turnOf(w))?.steps).toBe(0);
      await releaseLease(w.ctx, AGENT_ID, 'the-tick');
      expect((await act(w, credential, turn.turnId, 'publish_post', { text: 'a post once the lease is free' })).body.status).toBe('completed');
      expect(w.sender.published).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('while an outcome is unknown only that same call may be repeated; any other is runtime_busy', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      // The note store drops the connection once: whether the note was written is not known.
      const remember = w.ctx.memories.remember.bind(w.ctx.memories);
      let fail = true;
      w.ctx.memories.remember = async (...args: Parameters<typeof remember>) => {
        if (fail) {
          fail = false;
          throw new Error('fetch failed');
        }
        return remember(...args);
      };
      const note = { text: 'the coin page got a new look on 2026-10-24' };
      const first = await act(w, credential, turn.turnId, 'remember', note);
      expect(first.body).toMatchObject({ status: 'pending', turnEnded: false, stepsUsed: 1 });
      expect(first.body.retryAt).toBeDefined();
      expect((await runtimeOf(w)).pending).toMatchObject({ status: 'sent', id: first.body.actionId });

      const other = await act(w, credential, turn.turnId, 'publish_post', { text: 'another call while the first is unsettled' });
      expect(other.status).toBe(409);
      expect((other.body as unknown as OwnErrorBody).error).toBe('runtime_busy');
      expect((other.body as unknown as OwnErrorBody).retryAt).toBe(first.body.retryAt);
      expect(((await finish(w, credential, turn.turnId)).body as OwnErrorBody).error).toBe('runtime_busy');
      expect(w.sender.published).toHaveLength(0);

      // Too soon: still pending, nothing sent again. After the wait the same call goes through, as one step.
      expect((await act(w, credential, turn.turnId, 'remember', note)).body.status).toBe('pending');
      w.setNow(Date.parse(first.body.retryAt!) + 1);
      const settled = await act(w, credential, turn.turnId, 'remember', note);
      expect(settled.body).toMatchObject({ status: 'completed', actionId: first.body.actionId, stepsUsed: 1 });
      expect(await w.db.select().from(memories)).toHaveLength(1);
      expect((await runtimeOf(w)).pending).toBeNull();
      expect((await act(w, credential, turn.turnId, 'publish_post', { text: 'now the turn goes on' })).body.status).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('a publish that was sent before the process died is answered from its receipt, never sent again', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      // The state a crash leaves: the action marked sent and stored, its outcome never recorded.
      const runtime = await runtimeOf(w);
      const action = parseAction({ tool: 'publish_post', input: { text: 'Good morning from the test coin, written just before the crash.' } });
      const pending: PendingAction = markSent(beginAction({ runtimeId: AGENT_ID, cycle: runtime.cycle, pending: null }, action, runtime.cycle, w.ctx.now()));
      const stored = (await turnOf(w))!;
      await w.db.insert(actions).values({ actionId: pending.id, agentId: AGENT_ID, cycleKey: pending.cycleKey, action: { ...action, via: 'own' }, status: 'sending', createdAt: new Date(w.ctx.now()), updatedAt: new Date(w.ctx.now()) });
      await w.db.update(runtimes).set({ pending: pending as unknown as Record<string, unknown>, turn: { ...stored, steps: 1 } as unknown as Record<string, unknown> }).where(eq(runtimes.agentId, AGENT_ID));
      // The sender did send it.
      w.sender.receipts[pending.id] = { status: 'sent', providerPostId: '9100' };

      const retried = await act(w, credential, turn.turnId, 'publish_post', action.input as Record<string, unknown>);
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ status: 'completed', actionId: pending.id, stepsUsed: 1 });
      expect((retried.body.result as { postId?: string }).postId).toBe('9100');
      // Not one publish request left this process.
      expect(w.sender.published).toHaveLength(0);
      expect((await runtimeOf(w)).pending).toBeNull();
      // The slot is spent by it, and the same call once more is still the same action.
      expect((await stateOf(w)).lastPostAt).toBe(pending.createdAt);
      expect((await act(w, credential, turn.turnId, 'publish_post', action.input as Record<string, unknown>)).body.actionId).toBe(pending.id);
      const second = await act(w, credential, turn.turnId, 'publish_post', { text: 'A second original post in the same slot.' });
      expect(second.body.error).toMatch(/^post_slot_not_due: /);
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('a held publish ends the turn, blocks the next one, and is settled by the tick from its receipt', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      // The sender does not know whether X took the post.
      w.sender.publishStatus = 'held';
      const held = await act(w, credential, turn.turnId, 'publish_post', { text: 'Good morning from the test coin. The sky is clear.' });
      expect(held.status).toBe(200);
      expect(held.body).toMatchObject({ status: 'held', turnEnded: true });
      expect(held.body.error).toBe('sender_held');
      let runtime = await runtimeOf(w);
      expect(runtime.status).toBe('held');
      expect(runtime.turn).toBeNull();
      expect(runtime.pending).toMatchObject({ status: 'held', id: held.body.actionId });
      expect((await actionRows(w, 'publish_post'))[0]!.status).toBe('held');

      // Nothing opens and nothing is due until it settles; the old turn is over.
      const blocked = await w.run<OwnErrorBody>('turn', credential, { role: 'social' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe('held_action');
      const due = await w.run<DueView>('due', credential);
      expect(due.body.social.due).toBe(false);
      expect(due.body.holds.map((h) => h.reason)).toContain('held_action');
      expect(((await act(w, credential, turn.turnId, 'publish_post', { text: 'the same post, tried again by hand' })).body as unknown as OwnErrorBody).error).toBe('turn_closed');
      expect(w.sender.published).toHaveLength(1);

      // The receipt arrives: the tick settles the action whether or not the client is still there.
      w.sender.receipts[held.body.actionId!] = { status: 'sent', providerPostId: '9200' };
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      expect(report.ran).toEqual([]);
      runtime = await runtimeOf(w);
      expect(runtime.status).toBe('waiting');
      expect(runtime.pending).toMatchObject({ status: 'completed' });
      expect((await actionRows(w, 'publish_post'))[0]!.status).toBe('completed');

      // The next turn opens once it settled, and finds the slot used: the post is not made up for.
      w.setNow(w.ctx.now() + 6 * MIN);
      const next = await openSocial(w, credential);
      expect(next.turnId).not.toBe(turn.turnId);
      expect((await runtimeOf(w)).pending).toBeNull();
      expect((await stateOf(w)).lastPostAt).toBeGreaterThan(0);
      const second = await act(w, credential, next.turnId, 'publish_post', { text: 'Good morning again, in case the first one was lost.' });
      expect(second.body.status).toBe('failed');
      expect(second.body.error).toMatch(/^post_slot_not_due: /);
      expect(w.sender.published).toHaveLength(1);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });
});

describe('own agent: the step cap and the idle rule', () => {
  it('a turn has the hosted step budget; past it only finish is taken', async () => {
    const { w, credential } = await setup({ config: { MAX_TOOL_STEPS: '3' } });
    try {
      const turn = await openSocial(w, credential);
      expect(turn.stepBudget).toBe(3);
      for (let n = 1; n <= 3; n++) {
        const res = await act(w, credential, turn.turnId, 'read_market');
        expect(res.body).toMatchObject({ status: 'completed', stepsUsed: n, stepsLeft: 3 - n, turnEnded: false });
      }
      const over = await act(w, credential, turn.turnId, 'publish_post', { text: 'one step too many' });
      expect(over.status).toBe(409);
      expect((over.body as unknown as OwnErrorBody).error).toBe('step_cap');
      expect((over.body as unknown as OwnErrorBody).message).toBe(OWN_ERRORS.step_cap.message);
      expect(w.sender.published).toHaveLength(0);
      expect(await actionRows(w, 'publish_post')).toHaveLength(0);
      const done = await finish(w, credential, turn.turnId);
      expect(done.body).toMatchObject({ status: 'completed', turnEnded: true, stepsLeft: 0 });
    } finally {
      await w.close();
    }
  });

  it('a turn idle for ten minutes is closed like a cut-short turn: a continuation note, no checkpoint, and its id says so', async () => {
    const { w, credential } = await setup({ mentions: [mention('1001')] });
    try {
      await patchState(w, { memory: 'before', agenda: 'before', summary: 'before' });
      const turn = await openSocial(w, credential);
      await act(w, credential, turn.turnId, 'read_market');
      w.setNow(w.ctx.now() + 9 * MIN);
      expect((await act(w, credential, turn.turnId, 'read_market')).body.status).toBe('completed');
      w.setNow(w.ctx.now() + 10 * MIN);
      const late = await act(w, credential, turn.turnId, 'publish_post', { text: 'a post from a turn that ran out' });
      expect(late.status).toBe(410);
      expect((late.body as unknown as OwnErrorBody).error).toBe('turn_expired');
      expect(w.sender.published).toHaveLength(0);
      const runtime = await runtimeOf(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.status).toBe('waiting');
      const state = await stateOf(w);
      // No checkpoint was written; the next turn is told where this one stopped.
      expect(state).toMatchObject({ memory: 'before', agenda: 'before', summary: 'before' });
      expect(state.continuation?.progress).toBe('Turn ended by the runtime (expired). Continue from the agenda.');
      expect(state.continuation?.recentSteps.map((s) => s.tool)).toEqual(['read_market', 'read_market']);
      expect(state.ownLastTurnAt).toBe(w.ctx.now());
      // What it had in front of it is no reason to open another turn at once.
      expect(state.runtimeEnded).toMatchObject({ postIds: ['1001'], postDue: true });
      expect(((await finish(w, credential, turn.turnId)).body as OwnErrorBody).error).toBe('turn_expired');
      expect((await w.run<OwnErrorBody>('turn', credential, { role: 'social' })).body.error).toBe('not_due');
      w.setNow(w.ctx.now() + 5 * MIN + 1);
      const next = await openSocial(w, credential);
      expect(next.observation.continuation).toMatchObject({ progress: 'Turn ended by the runtime (expired). Continue from the agenda.' });
    } finally {
      await w.close();
    }
  });

  it('a turn kept busy is still closed after thirty minutes, and the tick closes one whose client is gone', async () => {
    const { w, credential } = await setup({ config: { MAX_TOOL_STEPS: '20' } });
    try {
      const turn = await openSocial(w, credential);
      for (let n = 0; n < 5; n++) {
        w.setNow(w.ctx.now() + 5 * MIN + 59_000);
        expect((await act(w, credential, turn.turnId, 'read_market')).body.status).toBe('completed');
      }
      w.setNow(w.ctx.now() + MIN);
      expect(((await act(w, credential, turn.turnId, 'read_market')).body as unknown as OwnErrorBody).error).toBe('turn_expired');

      // A second turn; this time the client simply never comes back.
      w.setNow(w.ctx.now() + 6 * MIN);
      const left = await openSocial(w, credential);
      await tick(w.ctx);
      expect((await turnOf(w))?.own?.turnId).toBe(left.turnId);
      w.setNow(w.ctx.now() + 10 * MIN);
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      const runtime = await runtimeOf(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.status).toBe('waiting');
      expect((await stateOf(w)).ownClosed).toMatchObject({ turnId: left.turnId, why: 'expired' });
      expect(((await act(w, credential, left.turnId, 'read_market')).body as unknown as OwnErrorBody).error).toBe('turn_expired');
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('an action whose outcome was still unknown when its turn ran out is closed with the turn, so the next turn is not blocked', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      w.ctx.memories.remember = async () => {
        throw new Error('fetch failed');
      };
      const first = await act(w, credential, turn.turnId, 'remember', { text: 'a note that never got an answer' });
      expect(first.body.status).toBe('pending');
      w.setNow(w.ctx.now() + 11 * MIN);
      await tick(w.ctx);
      const runtime = await runtimeOf(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.pending).toBeNull();
      const row = (await actionRows(w, 'remember'))[0]!;
      expect(row.status).toBe('failed');
      expect((row.result as { error?: string }).error).toBe(TURN_ENDED_ERROR);
      w.setNow(w.ctx.now() + 6 * MIN);
      expect((await openSocial(w, credential)).turnId).not.toBe(turn.turnId);
    } finally {
      await w.close();
    }
  });
});

describe('own agent: the hosted guards hold', () => {
  it('the sender\'s quota refusal sets the quota hold, a 403 sets the forbidden hold and tells the creator, as for a hosted agent', async () => {
    const { w, credential } = await setup({ mentions: [mention('1001')] });
    try {
      const retryAt = new Date(w.ctx.now() + 5 * HOUR).toISOString();
      const turn = await openSocial(w, credential);
      w.sender.quotaExceeded = retryAt;
      const post = await act(w, credential, turn.turnId, 'publish_post', { text: 'Good morning from the test coin.' });
      expect(post.body).toMatchObject({ status: 'failed', error: 'sender:quota_exceeded' });
      let state = await stateOf(w);
      expect(state.postQuotaUntil).toBe(Date.parse(retryAt));
      expect(state.postHoldEndedNote).toMatchObject({ reason: 'x_quota', until: Date.parse(retryAt), at: null });
      // The slot is kept, not spent: the post was held, not passed on.
      expect((await turnOf(w))?.postHeld).toBe(true);
      await finish(w, credential, turn.turnId);
      expect((await stateOf(w)).lastSlotSkippedAt ?? null).toBeNull();
      const due = await w.run<DueView>('due', credential);
      expect(due.body.holds).toEqual([expect.objectContaining({ reason: 'x_quota', until: retryAt })]);
      expect(due.body.social.due).toBe(false);

      // The quota opens; X now refuses the account itself.
      w.sender.quotaExceeded = null;
      w.setNow(Date.parse(retryAt) + MIN);
      const second = await openSocial(w, credential);
      expect(String(second.observation.holdEnded)).toMatch(/^x_hold_ended: your X posting quota opened again/);
      w.sender.publishError = FORBIDDEN;
      const refused = await act(w, credential, second.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' });
      expect(refused.body.status).toBe('failed');
      expect(refused.body.error).toContain('forbidden(403)');
      state = await stateOf(w);
      expect(state.postForbiddenStrikes).toBe(1);
      expect(state.postForbiddenUntil).toBe(w.ctx.now() + 6 * HOUR);
      expect((await w.db.select().from(notifications)).map((n) => n.event)).toContain('x_forbidden');
      await finish(w, credential, second.turnId);
      expect((await w.run<DueView>('due', credential)).body.holds.map((h) => h.reason)).toEqual(['x_forbidden']);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('approval mode queues a publish exactly as for a hosted agent, and the own guards still come first', async () => {
    const { w, credential } = await setup({ agent: { requireApproval: true }, mentions: [mention('1001')] });
    try {
      const turn = await openSocial(w, credential);
      expect(turn.observation.review).toMatchObject({ enabled: true, pending: 0 });
      const post = await act(w, credential, turn.turnId, 'publish_post', { text: 'Good morning from the test coin. The creator reads this first.' });
      expect(post.body.status).toBe('completed');
      expect(post.body.result).toMatchObject({ queued: true, status: 'pending_approval', approvalId: post.body.actionId });
      const reply = await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' });
      expect(reply.body.result).toMatchObject({ queued: true });
      // Nothing reached the sender; both wait in the creator's queue.
      expect(w.sender.published).toHaveLength(0);
      const queue = await w.db.select().from(approvals);
      expect(queue.map((a) => [a.kind, a.status]).sort()).toEqual([['post', 'pending_approval'], ['reply', 'pending_approval']]);
      // A queued post counts as the slot's post: a second one is refused before it is queued.
      const second = await act(w, credential, turn.turnId, 'publish_post', { text: 'A second original post for the same slot.' });
      expect(second.body.status).toBe('failed');
      expect(second.body.error).toMatch(/^post_slot_not_due: /);
      // ...and so is a post carrying a picture from before this turn.
      await w.db.insert(images).values({ id: 'img_old', agentId: AGENT_ID, actionId: 'act_old', alt: 'an old picture', mime: 'image/png', bytes: Buffer.from([1, 2, 3]), sizeBytes: 3, model: 'upload', createdAt: new Date(w.ctx.now() - HOUR) });
      const old = await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'Here is a picture from last week.', imageId: 'img_old' });
      expect(old.body).toMatchObject({ status: 'failed', error: IMAGE_NOT_FROM_THIS_TURN });
      expect(await w.db.select().from(approvals)).toHaveLength(2);
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('an original post needs a due slot: one per slot, none in a turn opened for a mention, replies still go out', async () => {
    const { w, credential } = await setup({ quiet: true, mentions: [mention('1001')] });
    try {
      // Opened for a mention; the post slot is not due.
      const turn = await openSocial(w, credential);
      expect(turn.reasons).toEqual(['pending_mention']);
      const post = await act(w, credential, turn.turnId, 'publish_post', { text: 'An original post nobody scheduled.' });
      expect(post.status).toBe(200);
      expect(post.body.status).toBe('failed');
      const nextSlot = Date.parse((turn.observation.social as { originalPost: { nextAt: string } }).originalPost.nextAt);
      expect(post.body.error).toBe(postSlotNotDue(nextSlot));
      expect(post.body.error).toBe(`post_slot_not_due: an original post needs a due slot or an open request from your creator; your next slot is at ${new Date(nextSlot).toISOString()}. Replies may still go out.`);
      expect((await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' })).body.status).toBe('completed');
      expect(w.sender.published).toHaveLength(1);
      await finish(w, credential, turn.turnId);

      // The slot comes due: exactly one original post goes out in it.
      w.setNow(nextSlot + MIN);
      const dueTurn = await openSocial(w, credential);
      expect(dueTurn.reasons).toContain('original_post_due');
      expect((await act(w, credential, dueTurn.turnId, 'publish_post', { text: 'Good morning from the test coin. The sky is clear.' })).body.status).toBe('completed');
      const second = await act(w, credential, dueTurn.turnId, 'publish_post', { text: 'And one more, to catch up on yesterday.' });
      expect(second.body.status).toBe('failed');
      expect(second.body.error).toMatch(/^post_slot_not_due: /);
      expect(w.sender.published).toHaveLength(2);
      expect((await stateOf(w)).lastPostAt).toBe(w.ctx.now());
    } finally {
      await w.close();
    }
  });

  it('a hosted agent is never held to the own guards', async () => {
    const w = await ownWorld();
    try {
      const agent = await seedAgent(w);
      const pending = { id: 'act_x', cycleKey: 'cycle:x', action: { tool: 'publish_post', input: { text: 'a hosted post' } }, status: 'sent', createdAt: 0, attempts: 1 } as unknown as PendingAction;
      const { executeAction } = await import('../src/broker/index.js');
      const config = (await import('../src/onboarding.js')).agentConfigOf(agent)!;
      // No turn on record at all: a hosted publish goes to the sender as it always did.
      expect((await executeAction(w.ctx, agent, config, pending, { inbox: new Map(), eligibility: new Map() })).kind).toBe('completed');
      expect(w.sender.published).toHaveLength(1);
      // The same call for an own coin without a turn on record is refused: the guard fails closed.
      const own = { ...agent, config: { ...agent.config, runner: 'own' } };
      const refused = await executeAction(w.ctx, own, config, { ...pending, id: 'act_y' }, { inbox: new Map(), eligibility: new Map() });
      expect(refused).toMatchObject({ kind: 'failed' });
      expect(w.sender.published).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('counts an own coin\'s page reads and web searches per day', async () => {
    const { w, credential } = await setup({ config: { OWN_READ_URL_PER_DAY: '2', OWN_SEARCH_PER_DAY: '1' } });
    try {
      const now = w.ctx.now();
      const row = (id: string, tool: string, at: number) => ({ actionId: id, agentId: AGENT_ID, cycleKey: `cycle:${id}`, action: { tool, input: {} }, status: 'completed' as const, createdAt: new Date(at), updatedAt: new Date(at) });
      // One read an hour ago, one two days ago (outside the window), and another coin's reads.
      await w.db.insert(actions).values([row('act_r1', 'read_url', now - HOUR), row('act_r0', 'read_url', now - 2 * DAY), { ...row('act_o1', 'read_url', now - HOUR), agentId: '8' }, { ...row('act_o2', 'read_url', now - HOUR), agentId: '8' }]);
      const turn = await openSocial(w, credential);
      const first = await act(w, credential, turn.turnId, 'read_url', { url: 'https://example.com/a' });
      expect(first.body.error ?? '').not.toMatch(/daily_cap/);
      const second = await act(w, credential, turn.turnId, 'read_url', { url: 'https://example.com/b' });
      expect(second.body).toMatchObject({ status: 'failed', error: readUrlDailyCap(2) });

      const agent = (await w.db.query.agents.findFirst())!;
      const search = (id: string) => ({ id, cycleKey: 'cycle:s', action: { tool: 'search_web', input: { query: 'bootr' } }, status: 'sent', createdAt: now, attempts: 1 }) as unknown as PendingAction;
      const env = { inbox: new Map(), eligibility: new Map(), own: { openedAt: now, postAllowed: false, nextSlotAt: null } };
      expect(await ownGuard(w.ctx, agent, search('act_s1'), env)).toBeNull();
      await w.db.insert(actions).values(row('act_s1', 'search_web', now));
      expect(await ownGuard(w.ctx, agent, search('act_s2'), env)).toEqual({ kind: 'failed', error: searchDailyCap(1) });
      // The action being decided is not counted against itself.
      expect(await ownGuard(w.ctx, agent, search('act_s1'), env)).toBeNull();
    } finally {
      await w.close();
    }
  });
});

describe('own agent: coming back after a downtime', () => {
  const old = (id: string, hoursAgo: number, now: number) => mention(id, '@bootr_agent are you there?', { createdAt: new Date(now - hoursAgo * HOUR).toISOString() });

  it('closes the mentions that waited more than a day while the agent was away, and answers the fresh ones', async () => {
    const { w, credential } = await setup();
    try {
      const now = w.ctx.now();
      w.sender.items = [old('2001', 50, now), old('2002', 25, now), old('2003', 2, now)];
      await patchState(w, { ownLastTurnAt: now - 3 * DAY, lastCheckpointAt: now - 3 * DAY });
      const resolved: { postId: string; outcome: string; reason: string }[] = [];
      w.sender.client.resolve = (async (body: { postId: string; outcome: string; reason: string }) => {
        resolved.push({ postId: body.postId, outcome: body.outcome, reason: body.reason });
        return {};
      }) as typeof w.sender.client.resolve;

      const turn = await openSocial(w, credential);
      expect(resolved).toEqual([
        { postId: '2001', outcome: 'skip', reason: STALE_MENTION_REASON },
        { postId: '2002', outcome: 'skip', reason: STALE_MENTION_REASON },
      ]);
      const social = turn.observation.social as { messages: { postId: string }[] };
      expect(social.messages.map((m) => m.postId)).toEqual(['2003']);
      expect(Object.keys((await turnOf(w))!.inbox)).toEqual(['2003']);
      // A reply to one of the closed ones is refused: it is not a mention of this turn any more.
      const late = await act(w, credential, turn.turnId, 'publish_reply', { postId: '2001', text: 'Sorry for the wait, I am here now.' });
      expect(late.body.status).toBe('failed');
      expect(w.sender.published.filter((p) => (p as { replyTo?: string }).replyTo === '2001' && !(p as { replyEligibility?: { eligible: boolean } }).replyEligibility?.eligible)).toHaveLength(w.sender.published.length);
    } finally {
      await w.close();
    }
  });

  it('closes nothing when the agent was here within the day, or when the rule is switched off', async () => {
    for (const config of [{}, { OWN_STALE_MENTION_MS: '0' }] as Record<string, string>[]) {
      const { w, credential } = await setup({ config });
      try {
        const now = w.ctx.now();
        w.sender.items = [old('2001', 50, now), old('2003', 2, now)];
        await patchState(w, 'OWN_STALE_MENTION_MS' in config ? { ownLastTurnAt: now - 3 * DAY } : { ownLastTurnAt: now - 2 * HOUR });
        const resolved: string[] = [];
        w.sender.client.resolve = (async (body: { postId: string }) => {
          resolved.push(body.postId);
          return {};
        }) as typeof w.sender.client.resolve;
        const turn = await openSocial(w, credential);
        expect(resolved).toEqual([]);
        expect((turn.observation.social as { messages: { postId: string }[] }).messages.map((m) => m.postId).sort()).toEqual(['2001', '2003']);
      } finally {
        await w.close();
      }
    }
  });
});

describe('own agent: the public record', () => {
  it('marks what an own agent\'s client did on the coin\'s tape, and leaves a hosted row as it was', async () => {
    const { w, credential } = await setup({ mentions: [mention('1001')] });
    try {
      const turn = await openSocial(w, credential);
      await act(w, credential, turn.turnId, 'publish_post', { text: 'Good morning from the test coin. The sky is clear.' });
      await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' });
      // A row from before the switch, made by the hosted agent.
      const at = new Date(w.ctx.now() - HOUR);
      await w.db.insert(actions).values({ actionId: 'act_hosted', agentId: AGENT_ID, cycleKey: 'cycle:h', action: { tool: 'publish_post', input: { text: 'hosted' } }, status: 'completed', result: { status: 'completed', result: { postId: '8000' } }, createdAt: at, updatedAt: at });
      const tape = await w.call<{ items: { kind: string; summary: string; url?: string }[] }>('GET', `/internal/agents/${AGENT_ID}/activity`);
      const posts = tape.body.items.filter((i) => i.kind === 'post' || i.kind === 'reply');
      expect(posts.map((i) => i.summary).sort()).toEqual(['Posted on X', 'Posted on X · own agent', 'Replied on X · own agent']);
      expect(posts.every((i) => i.url?.startsWith('https://x.com/bootr_agent/status/'))).toBe(true);
      // The client's id is in the row for the console, never on the public tape.
      expect(JSON.stringify(tape.body)).not.toMatch(/cli_[0-9a-f]{16}/);
      const row = (await w.db.select().from(actions).where(and(eq(actions.agentId, AGENT_ID), eq(actions.actionId, 'act_hosted'))))[0]!;
      expect((row.action as { via?: string }).via).toBeUndefined();
    } finally {
      await w.close();
    }
  });
});
