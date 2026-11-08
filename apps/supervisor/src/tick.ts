/**
 * The supervisor tick: onboarding, then up to MAX_AGENTS_PER_TICK awake runtimes ordered by nextAt, then a sweep of
 * up to MAX_SLEEPING_PER_TICK sleeping runtimes (one treasury read each), then the paused ones (reconciliation only).
 * Per runtime: lease -> reconcile pending effects -> sleep rule -> fee policy -> wake decision -> turn.
 */
import { randomUUID } from 'node:crypto';
import { pendingReplyDue, reconcile, wakeDecision, type PendingAction, type RuntimeStatus } from '@bootr/agent-core';
import { and, asc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import { zeroAddress, type Address, type Hex } from 'viem';
import { kernelAbi } from './abi.js';
import { agentDirectory } from './agent-directory.js';
import { inboxViews, resolvePending } from './broker/index.js';
import type { AgentRow, RuntimeRow, SupervisorContext } from './context.js';
import { backfillBuilderCodes } from './builder-codes.js';
import { actions, agents, runtimes } from './db/schema.js';
import { SLEEP_USDC } from './fuel.js';
import { rpcErrorText } from './log.js';
import { agentConfigOf, completeOnboarding, pollLaunches, rotateExpiringSessionKeys } from './onboarding.js';
import { sweepImages } from './image-retention.js';
import { sweepPostMetrics } from './post-performance.js';
import { applyQuotaHold, applyRhythm, creditsHold, forbiddenHold, isXCreditsError, quotaHold } from './rhythm.js';
import { acquireLease, continueTurn, releaseLease, saveRuntime, scheduleFor, startTurn, type AgentState, type TurnResult } from './runtime.js';
import { validationId } from './session-key.js';
import { platformNumbersWake } from './platform-numbers.js';
import { weeklyDigestWake } from './weekly-digest.js';
import { SenderError, type SenderInboxItem } from './sender-client.js';
import { readAgentChainState, readTreasuryOnChain, reconcileOps, runFeePolicy, type AgentChainState } from './treasury.js';
import { openServiceCalls, reconcileServiceCall } from './services.js';

export { SLEEP_USDC };

export interface TickReport {
  registered: number;
  processed: string[];
  ran: string[];
  errors: { agentId: string; error: string }[];
}

/** The on-chain session-key revocation check waits this long after an install (a lagging RPC can read the pre-install state). */
export const REVOKE_CHECK_GRACE_MS = 10 * 60_000;

export async function tick(ctx: SupervisorContext): Promise<TickReport> {
  const report: TickReport = { registered: 0, processed: [], ran: [], errors: [] };
  try {
    report.registered = await pollLaunches(ctx);
  } catch (err) {
    ctx.log.error({ err }, 'launch poll failed');
  }
  try {
    await completeOnboarding(ctx);
    await rotateExpiringSessionKeys(ctx);
  } catch (err) {
    ctx.log.error({ err }, 'onboarding pass failed');
  }
  try {
    await backfillBuilderCodes(ctx);
  } catch (err) {
    ctx.log.error({ err }, 'builder code backfill failed');
  }
  // Engagement of posts that went out a day ago, a few agents per tick (post-performance.ts).
  try {
    await sweepPostMetrics(ctx);
  } catch (err) {
    ctx.log.error({ err }, 'post metrics sweep failed');
  }
  // Pictures: the relay's base64 answers after a day, stored pictures after a month (image-retention.ts; hourly).
  try {
    await sweepImages(ctx);
  } catch (err) {
    ctx.log.error({ err }, 'image retention sweep failed');
  }

  // Awake runtimes by `nextAt`. Sleeping ones are not among them: a sleeping agent never moves its `nextAt`, so ten
  // sleeping coins would otherwise hold every slot of every tick and no awake agent would ever run again.
  const due = await ctx.db
    .select({ runtime: runtimes, agent: agents })
    .from(runtimes)
    .innerJoin(agents, eq(agents.agentId, runtimes.agentId))
    .where(and(eq(agents.status, 'active'), notInArray(runtimes.status, ['paused', 'sleeping'])))
    .orderBy(asc(runtimes.nextAt), asc(runtimes.updatedAt))
    .limit(ctx.config.MAX_AGENTS_PER_TICK);
  // Sleeping runtimes get their own sweep, least recently checked first (each check touches the row), so refuelling
  // is noticed in turn without a sleeping coin ever taking an awake agent's slot. One treasury read each, no turn.
  const sleepingCap = ctx.config.MAX_SLEEPING_PER_TICK ?? ctx.config.MAX_AGENTS_PER_TICK;
  const sleeping =
    sleepingCap > 0
      ? await ctx.db
          .select({ runtime: runtimes, agent: agents })
          .from(runtimes)
          .innerJoin(agents, eq(agents.agentId, runtimes.agentId))
          .where(and(eq(agents.status, 'active'), eq(runtimes.status, 'sleeping')))
          .orderBy(asc(runtimes.updatedAt), asc(runtimes.nextAt))
          .limit(sleepingCap)
      : [];
  // Operator-paused runtimes still get reconciliation (cheap), never a turn.
  const paused = await ctx.db
    .select({ runtime: runtimes, agent: agents })
    .from(runtimes)
    .innerJoin(agents, eq(agents.agentId, runtimes.agentId))
    .where(and(eq(agents.status, 'active'), eq(runtimes.status, 'paused')))
    .limit(ctx.config.MAX_AGENTS_PER_TICK);

  for (const { runtime, agent } of [...due, ...sleeping, ...paused]) {
    report.processed.push(agent.agentId);
    try {
      const result = await processAgent(ctx, agent, runtime);
      if (result?.ran) report.ran.push(agent.agentId);
    } catch (err) {
      // The report is logged whole: a viem message names the RPC URL, key and all, so it is scrubbed here (log.ts).
      report.errors.push({ agentId: agent.agentId, error: rpcErrorText(err) });
      ctx.log.error({ agentId: agent.agentId, err }, 'agent tick failed');
    }
  }
  return report;
}

export interface ProcessResult {
  ran: boolean;
  reasons: string[];
  turn?: TurnResult | null;
  skipped?: string;
}

/** `_runtimeRow` is the row the caller selected; the leased copy is re-read so a concurrent writer cannot be stomped. */
export async function processAgent(ctx: SupervisorContext, agent: AgentRow, _runtimeRow: RuntimeRow): Promise<ProcessResult | null> {
  const lease = randomUUID();
  const leased = await acquireLease(ctx, agent.agentId, lease);
  if (!leased) return { ran: false, reasons: ['leased'], skipped: 'leased' };
  const log = ctx.log.child({ agentId: agent.agentId });
  try {
    let runtime = leased;
    const config = agentConfigOf(agent);
    if (!config) return { ran: false, reasons: ['config_incomplete'], skipped: 'config_incomplete' };

    // Admin revoke is the platform's kill switch: `guardian.revokeAllSessionKeys` bumps the kernel's valid nonce
    // (and `revokeSessionKey` uninstalls the permission), which leaves the stored session key dead. Mirror that
    // into a sticky operator pause so the agent stops ticking instead of failing every minute; a fresh install
    // through the admin API clears it.
    // Not within the first minutes after an install: right after the install transaction a lagging RPC node can
    // still answer with the pre-install state (hook = 0), which looks exactly like `revokeSessionKey`.
    const installedFor = agent.sessionKeyInstalledAt ? ctx.now() - agent.sessionKeyInstalledAt.getTime() : -1;
    const checkRevocation = !!agent.permissionId && installedFor >= REVOKE_CHECK_GRACE_MS && runtime.pausedBy !== 'operator';

    // A sleeping or paused agent has one question for the chain (was it refuelled, was it unpaused), asked every
    // REST_CHECK_MS and not every tick: with 200 ms blocks the RPC key is the scarce resource, not the minute. Its
    // receipts are still reconciled below, and its social line still goes out.
    const state0 = runtime.state as unknown as AgentState;
    const resting = runtime.status === 'sleeping' || runtime.status === 'paused';
    const restDue = !resting || ctx.now() - (state0.chainCheckedAt ?? 0) >= ctx.config.REST_CHECK_MS;
    if (resting && !restDue) {
      await reconcileOps(ctx, agent).catch((err) => log.warn({ err }, 'treasury reconcile failed'));
      runtime = await reconcilePending(ctx, agent, runtime);
      if (runtime.status === 'sleeping' || runtime.status === 'paused') {
        await postSocial(ctx, agent, config, runtime, runtime.status);
        return { ran: false, reasons: ['resting'], skipped: runtime.status };
      }
    }

    // One multicall for the agent's chain state: guardian pause, session-key revocation and the treasury (treasury.ts).
    const chainState: AgentChainState | null = await readAgentChainState(ctx, agent, { permissionId: checkRevocation ? (agent.permissionId as Hex) : null }).catch((err) => {
      log.warn({ err }, 'chain state read failed');
      return null;
    });
    // A read that answered counts as the check; a refused one (rate limit) is asked again next tick.
    if (resting && chainState?.treasury) {
      await saveRuntime(ctx, agent.agentId, { state: { ...state0, chainCheckedAt: ctx.now() } as unknown as Record<string, unknown> });
      runtime = { ...runtime, state: { ...state0, chainCheckedAt: ctx.now() } as unknown as Record<string, unknown> };
    }

    // Guardian pause (creator, on-chain) mirrors into the runtime; an operator pause is sticky.
    const info = chainState?.info ?? null;
    if (info?.paused && runtime.pausedBy !== 'operator') {
      if (runtime.status !== 'paused') await saveRuntime(ctx, agent.agentId, { status: 'paused', pausedBy: 'guardian' });
      return { ran: false, reasons: ['guardian_paused'], skipped: 'guardian_paused' };
    }
    if (info && !info.paused && runtime.pausedBy === 'guardian') {
      await saveRuntime(ctx, agent.agentId, { status: 'waiting', pausedBy: null });
      runtime = { ...runtime, status: 'waiting', pausedBy: null };
    }

    if (checkRevocation && chainState?.revoked) {
      await saveRuntime(ctx, agent.agentId, { status: 'paused', pausedBy: 'operator' });
      log.warn({ permissionId: agent.permissionId, reason: chainState.revoked }, 'session keys revoked on-chain; agent paused (operator)');
      return { ran: false, reasons: ['keys_revoked'], skipped: 'keys_revoked' };
    }

    // 1. Reconcile money and pending effects (never re-send). Paid service calls left open close from the chain alone.
    await reconcileOps(ctx, agent).catch((err) => log.warn({ err }, 'treasury reconcile failed'));
    await reconcileServiceCalls(ctx, agent).catch((err) => log.warn({ err }, 'service call reconcile failed'));
    runtime = await reconcilePending(ctx, agent, runtime);
    if (runtime.status === 'paused') return { ran: false, reasons: ['paused'], skipped: 'paused' };

    // 2. Sleep rule: no inference without fuel; refuel detection from the snapshot read above.
    const treasury = chainState?.treasury ?? null;
    if (chainState && !treasury) log.warn({ err: chainState.treasuryError }, 'treasury read failed');
    // An unknown balance is not an empty one: it neither puts an awake agent to sleep nor wakes a sleeping one, which
    // would otherwise reach the wake decision as `waiting` and could buy a turn with no fuel. Next tick reads again.
    if (!treasury && runtime.status === 'sleeping') {
      await saveRuntime(ctx, agent.agentId, {}); // checked: the sleeping sweep moves on to the next one
      await postSocial(ctx, agent, config, runtime, 'sleeping');
      return { ran: false, reasons: ['treasury_unknown'], skipped: 'treasury_unknown' };
    }
    if (treasury) {
      const policy = await runFeePolicy(ctx, agent, treasury).catch((err) => {
        log.warn({ err }, 'fee policy failed');
        return null;
      });
      // fuel = kernel USDC (the reservoir) + spender USDC (what actually pays the relay)
      const fuel = (t: typeof treasury) => t.usd.usdc + t.usd.spenderUsdc;
      // Read again only when the policy moved money or failed partway: otherwise the snapshot from a moment ago stands.
      const moved = !policy || policy.claim || policy.gas || policy.swap || policy.fund;
      const after = fuel(treasury) < SLEEP_USDC && moved ? await readTreasuryOnChain(ctx, agent).catch(() => treasury) : treasury;
      const sleeping = fuel(after) < SLEEP_USDC;
      if (sleeping && runtime.status !== 'held') {
        if (runtime.status !== 'sleeping') log.info({ usdc: after.balances.usdc, spenderUsdc: after.balances.spenderUsdc }, 'kernel + spender below 1 USDC; sleeping');
        // Saved either way: the sleeping sweep (tick) checks the least recently touched row first.
        await saveRuntime(ctx, agent.agentId, runtime.status !== 'sleeping' ? { status: 'sleeping' } : {});
        await postSocial(ctx, agent, config, runtime, 'sleeping');
        return { ran: false, reasons: ['sleeping'], skipped: 'sleeping' };
      }
      if (!sleeping && runtime.status === 'sleeping') {
        log.info({ usdc: after.balances.usdc }, 'refuelled; waking');
        await saveRuntime(ctx, agent.agentId, { status: 'waiting', nextAt: new Date(ctx.now()) });
        runtime = { ...runtime, status: 'waiting', nextAt: new Date(ctx.now()) };
      }
    }

    const state = runtime.state as unknown as AgentState;
    const now = ctx.now();
    // After an inference failure no cause (continuation, mention, due post, config change, digest) wakes the agent
    // before the backoff ends, since a wake is a paid attempt. wakeDecision lets a mention, a due post or a config
    // change pass `nextAt`, so this sits in front of it; leases, the pauses, reconciliation and the sleep rule above still run.
    if (state.inferenceRetryAt && state.inferenceRetryAt > now) {
      await postSocial(ctx, agent, config, runtime, 'awake');
      return { ran: false, reasons: ['inference_backoff'] };
    }

    // 3. Inputs for the wake decision.
    let inbox: SenderInboxItem[] = [];
    /** X answered 402 to the mention read: the X app is out of credits right now, so this tick buys no turn. */
    let readOutOfCredits = false;
    if (config.capabilities.xRead) {
      try {
        inbox = (await ctx.sender.readMentions(agent.agentId)).items;
      } catch (err) {
        readOutOfCredits = err instanceof SenderError && isXCreditsError(err.code);
        // The agent's own X read budget for the day is spent (sender read-budget.ts): expected, once a tick until midnight UTC.
        if (err instanceof SenderError && err.code === 'read_budget_exhausted') log.info({ retryAt: err.retryAt }, 'mention read skipped: X read budget used up for today');
        else log.warn({ err }, 'mention read failed');
      }
    }
    // Other Bootr agents (one read per tick) mark their mentions; the platform rhythm may hold a due post (rhythm.ts).
    const directory = await agentDirectory(ctx);
    const views = inboxViews(config, inbox, now, directory);
    // The agent's own X quota used up (sender quota_exceeded): no post, no mention reply and no scheduled wake buys a
    // model turn until it opens; mentions stay in the inbox for then (rhythm.ts, `quotaHold`).
    // X out of credits (402 on a publish, or on this tick's mention read): the same hold, reason `x_credits`.
    // X forbids the account (403 on a publish): the same hold for hours, reason `x_forbidden` (rhythm.ts `forbiddenHold`).
    const quota = quotaHold(state.postQuotaUntil, now) ?? creditsHold(readOutOfCredits ? now + ctx.config.SUPERVISOR_TICK_MS : state.postCreditsUntil, now) ?? forbiddenHold(state.postForbiddenUntil, now);
    const schedule = applyQuotaHold(await applyRhythm(ctx, scheduleFor(config, state, now), now), quota);
    // A turn the runtime just ended: only something it has not seen may wake the agent before its `nextAt`.
    const ended = state.runtimeEnded && state.runtimeEnded.until > now ? state.runtimeEnded : null;
    const pending = runtime.pending as unknown as PendingAction | null;
    const status: RuntimeStatus = runtime.status === 'held' ? 'blocked' : runtime.status === 'paused' ? 'paused' : runtime.status === 'running' ? 'working' : 'waiting';
    const decision = wakeDecision({
      now,
      enabled: agent.status === 'active',
      status,
      nextAt: quota ? Math.max(runtime.nextAt.getTime(), quota.until) : runtime.nextAt.getTime(),
      leaseUntil: null,
      inbox: quota ? [] : views.filter((v) => !ended?.postIds.includes(v.postId)).map((v) => ({ postId: v.postId, status: 'pending', eligible: v.eligible, seenAt: null, deferredUntil: null })),
      replyRetryDue: false,
      schedule: schedule ? { due: schedule.due, nextAt: schedule.nextAt, mayCompose: schedule.mayCompose && !ended?.postDue } : null,
      continuation: !!state.continuation || !!runtime.turn,
      configRevision: config.revision,
      lastDecision: runtime.lastDecisionAt ? { at: runtime.lastDecisionAt.getTime(), revision: runtime.lastDecisionRevision ?? -1 } : null,
      heldAction: pending?.status === 'held',
    });
    // The platform agent's weekly digest (weekly-digest.ts) may wake it on its own; it folds itself into `decision`.
    const digest = await weeklyDigestWake(ctx, agent, config, state, schedule, status, now, decision);
    // ...and so may its daily numbers post (platform-numbers.ts).
    const numbers = await platformNumbersWake(ctx, agent, config, state, schedule, status, now, decision);
    if (runtime.configRevision !== config.revision) await saveRuntime(ctx, agent.agentId, { configRevision: config.revision });
    if (!decision.run) {
      await postSocial(ctx, agent, config, runtime, runtime.status === 'held' ? 'awake' : 'awake');
      return { ran: false, reasons: decision.reasons };
    }

    // 4. Run (or resume) a turn.
    log.info({ reasons: decision.reasons, pendingReply: pendingReplyDue(views.map((v) => ({ postId: v.postId, status: 'pending', eligible: v.eligible, seenAt: null, deferredUntil: null })), now) }, 'waking');
    const market = await ctx.indexer.market(agent.token);
    let turn: TurnResult | null = null;
    try {
      turn = runtime.turn ? await continueTurn(ctx, agent, runtime, config, lease) : null;
      if (!turn) turn = await startTurn(ctx, agent, runtime, config, { reasons: decision.reasons, inbox, schedule, treasury, market, directory, digest, numbers }, lease);
    } catch (err) {
      const failures = (runtime.failures ?? 0) + 1;
      const { interruptionPlan } = await import('@bootr/agent-core');
      const plan = interruptionPlan(pending ? 1 : 0, failures, ctx.now());
      log.error({ err, failures, nextAt: plan.nextAt }, 'turn crashed; backing off');
      // Stored in the runtime row and shown in the console: never with a keyed URL in it.
      await saveRuntime(ctx, agent.agentId, { status: 'waiting', nextAt: new Date(plan.nextAt), failures, lastError: rpcErrorText(err) });
    }
    const fresh = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agent.agentId) });
    if (fresh) await postSocial(ctx, agent, config, fresh, 'awake');
    return { ran: true, reasons: decision.reasons, turn };
  } finally {
    await releaseLease(ctx, agent.agentId, lease);
  }
}

