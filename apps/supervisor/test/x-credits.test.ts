import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { runtimes } from '../src/db/schema.js';
import { X_CREDITS_RETRY_MS } from '../src/rhythm.js';
import { SenderError } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { PROBE_GRACE_MS, noteXCredits402, refreshXCredits, xCreditsGate } from '../src/x-credits.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

/**
 * The X app's credits are shared by every agent. On 2026-11-25 a 3.5 hour outage bought seven turns whose posts X
 * refused and wrote about 600 warn lines with a stack trace. The sender now holds every X call after a 402 and the
 * tick buys nothing for an agent that uses X while that hold stands.
 */
const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-10-24T12:00:00Z');
const POST = toolCallResponse('publish_post', { text: 'A post from a test agent, in its own voice.' });

const thoughts = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
const runtimeRow = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
const iso = (ms: number) => new Date(ms).toISOString();

/** Captures the warn and info lines of the context's own logger (the tick's per-agent child is not this one). */
function capture(w: TestWorld) {
  const warn = vi.fn();
  const info = vi.fn();
  w.ctx.log = { ...w.ctx.log, warn, info, child: () => w.ctx.log } as unknown as typeof w.ctx.log;
  const of = (fn: typeof warn, re: RegExp) => fn.mock.calls.filter((c) => re.test(String(c[1] ?? c[0])));
  return { credits: () => of(warn, /X credits used up/), back: () => of(info, /X credits are back/), mentionFailed: () => of(warn, /mention read failed/) };
}

