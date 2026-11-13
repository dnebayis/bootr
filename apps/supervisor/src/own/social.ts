/**
 * Own agents (docs/design/byo-agent.md sections 1 and 2): the social role of an own coin, put together from the pieces
 * the hosted social turn is made of. Nothing here thinks and nothing here is a new rule:
 *   - `due` is the tick's wake decision (tick.ts `processAgent`, step 3) over the same inputs: the mentions read
 *     through the sender, the schedule with the platform rhythm and the X holds, a turn the runtime ended, a config
 *     change, and for the platform agent the weekly digest and the numbers post; plus a creator request no social turn
 *     has been shown yet;
 *   - `open` is `startTurn` (runtime.ts) without the model: the role's tools minus `generate_image`, bounty entries and
 *     unverified mentions closed, the same first observation cut to what a client takes, the same turn fields;
 *   - `settled` and `finish` are the hosted loop's own code, moved into `afterSettledAction` and `socialCheckpoint`;
 *   - `abandoned` is the hosted `forceFinish`.
 * Mentions are read here, when a client asks what is due or opens a turn, and nowhere else: an own coin whose client is
 * away reads nothing (the tick skips the background read).
 */
import { buildSystemPrompt, compactView, observationFits, postLimitsFor, wakeDecision, type AgentConfig, type PendingAction, type RuntimeStatus, type WakeDecision } from '@bootr/agent-core';
import type { DueRole } from '@bootr/shared/own-agent';
import { agentDirectory, openWakeBound, recordOpenWake, recordPeerWakes, wakeViews, type AgentDirectory } from '../agent-directory.js';
import { bountyConversationIds } from '../bounties.js';
import { inboxViews, type InboxView } from '../broker/index.js';
import { openRequests, type CreatorRequest, type TurnRequest } from '../creator-requests.js';
import { autoCloseMentions, closeBountyEntries } from '../mention-close.js';
import { platformNumbersWake, settlePlatformNumbers, type PlatformNumbersPlan } from '../platform-numbers.js';
import { offerPlatformUpdate, settlePlatformUpdate } from '../platform-updates.js';
import { applyQuotaHold, applyRhythm, creditsHold, forbiddenHold, isXCreditsError, quotaHold, type RhythmSchedule } from '../rhythm.js';
import { roleTools } from '../roles.js';
import { accountPremium, afterSettledAction, buildFirstObservation, scheduleFor, socialCheckpoint, trackHoldEnd, type Turn, type TurnInputs } from '../runtime.js';
import { applyScheduled, scheduledTimes } from '../scheduled.js';
import { SenderError, type SenderInboxItem } from '../sender-client.js';
import { readTreasuryOnChain } from '../treasury.js';
import { settleWeeklyDigest, weeklyDigestWake, type WeeklyDigestPlan } from '../weekly-digest.js';
import { ownSetting, type OwnCall, type OwnOpened, type OwnRoleHandler } from './registry.js';
import { ABANDONED_WAKE_MS, callNotes, closeStaleMentions } from './turns.js';

/** A creator request no social turn has been shown yet (docs/design/byo-agent.md section 5.3): a reason of its own. */
export const CREATOR_REQUEST_REASON = 'creator_request';

/** What one look at "is the social turn due" found; `open` builds the turn from the same look. */
interface SocialWake {
  inbox: SenderInboxItem[];
  directory: AgentDirectory;
  bountyConversations: Set<string>;
  views: InboxView[];
  schedule: RhythmSchedule | null;
  decision: WakeDecision;
  digest: WeeklyDigestPlan | null;
  numbers: PlatformNumbersPlan | null;
  requests: CreatorRequest[];
  reasons: string[];
  due: boolean;
  /** When the role can next become due with nothing new happening (epoch ms). */
  nextAt: number;
}

const wakes = new WeakMap<OwnCall, SocialWake>();

