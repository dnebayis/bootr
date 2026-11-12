/**
 * Own agents (docs/design/byo-agent.md sections 2 and 13.4): the turn engine. A turn of an own coin is a short object
 * on the server that the creator's client opens, feeds one tool call at a time and closes. The model call and the loop
 * around it are the client's; everything else is what the hosted loop (`runtime.ts` `runLoop`) does, by the same code:
 * the action is parsed (`parseAction`), bound to the cycle (`beginAction`), run by the broker (`executeAction`) or
 * queued for the creator's review (`queueForApproval`), recorded (`recordOutcome`) and settled (`settleCycle`).
 *
 * What the engine adds, because no hosted loop stands between the caller and the broker:
 *   - every call holds the runtime lease, so a call never overlaps the tick, another call or a runner switch;
 *   - one open turn per coin, with an id only the server makes; a turn idle for `OWN_TURN_IDLE_MS` or open for
 *     `OWN_TURN_MAX_MS` is closed the way a cut-short hosted turn ends (a continuation note, no checkpoint);
 *   - the step cap (`MAX_TOOL_STEPS`) on everything but `finish`;
 *   - an acting call that completed is never carried out twice in a turn: the same tool with the same input is
 *     answered from the row of the first one, so a retry after a lost answer, or a replayed request, repeats nothing.
 *     A read is simply run again; a call that failed did nothing and may be made again;
 *   - while an action's outcome is unknown, only that same call may be repeated (`runtime_busy` for any other), and an
 *     action that is held ends the turn and is settled by the tick from its receipt.
 *
 * The roles are plugged in through `own/registry.ts`: this file knows no role's observation, due rule or checkpoint.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PolicyError,
  TOOLS,
  actionId as actionIdOf,
  beginAction,
  boundedState,
  cycleKey,
  digest,
  markSent,
  parseAction,
  reconcile,
  recordOutcome,
  resumeAction,
  settleCycle,
  type Action,
  type ActionOutcome,
  type ActionResult,
  type AgentConfig,
  type AgentRole,
  type BrokerRuntime,
  type PendingAction,
} from '@bootr/agent-core';
import {
  MCP_TOOL_PREFIX,
  OWN_ROLES,
  PICTURE_DESCRIPTION_MAX,
  PICTURE_MAX_BYTES,
  PICTURE_MIMES,
  TURN_ID_PREFIX,
  runnerOf,
  type ActRequest,
  type ActResult,
  type AgentStatus,
  type DueRole,
  type DueView,
  type FinishRequest,
  type HoldView,
  type OwnRole,
  type TurnOpen,
  type TurnRequest,
  type UploadPictureRequest,
} from '@bootr/shared/own-agent';
import { and, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { queueForApproval, queuedOutcomeFor, requiresApproval } from '../approvals.js';
import { availableTools, executeAction, jsonSafe, ownGuard, resolveMentions, resolvePending, type BrokerEnv, type OwnBrokerTurn, type PendingResolution } from '../broker/index.js';
import type { AgentRow, RuntimeRow, SupervisorContext } from '../context.js';
import { actions, agents, runtimes } from '../db/schema.js';
import { ALT_MAX_CHARS } from '../image-rules.js';
import { imagesLeftToday } from '../images.js';
import { rpcErrorText } from '../log.js';
import { agentConfigOf } from '../onboarding.js';
import { settlePlatformUpdate } from '../platform-updates.js';
import { creditsHold, forbiddenHold, quotaHold } from '../rhythm.js';
import { LEASE_MS, acquireLease, releaseLease, saveRuntime, scheduleFor, trimState, type AgentState, type OwnCallRecord, type Turn } from '../runtime.js';
import type { SenderInboxItem } from '../sender-client.js';
import { readTreasuryOnChain } from '../treasury.js';
import { OwnError, clientView, coinRef, type VerifiedClient } from './clients.js';
import { storeUpload } from './pictures.js';
import { applyRunnerQuota, runnerReadsPerDay } from './quota.js';
import { isOwn, ownRole, ownSetting, ownTool, ownTools, type OwnCall, type OwnTurnMeta } from './registry.js';

type RuntimePatch = NonNullable<Parameters<typeof saveRuntime>[2]>;

/** A turn id is `otn_` and 16 random bytes in hex. */
export const OWN_TURN_ID_RE = /^otn_[0-9a-f]{32}$/;
/** After a social turn the server closed without a checkpoint, its wake moves this far on, as after a hosted turn the runtime ended. */
export const ABANDONED_WAKE_MS = 5 * 60_000;
/** How soon a waiting client should look again for mentions when nothing else is due sooner (the sender's mention interval). */
export const OWN_MENTION_CHECK_MS = 5 * 60_000;
export const HELD_RETRY_MS = 60_000;
export const BUSY_RETRY_MS = 5_000;
export const PENDING_RETRY_MS = 15_000;
/** Mentions one turn closes as stale; the rest wait for the next. */
export const MAX_STALE_CLOSE_PER_TURN = 50;
export const STALE_MENTION_REASON = 'stale_after_downtime';
/** What an action whose outcome was still unknown is recorded as once its turn is gone: nobody is left to repeat the call. */
export const TURN_ENDED_ERROR = 'turn_ended: the turn closed before this call was repeated; its outcome was not confirmed';
export const UPLOAD_TOOL = 'upload_picture';
export const FINISH_TOOL = 'finish';

/** Why the engine closed a turn without a `finish`. */
export type CloseWhy = 'expired' | 'client_revoked' | 'runner_switched' | 'held' | 'hosted_turn_dropped';

// ---------------------------------------------------------------------------
// Notes a role leaves for the engine while it answers `due` (the registry's `DueRole` has no room for them)
// ---------------------------------------------------------------------------

