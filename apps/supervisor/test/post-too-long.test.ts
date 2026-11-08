/**
 * An X account without Premium may post 280 characters; X answers a longer original with a bare 403 "not permitted",
 * which until now read as an account hold (x-forbidden.test.ts). Agent 1170231 (2026-11-09): every original of 347
 * to 369 characters refused, every reply under 280 sent. Now the sender knows the account's `premium` flag and refuses
 * such a post itself (`post_too_long_for_account`), the model is told the real limit (tool, prompt, observation), and
 * the refusal is an ordinary tool error: the model shortens and retries in the same turn, nothing is held.
 */
import { LENGTH_RULE_PREMIUM, lengthRuleFor } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { notifications, runtimes } from '../src/db/schema.js';
import { isXCreditsError, isXForbiddenError } from '../src/rhythm.js';
import { errorCodeOf } from '../src/runtime.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const T0 = Date.parse('2026-10-24T12:00:00Z');
const LONG = 'A post that runs long. '.repeat(15).trim().padEnd(347, '.');
const SHORT = 'A shorter post from a test agent, in its own voice.'.padEnd(165, '.');
/** The sender's receipt error for the 347-character post (apps/sender/src/publish.ts `postTooLongForAccount`). */
const TOO_LONG = 'post_too_long_for_account: this X account has no Premium: posts are limited to 280 characters (this one is 347). Shorten it and publish again.';

type Call = { body: { messages: { role: string; content: string }[]; tools?: { function: { name: string; description: string } }[] } };

function inferenceCalls(w: TestWorld): Call[] {
  return w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')) as unknown as Call[];
}

function captureLog(w: TestWorld): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  (w.ctx as { log: unknown }).log = pino({ level: 'info' }, { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) });
  return lines;
}

describe('post too long for the account (no X Premium)', () => {
  it('the sender refusal is neither a 403 account hold nor a credits outage; its code is what the log carries', () => {
    expect(LONG).toHaveLength(347);
    expect(SHORT).toHaveLength(165);
    expect(isXForbiddenError(`sender_rejected:${TOO_LONG}`)).toBe(false);
    expect(isXCreditsError(`sender_rejected:${TOO_LONG}`)).toBe(false);
    expect(errorCodeOf(`sender_rejected:${TOO_LONG}`)).toBe('sender_rejected:post_too_long_for_account');
    // what still is a hold
    expect(isXForbiddenError('sender_rejected:forbidden(403): You are not permitted to perform this action.')).toBe(true);
  });

  it('without Premium the model is told 280 (tool, prompt, observation); the refused 347 reaches it as a tool error, it retries shorter in the same turn, no hold, no notice', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: LONG }, 'call_long'), toolCallResponse('publish_post', { text: SHORT }, 'call_short'), finishResponse(T0 + 3 * H)] });
    try {
      const lines = captureLog(w);
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: new Date(now - 10 * H).toISOString() } });
      w.sender.accounts = { [AGENT_ID]: { agentId: AGENT_ID, connected: true, revoked: false, handle: 'bootr_agent', xUserId: '1000', verifiedType: 'none', premium: false } };
      const r = await tick(w.ctx);
      expect(r.ran).toEqual([AGENT_ID]);
      expect(r.errors).toEqual([]);

      const calls = inferenceCalls(w);
      expect(calls).toHaveLength(3);
      // the first thought: the tool, the prompt and the observation all say 280
      const first = calls[0]!.body;
      const publishPost = first.tools!.find((t) => t.function.name === 'publish_post')!;
      expect(publishPost.function.description).toContain('up to 280 characters (this X account has no Premium; X refuses longer posts)');
      expect(first.tools!.find((t) => t.function.name === 'publish_reply')!.function.description).toContain('Max 280 characters');
      expect(first.messages[0]!.content).toContain(lengthRuleFor(280));
      expect(first.messages[0]!.content).not.toContain(LENGTH_RULE_PREMIUM);
      const observation = JSON.parse(first.messages[1]!.content) as { social: { originalPost: { due: boolean; maxChars: number } } };
      expect(observation.social.originalPost).toMatchObject({ due: true, maxChars: 280 });
      // the tools of the later thoughts carry the same limit (the catalog is rebuilt from the persisted turn)
      expect(calls[2]!.body.tools!.find((t) => t.function.name === 'publish_post')!.function.description).toContain('up to 280 characters');

      // the refusal reaches the model as the tool's error, in full, and the model's shorter post goes out
      const toolMessages = calls[2]!.body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content) as { error?: string; status?: string; postId?: string });
      expect(toolMessages[0]).toMatchObject({ status: 'failed', error: `sender_rejected:${TOO_LONG}` });
      expect(toolMessages[0]!.error).toContain('(this one is 347)');
      expect(toolMessages[1]!.postId).toMatch(/^\d+$/);
      expect(w.sender.published).toHaveLength(2);
      expect((w.sender.published[0] as { text: string }).text).toBe(LONG);
      expect((w.sender.published[1] as { text: string }).text).toBe(SHORT);
      const receipts = Object.values(w.sender.receipts);
      expect(receipts.map((x) => x.status)).toEqual(['rejected', 'sent']);

      // logged by its code (never the text); no strike, no hold, no notice, and the post counts as the slot's post
      const refused = lines.find((l) => l.msg === 'publish refused')!;
      expect(refused).toMatchObject({ level: 30, agentId: AGENT_ID, tool: 'publish_post', code: 'sender_rejected:post_too_long_for_account' });
      expect(JSON.stringify(refused)).not.toContain('runs long');
      expect(lines.some((l) => l.msg === "x refuses this account's posts (403); posts held and the creator told")).toBe(false);
      const state = (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.state as Record<string, unknown>;
      expect(state.postForbiddenUntil ?? null).toBeNull();
      expect(state.postForbiddenStrikes ?? 0).toBe(0);
      expect(state.postQuotaUntil ?? null).toBeNull();
      expect(state.postCreditsUntil ?? null).toBeNull();
      expect(state.lastPostAt).toBe(now);
      expect(await w.db.select().from(notifications)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('with Premium, or while the sender does not know yet, the model is told 4000 and a 347-character post goes out', async () => {
    for (const account of [{ verifiedType: 'blue', premium: true }, { verifiedType: null, premium: null }, {}]) {
      const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: LONG }), finishResponse(T0 + 3 * H)] });
      try {
        const now = w.ctx.now();
        await seedAgent(w, { config: { socialStartedAt: new Date(now - 10 * H).toISOString() } });
        w.sender.accounts = { [AGENT_ID]: { agentId: AGENT_ID, connected: true, revoked: false, handle: 'bootr_agent', xUserId: '1000', ...account } };
        expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
        const first = inferenceCalls(w)[0]!.body;
        expect(first.tools!.find((t) => t.function.name === 'publish_post')!.function.description).toContain('up to 4000 characters');
        expect(first.tools!.find((t) => t.function.name === 'publish_post')!.function.description).not.toContain('Premium');
        expect(first.messages[0]!.content).toContain(LENGTH_RULE_PREMIUM);
        expect((JSON.parse(first.messages[1]!.content) as { social: { originalPost: { maxChars: number } } }).social.originalPost.maxChars).toBe(4000);
        expect(Object.values(w.sender.receipts).map((x) => x.status)).toEqual(['sent']);
      } finally {
        await w.close();
      }
    }
  });
});
