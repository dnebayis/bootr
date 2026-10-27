import { describe, expect, it } from 'vitest';
import { actionId, beginAction, canResume, cycleKey, isRetryable, markSent, reconcile, recordOutcome, resumeAction, runtimeBlocked, settleCycle, type BrokerRuntime } from './broker.js';
import type { Action } from '../types.js';

const now = 1_900_000_000_000;
const runtime: BrokerRuntime = { runtimeId: 'agent-1:social', cycle: 7, pending: null };
const read: Action = { tool: 'read_mentions', input: {} };
const reply: Action = { tool: 'publish_reply', input: { postId: '5', text: 'hi' } };
const money: Action = { tool: 'treasury_execute', input: { preparedId: 'p1', expectedHash: '0x' + 'a'.repeat(64) } };
const remember: Action = { tool: 'remember', input: { text: 'note' } };

describe('keys', () => {
  it('derive deterministically from runtime id and cycle', () => {
    expect(cycleKey('r', 1)).toBe(cycleKey('r', 1));
    expect(cycleKey('r', 1)).not.toBe(cycleKey('r', 2));
    expect(cycleKey('r', 1)).not.toBe(cycleKey('s', 1));
    expect(cycleKey('r', 1)).toMatch(/^cycle:[0-9a-f]{32}$/);
    expect(actionId('k', read)).toBe(actionId('k', { tool: 'read_mentions', input: {} }));
    expect(actionId('k', read)).not.toBe(actionId('k', reply));
  });
});

describe('beginAction', () => {
  it('binds the action to the current cycle', () => {
    const pending = beginAction(runtime, reply, 7, now, true);
    expect(pending).toMatchObject({ cycleKey: cycleKey('agent-1:social', 7), action: reply, status: 'sending', createdAt: now, attempts: 1, completeAfter: true });
    expect(pending.id).toBe(actionId(pending.cycleKey, reply));
    expect(beginAction(runtime, reply, 7, now).id).toBe(pending.id);
  });
  it('refuses a busy runtime, a stale cycle and unknown tools', () => {
    const busy = { ...runtime, pending: beginAction(runtime, read, 7, now) };
    expect(() => beginAction(busy, read, 7, now)).toThrow(/runtime_busy/);
    expect(() => beginAction(runtime, read, 8, now)).toThrow(/runtime_cycle_mismatch/);
    expect(() => beginAction(runtime, { tool: 'hack' } as unknown as Action, 7, now)).toThrow(/runtime_action_denied/);
    const settled = { ...runtime, pending: recordOutcome(markSent(beginAction(runtime, read, 7, now)), { kind: 'completed', result: [] }) };
    expect(beginAction(settled, read, 7, now).status).toBe('sending');
  });
});

describe('retryability', () => {
  it('reads and keyed writes resume; money and publishing never do', () => {
    expect(isRetryable(read)).toBe(true);
    expect(isRetryable(remember)).toBe(true);
    expect(isRetryable({ tool: 'resolve_mention', input: { postId: '1', outcome: 'skip', reason: 'x' } })).toBe(true);
    expect(isRetryable({ tool: 'treasury_prepare', input: { operation: 'burn', amount: '1' } })).toBe(true);
    expect(isRetryable(reply)).toBe(false);
    expect(isRetryable({ tool: 'publish_post', input: { text: 'x' } })).toBe(false);
    expect(isRetryable(money)).toBe(false);
  });
});