export interface CallNotes {
  /** The sender refused the mention read because no X account is connected (or X dropped it). */
  xNotConnected?: boolean;
  /** When the sender will next read mentions for this coin (its throttle), when it said so. */
  mentionsNextReadAt?: number | null;
}
const callNotesOf = new WeakMap<OwnCall, CallNotes>();
/** The notes of one call, made on first use; the social role writes them, the due view reads them. */
export function callNotes(call: OwnCall): CallNotes {
  let notes = callNotesOf.get(call);
  if (!notes) {
    notes = {};
    callNotesOf.set(call, notes);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// One leased call
// ---------------------------------------------------------------------------

interface Session {
  ctx: SupervisorContext;
  agent: AgentRow;
  config: AgentConfig;
  /** The row as it was leased; `state` is its state object, mutated in place and written back by `persist`. */
  runtime: RuntimeRow;
  state: AgentState;
  turn: Turn | null;
  broker: BrokerRuntime;
}

function sessionOf(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, runtime: RuntimeRow): Session {
  return {
    ctx,
    agent,
    config,
    runtime,
    state: runtime.state as unknown as AgentState,
    turn: (runtime.turn as unknown as Turn | null) ?? null,
    broker: { runtimeId: agent.agentId, cycle: runtime.cycle, pending: (runtime.pending as unknown as PendingAction | null) ?? null },
  };
}

function callOf(s: Session, pending: PendingAction | null = s.broker.pending): OwnCall {
  const runtime: RuntimeRow = { ...s.runtime, cycle: s.broker.cycle, pending: (pending as unknown as Record<string, unknown> | null) ?? null, turn: (s.turn as unknown as Record<string, unknown> | null) ?? null };
  return { ctx: s.ctx, agent: s.agent, runtime, config: s.config, state: s.state, now: s.ctx.now() };
}

async function persist(s: Session, patch: RuntimePatch = {}): Promise<void> {
  await saveRuntime(s.ctx, s.agent.agentId, {
    state: boundedState(trimState(s.state)) as unknown as Record<string, unknown>,
    cycle: s.broker.cycle,
    pending: (s.broker.pending as unknown as Record<string, unknown> | null) ?? null,
    turn: (s.turn as unknown as Record<string, unknown> | null) ?? null,
    ...patch,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` under the runtime lease, the lock the tick and the runner switch take too. The lease is taken for longer
 * than one tool may run, so it cannot lapse inside a step. When the tick or another call holds it, the call waits
 * `OWN_LEASE_WAIT_MS` and then answers `runtime_busy`: nothing was done and the same call may be repeated.
 */
async function withLease<T>(ctx: SupervisorContext, agentId: string, fn: (runtime: RuntimeRow) => Promise<T>): Promise<T> {
  const token = randomUUID();
  const leaseMs = Math.max(LEASE_MS, ctx.config.TOOL_TIMEOUT_MS + 30_000);
  const waitMs = Math.max(0, Number((ctx.config as { OWN_LEASE_WAIT_MS?: number }).OWN_LEASE_WAIT_MS ?? 4000));
  const deadline = Date.now() + waitMs;
  let runtime = await acquireLease(ctx, agentId, token, leaseMs);
  while (!runtime && Date.now() < deadline) {
    await sleep(150);
    runtime = await acquireLease(ctx, agentId, token, leaseMs);
  }
  if (!runtime) throw new OwnError('runtime_busy', { retryAt: ctx.now() + BUSY_RETRY_MS });
  try {
    return await fn(runtime);
  } finally {
    await releaseLease(ctx, agentId, token);
  }
}

/** The checks of 13.6 that follow the credential's own: the agent is set up, and it is run by its creator's client. */
function gate(v: VerifiedClient): AgentConfig {
  const config = v.agent.status === 'onboarding' ? null : agentConfigOf(v.agent);
  if (!config) throw new OwnError('agent_onboarding');
  if (!isOwn(v.agent)) throw new OwnError('agent_runs_hosted');
  return config;
}

const iso = (ms: number) => new Date(ms).toISOString();
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

function roleOf(turn: Turn): OwnRole {
  return turn.role === 'treasury' || turn.role === 'judge' ? turn.role : 'social';
}

function stepBudget(ctx: Pick<SupervisorContext, 'config'>): number {
  return ctx.config.MAX_TOOL_STEPS;
}

/** When the server closes this turn if nothing more is heard of it: idle for `OWN_TURN_IDLE_MS`, or open for `OWN_TURN_MAX_MS`. */
export function ownTurnExpiresAt(ctx: Pick<SupervisorContext, 'config'>, own: OwnTurnMeta): number {
  return Math.min(own.lastCallAt + ownSetting(ctx, 'OWN_TURN_IDLE_MS'), own.openedAt + ownSetting(ctx, 'OWN_TURN_MAX_MS'));
}

function summarize(status: string, result: unknown, error: string | undefined): string {
  const base = status === 'completed' ? JSON.stringify(jsonSafe(result ?? null)) : (error ?? status);
  return base.slice(0, 200);
}

function invalidCall(err: unknown): OwnError {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first ? first.path.filter((p) => p !== 'input').join('.') : '';
    return new OwnError('invalid_tool_call', { detail: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ').slice(0, 600), ...(field ? { field } : {}) });
  }
  return new OwnError('invalid_tool_call', { detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

/** The hosted `settle`: the action row takes the outcome, a platform update the post carried is marked, the cycle advances. */
async function settlePending(s: Session): Promise<ActionResult | null> {
  const pending = s.broker.pending;
  if (pending) {
    settlePlatformUpdate(s.config, s.state, pending, s.ctx.now());
    await s.ctx.db
      .update(actions)
      .set({ status: pending.status, result: (pending.result as unknown as Record<string, unknown>) ?? null, receipt: (pending.result?.receipt as Record<string, unknown> | undefined) ?? null, updatedAt: new Date(s.ctx.now()) })
      .where(eq(actions.actionId, pending.id));
  }
  const settled = settleCycle(s.broker);
  s.broker = settled.runtime;
  return settled.observation;
}

/**
 * An action an earlier call or turn left behind. One whose outcome is known by now (the tick reconciled it, the
 * sender has its receipt, the chain closed it) is settled here and the cycle moves on. `held`: its outcome is still
 * unknown and only a receipt can tell; nothing may run. `sent`: it may be repeated by the call that made it; with
 * `dropResumable` (its turn is gone, so nobody will repeat it) it is recorded as not confirmed instead.
 */
async function clearLeftover(s: Session, opts: { dropResumable: boolean }): Promise<'clear' | 'held' | 'sent'> {
  let pending = s.broker.pending;
  if (!pending) return 'clear';
  if (pending.status === 'sending') {
    // Persisted before it left the process (the engine stores an action only once it is marked sent): nothing happened.
    pending = recordOutcome(pending, { kind: 'failed', error: 'action_not_sent' }, s.ctx.now());
  } else if (pending.status === 'sent' || pending.status === 'held') {
    // A publish queued for the creator's review settles from its approval row, never from the sender.
    const publish = pending.action.tool === 'publish_post' || pending.action.tool === 'publish_reply';
    const queued = publish ? await queuedOutcomeFor(s.ctx, pending.id) : null;
    const resolution: PendingResolution = queued && queued.kind !== 'unknown' ? { resolved: true, outcome: queued } : await resolvePending(s.ctx, s.agent, pending);
    if (resolution.resolved) {
      pending = reconcile(pending, { actionId: pending.id, cycleKey: pending.cycleKey, outcome: resolution.outcome, ...(resolution.receipt ? { receipt: resolution.receipt } : {}) });
    } else if (pending.status === 'sent' && opts.dropResumable) {
      pending = recordOutcome(pending, { kind: 'failed', error: TURN_ENDED_ERROR }, s.ctx.now());
    }
  }
  s.broker.pending = pending;
  if (pending.status === 'held') return 'held';
  if (pending.status === 'sent') return 'sent';
  // An original post that turned out sent after its turn was gone is still the slot's post: without this the next turn
  // would find the slot unused and could post into it again.
  if (pending.status === 'completed' && pending.action.tool === 'publish_post' && (pending.result?.result as { queued?: unknown } | undefined)?.queued !== true) {
    s.state.lastPostAt = Math.max(s.state.lastPostAt ?? 0, pending.createdAt);
  }
  await settlePending(s);
  return 'clear';
}

// ---------------------------------------------------------------------------
// Closing a turn without a finish
// ---------------------------------------------------------------------------

/**
 * Ends the open turn the way a cut-short hosted turn ends: the role's `abandoned` writes its continuation note, the
 * turn is dropped, and the closed turn's id is kept so a late call with it is told what happened. Returns the runtime
 * patch that goes with it; the caller persists. A paused runtime stays paused.
 */
async function abandon(s: Session, why: CloseWhy): Promise<RuntimePatch> {
  const turn = s.turn;
  if (!turn?.own) return {};
  const role = roleOf(turn);
  const now = s.ctx.now();
  try {
    await ownRole(role)?.abandoned?.(callOf(s), turn, why);
  } catch (err) {
    s.ctx.log.warn({ agentId: s.agent.agentId, role, err: rpcErrorText(err) }, 'own agent: the role could not note the abandoned turn');
  }
  s.state.ownLastTurnAt = now;
  s.state.ownClosed = { turnId: turn.own.turnId, why, at: now, last: null };
  s.ctx.log.info({ agentId: s.agent.agentId, turnId: turn.own.turnId, role, why, steps: turn.steps }, 'own agent: turn closed by the server');
  s.turn = null;
  const status = s.runtime.status === 'paused' ? 'paused' : 'waiting';
  // The social turn's wake moves on like a hosted turn the runtime ended; another role's turn leaves the social schedule alone.
  return { status, ...(role === 'social' ? { nextAt: new Date(now + ABANDONED_WAKE_MS) } : {}) };
}

/**
 * Closes the open own turn of a runtime row the caller already holds the lease of (the tick, the runner switch), or
 * accepts the race for (a revoked client whose lease could not be taken). True when a turn was closed.
 */
async function closeTurnOf(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow, why: CloseWhy): Promise<boolean> {
  const turn = runtime.turn as unknown as Turn | null;
  if (!turn?.own) return false;
  const config = agentConfigOf(agent);
  if (!config) {
    // No readable config, so no role can be asked: the turn is dropped plainly.
    await saveRuntime(ctx, agent.agentId, { turn: null, status: runtime.status === 'running' ? 'waiting' : runtime.status });
    return true;
  }
  const s = sessionOf(ctx, agent, config, runtime);
  const patch = await abandon(s, why);
  const left = await clearLeftover(s, { dropResumable: true });
  await persist(s, { ...patch, ...(left === 'held' && patch.status !== 'paused' ? { status: 'held' } : {}) });
  return true;
}

/** `OwnHooks.closeTurn`: for the runner switch, which holds the lease when it calls. */
export async function closeOwnTurn(ctx: SupervisorContext, agentId: string, why: 'runner_switched' | 'client_revoked' | 'expired'): Promise<boolean> {
  const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, agentId) });
  const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agentId) });
  if (!agent || !runtime) return false;
  return closeTurnOf(ctx, agent, runtime, why);
}

/**
 * After clients were revoked: the turn one of them had open is closed, under the lease when it can be taken. When it
 * cannot (a step of that turn is running), the step finishes, every later call of the revoked credential is refused,
 * and the tick's idle rule closes the turn.
 */
export async function closeTurnOfClients(ctx: SupervisorContext, agent: AgentRow, clientIds: readonly string[]): Promise<boolean> {
  if (clientIds.length === 0) return false;
  try {
    return await withLease(ctx, agent.agentId, async (runtime) => {
      const own = (runtime.turn as unknown as Turn | null)?.own;
      if (!own || !clientIds.includes(own.clientId)) return false;
      return closeTurnOf(ctx, agent, runtime, 'client_revoked');
    });
  } catch (err) {
    if (err instanceof OwnError && err.code === 'runtime_busy') return false;
    throw err;
  }
}

/**
 * The tick's part (tick.ts, with the flag on or off; the tick holds the lease): an own turn past its idle or total
 * time is closed, and a hosted turn found stored on an own coin is dropped with a continuation note, since no hosted
 * loop will ever resume it. True when the runtime row changed.
 */
export async function expireOwnTurn(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow): Promise<boolean> {
  const turn = runtime.turn as unknown as Turn | null;
  if (!turn) return false;
  if (!turn.own) {
    const state = runtime.state as unknown as AgentState;
    if ((turn.role ?? 'social') === 'social') state.continuation = { progress: 'Turn ended by the runtime (the agent is now run by its creator\'s own client). Continue from the agenda.', recentSteps: (turn.recentSteps ?? []).slice(-6) };
    await saveRuntime(ctx, agent.agentId, { turn: null, state: boundedState(trimState(state)) as unknown as Record<string, unknown>, status: runtime.status === 'running' ? 'waiting' : runtime.status });
    ctx.log.info({ agentId: agent.agentId }, 'own agent: a stored hosted turn was dropped');
    return true;
  }
  if (ctx.now() < ownTurnExpiresAt(ctx, turn.own)) return false;
  return closeTurnOf(ctx, agent, runtime, 'expired');
}

// ---------------------------------------------------------------------------
// Finding the turn of a call
// ---------------------------------------------------------------------------

/**
 * The open turn a call names. A turn past its time is closed here and answered `turn_expired`; the id of the turn that
 * closed last is answered `turn_closed` (or `turn_expired`); any other id is `turn_not_found`. The turn belongs to the
 * credential's own coin by construction: the runtime row was read by that coin's id, so another coin's turn id is
 * simply unknown here.
 */
async function locateTurn(s: Session, turnId: string): Promise<Turn> {
  const turn = s.turn;
  if (turn?.own && turn.own.turnId === turnId) {
    if (s.ctx.now() >= ownTurnExpiresAt(s.ctx, turn.own)) {
      const patch = await abandon(s, 'expired');
      const left = await clearLeftover(s, { dropResumable: true });
      await persist(s, { ...patch, ...(left === 'held' && patch.status !== 'paused' ? { status: 'held' } : {}) });
      throw new OwnError('turn_expired');
    }
    return turn;
  }
  const closed = s.state.ownClosed;
  if (closed && closed.turnId === turnId) throw new OwnError(closed.why === 'expired' ? 'turn_expired' : 'turn_closed');
  throw new OwnError('turn_not_found');
}

function requireTurnId(turnId: unknown): string {
  if (typeof turnId !== 'string' || !turnId.startsWith(TURN_ID_PREFIX)) throw new OwnError('invalid_request', { field: 'turnId', detail: 'turnId must be the id of a turn.' });
  if (!OWN_TURN_ID_RE.test(turnId)) throw new OwnError('turn_not_found');
  return turnId;
}

function requireRunning(s: Session): void {
  if (s.agent.status !== 'active' || s.runtime.status === 'paused') throw new OwnError('agent_paused');
}

/** The answer of an acting call this turn already carried out, read back from its row: nothing runs again. */
async function replay(s: Session, record: OwnCallRecord, turnId: string, turnEnded: boolean): Promise<ActResult> {
  const row = await s.ctx.db.query.actions.findFirst({ where: and(eq(actions.actionId, record.actionId), eq(actions.agentId, s.agent.agentId)) });
  const stored = (row?.result ?? null) as { result?: unknown; error?: unknown } | null;
  const completed = row?.status === 'completed';
  s.ctx.log.info({ agentId: s.agent.agentId, turnId, tool: record.tool, actionId: record.actionId }, 'own agent: a repeated call was answered from its first run');
  return {
    turnId,
    tool: record.tool,
    actionId: record.actionId,
    status: completed ? 'completed' : 'failed',
    ...(completed ? { result: jsonSafe(stored?.result ?? null) } : { error: typeof stored?.error === 'string' ? stored.error : 'failed' }),
    stepsUsed: record.stepsUsed,
    stepsLeft: Math.max(0, stepBudget(s.ctx) - record.stepsUsed),
    turnEnded,
  };
}

/** What the broker's own guards need to know of this turn (broker `ownGuard`), from the turn and the state as they are now. */
function brokerTurn(s: Session, turn: Turn): OwnBrokerTurn {
  const slotOpen = !!turn.postDue && (s.state.lastPostAt ?? 0) < turn.startedAt;
  const postAllowed = !!turn.digestWeek || !!turn.numbersDay || (turn.creatorRequests?.length ?? 0) > 0 || slotOpen;
  return { openedAt: turn.own?.openedAt ?? turn.startedAt, postAllowed, nextSlotAt: scheduleFor(s.config, s.state, s.ctx.now())?.nextAt ?? null };
}

/** The agent-core tools this turn may call now: what it was opened with, as far as the coin's powers and owner rules still allow. */
function turnTools(s: Session, turn: Turn): Set<string> {
  const live = new Set<string>(availableTools(s.ctx, s.config, { premium: turn.premium ?? null }).map((t) => t.name));
  return new Set((turn.ownOpen?.tools ?? []).filter((name) => live.has(name) && name !== FINISH_TOOL && name !== 'generate_image'));
}

function uploadOffered(s: Session, turn: Turn): boolean {
  return roleOf(turn) === 'social' && s.config.capabilities.images === true;
}

/** The MCP tool names of a turn (`bootr_agent_...`): its agent-core tools, the special tools offered now, the upload and `finish`. */
function mcpTools(s: Session, turn: Turn): string[] {
  const role = roleOf(turn);
  const names = [...turnTools(s, turn)];
  for (const tool of ownTools()) if (tool.roles.includes(role) && offered(tool, turn, s.config)) names.push(tool.name);
  if (uploadOffered(s, turn)) names.push(UPLOAD_TOOL);
  // A judge turn has no finish: its ruling ends it.
  if (role !== 'judge') names.push(FINISH_TOOL);
  return [...new Set(names)].map((name) => MCP_TOOL_PREFIX + name);
}

function offered(tool: { offered(turn: Turn, config: AgentConfig): boolean }, turn: Turn, config: AgentConfig): boolean {
  try {
    return tool.offered(turn, config) === true;
  } catch {
    return false;
  }
}

function turnOpenView(s: Session, turn: Turn, resumed: boolean): TurnOpen {
  const own = turn.own!;
  return {
    turnId: own.turnId,
    role: roleOf(turn),
    resumed,
    reasons: turn.reasons,
    brief: turn.ownOpen?.brief ?? '',
    observation: turn.ownOpen?.observation ?? {},
    tools: mcpTools(s, turn),
    stepBudget: stepBudget(s.ctx),
    stepsUsed: turn.steps,
    expiresAt: iso(ownTurnExpiresAt(s.ctx, own)),
  };
}

function actResult(s: Session, turn: Turn, fields: Pick<ActResult, 'tool' | 'actionId' | 'status'> & Partial<Pick<ActResult, 'result' | 'error' | 'retryAt' | 'image'>>, turnEnded: boolean): ActResult {
  return { turnId: turn.own!.turnId, ...fields, stepsUsed: turn.steps, stepsLeft: Math.max(0, stepBudget(s.ctx) - turn.steps), turnEnded };
}

/** Ends a turn that ran to its end (a `finish`, a special tool that ends it): the last-active stamp and the closed-turn record. */
function closeFinished(s: Session, turn: Turn, last: OwnCallRecord | null): void {
  const now = s.ctx.now();
  s.state.ownLastTurnAt = now;
  s.state.ownClosed = { turnId: turn.own!.turnId, why: 'finished', at: now, last };
  s.turn = null;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** `run/status`: which coin, who runs it, what is on and what is left of today. Answered for a hosted coin too. */
export async function ownStatus(ctx: SupervisorContext, v: VerifiedClient): Promise<AgentStatus> {
  const { agent, client } = v;
  const runner = runnerOf(agent.config);
  const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agent.agentId) });
  const state = (runtime?.state ?? {}) as unknown as AgentState;
  const config = agentConfigOf(agent);
  const rawPowers = (agent.config as { capabilities?: Record<string, unknown> }).capabilities ?? {};
  const powers: Record<string, boolean> = {};
  for (const [name, on] of Object.entries(config ? config.capabilities : rawPowers)) powers[name] = on === true;

  const quota = await ctx.sender.quota(agent.agentId).catch(() => null);
  const postsLeftToday = quota && typeof quota.postsUsed24h === 'number' ? Math.max(0, quota.postsPerDay - quota.postsUsed24h) : null;
  const xReadsLeftToday = quota && typeof quota.readsPerDay === 'number' && quota.readsPerDay > 0 && typeof quota.readsUsedToday === 'number' ? Math.max(0, quota.readsPerDay - quota.readsUsedToday) : null;
  // The sender's read budget follows the runner (own/quota.ts); a write the sender missed is made up for here.
  if (quota && typeof quota.readsPerDay === 'number' && agent.status !== 'onboarding') {
    const wanted = runnerReadsPerDay(ctx, runner);
    if (runner === 'own' && wanted !== null && quota.readsPerDay !== wanted) await applyRunnerQuota(ctx, agent.agentId, runner);
  }
  const now = ctx.now();
  const forcedUsed = state.ownForced?.day === utcDay(now) ? state.ownForced.count : 0;
  const treasury = await readTreasuryOnChain(ctx, agent).catch(() => null);
  return {
    coin: coinRef(agent),
    runner,
    client: clientView(client),
    powers,
    requireApproval: requiresApproval(agent.config),
    postsLeftToday,
    xReadsLeftToday,
    picturesLeftToday: await imagesLeftToday(ctx, agent.agentId).catch(() => 0),
    forcedTurnsLeftToday: Math.max(0, Math.floor(ownSetting(ctx, 'OWN_FORCED_TURNS_PER_DAY')) - forcedUsed),
    fuel: treasury ? { spendableUsdc: treasury.usd.spenderUsdc.toFixed(2), reserveUsdc: treasury.usd.usdc.toFixed(2) } : null,
    lastTurnAt: typeof state.ownLastTurnAt === 'number' ? iso(state.ownLastTurnAt) : null,
  };
}

// ---------------------------------------------------------------------------
// due
// ---------------------------------------------------------------------------

const ROLE_OFF: DueRole = { on: false, due: false, reasons: [], nextAt: null };

/** A stored hosted turn on an own coin is dropped (no hosted loop will resume it); an own turn past its time is closed. */
async function tidyTurn(s: Session): Promise<void> {
  if (s.turn && !s.turn.own) {
    if ((s.turn.role ?? 'social') === 'social') s.state.continuation = { progress: 'Turn ended by the runtime (the agent is now run by its creator\'s own client). Continue from the agenda.', recentSteps: (s.turn.recentSteps ?? []).slice(-6) };
    s.turn = null;
    await persist(s, { status: s.runtime.status === 'running' ? 'waiting' : s.runtime.status });
    return;
  }
  if (s.turn?.own && s.ctx.now() >= ownTurnExpiresAt(s.ctx, s.turn.own)) {
    const patch = await abandon(s, 'expired');
    const left = await clearLeftover(s, { dropResumable: true });
    await persist(s, { ...patch, ...(left === 'held' && patch.status !== 'paused' ? { status: 'held' } : {}) });
  }
}

/** `run/due`: what is due now, per role, the holds, and when to look again. Reads mentions through the sender, as the tick does for a hosted coin. */
export async function ownDue(ctx: SupervisorContext, v: VerifiedClient): Promise<DueView> {
  const config = gate(v);
  return withLease(ctx, v.agent.agentId, async (runtime) => {
    const s = sessionOf(ctx, v.agent, config, runtime);
    await tidyTurn(s);
    const now = ctx.now();
    const call = callOf(s);
    const open = s.turn?.own ?? null;
    const openRole = s.turn && open ? roleOf(s.turn) : null;
    const paused = v.agent.status !== 'active' || runtime.status === 'paused';
    const pending = s.broker.pending;
    const held = pending?.status === 'held';

    const roles = {} as Record<OwnRole, DueRole>;
    for (const role of OWN_ROLES) {
      const handler = ownRole(role);
      if (!handler) roles[role] = ROLE_OFF;
      // Paused, or waiting on a held action: nothing is due and no role is asked (the social role would read mentions).
      else if (paused || held) roles[role] = { on: role === 'social' || openRole === role, due: false, reasons: [], nextAt: null };
      else if (openRole === role) roles[role] = { on: true, due: true, reasons: ['continuation'], nextAt: null };
      else {
        try {
          roles[role] = await handler.due(call);
        } catch (err) {
          ctx.log.warn({ agentId: v.agent.agentId, role, err: rpcErrorText(err) }, 'own agent: the role could not say whether it is due');
          roles[role] = { on: true, due: false, reasons: [], nextAt: null };
        }
      }
    }
    // The role may have marked a hold as ended on the state; it is written with the rest.
    await persist(s);

    const holds: HoldView[] = [];
    for (const hold of [quotaHold(s.state.postQuotaUntil, now), creditsHold(s.state.postCreditsUntil, now), forbiddenHold(s.state.postForbiddenUntil, now)]) {
      if (hold && (hold.reason === 'x_quota' || hold.reason === 'x_credits' || hold.reason === 'x_forbidden')) holds.push({ reason: hold.reason, until: iso(hold.until), message: hold.message });
    }
    if (paused) {
      const byCreator = runtime.pausedBy === 'guardian';
      holds.push({ reason: byCreator ? 'paused_by_creator' : 'paused_by_platform', until: null, message: byCreator ? 'The creator paused this agent. Nothing runs until it is resumed.' : 'This agent is paused by the platform. Nothing runs until it is resumed.' });
    }
    if (held) holds.push({ reason: 'held_action', until: null, message: 'An earlier action is waiting for its receipt. The server settles it; no turn opens until then.' });
    const notes = callNotes(call);
    if (notes.xNotConnected) holds.push({ reason: 'x_not_connected', until: null, message: 'No X account is connected to this agent. The creator connects one from the coin page.' });

    const floor = now + ownSetting(ctx, 'OWN_DUE_MIN_INTERVAL_MS');
    const anyDue = OWN_ROLES.some((role) => roles[role].due);
    const candidates = OWN_ROLES.map((role) => (roles[role].nextAt ? Date.parse(roles[role].nextAt!) : Number.NaN)).filter((t) => Number.isFinite(t));
    // A mention can make the social role due at the sender's next read, whatever the schedule says.
    if (config.capabilities.xRead && !paused) candidates.push(notes.mentionsNextReadAt && notes.mentionsNextReadAt > now ? notes.mentionsNextReadAt : now + OWN_MENTION_CHECK_MS);
    if (open) candidates.push(ownTurnExpiresAt(ctx, open));
    const next = anyDue ? floor : candidates.length ? Math.min(...candidates) : now + OWN_MENTION_CHECK_MS;
    return {
      coin: coinRef(v.agent),
      now: iso(now),
      social: roles.social,
      treasury: roles.treasury,
      judge: roles.judge,
      openTurn: open && openRole ? { turnId: open.turnId, role: openRole, expiresAt: iso(ownTurnExpiresAt(ctx, open)) } : null,
      holds,
      nextCheckAt: iso(Math.max(floor, next)),
    };
  });
}

// ---------------------------------------------------------------------------
// turn
// ---------------------------------------------------------------------------

/** `run/turn`: opens a turn of a role, or returns the open one when it has that role. */
export async function openTurn(ctx: SupervisorContext, v: VerifiedClient, req: Partial<TurnRequest>): Promise<TurnOpen> {
  const role = req?.role;
  if (typeof role !== 'string' || !(OWN_ROLES as readonly string[]).includes(role)) throw new OwnError('invalid_request', { field: 'role', detail: 'role must be social, treasury or judge.' });
  if (req.reason !== undefined && req.reason !== 'creator_asked') throw new OwnError('invalid_request', { field: 'reason', detail: 'reason, when given, is creator_asked.' });
  if (req.jobId !== undefined && (typeof req.jobId !== 'string' || req.jobId.length > 128)) throw new OwnError('invalid_request', { field: 'jobId', detail: 'jobId must be a job id.' });
  const config = gate(v);
  return withLease(ctx, v.agent.agentId, async (runtime) => {
    const s = sessionOf(ctx, v.agent, config, runtime);
    requireRunning(s);
    await tidyTurn(s);
    const now = ctx.now();
    if (s.turn?.own) {
      if (roleOf(s.turn) !== role) throw new OwnError('turn_open', { retryAt: ownTurnExpiresAt(ctx, s.turn.own) });
      // The same role again (a second client, or the same one after a restart): the open turn, as it was opened.
      s.turn.own.lastCallAt = now;
      await persist(s);
      return turnOpenView(s, s.turn, true);
    }
    // An action an earlier turn left behind settles before anything new: held means its receipt is still out.
    const left = await clearLeftover(s, { dropResumable: true });
    if (left !== 'clear') {
      await persist(s, { status: 'held' });
      throw new OwnError('held_action', { retryAt: now + HELD_RETRY_MS });
    }

    // No turn is open and nothing is held: a status an earlier turn or a hosted sleep left behind no longer says anything.
    const idle: RuntimePatch = s.runtime.status === 'held' || s.runtime.status === 'running' || s.runtime.status === 'sleeping' ? { status: 'waiting' } : {};
    const handler = ownRole(role as OwnRole);
    if (!handler) {
      await persist(s, idle);
      throw new OwnError('not_due');
    }
    const call = callOf(s);
    const due = await handler.due(call);
    let forced = false;
    const day = utcDay(now);
    const forcedUsed = s.state.ownForced?.day === day ? s.state.ownForced.count : 0;
    if (!due.due) {
      const dueAt = due.nextAt ? Date.parse(due.nextAt) : Number.NaN;
      const retryAt = Number.isFinite(dueAt) && dueAt > now ? dueAt : undefined;
      // Only the social role may be opened outside its schedule, by the creator's own ask, a few times a day.
      if (role !== 'social' || req.reason !== 'creator_asked' || !due.on) {
        await persist(s, idle);
        throw new OwnError('not_due', retryAt !== undefined ? { retryAt } : {});
      }
      if (forcedUsed >= Math.floor(ownSetting(ctx, 'OWN_FORCED_TURNS_PER_DAY'))) {
        await persist(s, idle);
        throw new OwnError('forced_turns_used', { retryAt: retryAt ?? nextUtcMidnight(now) });
      }
      forced = true;
    }
    const reasons = forced ? ['creator_asked'] : due.reasons;
    const opened = await handler.open(call, { reasons, forced, ...(req.jobId ? { jobId: req.jobId } : {}) });
    if (forced) s.state.ownForced = { day, count: forcedUsed + 1 };
    const opensAt = ctx.now();
    const own: OwnTurnMeta = { turnId: TURN_ID_PREFIX + randomBytes(16).toString('hex'), clientId: v.client.id, openedAt: opensAt, lastCallAt: opensAt, forced, ...(req.jobId ? { jobId: req.jobId } : {}) };
    const turn: Turn = {
      ...opened.turn,
      role: role as AgentRole,
      messages: [],
      own: { ...(opened.turn.own ?? {}), ...own },
      ownOpen: { brief: opened.brief, observation: jsonSafe(opened.observation), tools: [...new Set(opened.tools)] },
      ownCalls: [],
    };
    s.turn = turn;
    // The social turn stamps the decision as the hosted `startTurn` does, so a config change is told once; another role leaves it alone.
    await persist(s, { status: 'running', ...(role === 'social' ? { lastDecisionAt: new Date(opensAt), lastDecisionRevision: config.revision } : {}) });
    ctx.log.info({ agentId: v.agent.agentId, clientId: v.client.id, turnId: own.turnId, role, reasons, forced }, 'own agent: turn opened');
    return turnOpenView(s, turn, false);
  });
}

// ---------------------------------------------------------------------------
// act
// ---------------------------------------------------------------------------

/**
 * An action an earlier call of this turn left unsettled (its outcome was unknown, or the process died before it was
 * recorded). Settled here when its receipt is in; `held` ends the turn; otherwise it is returned still `sent`, and only
 * the call that made it may be repeated. Null when nothing stands in the way of a new step.
 */
async function leftoverInTurn(s: Session): Promise<PendingAction | null> {
  const left = await clearLeftover(s, { dropResumable: false });
  if (left === 'held') {
    const patch = await abandon(s, 'held');
    await persist(s, { ...patch, ...(patch.status !== 'paused' ? { status: 'held' } : {}) });
    throw new OwnError('held_action', { retryAt: s.ctx.now() + HELD_RETRY_MS });
  }
  return left === 'sent' ? s.broker.pending : null;
}

async function busy(s: Session, pending: PendingAction): Promise<never> {
  await persist(s);
  throw new OwnError('runtime_busy', { retryAt: pending.nextAt ?? s.ctx.now() + PENDING_RETRY_MS });
}

/** The step cap (`MAX_TOOL_STEPS`), on every call but `finish`: a guard, not model handling, so it stays on the server. */
async function requireStep(s: Session, turn: Turn): Promise<void> {
  if (turn.steps < stepBudget(s.ctx)) return;
  await persist(s);
  throw new OwnError('step_cap');
}

/** `run/act`: one tool call of an open turn. Tool outcomes are results (HTTP 200, `failed` included); only a call that could not be taken throws. */
export async function actTurn(ctx: SupervisorContext, v: VerifiedClient, req: Partial<ActRequest>): Promise<ActResult> {
  const turnId = requireTurnId(req?.turnId);
  const tool = req.tool;
  if (typeof tool !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(tool)) throw new OwnError('invalid_request', { field: 'tool', detail: 'tool must be a tool name.' });
  const input = req.input ?? {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new OwnError('invalid_request', { field: 'input', detail: 'input must be an object.' });
  // `finish` has its own route; a client that sends it here means the same thing.
  if (tool === FINISH_TOOL) return finishTurn(ctx, v, { ...(input as Record<string, unknown>), turnId } as Partial<FinishRequest>);
  const config = gate(v);
  return withLease(ctx, v.agent.agentId, async (runtime) => {
    const s = sessionOf(ctx, v.agent, config, runtime);
    requireRunning(s);
    const turn = await locateTurn(s, turnId);
    const role = roleOf(turn);
    const log = ctx.log.child({ agentId: v.agent.agentId, clientId: v.client.id, turnId, ...(role !== 'social' ? { role } : {}) });

    // (a) A special tool (own/registry.ts): no action row, no broker; its own step.
    const special = ownTool(tool);
    if (special) {
      const unsettled = await leftoverInTurn(s);
      if (unsettled) await busy(s, unsettled);
      await requireStep(s, turn);
      if (!special.roles.includes(role) || !offered(special, turn, config)) throw new OwnError('tool_unavailable');
      const parsed = special.input.safeParse(input);
      if (!parsed.success) throw invalidCall(parsed.error);
      turn.steps += 1;
      let res: Awaited<ReturnType<typeof special.run>>;
      try {
        res = await special.run(callOf(s), turn, parsed.data);
      } catch (err) {
        log.warn({ tool, err: rpcErrorText(err) }, 'own agent: a special tool threw');
        res = { status: 'failed', error: 'tool_failed: the tool could not be run; nothing was done' };
      }
      turn.own!.lastCallAt = ctx.now();
      turn.recentSteps.push({ tool, status: res.status, summary: summarize(res.status, res.result, res.error) });
      const answer = actResult(s, turn, { tool, actionId: null, status: res.status, ...(res.result !== undefined ? { result: jsonSafe(res.result) } : {}), ...(res.error !== undefined ? { error: res.error } : {}), ...(res.image ? { image: res.image } : {}) }, res.endsTurn === true);
      if (res.endsTurn === true) {
        closeFinished(s, turn, null);
        await persist(s, { status: 'waiting', failures: 0, lastError: null });
        log.info({ tool, steps: turn.steps }, 'own agent: turn ended by a special tool');
      } else {
        await persist(s);
      }
      return answer;
    }

    // (b) An agent-core tool: it must be in the turn's tools, as the powers and owner rules still allow.
    if (!turnTools(s, turn).has(tool)) throw new OwnError('tool_unavailable');
    let action: Action;
    try {
      action = parseAction({ tool, input });
    } catch (err) {
      log.info({ tool, code: 'invalid_tool_call', issues: err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.') || '.'}:${i.code}`) : undefined }, 'own agent: tool call refused before it ran');
      throw invalidCall(err);
    }
    const acting = TOOLS[action.tool].effect !== 'read';
    const key = digest({ tool: action.tool, input: action.input });
    // An acting call this turn already carried out is answered from its row: a retry or a replay repeats nothing.
    const done = acting ? turn.ownCalls?.find((c) => c.key === key) : undefined;
    if (done) {
      turn.own!.lastCallAt = ctx.now();
      await persist(s);
      return replay(s, done, turnId, false);
    }

    // The action this very call made earlier, when its answer never reached the client or the process died after it
    // was sent: once its receipt settles it, it is answered from its row and never run again.
    const before = s.broker.pending && (s.broker.pending.status === 'sent' || s.broker.pending.status === 'held') ? s.broker.pending : null;
    const sameAsBefore = before !== null && actionIdOf(before.cycleKey, action) === before.id;
    const resumable = await leftoverInTurn(s);
    if (before && !resumable && sameAsBefore) {
      turn.own!.lastCallAt = ctx.now();
      const answer = await replay(s, { key, actionId: before.id, tool, stepsUsed: turn.steps }, turnId, false);
      if (acting && answer.status === 'completed') (turn.ownCalls ??= []).push({ key, actionId: before.id, tool, stepsUsed: turn.steps });
      await persist(s);
      return answer;
    }
    // While an outcome is unknown, only the call that made the action may be repeated.
    if (resumable && !sameAsBefore) await busy(s, resumable);
    if (!resumable) await requireStep(s, turn);
    const env: BrokerEnv = { inbox: new Map(Object.entries(turn.inbox)), eligibility: new Map(Object.entries(turn.eligibility ?? {})), cycle: s.broker.cycle, own: brokerTurn(s, turn) };
    let pending: PendingAction;
    if (resumable) {
      // The identical request again, as the hosted loop resumes one: the receiving side keys it by the cycle.
      try {
        pending = resumeAction(resumable, ctx.now());
      } catch (err) {
        if (err instanceof PolicyError && err.code === 'action_backoff_pending') {
          await persist(s);
          return actResult(s, turn, { tool, actionId: resumable.id, status: 'pending', error: resumable.reason ?? 'outcome_unknown', retryAt: iso(resumable.nextAt ?? ctx.now() + PENDING_RETRY_MS) }, false);
        }
        await persist(s);
        throw new OwnError('runtime_busy', { retryAt: ctx.now() + PENDING_RETRY_MS });
      }
    } else {
      pending = beginAction(s.broker, action, s.broker.cycle, ctx.now());
      turn.steps += 1;
      await ctx.db
        .insert(actions)
        // Who thought is on the record: `via` and the client (activity.ts marks the tape row); a treasury or judge turn's rows carry their role as hosted ones do.
        .values({ actionId: pending.id, agentId: v.agent.agentId, cycleKey: pending.cycleKey, action: { ...(action as unknown as Record<string, unknown>), ...(role !== 'social' ? { role } : {}), via: 'own', clientId: v.client.id }, status: 'sending', createdAt: new Date(ctx.now()), updatedAt: new Date(ctx.now()) })
        .onConflictDoNothing();
    }
    pending = markSent(pending);
    s.broker.pending = pending;
    turn.own!.lastCallAt = ctx.now();
    // Stored before it leaves the process: a crash from here on finds the action and settles it from its receipt.
    await persist(s);

    // Approval mode is the hosted rule, untouched: a publish is queued exactly when `requiresApproval` says so. The own
    // guards run first there too, since a queued publish never reaches `executeAction`.
    const reviewed = (action.tool === 'publish_post' || action.tool === 'publish_reply') && requiresApproval(v.agent.config);
    let outcome: ActionOutcome;
    if (reviewed) outcome = (await ownGuard(ctx, v.agent, pending, env)) ?? (await queueForApproval(ctx, v.agent, pending, env));
    else outcome = await executeAction(ctx, v.agent, config, pending, env);
    pending = recordOutcome(pending, outcome, ctx.now());
    s.broker.pending = pending;
    turn.inbox = Object.fromEntries(env.inbox);
    turn.eligibility = Object.fromEntries(env.eligibility);
    turn.own!.lastCallAt = ctx.now();

    if (pending.status === 'held') {
      await ctx.db.update(actions).set({ status: 'held', result: (pending.result as unknown as Record<string, unknown>) ?? null, updatedAt: new Date(ctx.now()) }).where(eq(actions.actionId, pending.id));
      log.warn({ actionId: pending.id, tool: action.tool, reason: pending.reason }, 'own agent: action held; the turn ends and the tick settles it from its receipt');
      const answer = actResult(s, turn, { tool, actionId: pending.id, status: 'held', error: pending.reason ?? 'outcome_unknown' }, true);
      const patch = await abandon(s, 'held');
      await persist(s, { ...patch, ...(patch.status !== 'paused' ? { status: 'held' } : {}) });
      return answer;
    }
    if (pending.status === 'sent') {
      await ctx.db.update(actions).set({ status: 'sent', result: (pending.result as unknown as Record<string, unknown>) ?? null, updatedAt: new Date(ctx.now()) }).where(eq(actions.actionId, pending.id));
      await persist(s);
      return actResult(s, turn, { tool, actionId: pending.id, status: 'pending', error: pending.reason ?? 'outcome_unknown', retryAt: iso(pending.nextAt ?? ctx.now() + PENDING_RETRY_MS) }, false);
    }

    const settledAs = pending;
    const result = await settlePending(s);
    if (!result) throw new Error('own agent: a settled action left no result');
    // The role's bookkeeping after a settled action; it reads the settled action (its id, the sender's retryAt) from the call's runtime.
    try {
      await ownRole(role)?.settled?.(callOf(s, settledAs), turn, action, result);
    } catch (err) {
      // The action is done and settled whatever the bookkeeping does: the step is stored, so it can never run twice.
      log.error({ actionId: settledAs.id, tool, err: rpcErrorText(err) }, 'own agent: the role\'s bookkeeping after a settled action failed');
    }
    turn.recentSteps.push({ tool: result.tool, status: result.status, summary: summarize(result.status, result.result, result.error) });
    if (acting && result.status === 'completed') (turn.ownCalls ??= []).push({ key, actionId: settledAs.id, tool, stepsUsed: turn.steps });
    await persist(s);
    return actResult(s, turn, { tool, actionId: settledAs.id, status: result.status === 'completed' ? 'completed' : 'failed', ...(result.status === 'completed' ? { result: jsonSafe(result.result ?? null) } : { error: result.error ?? 'failed' }) }, false);
  });
}