/** Closes `paid` / `unknown` service calls whose action is no longer pending (a crashed turn) from the chain; the pending one goes through `reconcilePending`. */
export async function reconcileServiceCalls(ctx: SupervisorContext, agent: AgentRow): Promise<void> {
  for (const row of await openServiceCalls(ctx, agent.agentId)) await reconcileServiceCall(ctx, row);
}

/** Settles a held/sent pending action from receipts (sender, treasury) without re-sending it. */
export async function reconcilePending(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow): Promise<RuntimeRow> {
  const pending = runtime.pending as unknown as PendingAction | null;
  if (!pending || (pending.status !== 'held' && pending.status !== 'sent')) return runtime;
  const resolution = await resolvePending(ctx, agent, pending);
  if (!resolution.resolved) return runtime;
  const settled = reconcile(pending, { actionId: pending.id, cycleKey: pending.cycleKey, outcome: resolution.outcome, ...(resolution.receipt ? { receipt: resolution.receipt } : {}) });
  await ctx.db
    .update(actions)
    .set({ status: settled.status, result: (settled.result as unknown as Record<string, unknown>) ?? null, receipt: (resolution.receipt as Record<string, unknown> | undefined) ?? null, updatedAt: new Date(ctx.now()) })
    .where(eq(actions.actionId, pending.id));
  const status = runtime.status === 'held' ? 'waiting' : runtime.status;
  ctx.log.info({ agentId: agent.agentId, actionId: pending.id, status: settled.status }, 'pending action reconciled');
  await saveRuntime(ctx, agent.agentId, { pending: settled as unknown as Record<string, unknown>, status, nextAt: new Date(ctx.now()) });
  return { ...runtime, pending: settled as unknown as Record<string, unknown>, status, nextAt: new Date(ctx.now()) };
}

