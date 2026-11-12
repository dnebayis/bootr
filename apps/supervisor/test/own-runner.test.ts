/**
 * Own agents, W3's part of the supervisor (docs/design/byo-agent.md sections 5.3, 13.9 and 13.10): registration from a
 * launch whose model is `own-agent`, the creator's switch between "My own agent" and "Bootr agent" in both directions
 * and with everything that can be in flight, the config view and the chat refusal, each with the feature's flag on
 * and off. The own-agent engine (W1a) is not in this branch: the hooks are the registry's no-ops or test doubles.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, pad, toHex, type Address, type Hex, type Log } from 'viem';
import { OWN_AGENT_MODEL_ID, OWN_ERRORS, runnerOf, type Runner } from '@bootr/shared/own-agent';
import { agentLaunchedEvent, launchContextEvent } from '../src/abi.js';
import { createApp } from '../src/api.js';
import { agentActivity } from '../src/activity.js';
import { sendChatMessage } from '../src/chat.js';
import type { AgentRow, SupervisorContext } from '../src/context.js';
import { fileRequest, openRequests } from '../src/creator-requests.js';
import { actions, agents, approvals, bountyJobs, chatMessages, inference, memories, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { buildLaunchConfig, decodeLaunchLogs, DEFAULT_MODEL, pollLaunches } from '../src/onboarding.js';
import { isOwn, ownEnabled, setOwnHooks, type OwnHooks } from '../src/own/registry.js';
import { switchNotes, switchRunner } from '../src/own/runner-switch.js';
import { acquireLease, initialState, releaseLease, type AgentState } from '../src/runtime.js';
import { AGENT_ID, CREATOR, KERNEL, LAUNCHER, makeWorld, seedAgent, SUPERVISOR_KEY, TOKEN, type TestWorld } from './helpers.js';

const OTHER: Address = '0x9999999999999999999999999999999999999999';
const MODEL = 'openai/gpt-4.1-mini';
const ALLOWED = [MODEL, 'anthropic/claude-haiku-4.5'];
const DRAFT = '0b5a0c1e-3f6d-4c1b-9a53-2f0f8f7e9d11';

const NOOP_HOOKS: OwnHooks = { closeTurn: async () => false, applyRunnerQuota: async () => undefined, adoptDraftClients: async () => 0, countClients: async () => 0 };

afterEach(() => setOwnHooks(NOOP_HOOKS));

/** The feature's flag as config.ts (W1a) will carry it: a boolean on the config the registry reads. */
function setFlag(world: TestWorld, on: boolean): void {
  (world.ctx.config as unknown as Record<string, unknown>).OWN_AGENT_ENABLED = on;
}

async function withWorld<T>(fn: (world: TestWorld) => Promise<T>, opts: Parameters<typeof makeWorld>[0] = {}): Promise<T> {
  const world = await makeWorld(opts);
  try {
    return await fn(world);
  } finally {
    await world.close();
  }
}

const agentRow = async (world: TestWorld) => (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
const runtimeRow = async (world: TestWorld) => (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
const stateOf = async (world: TestWorld) => (await runtimeRow(world)).state as unknown as AgentState & { ownLastTurnAt?: number | null };

function switchTo(world: TestWorld, agent: AgentRow, runner: Runner, over: Record<string, unknown> = {}) {
  return switchRunner(world.ctx, agent, { runner, by: CREATOR, allowedModels: ALLOWED, ...over }, { leaseWaitMs: 60, leasePollMs: 10 });
}

function fakeLaunchLog(agentId: bigint, model: string, opts: { creator?: Address } = {}): Log {
  const creator = opts.creator ?? CREATOR;
  const topics = encodeEventTopics({ abi: [agentLaunchedEvent], eventName: 'AgentLaunched', args: { token: TOKEN, kernel: KERNEL, creator } });
  const data = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'tuple', components: [{ type: 'uint24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint32' }] },
      { type: 'bytes32' },
      { type: 'string' },
      { type: 'string' },
      { type: 'address' },
    ],
    // fuel 0: an own-agent launch needs none
    ['0x0000000000000000000000000000000000000000', agentId, [10_000, 5000, 3000, 0, 2000, creator, 0n, 90 * 86_400], pad('0x01', { size: 32 }), model, 'https://bootr.fun/agents/7.json', '0x0000000000000000000000000000000000000000'],
  );
  return { address: LAUNCHER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: toHex(7, { size: 32 }), logIndex: 0, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

function launchContextLog(draftId: string): Log {
  const topics = encodeEventTopics({ abi: [launchContextEvent], eventName: 'LaunchContext', args: { token: TOKEN } });
  const data = encodeAbiParameters([{ type: 'string' }], [JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id: draftId })]);
  return { address: LAUNCHER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: toHex(7, { size: 32 }), logIndex: 1, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

function api(world: TestWorld) {
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  return {
    get: async (path: string) => app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } }),
    post: async (path: string, body: unknown) => {
      const text = JSON.stringify(body);
      return app.request(path, { method: 'POST', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'POST', path, text, nowSec()) } });
    },
  };
}

