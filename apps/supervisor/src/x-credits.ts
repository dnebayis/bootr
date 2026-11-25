/**
 * The app-wide X credits hold, as the supervisor sees it.
 *
 * Every agent posts and reads through one X app, and that app pays X per call from one balance of credits. When the
 * balance is used up X answers 402 to everything. Until 2026-11-25 each agent learned that on its own: a publish that
 * came back 402 held that one agent for 30 minutes (`AgentState.postCreditsUntil`), after which it bought a whole
 * turn to try again, and a mention read that came back 402 held one tick. In a 3.5 hour outage that was seven turns
 * bought for posts X refused ($1.72) and about 600 warn lines with a stack trace each.
 *
 * The sender now holds every X call itself after a 402 (apps/sender/src/x-client.ts: 30 minutes, doubling to 4 hours
 * while X keeps refusing, cleared by the first success) and says so at `GET /internal/x-credits`. This module reads
 * that once per tick (`refreshXCredits`) and answers one question for the tick: may a turn be bought for an agent
 * that uses X (`xCreditsGate`)?
 *
 * - `clear`: yes.
 * - `held`: no. The mention read is not made either (the sender would answer it without asking X).
 * - `probing` (the sender's hold ran out and nothing has succeeded since): the tick makes the agent's mention read,
 *   which is the cheap way to ask X, reads the sender's state again, and buys a turn only if it is clear. Should no
 *   read settle it within `PROBE_GRACE_MS` (no agent reads mentions, or every read is throttled), a turn is allowed
 *   once: its publish is then the question, and a 402 puts the hold back for twice as long.
 *
 * A 402 the supervisor sees itself (a mention read, a publish receipt) sets the hold at once (`noteXCredits402`), so
 * the agents after it in the same tick buy nothing; the next refresh takes the sender's word. With a sender that has
 * no such route (an older one) only these notes exist: the hold then lasts `X_CREDITS_RETRY_MS` from the last 402.
 *
 * The log says it once per hold, at warn, in one line with no stack: when a hold starts or is put back, and at info
 * when it is over.
 */
import type { SupervisorContext } from './context.js';
import { X_CREDITS_RETRY_MS } from './rhythm.js';

export type XCreditsState = 'clear' | 'held' | 'probing';

export interface XCreditsView {
  state: XCreditsState;
  /** Epoch ms of the first 402 of this run of holds; null when clear. */
  since: number | null;
  /** Epoch ms the current (or last) hold ends; null when clear. */
  until: number | null;
}

/** After a hold runs out, how long the tick waits for a mention read to settle it before one turn is allowed to. */
export const PROBE_GRACE_MS = 10 * 60_000;

interface Memo {
  view: XCreditsView;
  /** Where the view came from: the sender's route, or a 402 this process saw. */
  source: 'sender' | 'local';
}

const CLEAR: XCreditsView = { state: 'clear', since: null, until: null };
/** One per sender client (one per process; one per world in the tests). */
const memos = new WeakMap<object, Memo>();

function memoOf(ctx: Pick<SupervisorContext, 'sender'>): Memo {
  let m = memos.get(ctx.sender);
  if (!m) {
    m = { view: CLEAR, source: 'local' };
    memos.set(ctx.sender, m);
  }
  return m;
}

/** Takes a new view and writes the one log line a change of state deserves. */
function adopt(ctx: Pick<SupervisorContext, 'sender' | 'log' | 'now'>, next: XCreditsView, source: Memo['source']): void {
  const m = memoOf(ctx);
  const prev = m.view;
  m.view = next;
  m.source = source;
  if (next.state === 'held' && prev.state !== 'held') {
    ctx.log.warn({ until: iso(next.until), since: iso(next.since), again: prev.state === 'probing', source }, 'X credits used up (402): no turn is bought and no mention is read for an agent that uses X until the hold ends');
  } else if (next.state === 'clear' && prev.state !== 'clear') {
    ctx.log.info({ since: iso(prev.since), heldMinutes: prev.since ? Math.round((ctx.now() - prev.since) / 60_000) : null }, 'X credits are back: the hold is over');
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const ms = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(t) ? t : null;
};

/** A local view whose time has passed is over: without the sender's word there is no `probing`. */
function settleLocal(ctx: Pick<SupervisorContext, 'sender' | 'log' | 'now'>): void {
  const m = memoOf(ctx);
  if (m.source === 'local' && m.view.state === 'held' && (m.view.until ?? 0) <= ctx.now()) adopt(ctx, CLEAR, 'local');
}

/**
 * Reads the sender's hold (one internal request, no X call). Called once at the start of a tick, and again after a
 * mention read made while the state was `probing`. A sender that cannot be asked leaves the last view standing.
 */
export async function refreshXCredits(ctx: Pick<SupervisorContext, 'sender' | 'log' | 'now'>): Promise<XCreditsView> {
  try {
    const s = await ctx.sender.xCredits();
    const state: XCreditsState = s.state === 'held' || s.state === 'probing' ? s.state : 'clear';
    const until = ms(s.until);
    // A hold with no end is not one this module can wait out: read as clear rather than hold every agent for good.
    adopt(ctx, state === 'clear' || until === null ? CLEAR : { state, since: ms(s.since) ?? until, until }, 'sender');
  } catch {
    settleLocal(ctx);
  }
  return memoOf(ctx).view;
}

/** X answered 402 to something this process asked for (a mention read, a publish): the hold is on from this moment. */
export function noteXCredits402(ctx: Pick<SupervisorContext, 'sender' | 'log' | 'now'>, retryAt?: number | null): void {
  const m = memoOf(ctx);
  const now = ctx.now();
  const until = retryAt && Number.isFinite(retryAt) && retryAt > now ? retryAt : now + X_CREDITS_RETRY_MS;
  if (m.view.state === 'held' && (m.view.until ?? 0) >= until) return;
  adopt(ctx, { state: 'held', since: m.view.since ?? now, until }, m.view.state === 'held' ? m.source : 'local');
}

export interface XCreditsGate {
  /** True: buy nothing for an agent that uses X on this tick. */
  held: boolean;
  state: XCreditsState;
  until: number | null;
}

/** Whether the hold stands at `now`, from the last view (no request). */
export function xCreditsGate(ctx: Pick<SupervisorContext, 'sender' | 'log' | 'now'>, now: number = ctx.now()): XCreditsGate {
  settleLocal(ctx);
  const { state, until } = memoOf(ctx).view;
  if (state === 'clear') return { held: false, state, until: null };
  // A hold whose end passed since the last refresh is the sender's `probing` by now.
  if (state === 'held' && (until ?? 0) > now) return { held: true, state, until };
  return { held: now - (until ?? now) < PROBE_GRACE_MS, state: 'probing', until };
}

/** Test hook: forget the view of this context's sender. */
export function resetXCredits(ctx: Pick<SupervisorContext, 'sender'>): void {
  memos.delete(ctx.sender);
}