describe('recordOutcome', () => {
  it('settles completed and failed outcomes', () => {
    const sent = markSent(beginAction(runtime, read, 7, now));
    const done = recordOutcome(sent, { kind: 'completed', result: { posts: [] } });
    expect(done.status).toBe('completed');
    expect(done.result).toEqual({ actionId: sent.id, tool: 'read_mentions', status: 'completed', result: { posts: [] } });
    const failed = recordOutcome(sent, { kind: 'failed', error: 'x_unavailable', retryAt: now + 1000 });
    expect(failed).toMatchObject({ status: 'failed', reason: 'x_unavailable', nextAt: now + 1000 });
    expect(() => recordOutcome(done, { kind: 'failed', error: 'late' })).toThrow(/action_already_settled/);
  });
  it('a definite failure may be recorded before sending, an unknown outcome may not', () => {
    const sending = beginAction(runtime, read, 7, now);
    expect(recordOutcome(sending, { kind: 'failed', error: 'invalid_input' }).status).toBe('failed');
    expect(() => recordOutcome(sending, { kind: 'unknown', error: 'timeout' })).toThrow(/action_not_sent/);
  });
  it('an unknown read outcome resumes with backoff and eventually holds', () => {
    let pending = markSent(beginAction(runtime, read, 7, now));
    pending = recordOutcome(pending, { kind: 'unknown', error: 'timeout' }, now);
    expect(pending).toMatchObject({ status: 'sent', attempts: 1, nextAt: now + 15_000, reason: 'timeout' });
    expect(canResume(pending)).toBe(true);
    expect(() => resumeAction(pending, now + 1000)).toThrow(/action_backoff_pending/);
    pending = resumeAction(pending, now + 15_000);
    expect(pending).toMatchObject({ status: 'sending', attempts: 2 });
    pending = recordOutcome(markSent(pending), { kind: 'unknown', error: 'timeout' }, now);
    expect(pending.nextAt).toBe(now + 30_000);
    pending = recordOutcome(markSent(resumeAction(pending, now + 60_000)), { kind: 'unknown', error: 'timeout' }, now);
    expect(pending).toMatchObject({ status: 'sent', attempts: 3, nextAt: now + 60_000 });
    pending = recordOutcome(markSent(resumeAction(pending, now + 120_000)), { kind: 'unknown', error: 'timeout' }, now);
    expect(pending).toMatchObject({ status: 'held', attempts: 4 });
    expect(canResume(pending)).toBe(false);
    expect(() => resumeAction(pending, now + 10 * 60_000)).toThrow(/runtime_original_not_resolved/);
  });
  it('an unknown money outcome is held immediately and blocks the runtime', () => {
    const held = recordOutcome(markSent(beginAction(runtime, money, 7, now)), { kind: 'unknown', error: 'request_timeout' }, now);
    expect(held).toMatchObject({ status: 'held', attempts: 1, reason: 'request_timeout' });
    expect(held.nextAt).toBeUndefined();
    expect(canResume(held)).toBe(false);
    expect(runtimeBlocked({ ...runtime, pending: held })).toBe(true);
    expect(() => settleCycle({ ...runtime, pending: held })).toThrow(/runtime_busy/);
    const heldReply = recordOutcome(markSent(beginAction(runtime, reply, 7, now)), { kind: 'unknown', error: 'timeout' }, now);
    expect(heldReply.status).toBe('held');
  });
});

describe('reconcile', () => {
  it('only the original receipt resolves a held money action', () => {
    const held = recordOutcome(markSent(beginAction(runtime, money, 7, now)), { kind: 'unknown', error: 'timeout' }, now);
    expect(() => reconcile(held, { actionId: 'act_other', cycleKey: held.cycleKey, outcome: { kind: 'completed', result: {} } })).toThrow(/runtime_original_not_resolved/);
    expect(() => reconcile(held, { actionId: held.id, cycleKey: 'cycle:other', outcome: { kind: 'completed', result: {} } })).toThrow(/runtime_original_not_resolved/);
    const receipt = { txHash: '0x' + 'b'.repeat(64) };
    const done = reconcile(held, { actionId: held.id, cycleKey: held.cycleKey, outcome: { kind: 'completed', result: { ok: true } }, receipt });
    expect(done.status).toBe('completed');
    expect(done.result?.receipt).toEqual(receipt);
    const failed = reconcile(held, { actionId: held.id, cycleKey: held.cycleKey, outcome: { kind: 'failed', error: 'reverted' } });
    expect(failed.status).toBe('failed');
    expect(() => reconcile(done, { actionId: held.id, cycleKey: held.cycleKey, outcome: { kind: 'failed', error: 'x' } })).toThrow(/action_not_held/);
  });
});

describe('settleCycle', () => {
  it('advances the cycle and hands the result over as the next observation', () => {
    const done = recordOutcome(markSent(beginAction(runtime, read, 7, now)), { kind: 'completed', result: 1 });
    const next = settleCycle({ ...runtime, pending: done });
    expect(next.runtime).toEqual({ runtimeId: 'agent-1:social', cycle: 8, pending: null });
    expect(next.observation?.result).toBe(1);
    expect(settleCycle(runtime)).toEqual({ runtime: { ...runtime, cycle: 8 }, observation: null });
    expect(() => settleCycle({ ...runtime, pending: beginAction(runtime, read, 7, now) })).toThrow(/runtime_busy/);
    expect(() => markSent(done)).toThrow(/action_not_sending/);
  });
});
