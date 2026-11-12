/**
 * Own agents (docs/design/byo-agent.md sections 5.3 and 13.9): moving a coin between "My own agent" and "Bootr agent".
 * One write to the stored config (`runner`, and `model` when the creator picked one), made under the runtime lease so
 * it never lands inside a step: the tick and the own-agent engine both work under that lease, so while this holds it
 * no hosted thought is being bought and no own tool call is being run.
 *
 * What it carries over and what it ends:
 *   - to the Bootr agent: the open own turn is closed like a cut-short turn (`ownHooks.closeTurn`); an action that was
 *     sent or is held stays in `sv_runtimes.pending` and settles from its receipt before any hosted turn (tick.ts);
 *   - to the creator's own client: a hosted turn stored between steps is dropped with a continuation note; a thought
 *     that was paid for and whose answer is unknown is reconciled first, and stays on the state when the relay still
 *     cannot say, so a later switch back reads that answer and never buys it again;
 *   - memory, checkpoint, notes, post history, X holds, quotas, approvals, open creator requests and bounty jobs are
 *     rows this never touches.
 *
 * The flag (`ownEnabled`) is asked for one thing only: a switch to own. A switch to the Bootr agent always works.
 */
import { randomUUID } from 'node:crypto';
import { boundedState, directModelId } from '@bootr/agent-core';
import { OWN_ERRORS, RUNNERS, runnerOf, type OwnErrorBody, type OwnErrorCode, type Runner, type RunnerSwitchResponse } from '@bootr/shared/own-agent';
import { eq } from 'drizzle-orm';
import { erc20Abi, getAddress, isAddressEqual, type Address } from 'viem';
import type { AgentRow, RuntimeRow, SupervisorContext } from '../context.js';
import { actions, agents, runtimes } from '../db/schema.js';
import { SLEEP_USDC } from '../fuel.js';
import { reconcileInference } from '../inference.js';
import { settlePlatformNumbers } from '../platform-numbers.js';
import { acquireLease, releaseLease, saveRuntime, trimState, type AgentState, type Turn } from '../runtime.js';
import { settleWeeklyDigest } from '../weekly-digest.js';
import { ownEnabled, ownHooks } from './registry.js';

/** How long a switch waits for the step in progress to finish before it answers `supervisor_unavailable`. */
export const SWITCH_LEASE_WAIT_MS = 10_000;
const SWITCH_LEASE_POLL_MS = 250;
const MAX_MODEL_CHARS = 128;

export interface RunnerSwitchInput {
  runner?: unknown;
  /** Switching to `hosted`: the model the Bootr agent thinks with; needed when the stored one is not offered. */
  model?: unknown;
  /** The signer the web verified; checked against the stored creator here. */
  by?: unknown;
  /** The models offered right now (the catalog under the admin allow-list), as the web reads them. */
  allowedModels?: unknown;
}

export type RunnerSwitchResult = { ok: true; response: RunnerSwitchResponse } | { ok: false; status: number; body: OwnErrorBody };

function refuse(error: OwnErrorCode, extra: Partial<Pick<OwnErrorBody, 'field' | 'retryAt'>> & { detail?: string } = {}): RunnerSwitchResult {
  const { detail, ...rest } = extra;
  return { ok: false, status: OWN_ERRORS[error].status, body: { error, message: detail ? `${OWN_ERRORS[error].message} ${detail}` : OWN_ERRORS[error].message, ...rest } };
}

/** Two ids that name the same model: equal, or the same catalog entry under an older name. */
function sameModel(a: string, b: string): boolean {
  return a === b || (directModelId(a) ?? a) === (directModelId(b) ?? b);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The runtime lease, tried again until `waitMs` of real time has passed; null when the step in progress outlasted it. */
async function leaseWithin(ctx: SupervisorContext, agentId: string, token: string, waitMs: number, pollMs: number): Promise<RuntimeRow | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const row = await acquireLease(ctx, agentId, token);
    if (row) return row;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/** Kernel and spender USDC together, in whole USDC; null when the chain did not answer. */
async function fuelUsdc(ctx: SupervisorContext, agent: AgentRow): Promise<number | null> {
  const balanceOf = (account: Address) => ({ address: ctx.chain.addresses.usdc, abi: erc20Abi, functionName: 'balanceOf' as const, args: [account] as const });
  try {
    const balances = await ctx.chain.publicClient.multicall({ contracts: [balanceOf(agent.kernel as Address), balanceOf(ctx.spenderFor(agent).address)], allowFailure: true });
    let total = 0n;
    for (const r of balances) {
      if (r.status !== 'success') throw r.error;
      total += r.result;
    }
    return Number(total) / 1e6;
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err }, 'runner switch: fuel read failed');
    return null;
  }
}