/** The tick's wake decision for the social turn (tick.ts `processAgent`, step 3), over the same inputs and in the same order. */
async function socialWake(call: OwnCall): Promise<SocialWake> {
  const cached = wakes.get(call);
  if (cached) return cached;
  const { ctx, agent, runtime, config, state, now } = call;
  const log = ctx.log.child({ agentId: agent.agentId });
  const notes = callNotes(call);

  let inbox: SenderInboxItem[] = [];
  /** X answered 402 to the mention read: the X app is out of credits right now, so nothing is due for it. */
  let readOutOfCredits = false;
  if (config.capabilities.xRead) {
    try {
      const res = await ctx.sender.readMentions(agent.agentId);
      inbox = res.items;
      const nextReadAt = res.nextReadAt ? Date.parse(res.nextReadAt) : Number.NaN;
      notes.mentionsNextReadAt = Number.isFinite(nextReadAt) ? nextReadAt : null;
    } catch (err) {
      readOutOfCredits = err instanceof SenderError && isXCreditsError(err.code);
      if (err instanceof SenderError && (err.code === 'not_connected' || err.code === 'revoked')) notes.xNotConnected = true;
      if (err instanceof SenderError && err.code === 'read_budget_exhausted') {
        log.info({ retryAt: err.retryAt }, 'mention read skipped: X read budget used up for today');
        notes.mentionsNextReadAt = err.retryAt ?? null;
      } else log.warn({ err: err instanceof Error ? err.message : String(err) }, 'mention read failed');
    }
  }
  const directory = await agentDirectory(ctx);
  const bountyConversations = inbox.length ? await bountyConversationIds(ctx, agent.agentId).catch(() => new Set<string>()) : new Set<string>();
  const views = inboxViews(config, inbox, now, directory, bountyConversations);
  const stateHold = quotaHold(state.postQuotaUntil, now) ?? creditsHold(state.postCreditsUntil, now) ?? forbiddenHold(state.postForbiddenUntil, now);
  const quota = readOutOfCredits ? (quotaHold(state.postQuotaUntil, now) ?? creditsHold(now + ctx.config.SUPERVISOR_TICK_MS, now)) : stateHold;
  // A hold the model was told about that is no longer on the state is marked ended; the engine writes the state back.
  trackHoldEnd(state, stateHold, now);
  // A slot that a scheduled post covers is not due: the client is not told a post is due (scheduled.ts `applyScheduled`).
  const schedule = applyQuotaHold(await applyScheduled(ctx, agent.agentId, await applyRhythm(ctx, scheduleFor(config, state, now), now), now), quota);
  // A turn the server just closed: only something it has not seen makes the role due before its `nextAt`.
  const ended = state.runtimeEnded && state.runtimeEnded.until > now ? state.runtimeEnded : null;
  const pending = runtime.pending as unknown as PendingAction | null;
  const blocked = agent.status !== 'active' || runtime.status === 'paused' || pending?.status === 'held';
  const status: RuntimeStatus = pending?.status === 'held' || runtime.status === 'held' ? 'blocked' : runtime.status === 'paused' ? 'paused' : 'waiting';
  const scheduledAt = quota ? Math.max(runtime.nextAt.getTime(), quota.until) : runtime.nextAt.getTime();
  const decision = wakeDecision({
    now,
    enabled: agent.status === 'active',
    status,
    nextAt: scheduledAt,
    leaseUntil: null,
    // A Bootr agent whose mentions already made this role due `PEER_WAKE_CAP` times today makes it due no more (agent-directory.ts).
    // Mentions from outside the verified audience make it due at most `OPEN_REPLIES_PER_DAY` times a day between them, as in the tick.
    inbox: quota ? [] : wakeViews(views, directory, agent.agentId, state.peerWakes, now, openWakeBound(ctx, state)).filter((v) => !ended?.postIds.includes(v.postId)).map((v) => ({ postId: v.postId, status: 'pending', eligible: v.eligible, seenAt: null, deferredUntil: null })),
    replyRetryDue: false,
    schedule: schedule ? { due: schedule.due, nextAt: schedule.nextAt, mayCompose: schedule.mayCompose && !ended?.postDue } : null,
    continuation: !!state.continuation,
    configRevision: config.revision,
    lastDecision: runtime.lastDecisionAt ? { at: runtime.lastDecisionAt.getTime(), revision: runtime.lastDecisionRevision ?? -1 } : null,
    heldAction: pending?.status === 'held',
  });
  // The platform agent's weekly digest and daily numbers post fold themselves into the decision, as in the tick.
  const digest = await weeklyDigestWake(ctx, agent, config, state, schedule, status, now, decision);
  const numbers = await platformNumbersWake(ctx, agent, config, state, schedule, status, now, decision);

  // Requests the creator filed in the private chat while the coin was hosted are still there after a switch.
  const requests = await openRequests(ctx, agent.agentId, 'social').catch(() => [] as CreatorRequest[]);
  const shownUntil = runtime.lastDecisionAt ? runtime.lastDecisionAt.getTime() : 0;
  const newRequest = requests.some((r) => Date.parse(r.createdAt) > shownUntil);
  const reasons = decision.run ? [...decision.reasons] : [];
  if (!blocked && newRequest && !reasons.includes(CREATOR_REQUEST_REASON)) reasons.push(CREATOR_REQUEST_REASON);
  const due = !blocked && (decision.run || newRequest);

  let nextAt = scheduledAt;
  if (schedule && (schedule.mayCompose || schedule.held)) nextAt = Math.min(nextAt, schedule.held ? Math.max(schedule.nextAt, schedule.held.until) : schedule.nextAt);
  const wake: SocialWake = { inbox, directory, bountyConversations, views, schedule, decision, digest, numbers, requests, reasons, due, nextAt: due ? now : nextAt };
  wakes.set(call, wake);
  return wake;
}

