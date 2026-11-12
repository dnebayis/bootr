/**
 * A minimal stand-in for the own-agent turn engine (own/turns.ts, which another workstream builds), for the tests of
 * the treasury and judge roles and the three special tools. It knows nothing about those roles: it reaches them only
 * through the registry (`ownRole`, `ownTool`), in the order docs/design/byo-agent.md section 13.4 fixes for one call:
 * refuse past the step cap, then either a special tool (`offered`, parse the input, `run`) or an agent-core tool (it
 * must be in the turn's `tools`, then `parseAction`, `beginAction`, the action row with `via: 'own'`, `executeAction`
 * or `queueForApproval`, `recordOutcome`, the row's update, `settleCycle`, the role's `settled`), then count the step
 * and persist state and turn. No credential, no lease, no expiry, no replay of a repeated call: those are the real
 * engine's.
 *
 * It is kept for the tests that are about a role in isolation (what a role says is due, what it shows, what its tools
 * check, with the flag on and off, where the real routes would answer `own_agent_disabled`). A test about what an own
 * coin really does runs through the real engine instead (`realEngine` in own-helpers.ts, the internal routes with a real
 * credential): a stand-in that leaves out a step of the engine reports a bug the engine does not have, as this one did
 * for the platform update before it marked it the way the engine does.
 */
import { PolicyError, beginAction, markSent, parseAction, recordOutcome, settleCycle, type Action, type ActionResult, type AgentConfig, type BrokerRuntime, type PendingAction } from '@bootr/agent-core';
import type { ActResult, DueRole, FinishRequest, OwnRole } from '@bootr/shared/own-agent';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { queueForApproval, requiresApproval } from '../src/approvals.js';
import { executeAction, type BrokerEnv } from '../src/broker/index.js';
import type { AgentRow, RuntimeRow } from '../src/context.js';
import { actions, agents, runtimes } from '../src/db/schema.js';
import { agentConfigOf } from '../src/onboarding.js';
import { ownRole, ownTool, ownTools, type OwnCall, type OwnOpened, type OwnTurnMeta } from '../src/own/registry.js';
import { settlePlatformUpdate } from '../src/platform-updates.js';
import type { AgentState, Turn } from '../src/runtime.js';
import { AGENT_ID, type TestWorld } from './helpers.js';

/** A call the engine could not take (`OwnErrorBody` on the wire): not due, no such tool in this turn, a bad input, past the step cap. */
export class EngineRefusal extends Error {
  constructor(
    readonly code: 'not_due' | 'turn_open' | 'turn_not_found' | 'tool_unavailable' | 'invalid_tool_call' | 'step_cap',
    detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EngineRefusal';
  }
}

export type Act = Pick<ActResult, 'tool' | 'actionId' | 'status' | 'result' | 'error' | 'image' | 'stepsUsed' | 'turnEnded'>;
type StoredTurn = Turn & { own?: OwnTurnMeta };

export interface FakeEngine {
  due(role: OwnRole): Promise<DueRole>;
  open(role: OwnRole, opts?: { jobId?: string; forced?: boolean }): Promise<OwnOpened>;
  act(tool: string, input: Record<string, unknown>): Promise<Act>;
  finish(input: Omit<FinishRequest, 'turnId'>): Promise<Act>;
  /** Close the open turn the way the engine does without a finish (idle, step cap, runner switch). */
  abandon(why: string): Promise<void>;
  /** The special tools the open turn is offered now. */
  offered(): Promise<string[]>;
  turn(): Promise<StoredTurn | null>;
  state(): Promise<AgentState>;
}