// ---------------------------------------------------------------------------
// finish
// ---------------------------------------------------------------------------

/** `run/finish`: the role's checkpoint, and the end of the turn. A checkpoint the role refuses is a `failed` result and the turn stays open. */
export async function finishTurn(ctx: SupervisorContext, v: VerifiedClient, req: Partial<FinishRequest>): Promise<ActResult> {
  const turnId = requireTurnId(req?.turnId);
  const config = gate(v);
  const input = { memory: req.memory, agenda: req.agenda, summary: req.summary, nextAt: req.nextAt };
  return withLease(ctx, v.agent.agentId, async (runtime) => {
    const s = sessionOf(ctx, v.agent, config, runtime);
    requireRunning(s);
    let parsed: Action | null = null;
    let parseError: unknown = null;
    try {
      parsed = parseAction({ tool: FINISH_TOOL, input });
    } catch (err) {
      parseError = err;
    }
    // The finish that closed this turn, sent again after its answer was lost: the stored answer, nothing written.
    const closed = s.state.ownClosed;
    const openHere = !!s.turn?.own && s.turn.own.turnId === turnId;
    if (parsed && !openHere && closed && closed.turnId === turnId && closed.why === 'finished' && closed.last && closed.last.key === digest({ tool: FINISH_TOOL, input: parsed.input })) return replay(s, closed.last, turnId, true);

    const turn = await locateTurn(s, turnId);
    if (!parsed) throw invalidCall(parseError);
    const action: Action = parsed;
    const key = digest({ tool: FINISH_TOOL, input: action.input });
    const role = roleOf(turn);
    const handler = ownRole(role);
    if (!handler) throw new OwnError('tool_unavailable');
    const log = ctx.log.child({ agentId: v.agent.agentId, clientId: v.client.id, turnId, ...(role !== 'social' ? { role } : {}) });
    // An action whose outcome is unknown settles first; `finish` itself is never refused for the step cap.
    const unsettled = await leftoverInTurn(s);
    if (unsettled) await busy(s, unsettled);

    const now = ctx.now();
    let pending = beginAction(s.broker, action, s.broker.cycle, now, true);
    s.broker.pending = pending;
    turn.steps += 1;
    turn.own!.lastCallAt = now;
    await ctx.db
      .insert(actions)
      .values({ actionId: pending.id, agentId: v.agent.agentId, cycleKey: pending.cycleKey, action: { ...(action as unknown as Record<string, unknown>), ...(role !== 'social' ? { role } : {}), via: 'own', clientId: v.client.id }, status: 'sending', createdAt: new Date(now), updatedAt: new Date(now) })
      .onConflictDoNothing();

    let done: Awaited<ReturnType<typeof handler.finish>>;
    try {
      done = await handler.finish(callOf(s), turn, { turnId, ...(action.input as unknown as Omit<FinishRequest, 'turnId'>) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      s.broker.pending = recordOutcome(pending, { kind: 'failed', error }, now);
      await settlePending(s);
      turn.recentSteps.push({ tool: FINISH_TOOL, status: 'failed', summary: error.slice(0, 200) });
      await persist(s);
      return actResult(s, turn, { tool: FINISH_TOOL, actionId: pending.id, status: 'failed', error }, false);
    }
    pending = markSent(pending);
    s.broker.pending = recordOutcome(pending, { kind: 'completed', result: done.result }, now);
    await settlePending(s);
    const answer = actResult(s, turn, { tool: FINISH_TOOL, actionId: pending.id, status: 'completed', result: jsonSafe(done.result) }, true);
    closeFinished(s, turn, { key, actionId: pending.id, tool: FINISH_TOOL, stepsUsed: turn.steps });
    await persist(s, { status: 'waiting', ...(typeof done.nextAt === 'number' && Number.isFinite(done.nextAt) ? { nextAt: new Date(done.nextAt) } : {}), failures: 0, lastError: null });
    log.info({ steps: turn.steps, cycle: s.broker.cycle }, 'own agent: turn finished');
    return answer;
  });
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

/** `run/upload`: one picture the client made, checked and stored (own/pictures.ts). One step of a social turn; refusals are `failed` results. */
export async function uploadPicture(ctx: SupervisorContext, v: VerifiedClient, req: Partial<UploadPictureRequest>): Promise<ActResult> {
  const turnId = requireTurnId(req?.turnId);
  if (typeof req.mime !== 'string' || !(PICTURE_MIMES as readonly string[]).includes(req.mime)) throw new OwnError('invalid_request', { field: 'mime', detail: 'mime must be image/png, image/jpeg or image/webp.' });
  if (typeof req.dataBase64 !== 'string' || req.dataBase64.length === 0) throw new OwnError('invalid_request', { field: 'dataBase64', detail: 'dataBase64 must be the picture as base64.' });
  if (typeof req.alt !== 'string' || !req.alt.trim() || [...req.alt].length > ALT_MAX_CHARS) throw new OwnError('invalid_request', { field: 'alt', detail: `alt must describe the picture in at most ${ALT_MAX_CHARS} characters.` });
  if (typeof req.description !== 'string' || !req.description.trim() || [...req.description].length > PICTURE_DESCRIPTION_MAX) throw new OwnError('invalid_request', { field: 'description', detail: `description must say what the picture shows in at most ${PICTURE_DESCRIPTION_MAX} characters.` });
  // Far past any picture the sender takes: refused before it is decoded or hashed.
  if (req.dataBase64.length > Math.ceil((PICTURE_MAX_BYTES * 4) / 3) + 1024 * 1024) throw new OwnError('payload_too_large');
  const alt = req.alt.trim();
  const description = req.description.trim();
  const dataBase64 = req.dataBase64;
  const config = gate(v);
  return withLease(ctx, v.agent.agentId, async (runtime) => {
    const s = sessionOf(ctx, v.agent, config, runtime);
    requireRunning(s);
    const turn = await locateTurn(s, turnId);
    if (!uploadOffered(s, turn)) throw new OwnError('tool_unavailable');
    const sha256 = createHash('sha256').update(dataBase64, 'utf8').digest('hex');
    const input = { alt, description, sha256 };
    const key = digest({ tool: UPLOAD_TOOL, input });
    const done = turn.ownCalls?.find((c) => c.key === key);
    if (done) {
      turn.own!.lastCallAt = ctx.now();
      await persist(s);
      return replay(s, done, turnId, false);
    }
    const unsettled = await leftoverInTurn(s);
    if (unsettled) await busy(s, unsettled);
    await requireStep(s, turn);

    const now = ctx.now();
    const key2 = cycleKey(v.agent.agentId, s.broker.cycle);
    const actionId = 'act_' + digest({ cycleKey: key2, action: { tool: UPLOAD_TOOL, input } }).slice(0, 32);
    turn.steps += 1;
    turn.own!.lastCallAt = now;
    await ctx.db
      .insert(actions)
      // The alt text is public (X shows it); the description stays in the row and is never put on the tape. No bytes here: they are in sv_images.
      .values({ actionId, agentId: v.agent.agentId, cycleKey: key2, action: { tool: UPLOAD_TOOL, input: { alt, description, mime: req.mime, sha256 }, via: 'own', clientId: v.client.id }, status: 'sending', createdAt: new Date(now), updatedAt: new Date(now) })
      .onConflictDoNothing();
    const receivedTexts = Object.values(turn.inbox).map((item: SenderInboxItem) => (typeof item.post?.text === 'string' ? item.post.text : ''));
    const outcome = await storeUpload(ctx, v.agent, config, { actionId, dataBase64, alt, description, receivedTexts });
    const envelope = outcome.kind === 'completed' ? { actionId, tool: UPLOAD_TOOL, status: 'completed', result: outcome.result } : { actionId, tool: UPLOAD_TOOL, status: 'failed', error: outcome.error };
    await ctx.db.update(actions).set({ status: outcome.kind === 'completed' ? 'completed' : 'failed', result: envelope as unknown as Record<string, unknown>, updatedAt: new Date(ctx.now()) }).where(eq(actions.actionId, actionId));
    // The upload was one cycle of the runtime, like any other step: the next action gets a new key.
    s.broker = { ...s.broker, cycle: s.broker.cycle + 1 };
    turn.recentSteps.push({ tool: UPLOAD_TOOL, status: outcome.kind, summary: summarize(outcome.kind, outcome.kind === 'completed' ? outcome.result : null, outcome.kind === 'failed' ? outcome.error : undefined) });
    if (outcome.kind === 'completed') (turn.ownCalls ??= []).push({ key, actionId, tool: UPLOAD_TOOL, stepsUsed: turn.steps });
    await persist(s);
    return actResult(s, turn, { tool: UPLOAD_TOOL, actionId, status: outcome.kind, ...(outcome.kind === 'completed' ? { result: outcome.result } : { error: outcome.error }) }, false);
  });
}

// ---------------------------------------------------------------------------
// Stale mentions
// ---------------------------------------------------------------------------

/**
 * Before a turn sees its inbox (docs/design/byo-agent.md open decision 7): when the agent was away for at least
 * `OWN_STALE_MENTION_MS`, the mentions that are older than that are closed unanswered at the sender (reason
 * `stale_after_downtime`) and taken out of the inbox. A reply two days late reads as a machine waking up, and "no
 * catch-up" is already the rule for posts. A mention the agent itself deferred is left alone. Never throws.
 */
export async function closeStaleMentions(call: OwnCall, inbox: SenderInboxItem[]): Promise<SenderInboxItem[]> {
  const { ctx, agent, state, now } = call;
  const staleMs = ownSetting(ctx, 'OWN_STALE_MENTION_MS');
  if (staleMs <= 0 || inbox.length === 0) return inbox;
  // Away: no turn of either runner ended in that time.
  const lastActive = Math.max(state.ownLastTurnAt ?? 0, state.lastCheckpointAt ?? 0);
  if (now - lastActive < staleMs) return inbox;
  const ageOf = (item: SenderInboxItem): number => {
    const created = item.post?.createdAt ? Date.parse(item.post.createdAt) : Number.NaN;
    const observed = typeof item.observedAt === 'number' ? item.observedAt : Date.parse(String(item.observedAt));
    const at = Number.isFinite(created) ? created : observed;
    return Number.isFinite(at) ? now - at : 0;
  };
  const stale = inbox.filter((item) => item.status === 'pending' && item.deferredUntil == null && ageOf(item) >= staleMs).slice(0, MAX_STALE_CLOSE_PER_TURN);
  if (stale.length === 0) return inbox;
  try {
    const { resolved, failed } = await resolveMentions(ctx, agent.agentId, stale.map((item) => ({ postId: item.postId, reason: STALE_MENTION_REASON })), 'skip');
    ctx.log.info({ agentId: agent.agentId, closed: resolved.length, failed: failed.length }, 'own agent: mentions that waited through the downtime were closed unanswered');
    const closed = new Set(resolved);
    return inbox.filter((item) => !closed.has(item.postId));
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err: err instanceof Error ? err.message : String(err) }, 'own agent: stale mentions could not be closed; the turn goes on with them');
    return inbox;
  }
}
