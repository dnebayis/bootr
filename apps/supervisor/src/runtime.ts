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
  parseAction,
  postLimitsFor,
  reconcile,
  recordOutcome,
  resumeAction,
  settleCycle,
  stateFits,
  type Action,
  type ActionResult,
  type AgentConfig,
  type AgentRole,
  type BrokerRuntime,
  type ChatMessage,
  type ModelTool,
  type PendingAction,
} from '@bootr/agent-core';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { ZodError } from 'zod';
import { agentDirectory, bootrAgentsSection, type AgentDirectory } from './agent-directory.js';
import { executeAction, inboxViews, jsonSafe, resolvePending, type BrokerEnv, type InboxView, type PendingResolution } from './broker/index.js';
import { buildTreasuryObservation, roleTools, type TreasuryTurnInputs } from './roles.js';
import { rpcErrorText } from './log.js';
import { expireApprovals, pendingCount, queueForApproval, queuedOutcomeFor, requiresApproval, takeFeedback } from './approvals.js';
import { bootrTodaySection, type AgentRow, type RuntimeRow, type SupervisorContext } from './context.js';
import { actions, runtimes } from './db/schema.js';
import { coinFeesSection } from './coin-fees.js';
import { buildRequest, reconcileInference, runInference, type InferenceResult } from './inference.js';
import { bootrPromotionSection } from './bootr-promotion.js';
import { postBudgetSection } from './post-budget.js';
import { MODEL_MISSING } from './blockrun.js';
import { raiseNotification, resolveNotification } from './notifications.js';
import { noteInferenceFailure, noteInferenceSuccess, providerHold } from './provider-hold.js';
import { fuelSection } from './fuel.js';
import { pictureSection } from './picture-hint.js';
import { handleIntent, logThought, modelFor, phaseOf, startRouting, toolsForPhase, type RoutingState } from './routing.js';
import { autoCloseMentions } from './mention-close.js';
import { postPerformanceSection } from './post-performance.js';
import { recentPostsSection } from './recent-posts.js';
import { X_CREDITS_RETRY_MS, forbiddenHoldMs, holdEndedMessage, isXCreditsError, isXForbiddenError, jitteredSchedule, originalPostView, type Hold, type PostHoldEnded, type RhythmSchedule, type StateHoldReason } from './rhythm.js';
import { cachedPlatformNumbers, platformNumbersSection, settlePlatformNumbers, type PlatformNumbersPlan } from './platform-numbers.js';
import { offerPlatformUpdate, platformUpdateSection, settlePlatformUpdate, type PlatformUpdate } from './platform-updates.js';
import { watchlistSection } from './watchlist.js';
import { settleWeeklyDigest, weeklyDigestSection, type WeeklyDigestPlan } from './weekly-digest.js';
import type { SenderInboxItem, ReplyEligibility } from './sender-client.js';
import type { TreasurySnapshot } from './treasury.js';

export const LEASE_MS = 60_000;
/** Hold after `sender:quota_exceeded` when the sender sent no `retryAt` (an older sender). */
export const QUOTA_FALLBACK_HOLD_MS = 3_600_000;

export interface AgentState {
  phase: 'boot' | 'social';
  memory: string;
  agenda: string;
  summary: string;
  lastCheckpointAt?: number | null;
  continuation?: { progress: string; recentSteps: { tool: string; status: string; summary: string }[] } | null;
  /** Idempotency key of an inference whose outcome is unknown; blocks new inference until reconciled. */
  inferenceKey?: string | null;
  /** Epoch ms before which nothing wakes the agent after an inference failure, whatever the cause (tick.ts). */
  inferenceRetryAt?: number | null;
  /**
   * A turn the runtime ended without a checkpoint (step cap, no tool call, context too large) waits for its `nextAt`:
   * what it already had in front of it (these mentions, a due post) is no reason to buy it again before `until` (tick.ts).
   */
  runtimeEnded?: { until: number; postIds: string[]; postDue: boolean } | null;
  lastPostAt?: number | null;
  /** When a turn that woke for a due original post finished without one: the slot is consumed, not kept (rhythm). */
  lastSlotSkippedAt?: number | null;
  /** Epoch ms until which the sender refuses this agent's publishes (`quota_exceeded`, its `retryAt`); see rhythm.ts. */
  postQuotaUntil?: number | null;
  /** Epoch ms until which publishes are held because X answered 402 `credits depleted`; see rhythm.ts. */
  postCreditsUntil?: number | null;
  /** Epoch ms until which publishes are held because X answered 403 "not permitted" (`forbiddenHold`, rhythm.ts). */
  postForbiddenUntil?: number | null;
  /** Forbidden refusals in a row (each one doubles the hold, `forbiddenHoldMs`); back to 0 when a publish goes through. */
  postForbiddenStrikes?: number | null;
  /**
   * Epoch ms when the current 403 hold was set (beside `postForbiddenUntil`): a sender account row whose `connectedAt`
   * is later means the creator reconnected X since, and the hold ends at once (`liftForbiddenHoldOnReconnect`).
   */
  postForbiddenAt?: number | null;
  /**
   * The X hold the model was told about (`noteHoldSet`, when its publish was refused) and, once the hold is over, when
   * and how it ended (`trackHoldEnd` in the tick, `liftForbiddenHoldOnReconnect`): the next turn's first observation
   * then says so once (`holdEnded`, rhythm.ts `holdEndedMessage`) and the note goes. Null when no hold is on record.
   */
  postHoldEndedNote?: PostHoldEnded | null;
  lastResults?: unknown[];
  /** ISO week (`YYYY-Www`) of the last weekly digest the platform agent closed (weekly-digest.ts). */
  lastDigestWeek?: string | null;
  /** UTC day (`YYYY-MM-DD`) of the last daily numbers post the platform agent closed (platform-numbers.ts). */
  lastNumbersDay?: string | null;
  /** UTC day (`YYYY-MM-DD`) of the last platform update that went out (platform-updates.ts). */
  lastUpdateDay?: string | null;
  /** Ids of the platform updates already announced (platform-updates.ts). */
  announcedUpdates?: string[];
  /** The platform update the latest turn was shown: the only one a publish can mark announced (platform-updates.ts). */
  offeredUpdate?: string | null;
  /** Epoch ms of the last chain read while sleeping or paused; the next one waits `REST_CHECK_MS` (tick.ts). */
  chainCheckedAt?: number | null;
  /** The creator was told the agent's model is not served (`model_unavailable`); cleared by the next answered thought. */
  modelUnavailable?: boolean | null;
  /**
   * The treasury turn's clock (roles.ts): when the next one is due (absent = due as soon as the turn is on), when the
   * last one started, and the time up to which the social turn's treasury notes have been shown to one.
   */
  treasuryNextAt?: number | null;
  lastTreasuryTurnAt?: number | null;
  lastTreasuryNoteSeenAt?: number | null;
  /** The treasury turn's own `finish` checkpoint, bounded by `TREASURY_CHECKPOINT_CHARS`; the social checkpoint above is never touched by it. */
  treasuryCheckpoint?: { memory: string; agenda: string; summary: string; at: number } | null;
}

