/**
 * One agent's worker loop: wake -> inference -> one tool per turn -> result as next observation ->
 * ... -> `finish` (checkpoint) or the step cap. Every inference and every action is keyed by the
 * runtime cycle (agent-core broker), persisted before it leaves the process, and resumable.
 */
import {
  PolicyError,
  beginAction,
  boundedState,
  buildObservation,
  buildSystemPrompt,
  checkpoint,
  interruptionPlan,
  markSent,
  originalPostSchedule,
  parseAction,
  publicChannelBlocked,
  reconcile,
  recordOutcome,
  resumeAction,
  settleCycle,
  stateFits,
  type Action,
  type ActionResult,
  type AgentConfig,
  type BrokerRuntime,
  type ChatMessage,
  type PendingAction,
  type PostSchedule,
  type ToolDefinition,
} from '@bootr/agent-core';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { ZodError } from 'zod';
import { availableTools, executeAction, inboxViews, jsonSafe, resolvePending, type BrokerEnv, type InboxView } from './broker/index.js';
import type { AgentRow, RuntimeRow, SupervisorContext } from './context.js';
import { actions, runtimes } from './db/schema.js';
import { buildRequest, reconcileInference, runInference, type InferenceResult } from './inference.js';
import type { SenderInboxItem, ReplyEligibility } from './sender-client.js';
import type { TreasurySnapshot } from './treasury.js';

export const LEASE_MS = 60_000;

export interface AgentState {
  phase: 'boot' | 'social';
  memory: string;
  agenda: string;
  summary: string;
  lastCheckpointAt?: number | null;
  continuation?: { progress: string; recentSteps: { tool: string; status: string; summary: string }[] } | null;
  /** Idempotency key of an inference whose outcome is unknown; blocks new inference until reconciled. */
  inferenceKey?: string | null;
  lastPostAt?: number | null;
  lastResults?: unknown[];
}

export function initialState(): AgentState {
  return { phase: 'boot', memory: '', agenda: '', summary: '', continuation: null, inferenceKey: null, lastPostAt: null };
}

