/**
 * Own agents (docs/design/byo-agent.md sections 2.2 and 13.9): the treasury role of a coin whose agent thinks in its
 * creator's own AI client. Everything here is the hosted treasury turn (roles.ts, runtime.ts `startTreasuryTurn`)
 * without the model call: the same clock, the same narrow observation, the same short tool list, the same `finish`.
 *
 * - `due` is `treasuryTurnDue`: the interval, a treasury note, a closed bounty job, a creator request, under the same
 *   gates (the turn is on for the coin, no turn stored, no action waiting for its receipt).
 * - `open` does what `startTreasuryTurn` does before its loop: the treasury snapshot, the market, the open requests,
 *   `roleTools(…, 'treasury')`, `buildTreasuryObservation`, and the three clock stamps, so a client that opens a turn
 *   and walks away does not get a fresh one every time it asks.
 * - `finish` is `roles.treasuryFinish`, the faithful copy of the hosted finish branch; the runtime's own wake (the
 *   social schedule) is never moved by a treasury turn.
 * - `abandoned` is what the hosted loop does for a treasury turn it cuts short: the social state is left alone and the
 *   treasury clock stays at least one interval away.
 *
 * What keeps the money side narrow is the tool list, as for the hosted agent: this turn holds `treasury_read`,
 * `treasury_prepare`, `treasury_execute`, `remember` and, with the Bounties power, the three bounty tools; never a
 * tool that reads or writes X. The observation never carries a mention, a page, a search result or a post. What the
 * server cannot do is keep the client's own context clean between turns (section 10).
 */
import { PolicyError, buildSystemPrompt } from '@bootr/agent-core';
import type { DueRole, FinishRequest } from '@bootr/shared/own-agent';
import { openRequests, requestTools, type TurnRequest } from '../creator-requests.js';
import { buildTreasuryObservation, pendingTreasuryNotes, roleTools, treasuryFinish, treasuryTurnDue, treasuryTurnOn, type TreasuryWakeReason } from '../roles.js';
import type { Turn } from '../runtime.js';
import { readTreasuryOnChain } from '../treasury.js';
import { ownSetting, type OwnCall, type OwnOpened, type OwnRoleHandler } from './registry.js';

const iso = (ms: number | null | undefined): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * The runtime as `treasuryTurnDue` should see it for an own coin. The hosted gate wants the runtime `waiting`: a
 * hosted agent gets there after its first thought, and `sleeping` is the fuel rule. Neither exists for an own coin
 * (nothing thinks on the server, and it never sleeps for fuel), so a runtime left `ready` or `sleeping` counts as
 * waiting here. `running` (a turn is open), `held` and `paused` stop the turn as they stop the hosted one.
 */
function gateStatus(status: OwnCall['runtime']['status']): OwnCall['runtime']['status'] {
  return status === 'ready' || status === 'sleeping' ? 'waiting' : status;
}