describe('the two questions: how a coin is run, and whether the feature is offered', () => {
  it('isOwn reads the stored config alone; ownEnabled reads the flag alone', async () => {
    await withWorld(async (world) => {
      expect(ownEnabled(world.ctx)).toBe(false);
      expect(isOwn({ config: { runner: 'own' } })).toBe(true);
      expect(isOwn({ config: {} })).toBe(false);
      setFlag(world, true);
      expect(ownEnabled(world.ctx)).toBe(true);
      expect(isOwn({ config: { runner: 'hosted' } })).toBe(false);
    });
  });
});

describe('registration of an own-agent launch', () => {
  for (const flag of [true, false]) {
    it(`a launch whose model is own-agent becomes an own coin with the flag ${flag ? 'on' : 'off'}, and keeps the default hosted model for a switch back`, async () => {
      await withWorld(async (world) => {
        setFlag(world, flag);
        const launch = decodeLaunchLogs([fakeLaunchLog(7n, OWN_AGENT_MODEL_ID)])[0]!;
        expect(launch.model).toBe(OWN_AGENT_MODEL_ID);
        const config = buildLaunchConfig(world.ctx, launch, { name: 'Quiet Engine', symbol: 'QENG' });
        expect(config.runner).toBe('own');
        expect(runnerOf(config)).toBe('own');
        expect(config.model).toBe(DEFAULT_MODEL);
        // nothing else about the coin differs from a hosted launch of the same worker
        const hosted = buildLaunchConfig(world.ctx, { ...launch, model: DEFAULT_MODEL }, { name: 'Quiet Engine', symbol: 'QENG' });
        expect(hosted.runner).toBeUndefined();
        expect(runnerOf(hosted)).toBe('hosted');
        expect({ ...config, runner: undefined }).toEqual({ ...hosted, runner: undefined });
      });
    });
  }

  it('a hosted launch stores no runner, so every coin launched before this stays the Bootr agent', async () => {
    await withWorld(async (world) => {
      const launch = decodeLaunchLogs([fakeLaunchLog(7n, MODEL)])[0]!;
      const config = buildLaunchConfig(world.ctx, launch, { name: 'A', symbol: 'A' });
      expect('runner' in config).toBe(false);
      expect(config.model).toBe(MODEL);
    });
  });

  it('registerAgent hands the registered row to the draft-client hook and sets the X read budget of an own coin; the flag changes neither', async () => {
    for (const flag of [true, false]) {
      await withWorld(
        async (world) => {
          setFlag(world, flag);
          world.state.logs = [fakeLaunchLog(7n, OWN_AGENT_MODEL_ID)];
          world.state.receipts[toHex(7, { size: 32 })] = [fakeLaunchLog(7n, OWN_AGENT_MODEL_ID), launchContextLog(DRAFT)];
          const adopted: { agentId: string; draftId: string | null; creator: string }[] = [];
          const quotas: { agentId: string; runner: Runner }[] = [];
          setOwnHooks({
            adoptDraftClients: async (_ctx, agent) => {
              adopted.push({ agentId: agent.agentId, draftId: agent.draftId, creator: agent.creator });
              return 1;
            },
            applyRunnerQuota: async (_ctx, agentId, runner) => void quotas.push({ agentId, runner }),
          });
          expect(await pollLaunches(world.ctx)).toBe(1);
          const row = await agentRow(world);
          expect(runnerOf(row.config)).toBe('own');
          expect(row.draftId).toBe(DRAFT);
          expect(adopted).toEqual([{ agentId: '7', draftId: DRAFT, creator: CREATOR }]);
          expect(quotas).toEqual([{ agentId: '7', runner: 'own' }]);
        },
        { chain: { blockNumber: 50n } },
      );
    }
  });

  it("adopts the draft's client for the wallet that approved it and for no other launcher of the same draft id", async () => {
    // The hook is W1a's; this double keeps the rule the contract gives it (the approving wallet must be the launch's
    // creator), which shows that what registration passes is enough to apply it.
    const approvedBy = CREATOR;
    const rule: OwnHooks['adoptDraftClients'] = async (_ctx, agent) => (agent.draftId === DRAFT && agent.creator.toLowerCase() === approvedBy.toLowerCase() ? 1 : 0);
    for (const [creator, expected] of [
      [CREATOR, 1],
      [OTHER, 0],
    ] as const) {
      await withWorld(
        async (world) => {
          setFlag(world, true);
          world.state.logs = [fakeLaunchLog(7n, OWN_AGENT_MODEL_ID, { creator })];
          world.state.receipts[toHex(7, { size: 32 })] = [fakeLaunchLog(7n, OWN_AGENT_MODEL_ID, { creator }), launchContextLog(DRAFT)];
          const results: number[] = [];
          setOwnHooks({ adoptDraftClients: async (ctx, agent) => (results.push(await rule(ctx, agent)), results.at(-1)!) });
          await pollLaunches(world.ctx);
          expect(results).toEqual([expected]);
        },
        { chain: { blockNumber: 50n } },
      );
    }
  });

  it('a hosted launch leaves the X read budget alone, and a hook that throws never fails a registration', async () => {
    await withWorld(
      async (world) => {
        world.state.logs = [fakeLaunchLog(7n, MODEL)];
        world.state.receipts[toHex(7, { size: 32 })] = [fakeLaunchLog(7n, MODEL), launchContextLog(DRAFT)];
        const quotas: string[] = [];
        setOwnHooks({
          adoptDraftClients: async () => {
            throw new Error('table missing');
          },
          applyRunnerQuota: async (_ctx, agentId) => void quotas.push(agentId),
        });
        expect(await pollLaunches(world.ctx)).toBe(1);
        expect(runnerOf((await agentRow(world)).config)).toBe('hosted');
        expect(quotas).toEqual([]);
      },
      { chain: { blockNumber: 50n } },
    );
  });
});