export interface Turn {
  startedAt: number;
  steps: number;
  nudged: boolean;
  reasons: string[];
  messages: ChatMessage[];
  /** postId -> inbox item used for replyAuthorId resolution. */
  inbox: Record<string, SenderInboxItem>;
  /** postId -> agent-core reply eligibility decided when the mention was observed (sent with replies). */
  eligibility?: Record<string, ReplyEligibility>;
  /** Short summaries of the steps so far (for continuation). */
  recentSteps: { tool: string; status: string; summary: string }[];
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export async function acquireLease(ctx: SupervisorContext, agentId: string, token: string, ms = LEASE_MS): Promise<RuntimeRow | null> {
  const now = new Date(ctx.now());
  const rows = await ctx.db
    .update(runtimes)
    .set({ leaseToken: token, leaseUntil: new Date(now.getTime() + ms), updatedAt: now })
    .where(and(eq(runtimes.agentId, agentId), or(isNull(runtimes.leaseUntil), lt(runtimes.leaseUntil, now))))
    .returning();
  return rows[0] ?? null;
}

export async function renewLease(ctx: SupervisorContext, agentId: string, token: string, ms = LEASE_MS): Promise<boolean> {
  const rows = await ctx.db
    .update(runtimes)
    .set({ leaseUntil: new Date(ctx.now() + ms) })
    .where(and(eq(runtimes.agentId, agentId), eq(runtimes.leaseToken, token)))
    .returning({ agentId: runtimes.agentId });
  return rows.length > 0;
}

export async function releaseLease(ctx: SupervisorContext, agentId: string, token: string): Promise<void> {
  await ctx.db.update(runtimes).set({ leaseToken: null, leaseUntil: null }).where(and(eq(runtimes.agentId, agentId), eq(runtimes.leaseToken, token)));
}

type RuntimePatch = Partial<Pick<typeof runtimes.$inferInsert, 'state' | 'cycle' | 'pending' | 'turn' | 'nextAt' | 'lastDecisionAt' | 'lastDecisionRevision' | 'configRevision' | 'status' | 'pausedBy' | 'failures' | 'lastError'>>;

export async function saveRuntime(ctx: SupervisorContext, agentId: string, patch: RuntimePatch): Promise<void> {
  await ctx.db.update(runtimes).set({ ...patch, updatedAt: new Date(ctx.now()) }).where(eq(runtimes.agentId, agentId));
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export interface TurnInputs {
  reasons: string[];
  inbox: SenderInboxItem[];
  schedule: PostSchedule | null;
  treasury: TreasurySnapshot | null;
  market: Record<string, unknown> | null;
}

export function scheduleFor(config: AgentConfig, state: AgentState, now: number): PostSchedule | null {
  if (!config.capabilities.xPublish || publicChannelBlocked(config.ownerRules, 'publish_post') || !config.socialStartedAt) return null;
  return originalPostSchedule(config.socialStartedAt, state.lastPostAt ?? null, now, config.postIntervalMs);
}

async function buildFirstObservation(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, state: AgentState, inputs: TurnInputs, tools: readonly ToolDefinition[]) {
  const now = ctx.now();
  const views: InboxView[] = inboxViews(config, inputs.inbox, now);
  const eligible = views.filter((v) => v.eligible);
  const memories = await ctx.memories.recent(agent.agentId, 5);
  const schedule = inputs.schedule;
  return buildObservation({
    now,
    market: inputs.market ? { snapshot: inputs.market } : null,
    treasury: inputs.treasury ? { balances: { ...inputs.treasury.balances, claimable: inputs.treasury.claimable, usd: inputs.treasury.usd } } : null,
    social: {
      messages: eligible.map((v) => ({ postId: v.postId, authorId: v.authorId, conversationId: v.conversationId, post: v.post, observedAt: v.observedAt })),
      threadContexts: [],
      repliesAvailable: eligible.length > 0,
      originalPost: schedule
        ? { due: schedule.due, nextAt: schedule.nextAtIso, intervalMs: schedule.intervalMs, lastPostAt: schedule.lastPostAt ? new Date(schedule.lastPostAt).toISOString() : null }
        : null,
    },
    lastResults: state.lastResults ?? [],
    continuation: state.continuation ?? null,
    extra: {
      wakeReasons: inputs.reasons,
      ineligibleMentions: views.length - eligible.length,
      checkpoint: { memory: state.memory, agenda: state.agenda, summary: state.summary, at: state.lastCheckpointAt ? new Date(state.lastCheckpointAt).toISOString() : null },
      recentNotes: memories,
      tools: tools.map((t) => t.name),
      stepBudget: ctx.config.MAX_TOOL_STEPS,
    },
  });
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------

export type TurnOutcome = 'finished' | 'step_cap' | 'held' | 'pending' | 'inference_unknown' | 'inference_failed' | 'error';

export interface TurnResult {
  outcome: TurnOutcome;
  steps: number;
  cycle: number;
}

function toolMessage(toolCallId: string, content: unknown): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(jsonSafe(content)) };
}

function summarize(result: ActionResult): string {
  const base = result.status === 'completed' ? JSON.stringify(jsonSafe(result.result ?? null)) : (result.error ?? result.status);
  return base.slice(0, 200);
}

/** Shrinks the conversation by truncating the oldest tool results. Returns false when nothing more can be done. */
function compactMessages(messages: ChatMessage[]): boolean {
  const target = messages.find((m, i) => i > 1 && m.role === 'tool' && typeof m.content === 'string' && m.content.length > 400);
  if (!target) return false;
  target.content = `${(target.content as string).slice(0, 300)}... [truncated for context]`;
  return true;
}

export async function startTurn(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow, config: AgentConfig, inputs: TurnInputs, lease: string): Promise<TurnResult> {
  const state = runtime.state as unknown as AgentState;
  const tools = availableTools(ctx, config);
  const observation = await buildFirstObservation(ctx, agent, config, state, inputs, tools);
  const turn: Turn = {
    startedAt: ctx.now(),
    steps: 0,
    nudged: false,
    reasons: inputs.reasons,
    messages: [
      { role: 'system', content: buildSystemPrompt(config) },
      { role: 'user', content: JSON.stringify(observation) },
    ],
    inbox: Object.fromEntries(inputs.inbox.map((i) => [i.postId, i])),
    eligibility: Object.fromEntries(inboxViews(config, inputs.inbox, ctx.now()).map((v) => [v.postId, { eligible: v.eligible, ...(v.reason ? { reason: v.reason } : {}) }])),
    recentSteps: [],
  };
  await saveRuntime(ctx, agent.agentId, { turn: turn as unknown as Record<string, unknown>, status: 'running', lastDecisionAt: new Date(ctx.now()), lastDecisionRevision: config.revision });
  return runLoop(ctx, agent, { ...runtime, turn: turn as unknown as Record<string, unknown> }, config, turn, lease);
}

/** Continues a persisted turn (after a crash, a held action that reconciled, or a resumable read). */
export async function continueTurn(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow, config: AgentConfig, lease: string): Promise<TurnResult | null> {
  const turn = runtime.turn as unknown as Turn | null;
  if (!turn) return null;
  return runLoop(ctx, agent, runtime, config, turn, lease);
}

async function runLoop(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow, config: AgentConfig, turn: Turn, lease: string): Promise<TurnResult> {
  const log = ctx.log.child({ agentId: agent.agentId });
  const state = runtime.state as unknown as AgentState;
  let broker: BrokerRuntime = { runtimeId: agent.agentId, cycle: runtime.cycle, pending: (runtime.pending as unknown as PendingAction | null) ?? null };
  const tools = availableTools(ctx, config);
  const env: BrokerEnv = { inbox: new Map(Object.entries(turn.inbox)), eligibility: new Map(Object.entries(turn.eligibility ?? {})) };

  const persist = async (patch: RuntimePatch = {}) => {
    await saveRuntime(ctx, agent.agentId, {
      state: boundedState(trimState(state)) as unknown as Record<string, unknown>,
      cycle: broker.cycle,
      pending: (broker.pending as unknown as Record<string, unknown> | null) ?? null,
      turn: turn as unknown as Record<string, unknown>,
      ...patch,
    });
  };

  const settle = async (): Promise<ActionResult | null> => {
    const pending = broker.pending;
    if (pending) {
      await ctx.db
        .update(actions)
        .set({ status: pending.status, result: (pending.result as unknown as Record<string, unknown>) ?? null, receipt: (pending.result?.receipt as Record<string, unknown> | undefined) ?? null, updatedAt: new Date(ctx.now()) })
        .where(eq(actions.actionId, pending.id));
    }
    const settled = settleCycle(broker);
    broker = settled.runtime;
    return settled.observation;
  };

  const endTurn = async (outcome: TurnOutcome, patch: RuntimePatch): Promise<TurnResult> => {
    await persist({ turn: null, ...patch });
    log.info({ outcome, steps: turn.steps, cycle: broker.cycle }, 'turn ended');
    return { outcome, steps: turn.steps, cycle: broker.cycle };
  };

  const forceFinish = async (why: string): Promise<TurnResult> => {
    state.continuation = { progress: `Turn ended by the runtime (${why}). Continue from the agenda.`, recentSteps: turn.recentSteps.slice(-6) };
    const next = ctx.now() + 5 * 60_000;
    return endTurn('step_cap', { status: 'waiting', nextAt: new Date(next) });
  };

  // A pending action left over from a previous process: resolve it first.
  if (broker.pending && (broker.pending.status === 'sent' || broker.pending.status === 'held')) {
    const resolution = await resolvePending(ctx, agent, broker.pending);
    if (resolution.resolved) {
      broker.pending = reconcile(broker.pending, { actionId: broker.pending.id, cycleKey: broker.pending.cycleKey, outcome: resolution.outcome, ...(resolution.receipt ? { receipt: resolution.receipt } : {}) });
    } else if (broker.pending.status === 'sent' && broker.pending.action.tool !== 'publish_post' && broker.pending.action.tool !== 'publish_reply') {
      // Resumable (idempotent) action: send the identical original request again.
      try {
        broker.pending = resumeAction(broker.pending, ctx.now());
        await persist();
        broker.pending = markSent(broker.pending);
        broker.pending = recordOutcome(broker.pending, await executeAction(ctx, agent, config, broker.pending, env), ctx.now());
      } catch (err) {
        if (err instanceof PolicyError && err.code === 'action_backoff_pending') return endTurn('pending', { status: 'waiting', nextAt: new Date(broker.pending.nextAt ?? ctx.now() + 15_000) });
        throw err;
      }
    }
    if (broker.pending.status === 'held') return endTurn('held', { status: 'held' });
    if (broker.pending.status === 'sent') return endTurn('pending', { status: 'waiting', nextAt: new Date(broker.pending.nextAt ?? ctx.now() + 15_000) });
    const completeAfter = broker.pending.completeAfter === true;
    const result = await settle();
    if (result) {
      const toolCallId = lastToolCallId(turn.messages) ?? result.actionId;
      turn.messages.push(toolMessage(toolCallId, result.status === 'completed' ? result.result : { error: result.error, status: result.status }));
      turn.recentSteps.push({ tool: result.tool, status: result.status, summary: summarize(result) });
      if (completeAfter && result.status === 'completed') return endTurn('finished', { status: 'waiting' });
    }
  } else if (broker.pending && (broker.pending.status === 'completed' || broker.pending.status === 'failed')) {
    await settle();
  }

  // Unknown inference from a previous attempt: never pay for a replacement.
  let carried: InferenceResult | null = null;
  if (state.inferenceKey) {
    const res = await reconcileInference(ctx, state.inferenceKey);
    if (res.kind === 'unknown') return endTurn('inference_unknown', { status: 'waiting', nextAt: new Date(ctx.now() + 60_000) });
    state.inferenceKey = null;
    if (res.kind === 'failed') {
      broker = { ...broker, cycle: broker.cycle + 1 };
    } else {
      carried = res;
    }
  }

  while (true) {
    if (turn.steps >= ctx.config.MAX_TOOL_STEPS) return forceFinish('step cap reached');
    await renewLease(ctx, agent.agentId, lease);

    let inf: InferenceResult;
    if (carried) {
      inf = carried;
      carried = null;
    } else {
      let request;
      for (;;) {
        try {
          request = buildRequest(config, turn.messages, tools, ctx.config.INFERENCE_MAX_OUTPUT_TOKENS);
          break;
        } catch (err) {
          if (err instanceof PolicyError && err.code === 'context_too_large' && compactMessages(turn.messages)) continue;
          return forceFinish('context too large');
        }
      }
      await persist();
      inf = await runInference(ctx, agent, config, broker.cycle, request);
    }
    turn.steps += 1;

    if (inf.kind === 'unknown') {
      state.inferenceKey = inf.key;
      log.warn({ key: inf.key, error: inf.error }, 'inference outcome unknown; holding the turn');
      return endTurn('inference_unknown', { status: 'waiting', nextAt: new Date(ctx.now() + 60_000) });
    }
    if (inf.kind === 'failed') {
      broker = { ...broker, cycle: broker.cycle + 1 };
      const failures = (runtime.failures ?? 0) + 1;
      const plan = interruptionPlan(0, failures, ctx.now());
      log.warn({ key: inf.key, error: inf.error, failures, nextAt: plan.nextAt }, 'inference failed');
      state.continuation = { progress: 'The previous turn was interrupted by an inference failure.', recentSteps: turn.recentSteps.slice(-6) };
      return endTurn('inference_failed', { status: 'waiting', nextAt: new Date(plan.nextAt), failures, lastError: inf.error });
    }

    turn.messages.push(inf.message);
    if (!inf.toolCall) {
      broker = { ...broker, cycle: broker.cycle + 1 };
      if (turn.nudged) return forceFinish('no tool call');
      turn.nudged = true;
      turn.messages.push({ role: 'user', content: 'Call exactly one tool. When you are done for now, call finish with your checkpoint.' });
      await persist();
      continue;
    }

    let action: Action;
    try {
      action = parseAction({ tool: inf.toolCall.name, input: inf.toolCall.input });
      if (!tools.some((t) => t.name === action.tool)) throw new PolicyError('tool_unavailable', { message: `tool_unavailable: ${action.tool}` });
    } catch (err) {
      broker = { ...broker, cycle: broker.cycle + 1 };
      const detail = err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : String(err);
      turn.messages.push(toolMessage(inf.toolCall.id, { error: 'invalid_tool_call', detail }));
      turn.recentSteps.push({ tool: inf.toolCall.name, status: 'invalid', summary: detail.slice(0, 200) });
      await persist();
      continue;
    }

    const now = ctx.now();
    let pending = beginAction(broker, action, broker.cycle, now, action.tool === 'finish');
    broker.pending = pending;
    await ctx.db
      .insert(actions)
      .values({ actionId: pending.id, agentId: agent.agentId, cycleKey: pending.cycleKey, action: action as unknown as Record<string, unknown>, status: 'sending', createdAt: new Date(now), updatedAt: new Date(now) })
      .onConflictDoNothing();
    await persist();

    if (action.tool === 'finish') {
      let cp;
      try {
        cp = checkpoint(action.input as unknown as Record<string, unknown>, now);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        broker.pending = recordOutcome(pending, { kind: 'failed', error }, now);
        await settle();
        turn.messages.push(toolMessage(inf.toolCall.id, { error }));
        turn.recentSteps.push({ tool: 'finish', status: 'failed', summary: error });
        await persist();
        continue;
      }
      state.memory = cp.memory;
      state.agenda = cp.agenda;
      state.summary = cp.summary;
      state.lastCheckpointAt = now;
      state.continuation = null;
      state.lastResults = [];
      state.phase = 'social';
      broker.pending = markSent(pending);
      broker.pending = recordOutcome(broker.pending, { kind: 'completed', result: { checkpointed: true, nextAt: cp.nextAt } }, now);
      await settle();
      return endTurn('finished', { status: 'waiting', nextAt: new Date(cp.nextAtMs), failures: 0, lastError: null });
    }

    pending = markSent(pending);
    broker.pending = pending;
    await persist();
    const outcome = await executeAction(ctx, agent, config, pending, env);
    pending = recordOutcome(pending, outcome, ctx.now());
    broker.pending = pending;
    turn.inbox = Object.fromEntries(env.inbox);
    turn.eligibility = Object.fromEntries(env.eligibility);
    if (pending.status === 'held') {
      await ctx.db.update(actions).set({ status: 'held', result: (pending.result as unknown as Record<string, unknown>) ?? null, updatedAt: new Date(ctx.now()) }).where(eq(actions.actionId, pending.id));
      log.warn({ actionId: pending.id, tool: action.tool, reason: pending.reason }, 'action held; runtime blocked until reconciled');
      return endTurn('held', { status: 'held' });
    }
    if (pending.status === 'sent') {
      await ctx.db.update(actions).set({ status: 'sent', result: (pending.result as unknown as Record<string, unknown>) ?? null, updatedAt: new Date(ctx.now()) }).where(eq(actions.actionId, pending.id));
      return endTurn('pending', { status: 'waiting', nextAt: new Date(pending.nextAt ?? ctx.now() + 15_000) });
    }
    const result = await settle();
    if (result) {
      if ((action.tool === 'publish_post' || action.tool === 'publish_reply') && result.status === 'completed') {
        if (action.tool === 'publish_post') state.lastPostAt = ctx.now();
      }
      turn.messages.push(toolMessage(inf.toolCall.id, result.status === 'completed' ? result.result : { error: result.error, status: result.status }));
      turn.recentSteps.push({ tool: result.tool, status: result.status, summary: summarize(result) });
    }
    await persist();
  }
}

function lastToolCallId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.tool_calls?.[0]) return m.tool_calls[0].id;
  }
  return undefined;
}

/** Keeps the persisted state inside agent-core's 12 KB budget by dropping the least important fields first. */
export function trimState(state: AgentState): AgentState {
  if (stateFits(state)) return state;
  const copy: AgentState = { ...state, lastResults: [] };
  if (stateFits(copy)) return copy;
  copy.continuation = copy.continuation ? { progress: copy.continuation.progress.slice(0, 500), recentSteps: copy.continuation.recentSteps.slice(-3) } : null;
  if (stateFits(copy)) return copy;
  copy.memory = copy.memory.slice(0, 6000);
  copy.agenda = copy.agenda.slice(0, 3000);
  copy.summary = copy.summary.slice(0, 1500);
  return copy;
}