export function fakeEngine(w: TestWorld, agentId: string = AGENT_ID): FakeEngine {
  const { ctx, db } = w;
  /** What `open` answered for the turn that is open: the agent-core tools it may call. */
  let tools: string[] = [];

  async function load(): Promise<{ agent: AgentRow; runtime: RuntimeRow; config: AgentConfig; call: OwnCall }> {
    const agent = (await db.query.agents.findFirst({ where: eq(agents.agentId, agentId) }))!;
    const runtime = (await db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agentId) }))!;
    const config = agentConfigOf(agent)!;
    const state = runtime.state as unknown as AgentState;
    return { agent, runtime, config, call: { ctx, agent, runtime, config, state, now: ctx.now() } };
  }

  async function save(patch: Partial<typeof runtimes.$inferInsert>): Promise<void> {
    await db.update(runtimes).set({ ...patch, updatedAt: new Date(ctx.now()) }).where(eq(runtimes.agentId, agentId));
  }

  const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

  return {
    async due(role) {
      const { call } = await load();
      return ownRole(role)!.due(call);
    },

    async open(role, opts = {}) {
      const { runtime, call } = await load();
      const handler = ownRole(role);
      if (!handler) throw new Error(`no ${role} role is registered`);
      if (runtime.turn) throw new EngineRefusal('turn_open');
      const due = await handler.due(call);
      if (!due.due && !opts.forced) throw new EngineRefusal('not_due');
      const opened = await handler.open(call, { reasons: due.reasons, forced: !!opts.forced && !due.due, ...(opts.jobId ? { jobId: opts.jobId } : {}) });
      const own: OwnTurnMeta = { turnId: `otn_${'0'.repeat(32)}`, clientId: 'cli_0000000000000000', openedAt: call.now, lastCallAt: call.now, forced: !!opts.forced && !due.due, ...(opts.jobId ? { jobId: opts.jobId } : {}) };
      tools = opened.tools;
      await save({ state: json(call.state), turn: json({ ...opened.turn, own }), status: 'running' });
      return opened;
    },

    async act(tool, input) {
      const { agent, runtime, config, call } = await load();
      const turn = runtime.turn as unknown as StoredTurn | null;
      if (!turn) throw new EngineRefusal('turn_not_found');
      const role: OwnRole = turn.role ?? 'social';
      if (turn.steps >= ctx.config.MAX_TOOL_STEPS) throw new EngineRefusal('step_cap');
      const done = async (act: Omit<Act, 'tool' | 'stepsUsed' | 'turnEnded'>, endsTurn: boolean, patch: Partial<typeof runtimes.$inferInsert> = {}): Promise<Act> => {
        turn.steps += 1;
        if (turn.own) turn.own.lastCallAt = ctx.now();
        await save({ state: json(call.state), turn: endsTurn ? null : json(turn), ...(endsTurn ? { status: 'waiting' as const } : {}), ...patch });
        return { tool, ...act, stepsUsed: turn.steps, turnEnded: endsTurn };
      };

      const special = ownTool(tool);
      if (special) {
        if (!special.roles.includes(role) || !special.offered(turn, config)) throw new EngineRefusal('tool_unavailable', tool);
        const parsed = special.input.safeParse(input);
        if (!parsed.success) throw new EngineRefusal('invalid_tool_call', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        const answer = await special.run(call, turn, parsed.data);
        return done({ actionId: null, status: answer.status, ...(answer.result !== undefined ? { result: answer.result } : {}), ...(answer.error ? { error: answer.error } : {}), ...(answer.image ? { image: answer.image } : {}) }, answer.endsTurn === true);
      }

      if (!tools.includes(tool)) throw new EngineRefusal('tool_unavailable', tool);
      let action: Action;
      try {
        action = parseAction({ tool, input });
      } catch (err) {
        throw new EngineRefusal('invalid_tool_call', err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : String(err));
      }
      let broker: BrokerRuntime = { runtimeId: agent.agentId, cycle: runtime.cycle, pending: (runtime.pending as unknown as PendingAction | null) ?? null };
      const now = ctx.now();
      let pending = beginAction(broker, action, broker.cycle, now, false);
      await db
        .insert(actions)
        .values({ actionId: pending.id, agentId: agent.agentId, cycleKey: pending.cycleKey, action: { ...(action as unknown as Record<string, unknown>), ...(role !== 'social' ? { role } : {}), via: 'own', clientId: turn.own?.clientId ?? null }, status: 'sending', createdAt: new Date(now), updatedAt: new Date(now) })
        .onConflictDoNothing();
      pending = markSent(pending);
      // What the real engine hands the broker's own guards (`brokerTurn` in src/own/turns.ts): without it `ownGuard` takes
      // the turn for one with no due slot and refuses every original post.
      const lastPostAt = ((runtime.state as { lastPostAt?: number } | null)?.lastPostAt ?? 0) as number;
      const postAllowed = !!turn.digestWeek || !!turn.numbersDay || (turn.creatorRequests?.length ?? 0) > 0 || (!!turn.postDue && lastPostAt < turn.startedAt);
      const env: BrokerEnv = { inbox: new Map(Object.entries(turn.inbox)), eligibility: new Map(Object.entries(turn.eligibility ?? {})), cycle: broker.cycle, own: { openedAt: turn.own?.openedAt ?? turn.startedAt, postAllowed, nextSlotAt: null } };
      const reviewed = (action.tool === 'publish_post' || action.tool === 'publish_reply') && requiresApproval(agent.config);
      const outcome = reviewed ? await queueForApproval(ctx, agent, pending, env) : await executeAction(ctx, agent, config, pending, env);
      pending = recordOutcome(pending, outcome, ctx.now());
      turn.inbox = Object.fromEntries(env.inbox);
      turn.eligibility = Object.fromEntries(env.eligibility);
      await db.update(actions).set({ status: pending.status, result: (pending.result as unknown as Record<string, unknown>) ?? null, receipt: (pending.result?.receipt as Record<string, unknown> | undefined) ?? null, updatedAt: new Date(ctx.now()) }).where(eq(actions.actionId, pending.id));
      if (pending.status === 'held' || pending.status === 'sent') {
        await ownRole(role)?.abandoned?.(call, turn, 'held_action');
        return done({ actionId: pending.id, status: pending.status === 'held' ? 'held' : 'pending', error: pending.reason ?? pending.status }, pending.status === 'held', { pending: json(pending), status: pending.status === 'held' ? 'held' : 'running' });
      }
      broker.pending = pending;
      // As the real engine settles (`settlePending` in src/own/turns.ts, the hosted `settle`): a platform update the post
      // carried is marked before the cycle moves on, and the role is handed the action as it settled in the call's runtime.
      settlePlatformUpdate(config, call.state, pending, ctx.now());
      const settled = settleCycle(broker);
      broker = settled.runtime;
      const result = settled.observation as ActionResult;
      await ownRole(role)?.settled?.({ ...call, runtime: { ...runtime, pending: pending as unknown as Record<string, unknown> } }, turn, action, result);
      return done({ actionId: pending.id, status: result.status === 'completed' ? 'completed' : 'failed', ...(result.status === 'completed' ? { result: result.result } : { error: result.error ?? result.status }) }, false, { cycle: broker.cycle, pending: null });
    },

    async finish(input) {
      const { runtime, call } = await load();
      const turn = runtime.turn as unknown as StoredTurn | null;
      if (!turn) throw new EngineRefusal('turn_not_found');
      const role: OwnRole = turn.role ?? 'social';
      try {
        const finished = await ownRole(role)!.finish(call, turn, { turnId: turn.own?.turnId ?? '', ...input });
        await save({ state: json(call.state), turn: null, status: 'waiting', ...(finished.nextAt ? { nextAt: new Date(finished.nextAt) } : {}) });
        return { tool: 'finish', actionId: null, status: 'completed', result: finished.result, stepsUsed: turn.steps, turnEnded: true };
      } catch (err) {
        if (!(err instanceof PolicyError)) throw err;
        return { tool: 'finish', actionId: null, status: 'failed', error: err.message, stepsUsed: turn.steps, turnEnded: false };
      }
    },

    async abandon(why) {
      const { runtime, call } = await load();
      const turn = runtime.turn as unknown as StoredTurn | null;
      if (!turn) return;
      await ownRole(turn.role ?? 'social')?.abandoned?.(call, turn, why);
      await save({ state: json(call.state), turn: null, status: 'waiting' });
    },

    async offered() {
      const { runtime, config } = await load();
      const turn = runtime.turn as unknown as StoredTurn | null;
      if (!turn) return [];
      const role: OwnRole = turn.role ?? 'social';
      return ownTools()
        .filter((t) => t.roles.includes(role) && t.offered(turn, config))
        .map((t) => t.name)
        .sort();
    },

    async turn() {
      return ((await load()).runtime.turn as unknown as StoredTurn | null) ?? null;
    },

    async state() {
      return (await load()).runtime.state as unknown as AgentState;
    },
  };
}

/** The seeded agent's stored config as an own-agent coin's: the one field the feature adds. */
export function ownConfig(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, runner: 'own' };
}

/** Turns the flag on or off for a test world: `ownEnabled` reads `OWN_AGENT_ENABLED === true` from the config (registry.ts). */
export function setOwnFlag(w: TestWorld, on: boolean): void {
  (w.ctx.config as unknown as Record<string, unknown>).OWN_AGENT_ENABLED = on;
}

/** Makes every model call a test failure: an own coin never buys a thought. Returns the urls that were asked anyway. */
export function forbidThoughts(w: TestWorld): string[] {
  const asked: string[] = [];
  const inner = w.ctx.fetch;
  w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/v1/chat/completions') || url.includes('/v1/requests/') || url.includes('/v1/images')) {
      asked.push(url);
      throw new Error(`an own coin asked for a thought: ${url}`);
    }
    return inner(input, init);
  }) as typeof fetch;
  return asked;
}