describe('switching: the checks before anything is written', () => {
  it('only the creator may switch, and the answer is the contract error body', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world);
      expect(await switchRunner(world.ctx, agent, { runner: 'own', by: OTHER, allowedModels: ALLOWED })).toEqual({ ok: false, status: 403, body: { error: 'not_creator', message: OWN_ERRORS.not_creator.message } });
      expect(await switchRunner(world.ctx, agent, { runner: 'own', by: 'nobody', allowedModels: ALLOWED })).toMatchObject({ ok: false, status: 400, body: { error: 'invalid_request', field: 'by' } });
      expect(await switchRunner(world.ctx, agent, { runner: 'cloud', by: CREATOR, allowedModels: ALLOWED })).toMatchObject({ ok: false, status: 400, body: { error: 'invalid_request', field: 'runner' } });
      expect(runnerOf((await agentRow(world)).config)).toBe('hosted');
    });
  });

  it('runner_unchanged in both directions, with the flag on and off', async () => {
    for (const flag of [true, false]) {
      await withWorld(async (world) => {
        setFlag(world, flag);
        const hosted = await seedAgent(world);
        expect(await switchTo(world, hosted, 'hosted')).toEqual({ ok: false, status: 409, body: { error: 'runner_unchanged', message: OWN_ERRORS.runner_unchanged.message } });
        await world.db.update(agents).set({ config: { ...hosted.config, runner: 'own' } }).where(eq(agents.agentId, AGENT_ID));
        expect(await switchTo(world, await agentRow(world), 'own')).toMatchObject({ ok: false, status: 409, body: { error: 'runner_unchanged' } });
      });
    }
  });

  it('to the Bootr agent: the stored model is kept when it is offered, model_required when it is not, model_not_allowed for one outside the list', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world, { config: { runner: 'own', model: 'retired/model-1' } });
      expect(await switchTo(world, agent, 'hosted')).toEqual({ ok: false, status: 400, body: { error: 'model_required', message: OWN_ERRORS.model_required.message } });
      expect(await switchTo(world, agent, 'hosted', { model: 'someone/elses-model' })).toEqual({ ok: false, status: 400, body: { error: 'model_not_allowed', message: OWN_ERRORS.model_not_allowed.message } });
      expect(await switchTo(world, agent, 'hosted', { model: '' })).toMatchObject({ ok: false, body: { error: 'model_not_allowed' } });
      // an empty list (the web could not read the catalog) allows nothing
      expect(await switchTo(world, agent, 'hosted', { allowedModels: [] })).toMatchObject({ ok: false, body: { error: 'model_required' } });
      expect(runnerOf((await agentRow(world)).config)).toBe('own');
      // the creator picks one from the list: it is stored with the runner
      const done = await switchTo(world, agent, 'hosted', { model: ALLOWED[1] });
      expect(done).toMatchObject({ ok: true, response: { runner: 'hosted', revision: 2 } });
      expect((await agentRow(world)).config).toMatchObject({ runner: 'hosted', model: ALLOWED[1], revision: 2 });
    });
  });

  it('to the Bootr agent with the stored model still offered: no model has to be sent, and it is not rewritten', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world, { config: { runner: 'own' } });
      expect(await switchTo(world, agent, 'hosted')).toMatchObject({ ok: true, response: { runner: 'hosted' } });
      expect((await agentRow(world)).config.model).toBe(MODEL);
    });
  });
});

