/**
 * `sv_turns` (turns.ts; docs/design/agent-behaviour.md section 5): one row per finished turn, hosted or own, with what
 * woke it, how many thoughts it bought, how it ended, what it published and what it cost. A turn that is kept to be
 * resumed gets no row until it ends, and a row that cannot be written never costs the turn.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ActResult } from '@bootr/shared/own-agent';
import { inference, turns } from '../src/db/schema.js';
import type { Turn } from '../src/runtime.js';
import { tick } from '../src/tick.js';
import { recordTurn, turnRowId } from '../src/turns.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse } from './helpers.js';
import { act, connectClient, finishInput, openSocial, ownWorld, seedOwn } from './own-helpers.js';

const HOUR = 3_600_000;
const rows = (w: { db: Awaited<ReturnType<typeof makeWorld>>['db'] }) => w.db.select().from(turns).where(eq(turns.agentId, AGENT_ID));

describe('sv_turns: a hosted turn', () => {
  it('that posts and finishes leaves one row with its wake reasons, thoughts, post and charge', async () => {
    const boot = await makeWorld();
    const start = boot.ctx.now();
    await boot.close();
    const w = await makeWorld({ script: [toolCallResponse('read_market', {}), toolCallResponse('publish_post', { text: 'A plain post about the coin, with nothing to hide.' }), finishResponse(start + HOUR)] });
    try {
      // The original post is due: the turn wakes for it.
      await seedAgent(w, { config: { socialStartedAt: new Date(start - 6 * HOUR).toISOString() } });
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      expect(report.ran).toEqual([AGENT_ID]);
      const all = await rows(w);
      expect(all).toHaveLength(1);
      const row = all[0]!;
      expect(row).toMatchObject({ agentId: AGENT_ID, role: 'social', via: null, thoughts: 3, outcome: 'finished', posted: 1, replied: 0 });
      expect(row.id).toBe(`${AGENT_ID}:social:${row.startedAt.getTime()}`);
      expect(row.wakeReasons).toEqual(expect.arrayContaining(['original_post_due']));
      expect(row.endedAt.getTime()).toBeGreaterThanOrEqual(row.startedAt.getTime());
      // Three thoughts at 1000 micro-USDC each (the scripted relay's receipt).
      expect(row.chargedMicroUsdc).toBe('3000');
      expect(await w.db.select().from(inference)).toHaveLength(3);
    } finally {
      await w.close();
    }
  });

  it('that finishes without a post says so: posted 0, the same wake reasons the log carried', async () => {
    const boot = await makeWorld();
    const start = boot.ctx.now();
    await boot.close();
    const w = await makeWorld({ script: [toolCallResponse('remember', { text: 'nothing new today' }), finishResponse(start + HOUR)] });
    try {
      await seedAgent(w, { config: { socialStartedAt: new Date(start - HOUR).toISOString() } });
      await tick(w.ctx);
      const [row] = await rows(w);
      expect(row).toMatchObject({ role: 'social', thoughts: 2, outcome: 'finished', posted: 0, replied: 0, chargedMicroUsdc: '2000' });
      expect(row!.wakeReasons).toEqual(['scheduled']);
    } finally {
      await w.close();
    }
  });

  it('that the runtime cuts short is on record with the outcome it ended in', async () => {
    // No tool call twice: the runtime ends the turn (step_cap) after the nudge.
    const text = () => new Response(JSON.stringify({ id: 'c', choices: [{ message: { role: 'assistant', content: 'thinking aloud' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const w = await makeWorld({ script: [text(), text()] });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const [row] = await rows(w);
      expect(row).toMatchObject({ outcome: 'step_cap', thoughts: 2, posted: 0 });
    } finally {
      await w.close();
    }
    // An inference whose outcome is unknown ends the social turn (the next one starts afresh): that is a finished turn too.
    const u = await makeWorld({ script: [new Response(JSON.stringify({ error: { code: 'request_outcome_unknown' } }), { status: 409, headers: { 'content-type': 'application/json' } })] });
    try {
      await seedAgent(u);
      await tick(u.ctx);
      const all = await rows(u);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ outcome: 'inference_unknown', thoughts: 1, chargedMicroUsdc: '0' });
    } finally {
      await u.close();
    }
  });
});

describe('sv_turns: recordTurn', () => {
  const turn = (over: Partial<Turn> = {}): Turn => ({ role: 'social', startedAt: 0, steps: 4, nudged: false, reasons: ['pending_mention'], messages: [], inbox: {}, recentSteps: [], ...over });

  it('counts completed publishes only, keeps the role, and writes the same turn once', async () => {
    const w = await makeWorld();
    try {
      const startedAt = w.ctx.now() - 60_000;
      const t = turn({
        startedAt,
        recentSteps: [
          { tool: 'publish_reply', status: 'completed', summary: '' },
          { tool: 'publish_reply', status: 'failed', summary: '' },
          { tool: 'publish_reply', status: 'completed', summary: '' },
          { tool: 'publish_post', status: 'failed', summary: '' },
          { tool: 'remember', status: 'completed', summary: '' },
        ],
      });
      await recordTurn(w.ctx, AGENT_ID, t, 'finished');
      await recordTurn(w.ctx, AGENT_ID, { ...t, steps: 5 }, 'step_cap');
      const all = await rows(w);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: `${AGENT_ID}:social:${startedAt}`, thoughts: 5, outcome: 'step_cap', posted: 0, replied: 2, wakeReasons: ['pending_mention'] });
      await recordTurn(w.ctx, AGENT_ID, turn({ role: 'treasury', startedAt, reasons: ['treasury_due'] }), 'finished');
      expect((await rows(w)).map((r) => r.role).sort()).toEqual(['social', 'treasury']);
      expect(turnRowId(AGENT_ID, turn({ startedAt: 5, own: { turnId: 'otn_' + '0'.repeat(32), clientId: 'cli_x', openedAt: 5, lastCallAt: 5, forced: false } }))).toBe('otn_' + '0'.repeat(32));
    } finally {
      await w.close();
    }
  });

  it('leaves chat and judge payments out of a turn\'s charge and never throws when the table is gone', async () => {
    const w = await makeWorld();
    try {
      const now = w.ctx.now();
      const paid = (key: string) => ({ idempotencyKey: key, agentId: AGENT_ID, cycle: 0, requestHash: 'h', request: {}, status: 'succeeded' as const, receipt: { relay: { chargedMicroUsdc: '700' } }, createdAt: new Date(now - 1000), updatedAt: new Date(now - 1000) });
      await w.db.insert(inference).values([paid('inference:a'), paid('image:b'), paid(`chat:${AGENT_ID}:c`), paid(`judge:${AGENT_ID}:d`), { ...paid('inference:before'), createdAt: new Date(now - HOUR) }]);
      await recordTurn(w.ctx, AGENT_ID, turn({ startedAt: now - 60_000 }), 'finished');
      expect((await rows(w))[0]!.chargedMicroUsdc).toBe('1400');
      await w.db.execute('drop table sv_turns');
      await expect(recordTurn(w.ctx, AGENT_ID, turn({ startedAt: now - 30_000 }), 'finished')).resolves.toBeUndefined();
      await expect(recordTurn(w.ctx, AGENT_ID, null, 'finished')).resolves.toBeUndefined();
    } finally {
      await w.close();
    }
  });
});

describe('sv_turns: an own agent\'s turn', () => {
  it('is on record when it finishes (via own, its tool calls as thoughts, no charge) and when the server closes it', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const opened = await openSocial(w, credential);
      expect((await act(w, credential, opened.turnId, 'publish_post', { text: 'An own agent posts once, in plain words.' })).body.status).toBe('completed');
      const done = await w.run<ActResult>('finish', credential, { turnId: opened.turnId, ...finishInput(w) });
      expect(done.body.status).toBe('completed');
      const all = await rows(w);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: opened.turnId, role: 'social', via: 'own', outcome: 'finished', thoughts: 2, posted: 1, replied: 0, chargedMicroUsdc: '0' });
      expect(all[0]!.wakeReasons).toEqual(opened.reasons);

      // A turn the client leaves open is closed by the tick's idle rule, and that is a row too.
      const second = await openSocial(w, credential, { reason: 'creator_asked' });
      w.setNow(w.ctx.now() + 2 * 24 * HOUR);
      await tick(w.ctx);
      const after = await rows(w);
      expect(after).toHaveLength(2);
      expect(after.find((r) => r.id === second.turnId)).toMatchObject({ via: 'own', outcome: 'expired', thoughts: 0, posted: 0 });
    } finally {
      await w.close();
    }
  });
});
