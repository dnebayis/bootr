/**
 * Own agents (docs/design/byo-agent.md section 13.4): the seam the other workstreams plug into. The engine runs a
 * special tool another workstream registers (`answer_request`, `judge_entry`, `judge`) in the order the contract fixes,
 * and the hooks the runner switch and the registration call (`ownHooks`) are the real functions once the routes are
 * mounted. The tools and roles here are stand-ins: what they answer belongs to whoever registers the real ones.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OWN_DEFAULTS, type ActResult, type AgentStatus, type OwnErrorBody } from '@bootr/shared/own-agent';
import { actions } from '../src/db/schema.js';
import { isOwn, ownEnabled, ownHooks, ownRole, ownSetting, registerOwnTool, type OwnSpecialTool } from '../src/own/registry.js';
import { runnerReadsPerDay } from '../src/own/quota.js';
import { acquireLease, releaseLease } from '../src/runtime.js';
import { AGENT_ID } from './helpers.js';
import { act, connectClient, finishInput, openSocial, ownWorld, runtimeOf, seedOwn, stateOf, turnOf } from './own-helpers.js';

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
      // Mounting the routes registered the social role and nothing else.
      expect(ownRole('social')?.role).toBe('social');
      expect(ownRole('treasury')).toBeNull();
      expect(ownRole('judge')).toBeNull();
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