describe('the app-wide X credits hold', () => {
  it('while the sender holds: no mention read, no turn for a due post or a mention, and one warn line', async () => {
    const w = await makeWorld({ script: [POST, finishResponse(T0 + 10 * H)] });
    try {
      const now = w.ctx.now();
      const lines = capture(w);
      await seedAgent(w, { config: { socialStartedAt: iso(now - 10 * H) } });
      w.sender.xCredits = { state: 'held', since: iso(now - MIN), until: iso(now + 29 * MIN) };
      w.sender.items = [{ postId: '3001', authorId: '77', eligible: true, post: { id: '3001', text: '@bootr_agent hello', authorId: '77', createdAt: iso(now) } } as never];
      for (let i = 0; i < 3; i++) {
        w.setNow(now + i * MIN);
        const r = await tick(w.ctx);
        expect(r.ran).toEqual([]);
        expect(r.errors).toEqual([]);
      }
      expect(thoughts(w)).toBe(0);
      expect(w.sender.mentionReads).toBe(0);
      expect(w.sender.published).toHaveLength(0);
      expect(lines.credits()).toHaveLength(1);
      // one line, no error object and so no stack
      expect(lines.credits()[0]![0]).toEqual({ until: iso(now + 29 * MIN), since: iso(now - MIN), again: false, source: 'sender' });
      // the waiting row is moved a tick on, so held agents do not keep the head of the awake queue
      expect((await runtimeRow(w)).nextAt.getTime()).toBeGreaterThan(now + 2 * MIN);

      // the hold ran out and nothing has succeeded yet: the mention read is the question, and no turn is bought on it
      w.sender.xCredits = { state: 'probing', since: iso(now - MIN), until: iso(now + 29 * MIN) };
      w.setNow(now + 30 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect(w.sender.mentionReads).toBe(1);
      expect(thoughts(w)).toBe(0);

      // X refused again: the sender holds for twice as long, and the log says so once more
      w.sender.xCredits = { state: 'held', since: iso(now - MIN), until: iso(now + 91 * MIN) };
      w.setNow(now + 31 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([]);
      w.setNow(now + 32 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect(lines.credits()).toHaveLength(2);
      expect(lines.credits()[1]![0]).toMatchObject({ again: true });
      expect(thoughts(w)).toBe(0);

      // the credits are back: the turn is bought and the post goes out
      w.sender.xCredits = null;
      w.sender.items = [];
      w.setNow(now + 95 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect(w.sender.published).toHaveLength(1);
      expect(lines.back()).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('a hold that ran out and that no read settles lets one turn ask X after the grace', async () => {
    const w = await makeWorld({ script: [POST, finishResponse(T0 + 10 * H)] });
    try {
      const now = w.ctx.now();
      // an agent that publishes but reads no mentions: nothing of its own asks X for free
      await seedAgent(w, { config: { socialStartedAt: iso(now - 10 * H), capabilities: { xRead: false, xReply: false, xPublish: true, research: true, memory: true, treasury: true, images: false } } });
      w.sender.xCredits = { state: 'probing', since: iso(now - 31 * MIN), until: iso(now - MIN) };
      expect((await tick(w.ctx)).ran).toEqual([]);
      w.setNow(now - MIN + PROBE_GRACE_MS - 1000);
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect(thoughts(w)).toBe(0);
      w.setNow(now - MIN + PROBE_GRACE_MS + 1000);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
    } finally {
      await w.close();
    }
  });

  it('a mention read answered 402 starts the hold with one line and no stack', async () => {
    const w = await makeWorld({ script: [finishResponse(T0 + 10 * H)] });
    try {
      const now = w.ctx.now();
      const lines = capture(w);
      await seedAgent(w, { config: { socialStartedAt: iso(now - 10 * H) } });
      const until = now + 30 * MIN;
      w.sender.readMentionsError = new SenderError(502, 'x_http_402', { error: 'x_http_402' }, false, until);
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect(xCreditsGate(w.ctx)).toEqual({ held: true, state: 'held', until });
      // the sender says the same from the next tick on; the read is not made again and nothing more is logged
      w.sender.xCredits = { state: 'held', since: iso(now), until: iso(until) };
      for (let i = 1; i <= 5; i++) {
        w.setNow(now + i * MIN);
        expect((await tick(w.ctx)).ran).toEqual([]);
      }
      expect(w.sender.mentionReads).toBe(1);
      expect(lines.credits()).toHaveLength(1);
      expect(lines.credits()[0]![0]).not.toHaveProperty('err');
      expect(lines.mentionFailed()).toHaveLength(0);
      expect(thoughts(w)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('holds the continuation of a turn that ran out of steps, and resumes a turn stored half-way', async () => {
    const w = await makeWorld({ script: [finishResponse(T0 + 10 * H)] });
    try {
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: iso(now - 10 * H) } });
      const row = await runtimeRow(w);
      // a turn the runtime ended at the step cap: its continuation is a new turn, and it is due
      await w.db.update(runtimes).set({ state: { ...(row.state as Record<string, unknown>), lastPostAt: now - MIN, continuation: { progress: 'Turn ended by the runtime (step cap reached). Continue from the agenda.', recentSteps: [] } }, nextAt: new Date(now - 1000) }).where(eq(runtimes.agentId, AGENT_ID));
      w.sender.xCredits = { state: 'held', since: iso(now - MIN), until: iso(now + 29 * MIN) };
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect(thoughts(w)).toBe(0);
      // a turn stored half-way (here: its first thought not asked yet) is resumed under the hold
      const turn = { role: 'social', startedAt: now, steps: 0, nudged: false, reasons: ['scheduled'], premium: null, messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: '{}' }], inbox: {}, eligibility: {}, recentSteps: [], routing: null };
      await w.db.update(runtimes).set({ turn: turn as unknown as Record<string, unknown>, status: 'running' }).where(eq(runtimes.agentId, AGENT_ID));
      w.setNow(now + MIN);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect(thoughts(w)).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('does not hold an agent that neither reads nor posts on X', async () => {
    const w = await makeWorld({ script: [finishResponse(T0 + 10 * H)] });
    try {
      const now = w.ctx.now();
      await seedAgent(w, { config: { capabilities: { xRead: false, xReply: false, xPublish: false, research: true, memory: true, treasury: true, images: false } } });
      w.sender.xCredits = { state: 'held', since: iso(now - MIN), until: iso(now + 29 * MIN) };
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
    } finally {
      await w.close();
    }
  });

  it('without the sender’s route, a 402 seen here holds for X_CREDITS_RETRY_MS and then lets go', async () => {
    const w = await makeWorld();
    try {
      const now = w.ctx.now();
      (w.ctx.sender as unknown as { xCredits: () => Promise<never> }).xCredits = async () => {
        throw new SenderError(404, 'http_404', null, false);
      };
      expect((await refreshXCredits(w.ctx)).state).toBe('clear');
      noteXCredits402(w.ctx);
      expect(xCreditsGate(w.ctx)).toEqual({ held: true, state: 'held', until: now + X_CREDITS_RETRY_MS });
      w.setNow(now + X_CREDITS_RETRY_MS - 1000);
      expect((await refreshXCredits(w.ctx)).state).toBe('held');
      w.setNow(now + X_CREDITS_RETRY_MS + 1000);
      expect((await refreshXCredits(w.ctx)).state).toBe('clear');
      expect(xCreditsGate(w.ctx).held).toBe(false);
    } finally {
      await w.close();
    }
  });
});