export async function postsLast24h(ctx: SupervisorContext, agentId: string): Promise<{ count: number; lastPostAt: number | null }> {
  const since = new Date(ctx.now() - 24 * 3_600_000);
  const rows = await ctx.db
    .select({ action: actions.action, createdAt: actions.createdAt })
    .from(actions)
    .where(and(eq(actions.agentId, agentId), eq(actions.status, 'completed'), gt(actions.createdAt, since), inArray(actions.status, ['completed'])));
  const posts = rows.filter((r) => (r.action as { tool?: string }).tool === 'publish_post' || (r.action as { tool?: string }).tool === 'publish_reply');
  const last = posts.reduce<number | null>((m, r) => (m === null || r.createdAt.getTime() > m ? r.createdAt.getTime() : m), null);
  return { count: posts.length, lastPostAt: last };
}

/** When the agent's first ever post or reply went out (ms), from the completed actions it still has; null when it never posted. */
export async function firstPostAt(ctx: SupervisorContext, agentId: string): Promise<number | null> {
  const [row] = await ctx.db
    .select({ createdAt: actions.createdAt })
    .from(actions)
    .where(and(eq(actions.agentId, agentId), eq(actions.status, 'completed'), sql`${actions.action}->>'tool' in ('publish_post', 'publish_reply')`))
    .orderBy(asc(actions.createdAt))
    .limit(1);
  return row ? row.createdAt.getTime() : null;
}

