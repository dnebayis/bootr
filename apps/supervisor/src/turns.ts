/**
 * `sv_turns`: one row per finished turn (docs/design/agent-behaviour.md section 5). The weekly behaviour check
 * (scripts/behaviour-check.ts) reads it for "turns that end without a post" (M5) and "fuel per published post" (M6);
 * nothing in the runtime reads it back, so a row that cannot be written costs a measurement and never a turn.
 *
 * A row is written when a turn is dropped from the runtime row, in whatever way it ended: a `finish`, the step cap, a
 * held action, an inference failure, a provider outage, or (own agents) the server closing a turn the client left
 * open. A turn that is kept to be resumed (a treasury turn waiting on its action, a turn holding a paid-for answer) is
 * not finished and gets no row until it is.
 *
 * What it counts comes from the turn itself: its wake reasons, its thoughts (`steps`: one model call each for a hosted
 * turn, one tool call each for an own agent's, whose thinking happens in the creator's client), and the publishes among
 * its steps (`recentSteps`, which holds every step of the turn; a publish queued for the creator's review counts, since
 * the agent decided to post). The charge is summed from `sv_inference` over the turn's window (inference.ts
 * `chargedBetween`). A publish whose outcome was still unknown when its turn was dropped is not counted here: the check
 * reads the posts themselves from `sv_actions`.
 */
import type { AgentRole } from '@bootr/agent-core';
import type { SupervisorContext } from './context.js';
import { turns } from './db/schema.js';
import { chargedBetween } from './inference.js';
import { rpcErrorText } from './log.js';
import type { Turn } from './runtime.js';

export type TurnRow = typeof turns.$inferSelect;

/** The id of a turn's row: the turn's own id for an own agent's, else agent, role and start (one turn runs at a time per agent). */
export function turnRowId(agentId: string, turn: Pick<Turn, 'role' | 'startedAt' | 'own'>): string {
  return turn.own?.turnId ?? `${agentId}:${roleOf(turn)}:${turn.startedAt}`;
}

function roleOf(turn: Pick<Turn, 'role'>): AgentRole {
  return turn.role === 'treasury' || turn.role === 'judge' ? turn.role : 'social';
}

/** How many steps of the turn were a completed call of `tool`. */
function completed(turn: Pick<Turn, 'recentSteps'>, tool: string): number {
  return (turn.recentSteps ?? []).filter((s) => s.tool === tool && s.status === 'completed').length;
}

/**
 * Writes the row of a turn that just ended as `outcome`. Never throws. Written again for the same turn (a crash
 * between the row and the runtime write), the later figures replace the earlier ones.
 */
export async function recordTurn(ctx: Pick<SupervisorContext, 'db' | 'now' | 'log'>, agentId: string, turn: Turn | null | undefined, outcome: string): Promise<void> {
  if (!turn || typeof turn.startedAt !== 'number' || !Number.isFinite(turn.startedAt)) return;
  try {
    const startedAt = new Date(turn.startedAt);
    const endedAt = new Date(Math.max(ctx.now(), turn.startedAt));
    // What a second write of the same turn replaces: everything but who it is and when it began.
    const figures = {
      role: roleOf(turn),
      via: turn.own ? 'own' : null,
      wakeReasons: Array.isArray(turn.reasons) ? turn.reasons.filter((r): r is string => typeof r === 'string').slice(0, 32) : [],
      endedAt,
      thoughts: Number.isFinite(turn.steps) ? Math.max(0, Math.floor(turn.steps)) : 0,
      outcome: outcome.slice(0, 64),
      posted: completed(turn, 'publish_post'),
      replied: completed(turn, 'publish_reply'),
      chargedMicroUsdc: await chargedBetween(ctx, agentId, startedAt, endedAt),
    };
    await ctx.db.insert(turns).values({ id: turnRowId(agentId, turn), agentId, startedAt, ...figures }).onConflictDoUpdate({ target: turns.id, set: figures });
  } catch (err) {
    ctx.log.warn({ agentId, outcome, err: rpcErrorText(err) }, 'the finished turn could not be put on record (sv_turns); the turn itself is unaffected');
  }
}