/** The social role's tools for an own agent: the hosted role's catalog without `generate_image` (the client uploads its pictures). */
export function ownSocialTools(ctx: Pick<OwnCall['ctx'], 'config'>, config: AgentConfig, raw: Record<string, unknown>, premium: boolean | null) {
  return roleTools(ctx, config, raw, 'social', { premium }).filter((t) => t.name !== 'generate_image');
}

export const ownSocialRole: OwnRoleHandler = {
  role: 'social',

  async due(call: OwnCall): Promise<DueRole> {
    const wake = await socialWake(call);
    return { on: true, due: wake.due, reasons: wake.due ? wake.reasons : [], nextAt: new Date(wake.nextAt).toISOString() };
  },

  async open(call: OwnCall, opts: { reasons: string[]; forced: boolean; jobId?: string }): Promise<OwnOpened> {
    const { ctx, agent, runtime, config, state } = call;
    const wake = await socialWake(call);
    const now = ctx.now();
    // A turn a mention made due: the Bootr agents among the authors are counted against their wakes of the day, as in the tick.
    if (opts.reasons.includes('pending_mention')) {
      const waking = wakeViews(wake.views, wake.directory, agent.agentId, state.peerWakes, now, openWakeBound(ctx, state));
      const woke = recordPeerWakes(waking, wake.directory, agent.agentId, state.peerWakes, now);
      if (woke.counted.length) state.peerWakes = woke.wakes;
      // ...and a turn that only mentions from outside the verified audience made due is counted against the day's such turns.
      const open = recordOpenWake(waking, state.openWakes, now);
      if (open.counted) state.openWakes = open.wakes;
    }
    // The account's post limit for this turn (one internal read at the sender), as in `startTurn`.
    const premium = config.capabilities.xPublish ? await accountPremium(ctx, agent.agentId) : null;
    const catalog = ownSocialTools(ctx, config, agent.config, premium);
    const creatorRequests = wake.requests;
    const turnRequests: TurnRequest[] = creatorRequests.map((r) => ({ id: r.id, picture: r.picture }));
    // Replies to the agent's open bounty jobs leave the inbox first, then what waited through a downtime, then the
    // unverified-author pass; what remains is what the turn sees and may answer.
    let inbox = await closeBountyEntries(ctx, agent, wake.inbox, wake.bountyConversations);
    inbox = await closeStaleMentions(call, inbox);
    inbox = await autoCloseMentions(ctx, agent, runtime, config, inbox, wake.directory, runtime.leaseToken ?? '');
    // A publish that settled while no turn was open counts before this turn is shown anything.
    settlePlatformUpdate(config, state, runtime.pending as unknown as PendingAction | null, now);
    const update = offerPlatformUpdate(config, state, now, !!wake.schedule?.due && !wake.digest && !wake.numbers);
    const [treasury, market] = await Promise.all([readTreasuryOnChain(ctx, agent).catch(() => null), ctx.indexer.market(agent.token).catch(() => null)]);
    const inputs: TurnInputs = { reasons: opts.reasons, inbox, schedule: wake.schedule, treasury, market, directory: wake.directory, digest: wake.digest, numbers: wake.numbers, bountyConversations: wake.bountyConversations, creatorRequests };
    const full = await buildFirstObservation(ctx, agent, config, state, inputs, catalog, wake.directory, update, premium, catalog);
    // Clients cap a tool result well under what the hosted model is given: the same compaction, to a smaller budget.
    const limit = ownSetting(ctx, 'OWN_OBSERVATION_BYTES');
    const observation = compactView(full, (v) => observationFits(v, limit));
    const pictureSuggested = (observation.picture as { suggested?: unknown } | undefined)?.suggested === true;
    if (creatorRequests.length) ctx.log.info({ agentId: agent.agentId, requests: creatorRequests.map((r) => r.id) }, 'creator requests shown');
    // The ended-hold note is delivered in this observation and in no later one.
    if (state.postHoldEndedNote?.at != null) state.postHoldEndedNote = null;
    const views = inboxViews(config, inbox, ctx.now(), wake.directory, wake.bountyConversations);
    const turn: Turn = {
      role: 'social',
      startedAt: now,
      steps: 0,
      nudged: false,
      reasons: opts.reasons,
      premium,
      messages: [],
      inbox: Object.fromEntries(inbox.map((i) => [i.postId, i])),
      eligibility: Object.fromEntries(views.map((v) => [v.postId, { eligible: v.eligible, ...(v.reason ? { reason: v.reason } : {}) }])),
      recentSteps: [],
      routing: null,
      digestWeek: wake.digest?.week ?? null,
      numbersDay: wake.numbers?.day ?? null,
      postDue: opts.reasons.includes('original_post_due'),
      ...(turnRequests.length ? { creatorRequests: turnRequests } : {}),
      ...(pictureSuggested ? { pictureSuggested } : {}),
    };
    return {
      turn,
      brief: buildSystemPrompt(config, 'social', { postLimit: postLimitsFor(premium).original }),
      observation: observation as unknown as Record<string, unknown>,
      tools: catalog.map((t) => t.name),
    };
  },

  async settled(call, turn, action, result): Promise<void> {
    const { ctx, agent, state } = call;
    // The engine hands the action as it settled in the call's runtime row: its id, and the sender's retryAt for a quota hold.
    const settled = call.runtime.pending as unknown as PendingAction | null;
    const pending = settled && settled.id === result.actionId ? settled : { id: result.actionId, nextAt: undefined };
    await afterSettledAction(ctx, agent, state, turn, action, pending, result, ctx.log.child({ agentId: agent.agentId }));
  },

  async finish(call, turn, input): Promise<{ result: Record<string, unknown>; nextAt?: number }> {
    const { ctx, agent, config, state } = call;
    const done = socialCheckpoint(config, state, turn, { memory: input.memory, agenda: input.agenda, summary: input.summary, nextAt: input.nextAt }, ctx.now(), ctx.log.child({ agentId: agent.agentId }), await scheduledTimes(ctx, agent));
    return { result: done.result, nextAt: done.nextAtMs };
  },

  /** The hosted `forceFinish`: the digest and the numbers post this turn carried are closed, and the next turn is told where this one stopped. */
  async abandoned(call, turn, why): Promise<void> {
    const { ctx, state } = call;
    settleWeeklyDigest(state, turn);
    settlePlatformNumbers(state, turn);
    state.continuation = { progress: `Turn ended by the runtime (${why}). Continue from the agenda.`, recentSteps: turn.recentSteps.slice(-6) };
    state.runtimeEnded = { until: ctx.now() + ABANDONED_WAKE_MS, postIds: Object.keys(turn.inbox).slice(-100), postDue: !!turn.postDue };
  },
};