async function postSocial(ctx: SupervisorContext, agent: AgentRow, config: { xHandle: string; model?: string }, runtime: RuntimeRow, status: 'awake' | 'sleeping' | 'paused'): Promise<void> {
  try {
    const [{ count, lastPostAt }, first] = await Promise.all([postsLast24h(ctx, agent.agentId), firstPostAt(ctx, agent.agentId)]);
    const state = runtime.state as unknown as AgentState;
    await ctx.indexer.postSocial(agent.kernel, {
      xHandle: config.xHandle,
      lastPostAt: state.lastPostAt ? Math.floor(state.lastPostAt / 1000) : lastPostAt ? Math.floor(lastPostAt / 1000) : null,
      // The indexer keeps the earliest value it ever saw, so pruned actions never move it later.
      firstPostAt: first ? Math.floor(first / 1000) : null,
      postsCount24h: count,
      status: runtime.status === 'paused' ? 'paused' : runtime.status === 'sleeping' ? 'sleeping' : status,
      spender: agent.spender ?? null,
      ...(config.model ? { model: config.model } : {}),
    });
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err }, 'social stats post failed');
  }
}

/**
 * `'nonce_bumped'` when the kernel's valid nonce passed the permission's install nonce (admin
 * `revokeAllSessionKeys`), `'uninstalled'` when the permission has no hook any more (`revokeSessionKey`),
 * `null` when the permission is live or the chain could not be read (never pause on a read error).
 */
export async function sessionKeyRevokedOnChain(ctx: SupervisorContext, kernel: Address, permissionId: Hex): Promise<'nonce_bumped' | 'uninstalled' | null> {
  try {
    const vId = validationId(permissionId);
    const [config, nonce] = await Promise.all([
      ctx.chain.publicClient.readContract({ address: kernel, abi: kernelAbi, functionName: 'validationConfig', args: [vId] }),
      ctx.chain.publicClient.readContract({ address: kernel, abi: kernelAbi, functionName: 'currentNonce' }),
    ]);
    if (config.hook === zeroAddress) return 'uninstalled';
    if (config.nonce < nonce) return 'nonce_bumped';
    return null;
  } catch {
    return null;
  }
}