describe('switching with the flag off', () => {
  it('a switch to own is own_agent_disabled and nothing is written', async () => {
    await withWorld(async (world) => {
      setFlag(world, false);
      const agent = await seedAgent(world);
      const before = await runtimeRow(world);
      expect(await switchTo(world, agent, 'own')).toEqual({ ok: false, status: 404, body: { error: 'own_agent_disabled', message: OWN_ERRORS.own_agent_disabled.message } });
      expect((await agentRow(world)).config).toEqual(agent.config);
      expect(await runtimeRow(world)).toEqual(before);
      expect(await world.db.select().from(actions)).toEqual([]);
    });
  });

  it('a switch from own to the Bootr agent works exactly as with the flag on', async () => {
    await withWorld(async (world) => {
      setFlag(world, false);
      const agent = await seedAgent(world, { config: { runner: 'own' } });
      const result = await switchTo(world, agent, 'hosted');
      expect(result).toMatchObject({ ok: true, response: { runner: 'hosted', revision: 2 } });
      expect(runnerOf((await agentRow(world)).config)).toBe('hosted');
      // and through the route, which never asks the flag itself
      await world.db.update(agents).set({ config: { ...agent.config, runner: 'own' } }).where(eq(agents.agentId, AGENT_ID));
      const res = await api(world).post(`/internal/agents/${AGENT_ID}/runner`, { runner: 'hosted', by: CREATOR, allowedModels: ALLOWED });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ runner: 'hosted', notes: expect.any(Array) });
      const refused = await api(world).post(`/internal/agents/${AGENT_ID}/runner`, { runner: 'own', by: CREATOR, allowedModels: ALLOWED });
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: 'own_agent_disabled', message: OWN_ERRORS.own_agent_disabled.message });
    });
  });
});

describe('switching: what is written', () => {
  it('one config write (runner, revision), one config_updated row on the tape, the X read budget, and the lease given back', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world);
      const quotas: Runner[] = [];
      setOwnHooks({ applyRunnerQuota: async (_ctx, _id, runner) => void quotas.push(runner), countClients: async () => 0 });
      const toOwn = await switchTo(world, agent, 'own');
      expect(toOwn).toEqual({ ok: true, response: { runner: 'own', revision: 2, notes: ['Connect an AI client, or the agent stays silent.'] } });
      const row = await agentRow(world);
      expect(row.config).toEqual({ ...agent.config, runner: 'own', revision: 2 });
      const [action] = await world.db.select().from(actions);
      expect(action).toMatchObject({ actionId: `config-${AGENT_ID}-r2`, status: 'completed', action: { kind: 'config_updated', fields: ['runner'], by: CREATOR, revision: 2, runner: 'own' } });
      const tape = await agentActivity(world.ctx, row, await runtimeRow(world), {});
      expect(tape.some((i) => i.kind === 'config' && i.summary.includes('runner'))).toBe(true);
      expect((await runtimeRow(world)).leaseToken).toBeNull();
      expect(quotas).toEqual(['own']);

      setOwnHooks({ countClients: async () => 2 });
      const back = await switchTo(world, row, 'hosted');
      expect(back).toEqual({
        ok: true,
        response: { runner: 'hosted', revision: 3, notes: ['The Bootr agent pays for its thinking from fuel. This coin holds 70 USDC; under 1 USDC it stays silent.', 'Pictures are made by Bootr again and paid from fuel.'] },
      });
      expect(quotas).toEqual(['own', 'hosted']);
      expect((await runtimeRow(world)).leaseToken).toBeNull();
      // with a client connected, a switch to own has nothing to add
      expect((await switchTo(world, await agentRow(world), 'own')) as unknown).toMatchObject({ ok: true, response: { notes: [] } });
    });
  });

  it('the notes: fuel in plain words, and a chain that does not answer still gets the rule', () => {
    expect(switchNotes('hosted', { fuelUsdc: 0, clients: 0 })[0]).toBe('The Bootr agent pays for its thinking from fuel. This coin holds 0 USDC; under 1 USDC it stays silent.');
    expect(switchNotes('hosted', { fuelUsdc: 12.5, clients: 0 })[0]).toContain('holds 12.5 USDC');
    expect(switchNotes('hosted', { fuelUsdc: null, clients: 0 })[0]).toBe('The Bootr agent pays for its thinking from fuel; under 1 USDC it stays silent.');
    expect(switchNotes('own', { fuelUsdc: null, clients: 1 })).toEqual([]);
  });

  it('a sender that refuses the read budget does not undo the switch', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world);
      setOwnHooks({
        applyRunnerQuota: async () => {
          throw new Error('sender down');
        },
      });
      expect(await switchTo(world, agent, 'own')).toMatchObject({ ok: true });
      expect(runnerOf((await agentRow(world)).config)).toBe('own');
      expect((await runtimeRow(world)).leaseToken).toBeNull();
    });
  });
});