export const treasuryRole: OwnRoleHandler = {
  role: 'treasury',

  async due(call: OwnCall): Promise<DueRole> {
    const { ctx, agent, runtime, state, now } = call;
    const on = treasuryTurnOn(agent.config);
    if (!on) return { on: false, due: false, reasons: [], nextAt: null };
    const wake = await treasuryTurnDue(ctx, agent, { status: gateStatus(runtime.status), turn: runtime.turn, pending: runtime.pending }, state, now);
    // Absent = due as soon as the turn is on (roles.ts): the clock's own answer is "now".
    return { on: true, due: !!wake, reasons: wake?.reasons ?? [], nextAt: iso(state.treasuryNextAt ?? now) };
  },

  async open(call: OwnCall, opts: { reasons: string[]; forced: boolean; jobId?: string }): Promise<OwnOpened> {
    const { ctx, agent, config, state, now } = call;
    // A turn outside the schedule (`creator_asked`) is a social turn by definition: the treasury keeps its own clock.
    if (opts.forced) throw new PolicyError('not_due', { message: 'not_due: a treasury turn opens on its own clock only' });
    const [treasury, market, requests, notes] = await Promise.all([
      readTreasuryOnChain(ctx, agent).catch((err: unknown) => {
        ctx.log.warn({ agentId: agent.agentId, role: 'treasury', err }, 'own agent: treasury read failed; the turn opens without balances');
        return null;
      }),
      ctx.indexer.market(agent.token).catch(() => null),
      openRequests(ctx, agent.agentId, 'treasury').catch(() => []),
      pendingTreasuryNotes(ctx, agent.agentId, state.lastTreasuryNoteSeenAt ?? 0).catch(() => []),
    ]);
    const turnRequests: TurnRequest[] = requests.map((r) => ({ id: r.id, picture: r.picture }));
    const catalog = roleTools(ctx, config, agent.config, 'treasury');
    // The observation names the tools as the hosted turn's does, `answer_request` included while a request is open.
    const shown = [...catalog, ...requestTools({ creatorRequests: turnRequests })];
    const observation = await buildTreasuryObservation(ctx, agent, config, state, { reasons: opts.reasons as TreasuryWakeReason[], treasury, market, notes, requests }, shown, ownSetting(ctx, 'OWN_OBSERVATION_BYTES'));
    if (requests.length) ctx.log.info({ agentId: agent.agentId, role: 'treasury', requests: requests.map((r) => r.id) }, 'creator requests shown');
    // The clock is stamped as the turn opens, like the hosted one before its first thought; the notes shown count as seen from here.
    state.lastTreasuryTurnAt = now;
    state.treasuryNextAt = now + ctx.config.TREASURY_TURN_INTERVAL_MS;
    state.lastTreasuryNoteSeenAt = now;
    const turn: Turn = {
      role: 'treasury',
      startedAt: now,
      steps: 0,
      nudged: false,
      reasons: opts.reasons,
      premium: null,
      // The client holds the conversation; the brief and the observation are handed over, not stored.
      messages: [],
      inbox: {},
      eligibility: {},
      recentSteps: [],
      routing: null,
      ...(turnRequests.length ? { creatorRequests: turnRequests } : {}),
    };
    return { turn, brief: buildSystemPrompt(config, 'treasury'), observation, tools: treasuryToolNames(catalog) };
  },

  async finish(call: OwnCall, _turn: Turn, input: FinishRequest): Promise<{ result: Record<string, unknown>; nextAt?: number }> {
    const { ctx, agent, config, state, now } = call;
    const { memory, agenda, summary, nextAt } = input;
    const done = treasuryFinish(ctx, agent, config, state, { memory, agenda, summary, nextAt }, now);
    // What the hosted loop does as it ends a treasury turn (`treasuryEnd`): the next one is an interval away at the earliest.
    state.treasuryNextAt = Math.max(state.treasuryNextAt ?? 0, now + ctx.config.TREASURY_TURN_INTERVAL_MS);
    // No `nextAt`: the runtime's wake is the social schedule and a treasury turn never moves it.
    return { result: done.result };
  },

  async abandoned(call: OwnCall, _turn: Turn, why: string): Promise<void> {
    const { ctx, agent, state, now } = call;
    // A treasury turn cut short leaves the social state alone: no continuation, no early wake; only its own clock moves.
    state.treasuryNextAt = Math.max(state.treasuryNextAt ?? 0, now + ctx.config.TREASURY_TURN_INTERVAL_MS);
    ctx.log.info({ agentId: agent.agentId, role: 'treasury', why }, 'own agent: treasury turn ended without a finish');
  },
};

/** The agent-core tools a treasury turn may call, by name; `finish` is the engine's own call and is not among them. */
export function treasuryToolNames(catalog: readonly { name: string }[]): string[] {
  return catalog.map((t) => t.name).filter((name) => name !== 'finish');
}
