/**
 * Scheduled posts (docs/design/agent-tools-2.md sections 5 and 17): what the tests of this piece share. A tool call
 * made the way the broker makes one, a stand-in for the posting workstream's `sendOriginal` that behaves like the
 * sender (one write per action id, a stored receipt for a repeat), and coins beside the test agent.
 */
import { parseAction, type ActionOutcome, type PendingAction } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { executeAction, type BrokerEnv } from '../src/broker/index.js';
import type { AgentRow } from '../src/context.js';
import { actions, agents, runtimes, scheduledPosts } from '../src/db/schema.js';
import { agentConfigOf } from '../src/onboarding.js';
import { setPostHooks, type OriginalPost } from '../src/post-send.js';
import { initialState, type AgentState } from '../src/runtime.js';
import type { ScheduledRow } from '../src/scheduled.js';
import { AGENT_ID, agentConfig, CREATOR, type TestWorld } from './helpers.js';

export const MIN = 60_000;
export const HOUR = 3_600_000;
/** The test agent's post interval (helpers.ts `agentConfig`). */
export const INTERVAL = 2 * HOUR;

export const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;

export async function agentRow(w: TestWorld, agentId: string = AGENT_ID): Promise<AgentRow> {
  return (await w.db.query.agents.findFirst({ where: eq(agents.agentId, agentId) }))!;
}

export async function rowsOf(w: TestWorld, agentId: string = AGENT_ID): Promise<ScheduledRow[]> {
  return (await w.db.select().from(scheduledPosts).where(eq(scheduledPosts.agentId, agentId))).sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
}

export async function rowOf(w: TestWorld, id: string): Promise<ScheduledRow> {
  return (await w.db.query.scheduledPosts.findFirst({ where: eq(scheduledPosts.id, id) }))!;
}

export async function stateOf(w: TestWorld, agentId: string = AGENT_ID): Promise<AgentState> {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agentId) }))!.state as unknown as AgentState;
}

export async function patchState(w: TestWorld, patch: Partial<AgentState>, agentId: string = AGENT_ID): Promise<void> {
  await w.db.update(runtimes).set({ state: { ...(await stateOf(w, agentId)), ...patch } as unknown as Record<string, unknown> }).where(eq(runtimes.agentId, agentId));
}

export async function patchConfig(w: TestWorld, patch: Record<string, unknown>, agentId: string = AGENT_ID): Promise<void> {
  const agent = await agentRow(w, agentId);
  await w.db.update(agents).set({ config: { ...agent.config, ...patch } }).where(eq(agents.agentId, agentId));
}

/**
 * One tool call of the agent, bound and run the way a turn's step is: the action row first, then the broker. `actionId`
 * repeats a call (a resumed step, a client's retry). The agent row is read fresh, so a config change counts.
 */
export async function callTool(w: TestWorld, tool: string, input: Record<string, unknown>, opts: { agentId?: string; actionId?: string; env?: Partial<BrokerEnv> } = {}): Promise<ActionOutcome & { actionId: string }> {
  const agent = await agentRow(w, opts.agentId);
  const config = agentConfigOf(agent)!;
  const id = opts.actionId ?? `act_sched_${++seq}`;
  const action = parseAction({ tool, input });
  const now = new Date(w.ctx.now());
  const pending = { id, cycleKey: `cycle:${id}`, action, status: 'sent', createdAt: w.ctx.now(), attempts: 1 } as PendingAction;
  await w.db.insert(actions).values({ actionId: id, agentId: agent.agentId, cycleKey: pending.cycleKey, action: action as unknown as Record<string, unknown>, status: 'sending', createdAt: now, updatedAt: now }).onConflictDoNothing();
  const outcome = await executeAction(w.ctx, agent, config, pending, { inbox: new Map(), eligibility: new Map(), ...(opts.env ?? {}) });
  await w.db.update(actions).set({ status: outcome.kind === 'completed' ? 'completed' : 'failed', result: outcome.kind === 'completed' ? { actionId: id, tool, status: 'completed', result: outcome.result as Record<string, unknown> } : { actionId: id, tool, status: 'failed', error: (outcome as { error?: string }).error } }).where(eq(actions.actionId, id));
  return { ...outcome, actionId: id };
}