/** What a treasury checkpoint may keep of a `finish` (the state has 12 KB for everything): the rest is cut, not refused. */
export const TREASURY_CHECKPOINT_CHARS = { memory: 2000, agenda: 1000, summary: 500 } as const;

export function initialState(): AgentState {
  return { phase: 'boot', memory: '', agenda: '', summary: '', continuation: null, inferenceKey: null, lastPostAt: null };
}

export interface Turn {
  /**
   * The role this turn runs as (roles.ts): `social` for every turn persisted before the field existed. `continueTurn`
   * rebuilds the system prompt's role, the tool list and the end-of-turn bookkeeping from it.
   */
  role?: AgentRole;
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
  /** Economy mode phase (routing.ts); null or absent when the whole turn runs on `config.model`. */
  routing?: RoutingState | null;
  /** The weekly digest this turn carries until an original post or `finish` closes it (weekly-digest.ts). */
  digestWeek?: string | null;
  /** The daily numbers post this turn carries until an original post or `finish` closes it (platform-numbers.ts). */
  numbersDay?: string | null;
  /** The turn woke for a due original post; `finish` without one consumes the slot (`lastSlotSkippedAt`). */
  postDue?: boolean;
  /** An original post completed (or was queued for review) in this turn. */
  posted?: boolean;
  /** A due post was refused by X for a reason that holds the account (quota, credits, forbidden): the slot is kept, not spent. */
  postHeld?: boolean;
  /** The last tool call was cut off at the output limit: the next thought gets INFERENCE_RETRY_OUTPUT_TOKENS. */
  outputBoost?: boolean;
  /** The earliest `reviewAt` of a mention this turn deferred (ISO): the one concrete reason to wake before the cadence floor. */
  reviewAt?: string | null;
  /**
   * Whether the X account may post beyond 280 characters (the sender's `premium`, read once at the start of the turn):
   * false caps `publish_post` at 280 in its description, the prompt and the observation; null = unknown, the defaults.
   */
  premium?: boolean | null;
}