describe('switching never lands inside a step', () => {
  it('waits for the runtime lease and answers supervisor_unavailable when the step outlasts the wait; nothing is written', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world);
      expect(await acquireLease(world.ctx, AGENT_ID, 'tick-lease')).not.toBeNull();
      expect(await switchTo(world, agent, 'own')).toEqual({ ok: false, status: 503, body: { error: 'supervisor_unavailable', message: OWN_ERRORS.supervisor_unavailable.message } });
      expect(runnerOf((await agentRow(world)).config)).toBe('hosted');
      // the step's own lease is untouched
      expect((await runtimeRow(world)).leaseToken).toBe('tick-lease');
    });
  });

  it('goes through as soon as the step in progress gives the lease back', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world);
      await acquireLease(world.ctx, AGENT_ID, 'tick-lease');
      const pending = switchRunner(world.ctx, agent, { runner: 'own', by: CREATOR, allowedModels: ALLOWED }, { leaseWaitMs: 2_000, leasePollMs: 10 });
      await new Promise((r) => setTimeout(r, 40));
      expect(runnerOf((await agentRow(world)).config)).toBe('hosted');
      await releaseLease(world.ctx, AGENT_ID, 'tick-lease');
      expect(await pending).toMatchObject({ ok: true, response: { runner: 'own' } });
    });
  });

  it('while the switch holds the lease nothing else can take it, and two switches at once write one', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world);
      let inside: unknown = 'not called';
      setOwnHooks({
        applyRunnerQuota: async (ctx) => {
          // what a tick would do at this moment: it finds the lease taken and skips the coin
          inside = await acquireLease(ctx as SupervisorContext, AGENT_ID, 'tick-lease');
        },
      });
      const [a, b] = await Promise.all([switchTo(world, agent, 'own'), switchRunner(world.ctx, agent, { runner: 'own', by: CREATOR, allowedModels: ALLOWED }, { leaseWaitMs: 2_000, leasePollMs: 10 })]);
      expect(inside).toBeNull();
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect([a, b].find((r) => !r.ok)).toMatchObject({ body: { error: 'runner_unchanged' } });
      expect((await agentRow(world)).config.revision).toBe(2);
      expect(await world.db.select().from(actions)).toHaveLength(1);
    });
  });
});

describe('own agent to Bootr agent: what is in flight', () => {
  it('an open own turn is closed by the engine hook, under the lease, before the runner is written', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const ownTurn = { role: 'social', startedAt: world.ctx.now(), steps: 2, nudged: false, reasons: ['pending_mention'], messages: [], inbox: {}, recentSteps: [{ tool: 'read_mentions', status: 'completed', summary: 'read 2' }], own: { turnId: 'otn_1', clientId: 'cli_1', openedAt: world.ctx.now(), lastCallAt: world.ctx.now(), forced: false } };
      const agent = await seedAgent(world, { config: { runner: 'own' }, runtime: { turn: ownTurn as unknown as Record<string, unknown>, status: 'running' } });
      const seen: { why: string; runnerAtClose: Runner; leased: boolean }[] = [];
      setOwnHooks({
        closeTurn: async (ctx, agentId, why) => {
          const [a, r] = [await agentRow(world), await runtimeRow(world)];
          seen.push({ why, runnerAtClose: runnerOf(a.config), leased: !!r.leaseToken });
          // what the engine does: a continuation note, the turn gone
          await ctx.db.update(runtimes).set({ turn: null, status: 'waiting', state: { ...(r.state as Record<string, unknown>), continuation: { progress: 'closed by the engine', recentSteps: [] } } }).where(eq(runtimes.agentId, agentId));
          return true;
        },
      });
      expect(await switchTo(world, agent, 'hosted')).toMatchObject({ ok: true });
      expect(seen).toEqual([{ why: 'runner_switched', runnerAtClose: 'own', leased: true }]);
      const runtime = await runtimeRow(world);
      expect(runtime.turn).toBeNull();
      // the engine's own note is kept: the switch reads the row again and does not write a stale state over it
      expect((runtime.state as unknown as AgentState).continuation?.progress).toBe('closed by the engine');
      expect(runnerOf((await agentRow(world)).config)).toBe('hosted');
    });
  });

  it('with no engine mounted, a stored own turn is still never handed to the hosted loop: it is cut short with a continuation note', async () => {
    await withWorld(async (world) => {
      setFlag(world, false);
      const ownTurn = { role: 'social', startedAt: world.ctx.now(), steps: 3, nudged: false, reasons: ['original_post_due'], messages: [], inbox: {}, recentSteps: [{ tool: 'publish_post', status: 'completed', summary: 'posted' }], own: { turnId: 'otn_2', clientId: 'cli_1', openedAt: world.ctx.now(), lastCallAt: world.ctx.now(), forced: false } };
      const agent = await seedAgent(world, { config: { runner: 'own' }, runtime: { turn: ownTurn as unknown as Record<string, unknown>, status: 'running' } });
      expect(await switchTo(world, agent, 'hosted')).toMatchObject({ ok: true });
      const runtime = await runtimeRow(world);
      expect(runtime.turn).toBeNull();
      expect(runtime.status).toBe('waiting');
      expect((runtime.state as unknown as AgentState).continuation).toEqual({ progress: 'Turn ended by the runtime (the agent was switched to the Bootr agent). Continue from the agenda.', recentSteps: ownTurn.recentSteps });
    });
  });

  it('an action that was sent or is held stays pending and held, so the tick settles it from its receipt before any hosted turn', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const pending = { actionId: '0xabc', cycle: 4, status: 'held', action: { tool: 'publish_post', input: { text: 'hello' } } };
      const agent = await seedAgent(world, { config: { runner: 'own' }, runtime: { pending, status: 'held', cycle: 4 } });
      expect(await switchTo(world, agent, 'hosted')).toMatchObject({ ok: true });
      const runtime = await runtimeRow(world);
      expect(runtime.pending).toEqual(pending);
      expect(runtime.status).toBe('held');
      expect(runtime.cycle).toBe(4);
    });
  });

  it('a creator pause is not lifted by a switch in either direction', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const nextAt = new Date(world.ctx.now() + 3_600_000);
      const agent = await seedAgent(world, { runtime: { status: 'paused', pausedBy: 'guardian', nextAt } });
      expect(await switchTo(world, agent, 'own')).toMatchObject({ ok: true });
      expect(await runtimeRow(world)).toMatchObject({ status: 'paused', pausedBy: 'guardian', nextAt });
      expect(await switchTo(world, await agentRow(world), 'hosted')).toMatchObject({ ok: true });
      expect(await runtimeRow(world)).toMatchObject({ status: 'paused', pausedBy: 'guardian', nextAt });
    });
  });
});

