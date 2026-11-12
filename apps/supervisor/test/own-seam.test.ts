/**
 * Own agents (docs/design/byo-agent.md section 13.4): the seam the other workstreams plug into. The engine runs a
 * special tool another workstream registers (`answer_request`, `judge_entry`, `judge`) in the order the contract fixes,
 * and the hooks the runner switch and the registration call (`ownHooks`) are the real functions once the routes are
 * mounted. The tools and roles here are stand-ins: what they answer belongs to whoever registers the real ones.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OWN_DEFAULTS, type ActResult, type AgentStatus, type OwnErrorBody, type TurnOpen } from '@bootr/shared/own-agent';
import { CREATOR_REQUESTS_MEANING, creatorRequestsSection, fileRequest, forgetTurnRequest } from '../src/creator-requests.js';
import { actions } from '../src/db/schema.js';
import { isOwn, ownEnabled, ownHooks, ownRole, ownSetting, registerOwnRole, registerOwnTool, type OwnSpecialTool } from '../src/own/registry.js';
import { runnerReadsPerDay } from '../src/own/quota.js';
import { acquireLease, ownRequestsWording, releaseLease, type Turn } from '../src/runtime.js';
import { AGENT_ID } from './helpers.js';
import { act, connectClient, finishInput, openSocial, ownWorld, quietRuntime, runtimeOf, seedOwn, stateOf, turnOf } from './own-helpers.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('own agent: special tools', () => {
  it('runs a registered tool as one step with no action row, in the contract\'s order, and can end the turn', async () => {
    const w = await ownWorld({ config: { MAX_TOOL_STEPS: '3' } });
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const calls: unknown[] = [];
      let offered = true;
      const note: OwnSpecialTool = {
        name: 'answer_request',
        roles: ['social'],
        input: z.object({ requestId: z.string().min(1), outcome: z.enum(['done', 'not_done']) }).strict(),
        offered: () => offered,
        run: async (call, turn, input) => {
          calls.push(input);
          // The tool is handed the live state and turn, and the engine persists what it changes.
          call.state.summary = `answered in turn ${turn.own?.turnId}`;
          return { status: 'completed', result: { closed: true }, image: { mime: 'image/png', dataBase64: PNG_1PX } };
        },
      };
      const ruling: OwnSpecialTool = { name: 'judge', roles: ['social'], input: z.object({}).strict(), offered: () => true, run: async () => ({ status: 'completed', result: { accepted: true }, endsTurn: true }) };
      const broken: OwnSpecialTool = {
        name: 'judge_entry',
        roles: ['judge'],
        input: z.object({ n: z.number().int() }).strict(),
        offered: () => true,
        run: async () => {
          throw new Error('boom');
        },
      };
      registerOwnTool(note);
      registerOwnTool(ruling);
      registerOwnTool(broken);

      const turn = await openSocial(w, credential);
      // Offered tools of this role are in the turn's tool list; another role's is not.
      expect(turn.tools).toEqual(expect.arrayContaining(['bootr_agent_answer_request', 'bootr_agent_judge']));
      expect(turn.tools).not.toContain('bootr_agent_judge_entry');

      const bad = await act(w, credential, turn.turnId, 'answer_request', { requestId: 'req_1', outcome: 'maybe' });
      expect(bad.status).toBe(400);
      expect((bad.body as unknown as OwnErrorBody).error).toBe('invalid_tool_call');
      expect((bad.body as unknown as OwnErrorBody).field).toBe('outcome');
      expect(((await act(w, credential, turn.turnId, 'judge_entry', { n: 1 })).body as unknown as OwnErrorBody).error).toBe('tool_unavailable');
      expect(calls).toEqual([]);
      expect((await turnOf(w))?.steps).toBe(0);

      const ok = await act(w, credential, turn.turnId, 'answer_request', { requestId: 'req_1', outcome: 'done' });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ turnId: turn.turnId, tool: 'answer_request', actionId: null, status: 'completed', result: { closed: true }, image: { mime: 'image/png', dataBase64: PNG_1PX }, stepsUsed: 1, stepsLeft: 2, turnEnded: false });
      expect(calls).toEqual([{ requestId: 'req_1', outcome: 'done' }]);
      expect((await stateOf(w)).summary).toBe(`answered in turn ${turn.turnId}`);
      // No action row and no broker cycle for a special tool.
      expect((await w.db.select().from(actions)).filter((r) => 'tool' in r.action)).toHaveLength(0);
      expect((await runtimeOf(w)).cycle).toBe(0);

      // No longer offered (the request it was for is closed): the tool leaves the turn.
      offered = false;
      expect(((await act(w, credential, turn.turnId, 'answer_request', { requestId: 'req_1', outcome: 'done' })).body as unknown as OwnErrorBody).error).toBe('tool_unavailable');
      // A tool that ends the turn: the answer says so, and the turn is closed as finished.
      const end = await act(w, credential, turn.turnId, 'judge', {});
      expect(end.body).toMatchObject({ status: 'completed', turnEnded: true, stepsUsed: 2 });
      expect(await turnOf(w)).toBeNull();
      expect((await runtimeOf(w)).status).toBe('waiting');
      expect((await stateOf(w)).ownClosed).toMatchObject({ turnId: turn.turnId, why: 'finished' });
      expect(((await act(w, credential, turn.turnId, 'judge', {})).body as unknown as OwnErrorBody).error).toBe('turn_closed');
    } finally {
      await w.close();
    }
  });

  it('a special tool that throws is a failed result, and special tools count against the step cap like any other', async () => {
    const w = await ownWorld({ config: { MAX_TOOL_STEPS: '2' } });
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      registerOwnTool({
        name: 'answer_request',
        roles: ['social'],
        input: z.object({}).passthrough(),
        offered: () => true,
        run: async () => {
          throw new Error('the database went away at postgres://user:secret@db.internal:5432');
        },
      });
      const turn = await openSocial(w, credential);
      const failed = await act(w, credential, turn.turnId, 'answer_request', {});
      expect(failed.status).toBe(200);
      expect(failed.body).toMatchObject({ status: 'failed', actionId: null, stepsUsed: 1 });
      // The client is told it failed, never why in the server's own words.
      expect(JSON.stringify(failed.body)).not.toMatch(/postgres|secret|db\.internal/);
      await act(w, credential, turn.turnId, 'answer_request', {});
      const over = await act(w, credential, turn.turnId, 'answer_request', {});
      expect(over.status).toBe(409);
      expect((over.body as unknown as OwnErrorBody).error).toBe('step_cap');
      expect((await w.run<ActResult>('finish', credential, { turnId: turn.turnId, ...finishInput(w) })).body.turnEnded).toBe(true);
    } finally {
      await w.close();
    }
  });
});

describe('own agent: what the roles of the other workstreams rely on', () => {
  /** A judge role and its two tools, standing in for the ones another workstream registers: one job with `entries` entries. */
  function registerJudge(entries: number, fullJobId: string) {
    const read: number[] = [];
    registerOwnRole({
      role: 'judge',
      due: async () => ({ on: true, due: true, reasons: ['judge_job_waiting'], nextAt: null }),
      open: async (call, opts) => {
        // The role keeps the job it picked on the turn itself, in a field the engine knows nothing about.
        const turn = { role: 'judge', startedAt: call.now, steps: 0, nudged: false, reasons: opts.reasons, messages: [], inbox: {}, recentSteps: [], judgeJobId: fullJobId, judgeNote: { asked: opts.jobId ?? null } } as Turn;
        return { turn, brief: 'judge brief', observation: { role: 'judge', meaning: 'rule on the job', job: { jobId: fullJobId, task: 'draw a fox', criteria: ['is a fox'], entries: Array.from({ length: entries }, (_, i) => ({ n: i + 1, kind: 'image' })) } }, tools: [] };
      },
      finish: async () => {
        throw new Error('a judge turn has no finish');
      },
    });
    registerOwnTool({
      name: 'judge_entry',
      roles: ['judge'],
      input: z.object({ n: z.number().int().min(1) }).strict(),
      offered: () => true,
      run: async (_call, _turn, input) => {
        read.push((input as { n: number }).n);
        return { status: 'completed', result: { n: (input as { n: number }).n, kind: 'image' } };
      },
    });
    registerOwnTool({
      name: 'judge',
      roles: ['judge'],
      input: z.object({ winner: z.number().int().nullable() }).passthrough(),
      offered: () => true,
      // The ruling reads the job from the turn, as the real one does: the field first, then `own.jobId`.
      run: async (_call, turn) => ({ status: 'completed', result: { jobId: (turn as { judgeJobId?: string }).judgeJobId ?? turn.own?.jobId, accepted: true, winner: 1 }, endsTurn: true }),
    });
    return read;
  }

  it('a judge turn may read every entry of its job and still rule, however many there are, and the turn the role returned is stored whole', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const read = registerJudge(12, 'bnt_0123456789abcdef');
      // The client names the job by a short id; the role resolves it.
      const turn = await w.run<TurnOpen>('turn', credential, { role: 'judge', jobId: 'bnt_0123' });
      expect(turn.status).toBe(200);
      // Eight steps (the cap) would leave five entries unread: one step per entry and one for the ruling.
      expect(turn.body.stepBudget).toBe(13);
      // Its two tools and nothing else: no finish (the ruling ends it), no tool of another role.
      expect([...turn.body.tools].sort()).toEqual(['bootr_agent_judge', 'bootr_agent_judge_entry']);
      const stored = (await turnOf(w)) as Turn & { judgeJobId?: string; judgeNote?: unknown };
      expect(stored.judgeJobId).toBe('bnt_0123456789abcdef');
      expect(stored.judgeNote).toEqual({ asked: 'bnt_0123' });
      // ...and the job on the engine's own record is the resolved one, not what the request named.
      expect(stored.own?.jobId).toBe('bnt_0123456789abcdef');
      expect(stored.messages).toEqual([]);

      for (let n = 1; n <= 12; n++) {
        const entry = await act(w, credential, turn.body.turnId, 'judge_entry', { n });
        expect(entry.body).toMatchObject({ status: 'completed', stepsUsed: n, stepsLeft: 13 - n, turnEnded: false });
      }
      expect(read).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      // The role's own field survived every step's write.
      expect(((await turnOf(w)) as Turn & { judgeJobId?: string }).judgeJobId).toBe('bnt_0123456789abcdef');
      const ruling = await act(w, credential, turn.body.turnId, 'judge', { winner: 1 });
      expect(ruling.body).toMatchObject({ status: 'completed', turnEnded: true, stepsUsed: 13, stepsLeft: 0, result: { jobId: 'bnt_0123456789abcdef', accepted: true } });
      expect(await turnOf(w)).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('the larger budget is the judge turn\'s alone and still a cap: past it nothing more is read, and a small job keeps the hosted cap', async () => {
    const w = await ownWorld({ config: { MAX_TOOL_STEPS: '4' } });
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const read = registerJudge(5, 'bnt_five');
      const turn = await w.run<TurnOpen>('turn', credential, { role: 'judge' });
      expect(turn.body.stepBudget).toBe(6);
      expect((await turnOf(w))?.own?.jobId).toBe('bnt_five');
      // Reading the same entries over and over uses the budget up; the ruling is then out of reach, as past any cap.
      for (let n = 0; n < 6; n++) expect((await act(w, credential, turn.body.turnId, 'judge_entry', { n: 1 })).body.status).toBe('completed');
      const over = await act(w, credential, turn.body.turnId, 'judge_entry', { n: 2 });
      expect((over.body as unknown as OwnErrorBody).error).toBe('step_cap');
      expect(((await act(w, credential, turn.body.turnId, 'judge', { winner: null })).body as unknown as OwnErrorBody).error).toBe('step_cap');
      expect(read).toHaveLength(6);
      // The turn idles out; a job with few entries has the hosted cap, and so has a social turn.
      w.setNow(w.ctx.now() + 11 * 60_000);
      registerJudge(2, 'bnt_two');
      expect((await w.run<TurnOpen>('turn', credential, { role: 'judge' })).body.stepBudget).toBe(4);
      w.setNow(w.ctx.now() + 11 * 60_000);
      expect((await openSocial(w, credential)).stepBudget).toBe(4);
    } finally {
      await w.close();
    }
  });

  it('what a special tool changes on the turn is stored with the step: a request it closes no longer lets a post out', async () => {
    const w = await ownWorld();
    try {
      const quiet = quietRuntime(w.ctx.now());
      await seedOwn(w, { config: quiet.config, runtime: quiet.runtime });
      const { credential } = await connectClient(w);
      const request = await fileRequest(w.ctx, AGENT_ID, { text: 'Say good morning to the holders today.', turn: 'social' });
      // The stand-in closes the request on the turn, as the real `answer_request` does.
      registerOwnTool({
        name: 'answer_request',
        roles: ['social', 'treasury'],
        input: z.object({ requestId: z.string(), outcome: z.enum(['done', 'not_done']), reason: z.string() }).strict(),
        offered: (turn) => (turn.creatorRequests?.length ?? 0) > 0,
        run: async (_call, turn, input) => {
          forgetTurnRequest(turn, (input as { requestId: string }).requestId);
          return { status: 'completed', result: { requestId: (input as { requestId: string }).requestId, outcome: 'not_done', closed: true } };
        },
      });
      const turn = await openSocial(w, credential);
      expect(turn.tools).toContain('bootr_agent_answer_request');
      expect((await turnOf(w))?.creatorRequests).toEqual([{ id: request.id, picture: false }]);
      const answered = await act(w, credential, turn.turnId, 'answer_request', { requestId: request.id, outcome: 'not_done', reason: 'Not today.' });
      expect(answered.body.status).toBe('completed');
      // The turn as stored no longer holds the request, so the tool is gone and the request opens no post slot any more.
      expect((await turnOf(w))?.creatorRequests).toEqual([]);
      expect(((await act(w, credential, turn.turnId, 'answer_request', { requestId: request.id, outcome: 'done', reason: 'again' })).body as unknown as OwnErrorBody).error).toBe('tool_unavailable');
      const post = await act(w, credential, turn.turnId, 'publish_post', { text: 'Good morning to the holders, after all.' });
      expect(post.body.status).toBe('failed');
      expect(post.body.error).toMatch(/^post_slot_not_due: /);
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('an own turn\'s creator requests are worded without draft_intent, which it does not have; a hosted turn\'s text is untouched', async () => {
    const w = await ownWorld();
    try {
      const quiet = quietRuntime(w.ctx.now());
      const agent = await seedOwn(w, { config: quiet.config, runtime: quiet.runtime });
      const { credential } = await connectClient(w);
      const request = await fileRequest(w.ctx, AGENT_ID, { text: 'Post about the new coin page.', turn: 'social' });
      const turn = await openSocial(w, credential);
      const section = turn.observation.creatorRequests as { meaning: string; items: { requestId: string }[] };
      expect(section.items.map((i) => i.requestId)).toEqual([request.id]);
      expect(section.meaning).not.toContain('draft_intent');
      // Only the one clause is gone: the sentence it sat in, and everything else, reads as before.
      expect(section.meaning).toContain('call answer_request with its requestId, outcome done and one line on what you did. When you cannot do one');
      expect(section.meaning).toBe(CREATOR_REQUESTS_MEANING.social.replace(' (for a post you plan with draft_intent, put the requestId in the intent instead and it closes when the post goes out)', ''));
      expect(section.meaning.length).toBeLessThan(CREATOR_REQUESTS_MEANING.social.length);

      // The hosted agent gets the very object the hosted code built: byte for byte its text.
      const hostedSection = creatorRequestsSection('social', [request]);
      const hosted = { config: { ...agent.config, runner: 'hosted' } };
      expect(ownRequestsWording(hosted, hostedSection)).toBe(hostedSection);
      expect(ownRequestsWording({ config: {} }, hostedSection)).toBe(hostedSection);
      expect((hostedSection.creatorRequests as { meaning: string }).meaning).toBe(CREATOR_REQUESTS_MEANING.social);
      expect(CREATOR_REQUESTS_MEANING.social).toContain('draft_intent');
      // No request, no section, for either runner.
      expect(ownRequestsWording(agent, {})).toEqual({});
    } finally {
      await w.close();
    }
  });
});

describe('own agent: the hooks and helpers the other workstreams call', () => {
  it('isOwn reads the stored config alone, ownEnabled the flag alone, and a setting falls back to its default', async () => {
    const on = await ownWorld({ config: { OWN_TURN_IDLE_MS: '120000' } });
    const off = await ownWorld({ flag: false });
    try {
      expect(ownEnabled(on.ctx)).toBe(true);
      expect(ownEnabled(off.ctx)).toBe(false);
      for (const ctx of [on.ctx, off.ctx]) {
        // The flag never turns an own coin into a hosted one, nor a hosted one into an own one.
        void ctx;
        expect(isOwn({ config: { runner: 'own' } })).toBe(true);
        expect(isOwn({ config: { runner: 'hosted' } })).toBe(false);
        expect(isOwn({ config: {} })).toBe(false);
      }
      expect(ownSetting(on.ctx, 'OWN_TURN_IDLE_MS')).toBe(120_000);
      expect(ownSetting(off.ctx, 'OWN_TURN_IDLE_MS')).toBe(OWN_DEFAULTS.OWN_TURN_IDLE_MS);
      for (const name of Object.keys(OWN_DEFAULTS) as (keyof typeof OWN_DEFAULTS)[]) expect([name, ownSetting(off.ctx, name)]).toEqual([name, OWN_DEFAULTS[name]]);
      // Mounting the routes registered the social role; `createApp` also registers the treasury and judge roles
      // (`registerW2`), so all three are present once the app is built.
      expect(ownRole('social')?.role).toBe('social');
      expect(ownRole('treasury')?.role).toBe('treasury');
    } finally {
      await on.close();
      await off.close();
    }
  });

  it('applyRunnerQuota sets the smaller X read budget for an own coin and returns a hosted one to the sender\'s default', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      await ownHooks.applyRunnerQuota(w.ctx, AGENT_ID, 'own');
      await ownHooks.applyRunnerQuota(w.ctx, AGENT_ID, 'hosted');
      expect(w.sender.quotaWrites).toEqual([
        { agentId: AGENT_ID, patch: { readsPerDay: 200 } },
        { agentId: AGENT_ID, patch: { readsPerDay: null } },
      ]);
      expect(runnerReadsPerDay(w.ctx, 'own')).toBe(200);
      expect(runnerReadsPerDay(w.ctx, 'hosted')).toBeNull();
      // A sender that does not answer does not undo a switch or a registration.
      w.sender.quotaError = new Error('sender down');
      await expect(ownHooks.applyRunnerQuota(w.ctx, AGENT_ID, 'own')).resolves.toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it('status says what is left of today from the sender, and makes up for a read budget the sender missed', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      // The sender as it answers once it carries the per-agent read budget: the default 400 still in force.
      w.sender.client.quota = (async (agentId: string) => ({ agentId, postsPerDay: 24, mentionReadIntervalSec: 300, lastMentionsReadAt: null, readsPerDay: 400, postsUsed24h: 5, readsUsedToday: 30 })) as typeof w.sender.client.quota;
      const status = await w.run<AgentStatus>('status', credential);
      expect(status.body).toMatchObject({ postsLeftToday: 19, xReadsLeftToday: 370, requireApproval: false, lastTurnAt: null });
      expect(w.sender.quotaWrites).toEqual([{ agentId: AGENT_ID, patch: { readsPerDay: 200 } }]);
      // A sender that does not answer: unknown, not zero.
      w.sender.client.quota = (async () => {
        throw new Error('sender down');
      }) as typeof w.sender.client.quota;
      expect((await w.run<AgentStatus>('status', credential)).body).toMatchObject({ postsLeftToday: null, xReadsLeftToday: null });
    } finally {
      await w.close();
    }
  });

  it('closeTurn closes the coin\'s open own turn for a caller that holds the lease (the runner switch), and countClients counts the live ones', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      await connectClient(w);
      expect(await ownHooks.countClients(w.ctx, AGENT_ID)).toBe(2);
      expect(await ownHooks.closeTurn(w.ctx, AGENT_ID, 'runner_switched')).toBe(false);
      const turn = await openSocial(w, credential);
      await act(w, credential, turn.turnId, 'read_market');
      // The switch takes the lease, then asks for the turn to be closed.
      expect(await acquireLease(w.ctx, AGENT_ID, 'the-switch')).not.toBeNull();
      expect(await ownHooks.closeTurn(w.ctx, AGENT_ID, 'runner_switched')).toBe(true);
      await releaseLease(w.ctx, AGENT_ID, 'the-switch');
      const runtime = await runtimeOf(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.status).toBe('waiting');
      const state = await stateOf(w);
      expect(state.ownClosed).toMatchObject({ turnId: turn.turnId, why: 'runner_switched' });
      expect(state.continuation?.progress).toBe('Turn ended by the runtime (runner_switched). Continue from the agenda.');
      // A late call with the old turn id is told the turn is over.
      const late = await act(w, credential, turn.turnId, 'publish_post', { text: 'a post after the switch' });
      expect(late.status).toBe(410);
      expect((late.body as unknown as OwnErrorBody).error).toBe('turn_closed');
      expect(w.sender.published).toHaveLength(0);
      expect(await ownHooks.closeTurn(w.ctx, 'no-such-agent', 'expired')).toBe(false);
    } finally {
      await w.close();
    }
  });
});
