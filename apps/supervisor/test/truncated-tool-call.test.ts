/**
 * A tool call cut off at the output limit: a paid thought that cannot run. The model is told, gets room for one retry, and
 * the broken JSON never goes back to the provider, which would refuse the next request (and a refusal can still bill).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runtimes } from '../src/db/schema.js';
import { parseAssistant } from '../src/inference.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent } from './helpers.js';

const cut = (args: string, finish_reason = 'length') =>
  new Response(JSON.stringify({ id: 'c', choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_f', type: 'function', function: { name: 'finish', arguments: args } }] } }], usage: { prompt_tokens: 100, completion_tokens: 1024 } }), { status: 200, headers: { 'content-type': 'application/json', 'x-bootr-receipt': JSON.stringify({ requestId: 'r', quoteMicroUsdc: '1000', chargedMicroUsdc: '1000' }) } });

describe('parseAssistant', () => {
  const body = (args: string, finish_reason: string) => ({ choices: [{ finish_reason, message: { content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'finish', arguments: args } }] } }] });

  it('marks unfinished JSON and the output limit, and nothing else', () => {
    expect(parseAssistant(body('{"memory":"long', 'tool_calls')).truncated).toBe(true);
    expect(parseAssistant(body('{"memory":"m"}', 'length')).truncated).toBe(true);
    expect(parseAssistant(body('{"memory":"m"}', 'max_tokens')).truncated).toBe(true);
    expect(parseAssistant(body('{"memory":"m"}', 'tool_calls')).truncated).toBe(false);
    expect(parseAssistant({ choices: [{ finish_reason: 'length', message: { content: 'text' } }] }).truncated).toBe(false);
  });

  it('reports the finish reason as the provider gave it, or null', () => {
    expect(parseAssistant({ choices: [{ finish_reason: 'length', message: { content: 'text' } }] }).finishReason).toBe('length');
    expect(parseAssistant(body('{}', 'tool_calls')).finishReason).toBe('tool_calls');
    expect(parseAssistant({ choices: [{ message: { content: 'text' } }] }).finishReason).toBeNull();
    expect(parseAssistant({ choices: [{ finish_reason: 7, message: { content: 'text' } }] }).finishReason).toBeNull();
  });

  // The social turn (runtime.ts) and the chat (chat.ts) read the assistant through this one function, so both see the same text.
  it('joins text parts of an array answer and drops reasoning parts; a string stays as it is', () => {
    const parts = [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Hello ' }, { type: 'reasoning', text: 'private too' }, { type: 'text', text: 'there.' }, 'junk', null];
    expect(parseAssistant({ choices: [{ finish_reason: 'stop', message: { content: parts } }] }).message).toEqual({ role: 'assistant', content: 'Hello there.' });
    expect(parseAssistant({ choices: [{ message: { content: 'plain' } }] }).message.content).toBe('plain');
    expect(parseAssistant({ choices: [{ message: { content: '' } }] }).message.content).toBe('');
    expect(parseAssistant({ choices: [{ message: { content: null } }] }).message.content).toBeNull();
    expect(parseAssistant({ choices: [{ message: { content: [{ type: 'thinking', thinking: 'only' }] } }] }).message.content).toBeNull();
    expect(parseAssistant({ choices: [{ message: { content: { text: 'an object' } } }] }).message.content).toBeNull();
    // a tool call beside array text keeps both
    const withCall = parseAssistant({ choices: [{ finish_reason: 'tool_calls', message: { content: [{ type: 'text', text: 'Noting that.' }], tool_calls: [{ id: 'x', type: 'function', function: { name: 'remember', arguments: '{"text":"n"}' } }] } }] });
    expect(withCall.message.content).toBe('Noting that.');
    expect(withCall.toolCall?.name).toBe('remember');
  });
});

describe('a truncated finish in a turn', () => {
  it('is not carried out, tells the model, and the retry has room; then the limit goes back down', async () => {
    const start = Date.parse('2026-10-24T12:00:00Z');
    const w = await makeWorld({ script: [cut('{"memory":"a very long note that never ends'), finishResponse(start + 3_600_000)] });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
      expect(calls).toHaveLength(2);
      const first = calls[0]!.body as { max_tokens: number };
      const second = calls[1]!.body as { max_tokens: number; messages: { role: string; content: string | null; tool_calls?: unknown[] }[] };
      expect(first.max_tokens).toBe(w.ctx.config.INFERENCE_MAX_OUTPUT_TOKENS);
      expect(second.max_tokens).toBe(w.ctx.config.INFERENCE_RETRY_OUTPUT_TOKENS);
      // no broken JSON goes back, and the model hears why
      expect(JSON.stringify(second.messages)).not.toContain('never ends');
      expect(second.messages.some((m) => m.tool_calls)).toBe(false);
      expect(second.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('cut off') });
      const rt = (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      expect(rt.turn).toBeNull();
      expect(rt.failures).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('truncated every time ends at the step cap, not in a loop of its own', async () => {
    const script = Array.from({ length: 40 }, () => cut('{"memory":"x'));
    const w = await makeWorld({ script, config: { MAX_TOOL_STEPS: '4' } });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
      expect(calls).toHaveLength(4);
    } finally {
      await w.close();
    }
  });
});