describe('Bootr agent to own agent: what is in flight', () => {
  it('a hosted turn stored between steps is dropped with a continuation note; its pending action is left to settle', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const hostedTurn = { role: 'social', startedAt: world.ctx.now(), steps: 2, nudged: false, reasons: ['pending_mention'], messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: '{}' }], inbox: {}, recentSteps: [{ tool: 'read_mentions', status: 'completed', summary: 'read 3' }] };
      const pending = { actionId: '0xdef', cycle: 2, status: 'sent', action: { tool: 'publish_reply', input: {} } };
      const agent = await seedAgent(world, { runtime: { turn: hostedTurn as unknown as Record<string, unknown>, status: 'running', pending, cycle: 2 } });
      expect(await switchTo(world, agent, 'own')).toMatchObject({ ok: true });
      const runtime = await runtimeRow(world);
      expect(runtime.turn).toBeNull();
      expect(runtime.pending).toEqual(pending);
      expect(runtime.status).toBe('waiting');
      expect((runtime.state as unknown as AgentState).continuation).toEqual({ progress: "Turn ended by the runtime (the agent was switched to its creator's own AI client). Continue from the agenda.", recentSteps: hostedTurn.recentSteps });
    });
  });

  it('a stored treasury turn is dropped without touching the social checkpoint', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const state = { ...initialState(), memory: 'm', agenda: 'a', summary: 's', continuation: null };
      const turn = { role: 'treasury', startedAt: world.ctx.now(), steps: 1, nudged: false, reasons: ['treasury_interval'], messages: [], inbox: {}, recentSteps: [] };
      const agent = await seedAgent(world, { runtime: { state: state as unknown as Record<string, unknown>, turn: turn as unknown as Record<string, unknown>, status: 'running' } });
      expect(await switchTo(world, agent, 'own')).toMatchObject({ ok: true });
      const runtime = await runtimeRow(world);
      expect(runtime.turn).toBeNull();
      expect(runtime.state).toMatchObject({ memory: 'm', agenda: 'a', summary: 's', continuation: null });
    });
  });

  it('a hosted agent asleep for fuel wakes as an own agent: thinking is not bought, so it does not sleep', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world, { runtime: { status: 'sleeping', nextAt: new Date(world.ctx.now() + 86_400_000) } });
      expect(await switchTo(world, agent, 'own')).toMatchObject({ ok: true });
      const runtime = await runtimeRow(world);
      expect(runtime.status).toBe('waiting');
      expect(runtime.nextAt.getTime()).toBe(world.ctx.now());
    });
  });

  it('a paid thought whose answer is unknown is asked for again and never bought again: the key stays while the relay cannot say', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const key = 'inf:7:3:abc';
      const state = { ...initialState(), inferenceKey: key };
      const agent = await seedAgent(world, { runtime: { state: state as unknown as Record<string, unknown> } });
      await world.db.insert(inference).values({ idempotencyKey: key, agentId: AGENT_ID, cycle: 3, requestHash: '0x1', request: { model: MODEL, messages: [] }, status: 'unknown', receipt: { payment: { x402Version: 2, payload: { signature: '0xsig' } } } });
      world.inference.state.requests = { status: 'unknown' };
      expect(await switchTo(world, agent, 'own')).toMatchObject({ ok: true });
      // the relay was asked about that key, and no thought was bought
      expect(world.inference.calls.filter((c) => c.url.includes(`/v1/requests/${encodeURIComponent(key)}`))).toHaveLength(1);
      expect(world.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toEqual([]);
      expect((await stateOf(world)).inferenceKey).toBe(key);
      // back on the Bootr agent the key is still there, which is what makes the hosted loop reconcile before it buys
      expect(await switchTo(world, await agentRow(world), 'hosted')).toMatchObject({ ok: true });
      expect((await stateOf(world)).inferenceKey).toBe(key);
      expect(world.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toEqual([]);
    });
  });

  it('a paid thought that did arrive is the one thought that goes unused: the key is cleared and nothing is bought', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const key = 'inf:7:3:def';
      const agent = await seedAgent(world, { runtime: { state: { ...initialState(), inferenceKey: key } as unknown as Record<string, unknown> } });
      await world.db.insert(inference).values({ idempotencyKey: key, agentId: AGENT_ID, cycle: 3, requestHash: '0x1', request: { model: MODEL, messages: [] }, status: 'succeeded', response: { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }, receipt: null });
      expect(await switchTo(world, agent, 'own')).toMatchObject({ ok: true });
      expect((await stateOf(world)).inferenceKey).toBeNull();
      expect(world.inference.calls).toEqual([]);
    });
  });

  it('a thought that was never paid for is simply dropped', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world, { runtime: { state: { ...initialState(), inferenceKey: 'inf:7:9:none' } as unknown as Record<string, unknown> } });
      expect(await switchTo(world, agent, 'own')).toMatchObject({ ok: true });
      expect((await stateOf(world)).inferenceKey).toBeNull();
      expect(world.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toEqual([]);
    });
  });
});