function usdcText(amount: number): string {
  return amount.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/** What the creator should know after the switch, in plain words (section 5.3). */
export function switchNotes(runner: Runner, facts: { fuelUsdc: number | null; clients: number }): string[] {
  if (runner === 'hosted') {
    return [
      facts.fuelUsdc === null
        ? `The Bootr agent pays for its thinking from fuel; under ${SLEEP_USDC} USDC it stays silent.`
        : `The Bootr agent pays for its thinking from fuel. This coin holds ${usdcText(facts.fuelUsdc)} USDC; under ${SLEEP_USDC} USDC it stays silent.`,
      'Pictures are made by Bootr again and paid from fuel.',
    ];
  }
  return facts.clients > 0 ? [] : ['Connect an AI client, or the agent stays silent.'];
}

/**
 * Ends a stored turn without a checkpoint, the way the runtime's own `forceFinish` does: a social turn leaves a
 * continuation note and closes the digest or numbers post it carried; a treasury or judge turn leaves the social
 * state alone. The pending action, if any, is not touched: it settles from its receipt.
 */
function dropTurn(state: AgentState, turn: Turn, why: string): void {
  if ((turn.role ?? 'social') !== 'social') return;
  settleWeeklyDigest(state, turn);
  settlePlatformNumbers(state, turn);
  state.continuation = { progress: `Turn ended by the runtime (${why}). Continue from the agenda.`, recentSteps: (turn.recentSteps ?? []).slice(-6) };
}

/**
 * The status a runtime rests in once its turn is gone: a pause, a held action and a runtime that never started keep
 * what they have; a turn in flight (`running`) and the hosted sleep (`sleeping`) become `waiting`, or `held` while a
 * sent action still waits for its receipt.
 */
function restingStatus(runtime: RuntimeRow): RuntimeRow['status'] {
  if (runtime.status !== 'running' && runtime.status !== 'sleeping') return runtime.status;
  return (runtime.pending as { status?: string } | null)?.status === 'held' ? 'held' : 'waiting';
}

export async function switchRunner(ctx: SupervisorContext, agent: AgentRow, input: RunnerSwitchInput, opts: { leaseWaitMs?: number; leasePollMs?: number } = {}): Promise<RunnerSwitchResult> {
  // Who: the stored creator, as the config route checks it (the web verified the signature; `by` is the signer).
  let by: Address;
  try {
    by = getAddress(String(input.by ?? ''));
  } catch {
    return refuse('invalid_request', { field: 'by', detail: '`by` must be the creator address.' });
  }
  if (!isAddressEqual(by, agent.creator as Address)) return refuse('not_creator');
  if (typeof input.runner !== 'string' || !(RUNNERS as readonly string[]).includes(input.runner)) return refuse('invalid_request', { field: 'runner', detail: 'runner must be hosted or own.' });
  const runner = input.runner as Runner;
  if (runnerOf(agent.config) === runner) return refuse('runner_unchanged');

  // The one place the flag is asked: a coin may not become own while the feature is off. Leaving own is never refused.
  if (runner === 'own' && !ownEnabled(ctx)) return refuse('own_agent_disabled');

  // To the Bootr agent: a model it can think with. The stored one is kept when it is still offered.
  let model: string | null = null;
  if (runner === 'hosted') {
    const allowed = Array.isArray(input.allowedModels) ? input.allowedModels.filter((m): m is string => typeof m === 'string') : [];
    if (input.model !== undefined && input.model !== null) {
      const asked = typeof input.model === 'string' ? input.model.trim() : '';
      if (!asked || asked.length > MAX_MODEL_CHARS || !allowed.includes(asked)) return refuse('model_not_allowed');
      model = asked;
    } else {
      const stored = typeof agent.config.model === 'string' ? agent.config.model : '';
      if (!stored || !allowed.some((m) => sameModel(m, stored))) return refuse('model_required');
    }
  }

  // Read before the lease is taken, so the lease is never held across an RPC call that only words a note.
  const fuel = runner === 'hosted' ? await fuelUsdc(ctx, agent) : null;

  const lease = `runner-switch:${randomUUID()}`;
  const leased = await leaseWithin(ctx, agent.agentId, lease, opts.leaseWaitMs ?? SWITCH_LEASE_WAIT_MS, opts.leasePollMs ?? SWITCH_LEASE_POLL_MS);
  if (!leased) return refuse('supervisor_unavailable');
  try {
    // Under the lease nothing else writes this agent: read it again and decide on what is stored now.
    const current = (await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, agent.agentId) })) ?? agent;
    if (runnerOf(current.config) === runner) return refuse('runner_unchanged');
    const log = ctx.log.child({ agentId: agent.agentId });

    if (runner === 'hosted') {
      // The open own turn ends like a cut-short turn. Its sent or held action stays pending and settles from its receipt.
      const closed = await ownHooks.closeTurn(ctx, agent.agentId, 'runner_switched');
      const runtime = (await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agent.agentId) })) ?? leased;
      const turn = runtime.turn as unknown as Turn | null;
      if (turn && (turn as { own?: unknown }).own) {
        // The engine did not close it (its hooks are not mounted in this process): a hosted loop must never be handed
        // a turn whose conversation lives in a client, so it is cut short here.
        const state = { ...(runtime.state as unknown as AgentState) };
        dropTurn(state, turn, 'the agent was switched to the Bootr agent');
        const status = restingStatus(runtime);
        await saveRuntime(ctx, agent.agentId, { state: boundedState(trimState(state)) as unknown as Record<string, unknown>, turn: null, status, ...(status === 'paused' ? {} : { nextAt: new Date(ctx.now()) }) });
        log.warn({ closedByEngine: closed }, 'runner switch: an own turn was still stored and was cut short');
      } else if (runtime.status !== 'paused') {
        // The tick looks at the coin on its next pass: the sleep rule, a held action's receipt, then a turn.
        await saveRuntime(ctx, agent.agentId, { nextAt: new Date(ctx.now()) });
      }
    } else {
      const runtime = leased;
      const state = { ...(runtime.state as unknown as AgentState) };
      // A thought already paid whose answer is unknown: asked for once more, never bought again. An answer that
      // arrives is not used (at most one paid thought); while the relay cannot say, the key stays for a switch back.
      if (state.inferenceKey) {
        const res = await reconcileInference(ctx, state.inferenceKey).catch((err: unknown) => ({ kind: 'unknown' as const, error: err instanceof Error ? err.message : String(err) }));
        log.info({ key: state.inferenceKey, outcome: res.kind }, 'runner switch: paid thought reconciled');
        if (res.kind === 'ok' || res.kind === 'failed') state.inferenceKey = null;
      }
      const turn = runtime.turn as unknown as Turn | null;
      if (turn) dropTurn(state, turn, "the agent was switched to its creator's own AI client");
      // An own coin never sleeps for fuel; a pause or a held action stays what it is.
      const status = restingStatus(runtime);
      await saveRuntime(ctx, agent.agentId, { state: boundedState(trimState(state)) as unknown as Record<string, unknown>, turn: null, status, ...(status === 'paused' ? {} : { nextAt: new Date(ctx.now()) }) });
    }

    const revision = (typeof current.config.revision === 'number' ? current.config.revision : 0) + 1;
    const config: Record<string, unknown> = { ...current.config, runner, ...(model ? { model } : {}), revision };
    const now = new Date(ctx.now());
    await ctx.db.update(agents).set({ config, updatedAt: now }).where(eq(agents.agentId, agent.agentId));
    await ctx.db
      .insert(actions)
      .values({
        actionId: `config-${agent.agentId}-r${revision}`,
        agentId: agent.agentId,
        cycleKey: `config:${revision}`,
        action: { kind: 'config_updated', fields: ['runner'], by, revision, runner },
        status: 'completed',
        result: null,
        receipt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    // The sender's X read budget follows the runner. A sender that does not answer does not undo the switch.
    await ownHooks.applyRunnerQuota(ctx, agent.agentId, runner).catch((err: unknown) => log.warn({ err, runner }, 'runner switch: the X read budget could not be set'));
    const clients = runner === 'own' ? await ownHooks.countClients(ctx, agent.agentId).catch(() => 0) : 0;
    log.info({ by, runner, revision, ...(model ? { model } : {}) }, 'agent runner switched by the creator');
    return { ok: true, response: { runner, revision, notes: switchNotes(runner, { fuelUsdc: fuel, clients }) } };
  } finally {
    await releaseLease(ctx, agent.agentId, lease);
  }
}