export const errorOf = (outcome: ActionOutcome): string => (outcome.kind === 'completed' ? '' : outcome.error);
export const resultOf = <T = Record<string, unknown>>(outcome: ActionOutcome): T => (outcome.kind === 'completed' ? (outcome.result as T) : ({} as T));

/** Schedules a post and returns its id; throws with the refusal when it is not taken. */
export async function schedule(w: TestWorld, text: string, sendAt: number, opts: Parameters<typeof callTool>[3] & { more?: Record<string, unknown> } = {}): Promise<string> {
  const { more, ...rest } = opts;
  const outcome = await callTool(w, 'schedule_post', { text, sendAt: iso(sendAt), ...(more ?? {}) }, rest);
  if (outcome.kind !== 'completed') throw new Error(`schedule_post refused: ${errorOf(outcome)}`);
  return resultOf<{ scheduledId: string }>(outcome).scheduledId;
}

/** A completed original on the record, as the runtime leaves one: the action row and, when asked, the cadence anchor. */
export async function seedPost(w: TestWorld, at: number, text: string, opts: { agentId?: string; anchor?: boolean; thread?: string[] } = {}): Promise<void> {
  const agentId = opts.agentId ?? AGENT_ID;
  const id = `act_seed_${++seq}`;
  await w.db.insert(actions).values({ actionId: id, agentId, cycleKey: `seed:${id}`, action: { tool: 'publish_post', input: { text, ...(opts.thread ? { thread: opts.thread.map((t) => ({ text: t })) } : {}) } }, status: 'completed', result: { actionId: id, tool: 'publish_post', status: 'completed', result: { postId: String(5000 + seq) } }, createdAt: new Date(at), updatedAt: new Date(at) });
  if (opts.anchor !== false) await patchState(w, { lastPostAt: at }, agentId);
}

export interface FakeSend {
  /** Every call of the hook, in order. */
  calls: OriginalPost[];
  /** The action ids that reached X: one entry per real write, whatever the number of calls. */
  written: string[];
  /** What the next call that reaches the sender does. `sent`: X takes it. `unknown`: the sender holds it. `lost`: the process dies before the sender sees it (the hook throws). `crash_after`: X takes it and the answer is lost. Or a refusal's error text. */
  next: 'sent' | 'unknown' | 'lost' | 'crash_after' | { error: string; retryAt?: number };
  /** Parts of a thread X takes before the send is cut (default: all). */
  cutAfter?: number;
}

/**
 * Stands in for the posting workstream's `sendOriginal` (post-send.ts) against the world's mock sender: the sender's
 * row is written before X is "contacted", a repeated action id is answered from its stored receipt, and a refusal by X
 * is final for that id. Registered for the calling test file; `reset()` puts the defaults back.
 */