describe('what a switch carries over (section 5.3), both ways', () => {
  it('memory, checkpoint, notes, post history, X holds, approvals, creator requests, the chat history and a bounty job waiting for a ruling are the same rows after a switch there and back', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const now = world.ctx.now();
      const state = {
        ...initialState(),
        phase: 'social',
        memory: 'what I know',
        agenda: 'what is next',
        summary: 'what happened',
        lastCheckpointAt: now - 60_000,
        lastPostAt: now - 3_600_000,
        postQuotaUntil: now + 600_000,
        postForbiddenUntil: now + 6 * 3_600_000,
        postForbiddenStrikes: 1,
        postForbiddenAt: now - 1000,
        treasuryNextAt: now + 1_800_000,
        treasuryCheckpoint: { memory: 'tm', agenda: 'ta', summary: 'ts', at: now - 5000 },
        ownLastTurnAt: now - 120_000,
      };
      const agent = await seedAgent(world, { runtime: { state: state as unknown as Record<string, unknown>, cycle: 9 } });
      await world.ctx.memories.remember(AGENT_ID, { text: 'a note the agent took', sources: ['own'], tags: ['note'] });
      const request = await fileRequest(world.ctx, AGENT_ID, { text: 'Post about the new pool today', turn: 'social' });
      await world.db.insert(actions).values({ actionId: '0xpost1', agentId: AGENT_ID, cycleKey: '8', action: { tool: 'publish_post', input: { text: 'gm' } }, status: 'completed', result: { status: 'completed', result: { postId: '111' } }, receipt: null });
      await world.db.insert(approvals).values({ id: '0xappr1', agentId: AGENT_ID, kind: 'post', text: 'a post waiting for review', textHash: 'h1', status: 'pending_approval' });
      await world.db.insert(chatMessages).values([
        { id: 'msg_1', agentId: AGENT_ID, role: 'creator', text: 'what did you do today?', status: 'done', createdAt: new Date(now - 9000), updatedAt: new Date(now - 9000) },
        { id: 'msg_2', agentId: AGENT_ID, role: 'agent', text: 'I posted once.', status: 'done', chargedMicroUsdc: '1200', createdAt: new Date(now - 8000), updatedAt: new Date(now - 8000) },
      ]);
      // a bounty job whose window closed and which waits for a ruling
      await world.db.insert(bountyJobs).values({ id: `0x${'5'.repeat(64)}`, agentId: AGENT_ID, actionId: '0xbounty1', nonce: 1, task: 'Draw the coin', criteria: ['Shows the coin'], deliverable: 'image', amountMicroUsdc: '500000', status: 'judging', createdAt: new Date(now - 7 * 3_600_000), openedAt: new Date(now - 7 * 3_600_000), closesAt: new Date(now - 3_600_000), pageText: 'Draw the coin', updatedAt: new Date(now - 3_600_000) });

      const snapshot = async () => ({
        state: await stateOf(world),
        cycle: (await runtimeRow(world)).cycle,
        memories: await world.db.select().from(memories).orderBy(memories.id),
        posts: (await world.db.select().from(actions)).filter((a) => (a.action as { tool?: string }).tool),
        approvals: await world.db.select().from(approvals),
        chat: await world.db.select().from(chatMessages).orderBy(chatMessages.id),
        jobs: await world.db.select().from(bountyJobs),
        requests: await openRequests(world.ctx, AGENT_ID, 'social'),
        identity: (({ runner: _r, revision: _v, ...rest }) => rest)((await agentRow(world)).config as Record<string, unknown>),
        keys: (({ permissionId, sessionKeyInstalledAt, spender, status }) => ({ permissionId, sessionKeyInstalledAt, spender, status }))(await agentRow(world)),
      });
      const before = await snapshot();
      expect(before.requests.map((r) => r.id)).toEqual([request.id]);
      expect(before.jobs).toHaveLength(1);

      expect(await switchTo(world, agent, 'own')).toMatchObject({ ok: true });
      expect(await snapshot()).toEqual(before);
      // the open request is still there for the own turn of its kind to be shown and to answer
      expect((await openRequests(world.ctx, AGENT_ID, 'social')).map((r) => r.id)).toEqual([request.id]);

      expect(await switchTo(world, await agentRow(world), 'hosted')).toMatchObject({ ok: true });
      expect(await snapshot()).toEqual(before);
      // and the session key was not touched: no rotation, nobody signs
      expect(world.kernel.submitted).toEqual([]);
    });
  });
});