/** The account's `premium` flag from the sender, or null when the sender does not answer or has not read it yet. */
export async function accountPremium(ctx: Pick<SupervisorContext, 'sender'>, agentId: string): Promise<boolean | null> {
  const account = await ctx.sender.account(agentId).catch(() => null);
  return typeof account?.premium === 'boolean' ? account.premium : null;
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

/**
 * A creator who reconnects X after a 403 hold (`x_forbidden`) should not wait out the 6/12/24 h: the sender refreshes
 * the account row's `connectedAt` on every (re)connect (apps/sender/src/accounts.ts), so a `connectedAt` later than the
 * moment the hold was set lifts it now: the hold, the strikes and the notice go, and the schedule tries the kept slot
 * (`turn.postHeld`) as usual. The tick calls this only while a hold is set, so the sender is read once a tick then and
 * never otherwise. Mutates `state`; true when the hold was lifted (the caller persists). A hold set before this field
 * existed falls back to `until - forbiddenHoldMs(strikes)` as its start. A sender that does not answer leaves the hold.
 */
export async function liftForbiddenHoldOnReconnect(ctx: SupervisorContext, agent: Pick<AgentRow, 'agentId'>, state: AgentState): Promise<boolean> {
  if (!state.postForbiddenUntil) return false;
  const account = await ctx.sender.account(agent.agentId).catch(() => null);
  const connectedAt = account?.connectedAt ? Date.parse(account.connectedAt) : Number.NaN;
  if (!account?.connected || !Number.isFinite(connectedAt)) return false;
  const heldAt = state.postForbiddenAt ?? state.postForbiddenUntil - forbiddenHoldMs(state.postForbiddenStrikes ?? 1);
  if (connectedAt <= heldAt) return false;
  ctx.log.info({ agentId: agent.agentId, connectedAt: account.connectedAt, heldAt: new Date(heldAt).toISOString(), strikes: state.postForbiddenStrikes ?? 0 }, 'x account reconnected; the 403 hold is lifted');
  // The next turn hears that the hold is over and why, so its own note about the block does not outlive it.
  state.postHoldEndedNote = { reason: 'x_forbidden', until: state.postForbiddenUntil, at: ctx.now(), how: 'reconnect', connectedAt };
  state.postForbiddenUntil = null;
  state.postForbiddenStrikes = 0;
  state.postForbiddenAt = null;
  await resolveNotification(ctx, agent.agentId, 'x_forbidden');
  return true;
}

/**
 * A hold was just set on the state and the model has seen the refusal that caused it: the hold is on record so the turn
 * after it ends can be told (`trackHoldEnd`, `holdEndedMessage`). Replaces any earlier note: a new hold makes "the hold
 * ended" untrue.
 */
export function noteHoldSet(state: AgentState, reason: StateHoldReason, until: number): void {
  state.postHoldEndedNote = { reason, until, at: null };
}

/**
 * The tick's view of the state holds against the note (`hold` is the X hold kept in the state right now, null when none):
 * a hold on the state with no note (set before this field existed, or by hand) is put on record; a note whose hold is
 * gone is marked ended, `expired` when its time ran out and `cleared` when the state was emptied before it (an operator,
 * a migration). A note already waiting for delivery is left alone. Mutates `state`; true when it changed.
 */
export function trackHoldEnd(state: AgentState, hold: Hold | null, now: number): boolean {
  const note = state.postHoldEndedNote ?? null;
  if (hold && (hold.reason === 'x_quota' || hold.reason === 'x_credits' || hold.reason === 'x_forbidden')) {
    if (note && note.at === null && note.reason === hold.reason && note.until === hold.until) return false;
    noteHoldSet(state, hold.reason, hold.until);
    return true;
  }
  if (!note || note.at !== null) return false;
  state.postHoldEndedNote = { ...note, at: now, how: note.until > now ? 'cleared' : 'expired' };
  return true;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export interface TurnInputs {
  reasons: string[];
  inbox: SenderInboxItem[];
  /** The agent's cadence with the platform rhythm applied (rhythm.ts: jitter, quiet hours, slots). */
  schedule: RhythmSchedule | null;
  treasury: TreasurySnapshot | null;
  market: Record<string, unknown> | null;
  /** The other Bootr agents (agent-directory.ts); read on demand when the caller did not pass it. */
  directory?: AgentDirectory;
  /** The platform agent's weekly digest when one is due this turn (weekly-digest.ts). */
  digest?: WeeklyDigestPlan | null;
  /** The platform agent's daily numbers post when one is due this turn (platform-numbers.ts). */
  numbers?: PlatformNumbersPlan | null;
}

/** The agent's own cadence (anchor + interval) with its deterministic jitter; quiet hours and slots are applied by tick.ts. */
/** A verified X account (blue, business or government badge) behind a post. */
export function isVerifiedAuthor(post: { author?: { verified?: boolean; verifiedType?: string } } | null | undefined): boolean {
  const a = post?.author;
  if (!a) return false;
  if (a.verifiedType && a.verifiedType !== 'none') return true;
  return a.verified === true;
}

/** Verified accounts first, otherwise the given order (a stable sort), so the model answers them first. */
export function verifiedFirst<T extends { post: { author?: { verified?: boolean; verifiedType?: string } } }>(views: readonly T[]): T[] {
  return [...views].sort((a, b) => Number(isVerifiedAuthor(b.post)) - Number(isVerifiedAuthor(a.post)));
}

/** The cadence anchor: the last original post, or the last slot the agent consumed by finishing without one. */
export function scheduleAnchor(state: Pick<AgentState, 'lastPostAt' | 'lastSlotSkippedAt'>): number | null {
  const a = state.lastPostAt ?? 0;
  const b = state.lastSlotSkippedAt ?? 0;
  const anchor = Math.max(a, b);
  return anchor > 0 ? anchor : null;
}

export function scheduleFor(config: AgentConfig, state: AgentState, now: number): RhythmSchedule | null {
  return jitteredSchedule(config, scheduleAnchor(state), now);
}

/** The earliest wake a coin agent's `finish` may choose, and why (runtime.ts `coinWakeFloor`). */
export interface WakeFloor {
  at: number;
  reason: 'next_slot' | 'cadence' | 'review_at';
}

/**
 * A coin agent's own wake never comes before its cadence: mentions wake it through the tick, its due original post
 * through the schedule, so a self-chosen wake in between buys a thought for nothing (one agent on Haiku woke every
 * six minutes echoing the sender's `nextReadAt`, about $0.04 a wake). The floor is the next original-post slot
 * (jittered, from the state as it is after this turn), or one cadence from now when no slot lies ahead (publishing
 * off, or the slot is due but held). The one concrete reason to come back sooner is a mention the turn deferred to a
 * `reviewAt`: the floor drops to it. The platform agent keeps its own choice (null): its rhythm is its own.
 */
export function coinWakeFloor(config: AgentConfig, state: AgentState, turn: Pick<Turn, 'reviewAt'>, now: number): WakeFloor | null {
  if (config.platform) return null;
  const schedule = scheduleFor(config, state, now);
  let floor: WakeFloor = schedule && schedule.nextAt > now ? { at: schedule.nextAt, reason: 'next_slot' } : { at: now + config.postIntervalMs, reason: 'cadence' };
  const review = turn.reviewAt ? Date.parse(turn.reviewAt) : Number.NaN;
  if (Number.isFinite(review) && review > now && review < floor.at) floor = { at: review, reason: 'review_at' };
  return floor;
}

/**
 * The stable code at the head of a tool error, for the log: `sender_rejected:policy:social_execution_command_forbidden`,
 * `sender_rejected:forbidden(403)`, `mention_unknown_account`, `quiet_hours`. Everything after the first space (the
 * explanation, which may quote the post) is left out.
 */
export function errorCodeOf(error: string | null | undefined): string {
  return (error ?? '').trim().split(/\s/)[0]!.replace(/:$/, '').slice(0, 120);
}

async function buildFirstObservation(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, state: AgentState, inputs: TurnInputs, tools: readonly ModelTool[], directory: AgentDirectory, update: PlatformUpdate | null, premium: boolean | null = null) {
  const now = ctx.now();
  const views: InboxView[] = inboxViews(config, inputs.inbox, now, directory);
  const eligible = views.filter((v) => v.eligible);
  const memories = await ctx.memories.recent(agent.agentId, 5);
  const schedule = inputs.schedule;
  const review = await reviewSection(ctx, agent);
  // An X hold the model was told about is over (rhythm.ts `holdEndedMessage`): said once, here, before anything else.
  const holdEnded = state.postHoldEndedNote?.at != null ? state.postHoldEndedNote : null;
  return buildObservation({
    now,
    market: inputs.market ? { snapshot: inputs.market } : null,
    treasury: inputs.treasury ? { balances: { ...inputs.treasury.balances, claimable: inputs.treasury.claimable, usd: inputs.treasury.usd, gas: inputs.treasury.gas } } : null,
    social: {
      messages: verifiedFirst(eligible).map((v) => ({ postId: v.postId, authorId: v.authorId, conversationId: v.conversationId, verified: isVerifiedAuthor(v.post), post: v.post, observedAt: v.observedAt, ...(v.bootrAgent ? { bootrAgent: v.bootrAgent } : {}) })),
      threadContexts: [],
      repliesAvailable: eligible.length > 0,
      // `maxChars`: what this X account may send in one original post (280 without Premium; the tool and the prompt say the same).
      originalPost: schedule ? { ...originalPostView(schedule), maxChars: postLimitsFor(premium).original } : null,
    },
    lastResults: state.lastResults ?? [],
    continuation: state.continuation ?? null,
    extra: {
      wakeReasons: inputs.reasons,
      ...(holdEnded ? { holdEnded: holdEndedMessage(holdEnded) } : {}),
      ineligibleMentions: views.length - eligible.length,
      checkpoint: { memory: state.memory, agenda: state.agenda, summary: state.summary, at: state.lastCheckpointAt ? new Date(state.lastCheckpointAt).toISOString() : null },
      recentNotes: memories,
      tools: tools.map((t) => t.name),
      stepBudget: ctx.config.MAX_TOOL_STEPS,
      ...(review ? { review } : {}),
      // What the agent can still spend on thinking (one database read, no RPC; omitted when it cannot be read): fuel.ts.
      ...(await fuelSection(ctx, agent.agentId, inputs.treasury)),
      // Whether a picture fits this turn, what one costs and how many are left today (images on only): picture-hint.ts.
      ...(await pictureSection(ctx, agent, config, tools, inputs, directory)),
      // How its own coin's trades pay their fee, in percentages, from the market snapshot above (no extra read): coin-fees.ts.
      ...coinFeesSection(config, inputs.market),
      // "Bootr today" (platform agents only; empty for everyone else): context.ts / platform-feed.ts.
      ...(await bootrTodaySection(ctx, agent, config)),
      // How the agent's own posts of the last 7 days did (empty until something was measured): post-performance.ts.
      ...(await postPerformanceSection(ctx, agent.agentId)),
      // What it said in the last day (recent-posts.ts): no repeats, and the creator's rejection notes.
      ...(await recentPostsSection(ctx, agent.agentId)),
      // Whether a coin agent may say it runs on Bootr in this post (one in six; empty for the platform agent): bootr-promotion.ts.
      ...(await bootrPromotionSection(ctx, agent.agentId, config)),
      // What is left of the creator's daily budget of posts and replies, so the model paces itself: post-budget.ts.
      ...(await postBudgetSection(ctx, agent.agentId, config)),
      // The other Bootr agents and the agent-to-agent conversation caps: agent-directory.ts.
      ...(await bootrAgentsSection(ctx, agent, config, views)),
      // "This week on Bootr" (platform agent, once a week): weekly-digest.ts.
      ...weeklyDigestSection(config, inputs.digest ?? null, tools),
      // The platform's numbers and the daily numbers post (platform agent only): platform-numbers.ts.
      ...platformNumbersSection(config, config.platform ? await cachedPlatformNumbers(ctx, config) : null, inputs.numbers ?? null),
      // One change that is live on Bootr, at most one a day (platform agent only): platform-updates.ts.
      ...platformUpdateSection(config, update),
      // The people the host follows and their latest posts (platform agent only): watchlist.ts.
      ...(await watchlistSection(ctx, agent, config)),
    },
  });
}

/**
 * Post approval mode as the model sees it (approvals.ts): whether its posts are reviewed first, how many wait,
 * and the rejections since its last turn ("your post X was rejected: note"), each told once. Stale pending
 * items expire here too. Null when the flag is off and nothing was rejected.
 */
async function reviewSection(ctx: SupervisorContext, agent: AgentRow): Promise<Record<string, unknown> | null> {
  await expireApprovals(ctx, agent.agentId);
  const rejected = await takeFeedback(ctx, agent.agentId);
  const enabled = requiresApproval(agent.config);
  if (!enabled && rejected.length === 0) return null;
  return {
    enabled,
    ...(enabled
      ? {
          pending: await pendingCount(ctx, agent.agentId),
          note: 'The creator reviews your posts and replies before they go out: publish_post and publish_reply queue them. A queued item counts as posted; never post or rephrase it again. Rejections appear here on a later turn.',
        }
      : {}),
    ...(rejected.length ? { rejected: rejected.map((r) => ({ approvalId: r.approvalId, kind: r.kind, text: r.text, note: r.note, decidedAt: r.decidedAt, message: r.message })) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------

export type TurnOutcome = 'finished' | 'step_cap' | 'held' | 'pending' | 'inference_unknown' | 'inference_failed' | 'provider_hold' | 'error';

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
  const routing = startRouting(config);
  // The account's post limit for this turn: the sender's `premium` (one internal read; it also keeps the sender's flag fresh).
  const premium = config.capabilities.xPublish ? await accountPremium(ctx, agent.agentId) : null;
  // The social role's catalog: everything the agent has, minus the money tools while the treasury turn is on (roles.ts).
  const tools = toolsForPhase(routing, roleTools(ctx, config, agent.config, 'social', { premium }));
  const directory = inputs.directory ?? (await agentDirectory(ctx));
  inputs = { ...inputs, inbox: await autoCloseMentions(ctx, agent, runtime, config, inputs.inbox, directory, lease) };
  // A publish that settled while no turn was open (tick.ts `reconcilePending`) counts before this turn is shown anything.
  settlePlatformUpdate(config, state, runtime.pending as unknown as PendingAction | null, ctx.now());
  const update = offerPlatformUpdate(config, state, ctx.now(), !!inputs.schedule?.due && !inputs.digest && !inputs.numbers);
  const observation = await buildFirstObservation(ctx, agent, config, state, inputs, tools, directory, update, premium);
  // The ended-hold note is delivered in this observation and in no later one: it goes with the same write as the turn.
  if (state.postHoldEndedNote?.at != null) state.postHoldEndedNote = null;
  const turn: Turn = {
    role: 'social',
    startedAt: ctx.now(),
    steps: 0,
    nudged: false,
    reasons: inputs.reasons,
    premium,
    messages: [
      { role: 'system', content: buildSystemPrompt(config, 'social', { phase: phaseOf(routing), postLimit: postLimitsFor(premium).original }) },
      { role: 'user', content: JSON.stringify(observation) },
    ],
    inbox: Object.fromEntries(inputs.inbox.map((i) => [i.postId, i])),
    eligibility: Object.fromEntries(inboxViews(config, inputs.inbox, ctx.now(), directory).map((v) => [v.postId, { eligible: v.eligible, ...(v.reason ? { reason: v.reason } : {}) }])),
    recentSteps: [],
    routing,
    digestWeek: inputs.digest?.week ?? null,
    numbersDay: inputs.numbers?.day ?? null,
    postDue: inputs.reasons.includes('original_post_due'),
  };
  await saveRuntime(ctx, agent.agentId, { state: boundedState(trimState(state)) as unknown as Record<string, unknown>, turn: turn as unknown as Record<string, unknown>, status: 'running', lastDecisionAt: new Date(ctx.now()), lastDecisionRevision: config.revision });
  return runLoop(ctx, agent, { ...runtime, turn: turn as unknown as Record<string, unknown> }, config, turn, lease);
}

/** Continues a persisted turn (after a crash, a held action that reconciled, or a resumable read), in the role it was started as. */
export async function continueTurn(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow, config: AgentConfig, lease: string): Promise<TurnResult | null> {
  const turn = runtime.turn as unknown as Turn | null;
  if (!turn) return null;
  return runLoop(ctx, agent, runtime, config, turn, lease);
}

/**
 * The treasury turn (roles.ts; design section 3.4): the same loop as the social turn with the treasury role's prompt,
 * tools and observation, no economy mode (the whole turn runs on `config.model`: the decide model is the social turn's
 * cheap reader, and a turn that may move money is not the place to save on the model), no inbox and no post slot. The
 * clock is stamped before the first thought so a crash does not buy another attempt every tick; the notes shown here
 * count as consumed from this moment. `lastDecisionAt` and the revision are left alone: a config change must still
 * wake the social turn once.
 */
export async function startTreasuryTurn(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow, config: AgentConfig, inputs: TreasuryTurnInputs, lease: string): Promise<TurnResult> {
  const state = runtime.state as unknown as AgentState;
  const now = ctx.now();
  const tools = roleTools(ctx, config, agent.config, 'treasury');
  const observation = await buildTreasuryObservation(ctx, agent, config, state, inputs, tools);
  state.lastTreasuryTurnAt = now;
  state.treasuryNextAt = now + ctx.config.TREASURY_TURN_INTERVAL_MS;
  state.lastTreasuryNoteSeenAt = now;
  const turn: Turn = {
    role: 'treasury',
    startedAt: now,
    steps: 0,
    nudged: false,
    reasons: inputs.reasons,
    premium: null,
    messages: [
      { role: 'system', content: buildSystemPrompt(config, 'treasury') },
      { role: 'user', content: JSON.stringify(observation) },
    ],
    inbox: {},
    eligibility: {},
    recentSteps: [],
    routing: null,
  };
  await saveRuntime(ctx, agent.agentId, { state: boundedState(trimState(state)) as unknown as Record<string, unknown>, turn: turn as unknown as Record<string, unknown>, status: 'running' });
  return runLoop(ctx, agent, { ...runtime, turn: turn as unknown as Record<string, unknown> }, config, turn, lease);
}

/** The role a persisted action was recorded under (`sv_actions.action.role`; `social` for every row without one). */
async function actionRoleOf(ctx: Pick<SupervisorContext, 'db'>, actionId: string): Promise<AgentRole> {
  const row = await ctx.db.query.actions.findFirst({ where: eq(actions.actionId, actionId), columns: { action: true } });
  const role = (row?.action as { role?: unknown } | undefined)?.role;
  return role === 'treasury' || role === 'judge' ? role : 'social';
}

async function runLoop(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow, config: AgentConfig, turn: Turn, lease: string): Promise<TurnResult> {
  /** The role the turn was started as (roles.ts); a turn persisted before the field existed is a social one. */
  const role: AgentRole = turn.role ?? 'social';
  // Every log line of a treasury turn (thought, turn ended, refusals) carries its role; the social turn's lines are as before.
  const log = ctx.log.child({ agentId: agent.agentId, ...(role !== 'social' ? { role } : {}) });
  const state = runtime.state as unknown as AgentState;
  let broker: BrokerRuntime = { runtimeId: agent.agentId, cycle: runtime.cycle, pending: (runtime.pending as unknown as PendingAction | null) ?? null };
  const catalog = roleTools(ctx, config, agent.config, role, { premium: turn.premium ?? null });
  /** The functions of the current economy-mode phase (routing.ts, the social role only); the role's catalog otherwise. */
  const tools = () => (role === 'social' ? toolsForPhase(turn.routing, catalog) : [...catalog]);
  const env: BrokerEnv = { inbox: new Map(Object.entries(turn.inbox)), eligibility: new Map(Object.entries(turn.eligibility ?? {})), cycle: broker.cycle };

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
      settlePlatformUpdate(config, state, pending, ctx.now());
      await ctx.db
        .update(actions)
        .set({ status: pending.status, result: (pending.result as unknown as Record<string, unknown>) ?? null, receipt: (pending.result?.receipt as Record<string, unknown> | undefined) ?? null, updatedAt: new Date(ctx.now()) })
        .where(eq(actions.actionId, pending.id));
    }
    const settled = settleCycle(broker);
    broker = settled.runtime;
    return settled.observation;
  };

  /**
   * How a treasury turn ends (roles.ts). The runtime's `nextAt` is the social schedule and stays where it is, unless
   * the turn itself is kept for a resume (a sent or held action, an unknown or credited inference), when the resume
   * time must reach the tick. An unknown inference keeps the turn as well, so its paid answer comes back into this
   * conversation and not into the next social one. Its own clock: the next turn an interval from now at the earliest,
   * later when the model asked for later (`finish`) or the inference backoff reaches further.
   */
  const treasuryEnd = (outcome: TurnOutcome, patch: RuntimePatch): RuntimePatch => {
    const kept = patch.turn != null || outcome === 'pending' || outcome === 'held' || outcome === 'inference_unknown';
    if (kept) return outcome === 'inference_unknown' ? { ...patch, turn: turn as unknown as Record<string, unknown> } : patch;
    const rest: RuntimePatch = { ...patch };
    delete rest.nextAt;
    state.treasuryNextAt = Math.max(state.treasuryNextAt ?? 0, ctx.now() + ctx.config.TREASURY_TURN_INTERVAL_MS, state.inferenceRetryAt ?? 0);
    return rest;
  };

  const endTurn = async (outcome: TurnOutcome, patch: RuntimePatch): Promise<TurnResult> => {
    await persist({ turn: null, ...(role === 'treasury' ? treasuryEnd(outcome, patch) : patch) });
    log.info({ outcome, steps: turn.steps, cycle: broker.cycle }, 'turn ended');
    return { outcome, steps: turn.steps, cycle: broker.cycle };
  };

  const forceFinish = async (why: string): Promise<TurnResult> => {
    // A treasury turn cut short leaves the social state alone: no continuation, no runtimeEnded note, no early wake.
    if (role === 'treasury') {
      log.info({ why }, 'treasury turn ended by the runtime');
      return endTurn('step_cap', { status: 'waiting' });
    }
    settleWeeklyDigest(state, turn);
    settlePlatformNumbers(state, turn);
    state.continuation = { progress: `Turn ended by the runtime (${why}). Continue from the agenda.`, recentSteps: turn.recentSteps.slice(-6) };
    const next = ctx.now() + 5 * 60_000;
    state.runtimeEnded = { until: next, postIds: Object.keys(turn.inbox).slice(-100), postDue: !!turn.postDue };
    return endTurn('step_cap', { status: 'waiting', nextAt: new Date(next) });
  };

  // A pending action left over from a previous process: resolve it first.
  if (broker.pending && (broker.pending.status === 'sent' || broker.pending.status === 'held')) {
    // A publish queued for the creator's review before a crash settles from its approval row, never from the sender.
    const queued = broker.pending.action.tool === 'publish_post' || broker.pending.action.tool === 'publish_reply' ? await queuedOutcomeFor(ctx, broker.pending.id) : null;
    const resolution: PendingResolution = queued && queued.kind !== 'unknown' ? { resolved: true, outcome: queued } : await resolvePending(ctx, agent, broker.pending);
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
    // A leftover action of the other role (a treasury turn's that a social turn now settles, or the reverse) is settled
    // and recorded, but its result is not put in front of this role: the social turn never sees a money result it did
    // not ask for, and the treasury turn never sees a reply's.
    const leftoverRole = await actionRoleOf(ctx, broker.pending.id);
    const result = await settle();
    if (result && leftoverRole === role) {
      const toolCallId = lastToolCallId(turn.messages) ?? result.actionId;
      turn.messages.push(toolMessage(toolCallId, result.status === 'completed' ? result.result : { error: result.error, status: result.status }));
      turn.recentSteps.push({ tool: result.tool, status: result.status, summary: summarize(result) });
      if (completeAfter && result.status === 'completed') return endTurn('finished', { status: 'waiting' });
    }
  } else if (broker.pending && (broker.pending.status === 'completed' || broker.pending.status === 'failed')) {
    await settle();
  }

  /**
   * Every inference failure backs off, and tick.ts wakes nothing before `inferenceRetryAt`. A credit keeps the key
   * and the turn, so the next attempt replays the stored request without a new payment; anything else ends the turn
   * and the next attempt gets a new key. An outage-shaped failure also counts towards the fleet-wide provider hold
   * (provider-hold.ts): once enough agents fail the same way, this agent waits for the hold too.
   */
  const backOff = async (inf: { kind: 'credit' | 'failed'; key: string; error: string }): Promise<TurnResult> => {
    const failures = (runtime.failures ?? 0) + 1;
    const plan = interruptionPlan(0, failures, ctx.now());
    const hold = noteInferenceFailure(agent.agentId, inf.error, ctx.now());
    const nextAt = Math.max(plan.nextAt, hold?.until ?? 0);
    log.warn({ key: inf.key, error: inf.error, failures, nextAt, credit: inf.kind === 'credit', providerHold: hold?.until ?? null }, 'inference failed');
    // BlockRun does not know this agent's model: no backoff fixes that. The creator hears it in the inbox, the owner in the log.
    if (inf.error.includes(MODEL_MISSING)) {
      const model = modelFor(config, turn.routing);
      log.error({ key: inf.key, model, error: inf.error }, 'the model this agent is configured with is not served by BlockRun; it waits unpaid until the creator or the platform changes it');
      await raiseNotification(ctx, agent.agentId, 'model_unavailable', { model, field: turn.routing?.phase === 'decide' ? 'decideModel' : 'model', picture: 0 });
      state.modelUnavailable = true;
    }
    state.inferenceKey = inf.kind === 'credit' ? inf.key : null;
    // The backoff gate (tick.ts) holds both roles; the continuation note is the social turn's own.
    state.inferenceRetryAt = nextAt;
    if (role === 'social') state.continuation = { progress: 'The previous turn was interrupted by an inference failure.', recentSteps: turn.recentSteps.slice(-6) };
    return endTurn('inference_failed', { ...(inf.kind === 'credit' ? { turn: turn as unknown as Record<string, unknown> } : {}), status: 'waiting', nextAt: new Date(nextAt), failures, lastError: rpcErrorText(inf.error) });
  };

  /**
   * The provider is down for everyone (provider-hold.ts): this thought is not bought. The agent waits until the hold
   * ends with its own `inferenceRetryAt`, so tick.ts does not wake it meanwhile; its failure count is not touched,
   * since nothing of its own failed. A paid-for answer carried from an earlier attempt is still used (see the loop).
   */
  const waitOutProvider = (hold: { until: number; error: string; message: string }): Promise<TurnResult> => {
    log.warn({ until: new Date(hold.until).toISOString(), error: hold.error, steps: turn.steps }, 'provider down for every agent; no thought bought');
    state.inferenceRetryAt = hold.until;
    if (role === 'social') state.continuation = { progress: 'The previous turn waited out a model provider outage.', recentSteps: turn.recentSteps.slice(-6) };
    return endTurn('provider_hold', { status: 'waiting', nextAt: new Date(hold.until), lastError: hold.message.slice(0, 500) });
  };

  // Unknown inference or a credit from a previous attempt: never pay for a replacement.
  let carried: InferenceResult | null = null;
  if (state.inferenceKey) {
    const res = await reconcileInference(ctx, state.inferenceKey);
    if (res.kind === 'unknown') return endTurn('inference_unknown', { status: 'waiting', nextAt: new Date(ctx.now() + 60_000) });
    if (res.kind === 'credit') return backOff(res);
    state.inferenceKey = null;
    if (res.kind === 'failed') {
      broker = { ...broker, cycle: broker.cycle + 1 };
      // Signed for and lost (a refund may be due): a replacement waits for the backoff. Nothing signed: nothing at stake.
      if (res.error !== 'no_payment_signed') return backOff(res);
    } else {
      carried = res;
    }
  }

  while (true) {
    // A carried response is already paid for: it is used even on the last step.
    if (!carried && turn.steps >= ctx.config.MAX_TOOL_STEPS) return forceFinish('step cap reached');
    await renewLease(ctx, agent.agentId, lease);

    let inf: InferenceResult;
    if (carried) {
      inf = carried;
      carried = null;
    } else {
      let request;
      for (;;) {
        try {
          request = buildRequest(config, turn.messages, tools(), turn.outputBoost ? ctx.config.INFERENCE_RETRY_OUTPUT_TOKENS : ctx.config.INFERENCE_MAX_OUTPUT_TOKENS, modelFor(config, turn.routing));
          break;
        } catch (err) {
          if (err instanceof PolicyError && err.code === 'context_too_large' && compactMessages(turn.messages)) continue;
          return forceFinish('context too large');
        }
      }
      const hold = providerHold(ctx.now());
      if (hold) return waitOutProvider(hold);
      await persist();
      inf = await runInference(ctx, agent, config, broker.cycle, request);
      logThought(log, turn.routing, turn.steps + 1, request.model, inf);
    }
    turn.steps += 1;

    if (inf.kind === 'unknown') {
      state.inferenceKey = inf.key;
      log.warn({ key: inf.key, error: inf.error }, 'inference outcome unknown; holding the turn');
      return endTurn('inference_unknown', { status: 'waiting', nextAt: new Date(ctx.now() + 60_000) });
    }
    if (inf.kind === 'credit') return backOff(inf);
    if (inf.kind === 'failed') {
      broker = { ...broker, cycle: broker.cycle + 1 };
      return backOff(inf);
    }
    state.inferenceRetryAt = null;
    if (!inf.replayed) noteInferenceSuccess();
    if (state.modelUnavailable) {
      await resolveNotification(ctx, agent.agentId, 'model_unavailable');
      state.modelUnavailable = null;
    }

    // Cut off at the output limit: the call is not carried out, and its broken JSON must not go back to the provider,
    // which would refuse the next request. The model is told why, and gets room for one retry.
    if (inf.truncated && inf.toolCall) {
      broker = { ...broker, cycle: broker.cycle + 1 };
      log.warn({ key: inf.key, tool: inf.toolCall.name, boosted: !!turn.outputBoost }, 'tool call cut off at the output limit');
      turn.outputBoost = true;
      turn.recentSteps.push({ tool: inf.toolCall.name, status: 'truncated', summary: 'cut off at the output limit' });
      turn.messages.push({ role: 'user', content: `Your ${inf.toolCall.name} call was cut off because it was too long, so it was not carried out. Make it again, shorter. For finish: keep memory, agenda and summary brief and archive details with remember.` });
      await persist();
      continue;
    }
    turn.outputBoost = false;

    turn.messages.push(inf.message);
    if (!inf.toolCall) {
      broker = { ...broker, cycle: broker.cycle + 1 };
      if (turn.nudged) return forceFinish('no tool call');
      turn.nudged = true;
      turn.messages.push({ role: 'user', content: 'Call exactly one tool. When you are done for now, call finish with your checkpoint.' });
      await persist();
      continue;
    }

    // Economy mode: draft_intent is consumed here (the writer takes over from the next step), never brokered.
    if (handleIntent(config, turn, catalog, inf.toolCall)) {
      broker = { ...broker, cycle: broker.cycle + 1 };
      await persist();
      continue;
    }

    let action: Action;
    try {
      action = parseAction({ tool: inf.toolCall.name, input: inf.toolCall.input });
      if (!tools().some((t) => t.name === action.tool)) throw new PolicyError('tool_unavailable', { message: `tool_unavailable: ${action.tool}` });
    } catch (err) {
      broker = { ...broker, cycle: broker.cycle + 1 };
      const detail = err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : String(err);
      // The paths and codes only: an issue message can quote the model's text.
      log.info({ tool: inf.toolCall.name, code: err instanceof PolicyError ? err.code : 'invalid_tool_call', issues: err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.') || '.'}:${i.code}`) : undefined }, 'tool call refused before it ran');
      turn.messages.push(toolMessage(inf.toolCall.id, { error: 'invalid_tool_call', detail }));
      turn.recentSteps.push({ tool: inf.toolCall.name, status: 'invalid', summary: detail.slice(0, 200) });
      await persist();
      continue;
    }

    const now = ctx.now();
    env.cycle = broker.cycle;
    let pending = beginAction(broker, action, broker.cycle, now, action.tool === 'finish');
    broker.pending = pending;
    await ctx.db
      .insert(actions)
      // A treasury turn's actions carry their role in the stored JSON (activity.ts and `actionRoleOf` read it); social rows are as before.
      .values({ actionId: pending.id, agentId: agent.agentId, cycleKey: pending.cycleKey, action: { ...(action as unknown as Record<string, unknown>), ...(role !== 'social' ? { role } : {}) }, status: 'sending', createdAt: new Date(now), updatedAt: new Date(now) })
      .onConflictDoNothing();
    await persist();

    if (action.tool === 'finish' && role === 'treasury') {
      // The treasury's own checkpoint: its slot in the state, cut to size; the social memory, agenda, summary, post slot
      // and wake are not touched. The model's wake request is honoured only beyond the interval (and within a day).
      let cp;
      try {
        cp = checkpoint(action.input as unknown as Record<string, unknown>, now, { floorMs: ctx.config.TREASURY_TURN_INTERVAL_MS });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        broker.pending = recordOutcome(pending, { kind: 'failed', error }, now);
        await settle();
        turn.messages.push(toolMessage(inf.toolCall.id, { error }));
        turn.recentSteps.push({ tool: 'finish', status: 'failed', summary: error });
        await persist();
        continue;
      }
      state.treasuryCheckpoint = { memory: cp.memory.slice(0, TREASURY_CHECKPOINT_CHARS.memory), agenda: cp.agenda.slice(0, TREASURY_CHECKPOINT_CHARS.agenda), summary: cp.summary.slice(0, TREASURY_CHECKPOINT_CHARS.summary), at: now };
      state.treasuryNextAt = cp.nextAtMs;
      broker.pending = markSent(pending);
      broker.pending = recordOutcome(broker.pending, { kind: 'completed', result: { checkpointed: true, nextTreasuryTurnAt: cp.nextAt } }, now);
      await settle();
      return endTurn('finished', { status: 'waiting', failures: 0, lastError: null });
    }

    if (action.tool === 'finish') {
      let cp;
      // The state the floor reads is the one after this turn: a post or a passed slot moves the anchor first. A slot
      // whose post X held (quota, credits, forbidden) is kept: the schedule wakes the agent again when the hold ends.
      const skippedSlot = !!turn.postDue && !turn.posted && !turn.postHeld;
      const floor = coinWakeFloor(config, skippedSlot ? { ...state, lastSlotSkippedAt: now } : state, turn, now);
      try {
        cp = checkpoint(action.input as unknown as Record<string, unknown>, now, floor ? { floorMs: floor.at - now } : {});
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
      state.runtimeEnded = null;
      state.lastResults = [];
      state.phase = 'social';
      // A due slot the agent passed on is spent: it is not asked again every tick until the next slot.
      if (skippedSlot) state.lastSlotSkippedAt = now;
      settleWeeklyDigest(state, turn);
      settlePlatformNumbers(state, turn);
      // A wake asked for before the cadence floor was lifted to it (coinWakeFloor); said once here, with no post text.
      if (floor && cp.nextAtMs > Math.max(cp.requestedMs, now + 60_000)) log.info({ requestedAt: new Date(cp.requestedMs).toISOString(), nextAt: cp.nextAt, floor: floor.reason }, 'wake moved to the cadence floor');
      broker.pending = markSent(pending);
      broker.pending = recordOutcome(broker.pending, { kind: 'completed', result: { checkpointed: true, nextAt: cp.nextAt, ...(floor && cp.nextAtMs > cp.requestedMs ? { note: `your wake was moved to ${cp.nextAt} (${floor.reason === 'review_at' ? 'the mention you deferred' : 'your next original-post slot'}); mentions and a due post wake you on their own` } : {}) } }, now);
      await settle();
      return endTurn('finished', { status: 'waiting', nextAt: new Date(cp.nextAtMs), failures: 0, lastError: null });
    }

    pending = markSent(pending);
    broker.pending = pending;
    await persist();
    // Post approval mode: the publish is stored for the creator instead of sent (approvals.ts).
    const reviewed = (action.tool === 'publish_post' || action.tool === 'publish_reply') && requiresApproval(agent.config);
    const outcome = reviewed ? await queueForApproval(ctx, agent, pending, env) : await executeAction(ctx, agent, config, pending, env);
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
      const publish = action.tool === 'publish_post' || action.tool === 'publish_reply';
      // Every refused publish is on the record at info, by its code alone (never the text): until now a refusal
      // showed only in sv_actions, and three 403s in six minutes went unnoticed.
      if (publish && result.status === 'failed') log.info({ tool: action.tool, actionId: pending.id, code: errorCodeOf(result.error) }, 'publish refused');
      if (publish && result.status === 'failed' && isXForbiddenError(result.error)) {
        // X refuses the account itself (403 "not permitted"): no retry fixes it, so posts and mention wakes are held for
        // hours, longer each time (rhythm.ts `forbiddenHold`), and the creator is told to look at the X account.
        const strikes = (state.postForbiddenStrikes ?? 0) + 1;
        const until = ctx.now() + forbiddenHoldMs(strikes);
        state.postForbiddenUntil = until;
        state.postForbiddenStrikes = strikes;
        state.postForbiddenAt = ctx.now();
        noteHoldSet(state, 'x_forbidden', until);
        if (action.tool === 'publish_post') turn.postHeld = true;
        log.warn({ tool: action.tool, actionId: pending.id, strikes, until: new Date(until).toISOString() }, 'x refuses this account\'s posts (403); posts held and the creator told');
        await raiseNotification(ctx, agent.agentId, 'x_forbidden', { strikes, hours: Math.round((until - ctx.now()) / 3_600_000), until: new Date(until).toISOString() });
      }
      if ((action.tool === 'resolve_mention' || action.tool === 'resolve_mentions') && result.status === 'completed' && action.input.outcome === 'defer' && action.input.reviewAt) {
        // A deferred mention is the one concrete reason a coin agent may wake before its cadence (coinWakeFloor).
        const at = Date.parse(action.input.reviewAt);
        if (Number.isFinite(at) && (!turn.reviewAt || at < Date.parse(turn.reviewAt))) turn.reviewAt = new Date(at).toISOString();
      }
      if (publish && result.status === 'failed' && result.error === 'sender:quota_exceeded') {
        // The sender's rolling 24 h quota is used up: hold posts and mention wakes until its retryAt (rhythm.ts).
        const until = pending.nextAt ?? ctx.now() + QUOTA_FALLBACK_HOLD_MS;
        state.postQuotaUntil = until;
        noteHoldSet(state, 'x_quota', until);
        if (action.tool === 'publish_post') turn.postHeld = true;
        log.info({ tool: action.tool, until: new Date(until).toISOString() }, 'x quota used up; posts held');
      }
      if ((action.tool === 'publish_post' || action.tool === 'publish_reply') && result.status === 'failed' && isXCreditsError(result.error)) {
        // The X app is out of API credits (402): hold posts and mention wakes, then try once more (rhythm.ts).
        const until = ctx.now() + X_CREDITS_RETRY_MS;
        state.postCreditsUntil = until;
        noteHoldSet(state, 'x_credits', until);
        if (action.tool === 'publish_post') turn.postHeld = true;
        log.warn({ tool: action.tool, until: new Date(until).toISOString() }, 'x credits depleted; posts held');
      }
      if ((action.tool === 'publish_post' || action.tool === 'publish_reply') && result.status === 'completed') {
        state.postQuotaUntil = null;
        state.postCreditsUntil = null;
        // The post went out: there is no hold left to report on, and nothing to say about one that just ended.
        state.postHoldEndedNote = null;
        if (state.postForbiddenUntil || state.postForbiddenStrikes) {
          state.postForbiddenUntil = null;
          state.postForbiddenStrikes = 0;
          state.postForbiddenAt = null;
          await resolveNotification(ctx, agent.agentId, 'x_forbidden');
        }
        // The weekly digest and the daily numbers post are not the cadence post (weekly-digest.ts, platform-numbers.ts): the first original post of a turn that carries one closes it and leaves the anchor alone.
        if (action.tool === 'publish_post') turn.posted = true;
        if (action.tool === 'publish_post' && !settleWeeklyDigest(state, turn) && !settlePlatformNumbers(state, turn)) state.lastPostAt = ctx.now();
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
  // The treasury's own checkpoint goes before the social memory is cut: the hourly turn rereads its numbers anyway.
  if (copy.treasuryCheckpoint) copy.treasuryCheckpoint = { ...copy.treasuryCheckpoint, memory: copy.treasuryCheckpoint.memory.slice(0, 500), agenda: copy.treasuryCheckpoint.agenda.slice(0, 300), summary: copy.treasuryCheckpoint.summary.slice(0, 200) };
  if (stateFits(copy)) return copy;
  copy.memory = copy.memory.slice(0, 6000);
  copy.agenda = copy.agenda.slice(0, 3000);
  copy.summary = copy.summary.slice(0, 1500);
  return copy;
}

