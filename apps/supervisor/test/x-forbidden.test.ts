/**
 * X refuses an account's posts with 403 "You are not permitted to perform this action" (the sender's `forbidden(403)`):
 * the account is locked, restricted or its token lost write access, and no retry fixes it. On 2026-11-08 one agent hit
 * it three times in six minutes, each a paid turn, and nothing said so but sv_actions. Now: the refusal is logged by
 * its code, posts and mention wakes are held for hours (longer each time), the creator is told, a publish that goes
 * through clears it all.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { notifications, runtimes } from '../src/db/schema.js';
import { notificationText, telegramText } from '../src/notifications.js';
import { X_FORBIDDEN_HOLD_MS, X_FORBIDDEN_HOLD_MAX_MS, forbiddenHold, forbiddenHoldMs, isXForbiddenError } from '../src/rhythm.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const T0 = Date.parse('2026-10-24T12:00:00Z');
/** What X answered on 2026-11-08, as the sender's receipt carries it. */
const FORBIDDEN = 'forbidden(403): You are not permitted to perform this action.';

async function runtimeRow(w: TestWorld) {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
}

function lastToolMessages(w: TestWorld): string[] {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls[calls.length - 1]!.body as { messages: { role: string; content: string }[] };
  return body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
}

/** The world's log, captured: every line as its parsed object. */
function captureLog(w: TestWorld): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  (w.ctx as { log: unknown }).log = pino({ level: 'info' }, { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) });
  return lines;
}

function mention(postId: string, at: number): SenderInboxItem {
  return {
    postId,
    authorId: '42',
    conversationId: postId,
    status: 'pending' as const,
    observedAt: new Date(at).toISOString(),
    seenAt: null,
    deferredUntil: null,
    post: { id: postId, authorId: '42', text: '@bootr_agent hello?', createdAt: new Date(at).toISOString(), conversationId: postId, author: { id: '42', username: 'user42', verified: true, verifiedType: 'blue' } },
  };
}