describe('GET /internal/agents/:id/config: runner and own', () => {
  for (const flag of [true, false]) {
    it(`reads the config with the flag ${flag ? 'on' : 'off'}: hosted has no own block, own has the last turn and the client count`, async () => {
      await withWorld(async (world) => {
        setFlag(world, flag);
        const agent = await seedAgent(world);
        const read = async () => (await (await api(world).get(`/internal/agents/${AGENT_ID}/config`)).json()) as { runner: string; own: unknown; model: string };
        expect(await read()).toMatchObject({ runner: 'hosted', own: null });
        await world.db.update(agents).set({ config: { ...agent.config, runner: 'own' } }).where(eq(agents.agentId, AGENT_ID));
        expect(await read()).toMatchObject({ runner: 'own', own: { lastTurnAt: null, clients: 0 }, model: MODEL });
        const at = world.ctx.now() - 14 * 60_000;
        const row = await runtimeRow(world);
        await world.db.update(runtimes).set({ state: { ...(row.state as Record<string, unknown>), ownLastTurnAt: at } }).where(eq(runtimes.agentId, AGENT_ID));
        setOwnHooks({ countClients: async () => 2 });
        expect(await read()).toMatchObject({ runner: 'own', own: { lastTurnAt: new Date(at).toISOString(), clients: 2 } });
        // a client count that cannot be read is zero, never an error on a public read
        setOwnHooks({
          countClients: async () => {
            throw new Error('no table');
          },
        });
        expect(await read()).toMatchObject({ runner: 'own', own: { lastTurnAt: new Date(at).toISOString(), clients: 0 } });
      });
    });
  }
});

describe('the chat of an own coin', () => {
  for (const flag of [true, false]) {
    it(`is chat_not_available with the flag ${flag ? 'on' : 'off'}, before anything is read or paid`, async () => {
      await withWorld(async (world) => {
        setFlag(world, flag);
        const agent = await seedAgent(world, { config: { runner: 'own' } });
        const calls = world.state.calls.length;
        const result = await sendChatMessage(world.ctx, agent, { by: CREATOR, text: 'What did you do today?' });
        expect(result).toEqual({ ok: false, status: 409, error: 'chat_not_available', message: OWN_ERRORS.chat_not_available.message });
        // no chain read, no relay call, no row
        expect(world.state.calls.length).toBe(calls);
        expect(world.inference.calls).toEqual([]);
        expect(await world.db.select().from(chatMessages)).toEqual([]);
        expect(await world.db.select().from(inference)).toEqual([]);
        // the same through the route the web calls, whoever asks
        const res = await api(world).post(`/internal/agents/${AGENT_ID}/chat`, { by: OTHER, text: 'hi' });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'chat_not_available', message: OWN_ERRORS.chat_not_available.message });
      });
    });
  }

  it('is back for the same coin once it runs on the Bootr agent again, history included', async () => {
    await withWorld(async (world) => {
      setFlag(world, true);
      const agent = await seedAgent(world, { config: { runner: 'own' } });
      await world.db.insert(chatMessages).values({ id: 'msg_old', agentId: AGENT_ID, role: 'creator', text: 'an old question', status: 'done', createdAt: new Date(world.ctx.now() - 86_400_000), updatedAt: new Date(world.ctx.now() - 86_400_000) });
      expect(await sendChatMessage(world.ctx, agent, { by: CREATOR, text: 'hi' })).toMatchObject({ ok: false, error: 'chat_not_available' });
      expect(await switchTo(world, agent, 'hosted')).toMatchObject({ ok: true });
      const res = await api(world).get(`/internal/agents/${AGENT_ID}/chat`);
      expect(((await res.json()) as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual(['an old question']);
      const hosted = await sendChatMessage(world.ctx, await agentRow(world), { by: CREATOR, text: 'hi' });
      expect(hosted.ok ? 'answered' : hosted.error).not.toBe('chat_not_available');
    });
  });
});