export function fakeSend(w: TestWorld): FakeSend {
  const fake: FakeSend = { calls: [], written: [], next: 'sent' };
  let n = 0;
  setPostHooks({
    sendOriginal: async (_ctx, _agent, post) => {
      fake.calls.push(post);
      const stored = w.sender.receipts[post.actionId];
      if (stored) {
        if (stored.status === 'sent') return { kind: 'completed', result: { postId: stored.providerPostId } };
        if (stored.status === 'rejected') return { kind: 'failed', error: `sender_rejected:${stored.error ?? 'rejected'}` };
        return { kind: 'unknown', error: `sender_${stored.status}` };
      }
      const mode = fake.next;
      if (mode === 'lost') throw new Error('fetch failed: the process died before the sender answered');
      if (typeof mode === 'object') {
        if (mode.error.startsWith('sender_rejected:')) w.sender.receipts[post.actionId] = { status: 'rejected', providerPostId: null, error: mode.error.slice('sender_rejected:'.length) };
        return { kind: 'failed', error: mode.error, ...(mode.retryAt ? { retryAt: mode.retryAt } : {}) };
      }
      if (mode === 'unknown') {
        w.sender.receipts[post.actionId] = { status: 'held', providerPostId: null, error: null };
        return { kind: 'unknown', error: 'sender_held' };
      }
      const postId = String(7000 + ++n);
      fake.written.push(post.actionId);
      w.sender.receipts[post.actionId] = { status: 'sent', providerPostId: postId, error: null };
      if (mode === 'crash_after') throw new Error('fetch failed: the answer was lost');
      const parts = [post.text, ...(post.thread ?? []).map((p) => p.text)];
      if (parts.length === 1) return { kind: 'completed', result: { postId } };
      const sent = Math.min(parts.length, fake.cutAfter ?? parts.length);
      const list = Array.from({ length: sent }, (_, i) => ({ n: i + 1, postId: i === 0 ? postId : String(7000 + ++n) }));
      return { kind: 'completed', result: { postId, parts: list, sent, of: parts.length, ...(sent < parts.length ? { cut: { n: sent + 1, error: 'sender_rejected:test' } } : {}) } };
    },
  });
  return fake;
}

/** The hooks as post-send.ts ships them: nothing is mounted. */
export function resetHooks(): void {
  setPostHooks({ sendOriginal: async () => ({ kind: 'failed', error: 'original_sender_not_mounted: nothing was sent' }), beforeOriginalNow: async () => null });
}

/** Another active coin beside the test agent, hosted unless `config.runner` says otherwise; `n` makes its id and addresses. */
export async function seedCoin(w: TestWorld, n: number, over: { config?: Record<string, unknown>; runtime?: Partial<typeof runtimes.$inferInsert>; state?: Partial<AgentState> } = {}): Promise<string> {
  const agentId = `coin${n}`;
  // Clear of the test agent's own addresses (…0002, …0003) and of the own-agent helpers' second coin (…0008).
  const hex = (0xa000 + n).toString(16);
  const kernel = `0x2${'0'.repeat(35)}${hex}`;
  const token = `0x3${'0'.repeat(35)}${hex}`;
  const now = w.ctx.now();
  await w.db.insert(agents).values({
    agentId,
    token,
    kernel,
    creator: CREATOR,
    config: agentConfig(now, { agentId, token: { address: token, symbol: `C${n}`, name: `Coin ${n}`, chainId: 84532 }, kernel: { address: kernel }, xHandle: `coin_${n}`, xUserId: String(3000 + n), ...(over.config ?? {}) }),
    permissionId: '0x11223344',
    sessionKeyInstalledAt: new Date(now),
    status: 'active',
  });
  await w.db.insert(runtimes).values({ agentId, state: { ...initialState(), ...(over.state ?? {}) } as unknown as Record<string, unknown>, cycle: 0, nextAt: new Date(now + 6 * HOUR), status: 'waiting', configRevision: 1, lastDecisionAt: new Date(now - MIN), lastDecisionRevision: 1, ...(over.runtime ?? {}) });
  return agentId;
}

/** A waiting row put straight into the queue, for the sweep's own tests (many coins, odd states). */
export async function seedRow(w: TestWorld, agentId: string, sendAt: number, over: Partial<typeof scheduledPosts.$inferInsert> = {}): Promise<string> {
  const id = `sch_${(++seq).toString(16).padStart(16, '0')}`;
  const now = new Date(w.ctx.now() - 5 * MIN);
  await w.db.insert(scheduledPosts).values({ id, agentId, actionId: `act_row_${seq}`, text: `A scheduled thought number ${seq}.`, textHash: `hash${seq}`, sendAt: new Date(sendAt), status: 'waiting', createdAt: now, updatedAt: now, ...over });
  return id;
}