describe('x forbidden (403)', () => {
  it("recognises the sender's forbidden(403) and nothing else; the hold doubles per strike up to a day", () => {
    expect(isXForbiddenError(`sender_rejected:${FORBIDDEN}`)).toBe(true);
    expect(isXForbiddenError(FORBIDDEN)).toBe(true);
    expect(isXForbiddenError('sender_rejected:duplicate_content(403): You are not allowed to create a Tweet with duplicate content.')).toBe(false);
    expect(isXForbiddenError('sender_rejected:policy:social_execution_command_forbidden')).toBe(false);
    expect(isXForbiddenError('sender_rejected:http_402(402): credits depleted')).toBe(false);
    expect(isXForbiddenError(null)).toBe(false);
    expect(forbiddenHoldMs(1)).toBe(X_FORBIDDEN_HOLD_MS);
    expect(forbiddenHoldMs(2)).toBe(2 * X_FORBIDDEN_HOLD_MS);
    expect(forbiddenHoldMs(3)).toBe(X_FORBIDDEN_HOLD_MAX_MS);
    expect(forbiddenHoldMs(9)).toBe(X_FORBIDDEN_HOLD_MAX_MS);
    expect(forbiddenHoldMs(0)).toBe(X_FORBIDDEN_HOLD_MS);
    expect(forbiddenHold(T0 - 1, T0)).toBeNull();
    expect(forbiddenHold(T0 + H, T0)).toMatchObject({ reason: 'x_forbidden', until: T0 + H });
    expect(forbiddenHold(T0 + H, T0)!.message).toMatch(/not permitted.*do not call them.*creator was told/s);
  });

  it("the creator's notice names the problem and what to do, for the inbox and Telegram", () => {
    const t = notificationText('x_forbidden', { strikes: 2, hours: 12 });
    expect(t.title).toBe('X refused posting for this account');
    expect(t.body).toMatch(/not permitted.*2 times in a row.*Log in to the X account.*about 12 hours.*no fuel is spent/s);
    expect(notificationText('x_forbidden', {}).body).toMatch(/It tries again later/);
    expect(telegramText({ config: { token: { symbol: 'TEST' } }, token: '0x3000000000000000000000000000000000000003' }, 'x_forbidden', { strikes: 1, hours: 6 }, 'https://bootr.fun')).toMatch(/^\$TEST: X refused posting for this account\n.*\nhttps:\/\/bootr\.fun\/token\/0x3000/s);
  });

  it('a 403 publish is logged by its code, holds posts and mention wakes for hours (doubling), tells the creator, and a sent post clears it', async () => {
    const w = await makeWorld({
      script: [
        toolCallResponse('publish_post', { text: 'A post from a test agent, in its own voice.' }),
        finishResponse(T0 + 10 * 60_000),
        toolCallResponse('publish_post', { text: 'Trying again after the hold, in my own voice.' }),
        finishResponse(T0 + 7 * H),
        toolCallResponse('publish_post', { text: 'Back for real this time, in my own voice.' }),
        finishResponse(T0 + 30 * H),
      ],
    });
    try {
      const lines = captureLog(w);
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: new Date(now - 10 * H).toISOString() } });
      w.sender.publishError = FORBIDDEN;
      const r1 = await tick(w.ctx);
      expect(r1.ran).toEqual([AGENT_ID]);
      expect(r1.errors).toEqual([]);
      // the model hears what X said; the log carries the code and never the post
      expect(lastToolMessages(w)[0]).toMatch(/sender_rejected:forbidden\(403\)/);
      const refused = lines.find((l) => l.msg === 'publish refused')!;
      expect(refused).toMatchObject({ level: 30, agentId: AGENT_ID, tool: 'publish_post', code: 'sender_rejected:forbidden(403)' });
      expect(JSON.stringify(refused)).not.toMatch(/own voice|not permitted/);
      expect(lines.some((l) => l.msg === "x refuses this account's posts (403); posts held and the creator told" && l.strikes === 1)).toBe(true);
      // the hold: six hours, one strike; the creator's notice is open
      expect((await runtimeRow(w)).state).toMatchObject({ postForbiddenUntil: now + X_FORBIDDEN_HOLD_MS, postForbiddenStrikes: 1 });
      const [notice] = await w.db.select().from(notifications).where(eq(notifications.agentId, AGENT_ID));
      expect(notice).toMatchObject({ event: 'x_forbidden', resolvedAt: null, data: { strikes: 1, hours: 6 } });

      // inside the hold: a passed runtime wake, a due post and a pending mention buy no turn
      const calls = () => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
      const bought = calls();
      w.sender.items = [mention('3001', now)];
      for (const at of [15 * 60_000, 2 * H, 5 * H + 59 * 60_000]) {
        w.setNow(now + at);
        expect((await tick(w.ctx)).ran).toEqual([]);
      }
      expect(calls()).toBe(bought);
      expect(w.sender.published).toHaveLength(1);

      // the hold ends, X still refuses: the second strike holds twice as long, the notice is refreshed, not duplicated
      w.sender.items = [];
      w.setNow(now + X_FORBIDDEN_HOLD_MS + 60_000);
      const r2 = await tick(w.ctx);
      expect(r2.ran).toEqual([AGENT_ID]);
      expect(w.sender.published).toHaveLength(2);
      const t2 = w.ctx.now();
      expect((await runtimeRow(w)).state).toMatchObject({ postForbiddenUntil: t2 + 2 * X_FORBIDDEN_HOLD_MS, postForbiddenStrikes: 2 });
      const open = await w.db.select().from(notifications).where(eq(notifications.agentId, AGENT_ID));
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ resolvedAt: null, data: { strikes: 2, hours: 12 } });
      w.setNow(t2 + 11 * H);
      expect((await tick(w.ctx)).ran).toEqual([]);

      // the account can post again: the publish goes out, the hold and the strikes are gone, the notice is closed
      w.sender.publishError = null;
      w.setNow(t2 + 2 * X_FORBIDDEN_HOLD_MS + 60_000);
      const r3 = await tick(w.ctx);
      expect(r3.ran).toEqual([AGENT_ID]);
      expect(w.sender.published).toHaveLength(3);
      expect((w.sender.receipts[Object.keys(w.sender.receipts).pop()!] as { status: string }).status).toBe('sent');
      expect((await runtimeRow(w)).state).toMatchObject({ postForbiddenUntil: null, postForbiddenStrikes: 0 });
      const [closed] = await w.db.select().from(notifications).where(eq(notifications.agentId, AGENT_ID));
      expect(closed!.resolvedAt).not.toBeNull();
    } finally {
      await w.close();
    }
  });

  it('a duplicate-content 403 is an ordinary refusal: logged, no hold', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: 'A post from a test agent, in its own voice.' }), finishResponse(T0 + 3 * H)] });
    try {
      const lines = captureLog(w);
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: new Date(now - 10 * H).toISOString() } });
      w.sender.publishError = 'duplicate_content(403): You are not allowed to create a Tweet with duplicate content.';
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect(lines.find((l) => l.msg === 'publish refused')).toMatchObject({ code: 'sender_rejected:duplicate_content(403)' });
      const state = (await runtimeRow(w)).state as { postForbiddenUntil?: number | null };
      expect(state.postForbiddenUntil ?? null).toBeNull();
      expect(await w.db.select().from(notifications)).toEqual([]);
    } finally {
      await w.close();
    }
  });
});
