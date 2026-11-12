/**
 * Own agents (docs/design/byo-agent.md section 13): the seams between the workstreams that work inside the supervisor.
 * W1a owns this file and the turn engine (own/turns.ts). W2 registers the treasury and judge roles and its special
 * tools; W3 calls the hooks from the runner switch and from registration; W1b never touches the supervisor. Nothing here runs a model, reads X or
 * touches the database: it only holds what was registered.
 */
import type { Action, ActionResult, AgentConfig } from '@bootr/agent-core';
import { OWN_DEFAULTS, runnerOf, type ActResult, type DueRole, type FinishRequest, type OwnRole, type Runner } from '@bootr/shared/own-agent';
import type { z } from 'zod';
import type { AgentRow, RuntimeRow, SupervisorContext } from '../context.js';
import type { AgentState, Turn } from '../runtime.js';

/**
 * The flag (`OWN_AGENT_ENABLED=true`): whether the feature's surfaces are offered and a coin may become own. Asked at
 * the top of the connect and run routes and in a switch to own, and nowhere else. It never decides how a coin is run.
 */
export function ownEnabled(ctx: Pick<SupervisorContext, 'config'>): boolean {
  return (ctx.config as unknown as Record<string, unknown>).OWN_AGENT_ENABLED === true;
}

/**
 * How this coin is run: true when its stored config says `runner: 'own'`, with the flag on or off. Every branch in the
 * tick, the broker, the sweeps, the fee policy and the chat asks this and only this, so an own coin is never thought
 * for by a hosted model. With the flag off such a coin is silent.
 */
export function isOwn(agent: Pick<AgentRow, 'config'>): boolean {
  return runnerOf(agent.config) === 'own';
}

/** One of the supervisor's own-agent settings: the config value when config.ts carries it, else the default. */
export function ownSetting<K extends keyof typeof OWN_DEFAULTS>(ctx: Pick<SupervisorContext, 'config'>, name: K): number {
  const value = (ctx.config as unknown as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : OWN_DEFAULTS[name];
}

/** What the engine keeps on a stored turn (`Turn.own`); absent on every hosted turn. */
export interface OwnTurnMeta {
  turnId: string;
  clientId: string;
  openedAt: number;
  lastCallAt: number;
  /** Opened with `reason: 'creator_asked'` while nothing was due. */
  forced: boolean;
  /** The judge role: the job being ruled on. */
  jobId?: string;
}

/** What every role and tool function is handed. `state` is the runtime's state, mutated in place; the engine persists it. */
export interface OwnCall {
  ctx: SupervisorContext;
  agent: AgentRow;
  runtime: RuntimeRow;
  config: AgentConfig;
  state: AgentState;
  now: number;
}

export interface OwnOpened {
  /** Stored in `sv_runtimes.turn` as today; `messages` stays empty; the engine adds `own`. */
  turn: Turn;
  /** `buildSystemPrompt(config, role)`. */
  brief: string;
  observation: Record<string, unknown>;
  /** agent-core tool names this turn may call; `finish` is implied and special tools come from `OwnSpecialTool.offered`. */
  tools: string[];
}

export interface OwnRoleHandler {
  role: OwnRole;
  /** Whether a turn of this role is due now and why. No X read beyond what the engine already did for this call. */
  due(call: OwnCall): Promise<DueRole>;
  /** Build the turn. The engine has the lease, checked `due` (or the forced-turn allowance) and stores what comes back. */
  open(call: OwnCall, opts: { reasons: string[]; forced: boolean; jobId?: string }): Promise<OwnOpened>;
  /** After an agent-core action of this turn settled: the role's bookkeeping on `state` and `turn`. */
  settled?(call: OwnCall, turn: Turn, action: Action, result: ActionResult): Promise<void>;
  /** `finish`: write the checkpoint into `state`; `nextAt` (ms) moves the runtime's wake when present. Throws on a bad checkpoint; the engine answers `failed` and keeps the turn. */
  finish(call: OwnCall, turn: Turn, input: FinishRequest): Promise<{ result: Record<string, unknown>; nextAt?: number }>;
  /** The engine is closing the turn without a finish (idle, step cap, runner switch, client revoked). */
  abandoned?(call: OwnCall, turn: Turn, why: string): Promise<void>;
}

/** A tool that is not in agent-core's catalog: `answer_request`, `judge_entry`, `judge` (W2). */
export interface OwnSpecialTool {
  /** Without the `bootr_agent_` prefix. */
  name: string;
  roles: readonly OwnRole[];
  input: z.ZodTypeAny;
  /** Whether this turn may call it now. */
  offered(turn: Turn, config: AgentConfig): boolean;
  /** One step. Never throws: a failure is `status: 'failed'` with `error`. `endsTurn` closes the turn after the answer. */
  run(call: OwnCall, turn: Turn, input: unknown): Promise<Pick<ActResult, 'status' | 'result' | 'error' | 'image'> & { endsTurn?: boolean }>;
}

/** What W3 (the runner switch, registration, the config view) needs from W1a without importing W1a's files. */
export interface OwnHooks {
  /** Close the coin's open own turn, if any, the way a cut-short turn ends. True when one was closed. */
  closeTurn(ctx: SupervisorContext, agentId: string, why: 'runner_switched' | 'client_revoked' | 'expired'): Promise<boolean>;
  /** Set the sender's X read budget for the runner in force (OWN_READS_PER_DAY for `own`, the sender's default for `hosted`). */
  applyRunnerQuota(ctx: SupervisorContext, agentId: string, runner: Runner): Promise<void>;
  /** Bind the clients approved for the agent's launch draft to the agent, when the creator matches. Returns how many. */
  adoptDraftClients(ctx: SupervisorContext, agent: AgentRow): Promise<number>;
  /** Live (not revoked, not expired) clients of the agent. */
  countClients(ctx: SupervisorContext, agentId: string): Promise<number>;
}

const roles = new Map<OwnRole, OwnRoleHandler>();
const tools = new Map<string, OwnSpecialTool>();

/** Until W1a's mount replaces them the hooks do nothing, so W2 and W3 compile and test alone. */
export const ownHooks: OwnHooks = {
  closeTurn: async () => false,
  applyRunnerQuota: async () => undefined,
  adoptDraftClients: async () => 0,
  countClients: async () => 0,
};

export function setOwnHooks(hooks: Partial<OwnHooks>): void {
  Object.assign(ownHooks, hooks);
}

/** Registering the same role or tool again replaces it (tests build several apps in one process). */
export function registerOwnRole(handler: OwnRoleHandler): void {
  roles.set(handler.role, handler);
}

export function registerOwnTool(tool: OwnSpecialTool): void {
  tools.set(tool.name, tool);
}

export function ownRole(role: OwnRole): OwnRoleHandler | null {
  return roles.get(role) ?? null;
}

export function ownTool(name: string): OwnSpecialTool | null {
  return tools.get(name) ?? null;
}

export function ownTools(): OwnSpecialTool[] {
  return [...tools.values()];
}
