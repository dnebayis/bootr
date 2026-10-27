import { describe, expect, it } from 'vitest';
import { buildInferenceRequest, contextFits, inferenceIdempotencyKey, inputCount, maxQuoteFor, MAX_CONTEXT_BYTES, MAX_QUOTE_MICRO_USDC, type ChatMessage } from './request.js';
import { TOOLS } from '../tools.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'obs' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_mentions', arguments: '{}' } }] },
  { role: 'tool', content: '[]', tool_call_id: 'c1' },
];

describe('buildInferenceRequest', () => {
  it('produces a chat-completions request with one tool at a time', () => {
    const request = buildInferenceRequest(messages, [TOOLS.read_mentions, TOOLS.finish], { model: 'gpt-5-mini', maxOutputTokens: 1024, reasoningEffort: 'low', seed: 7 });
    expect(request).toMatchObject({ model: 'gpt-5-mini', tool_choice: 'auto', parallel_tool_calls: false, max_tokens: 1024, stream: false, store: false, reasoning_effort: 'low', seed: 7 });
    expect(request.tools.map((t) => t.function.name)).toEqual(['read_mentions', 'finish']);
    expect(request.messages).toEqual(messages);
    expect(request.messages).not.toBe(messages);
    expect(request.temperature).toBeUndefined();
    expect(buildInferenceRequest(messages, [], { model: 'm', maxOutputTokens: 1 }).tool_choice).toBe('none');
  });
});

describe('contextFits', () => {
  const request = buildInferenceRequest(messages, [TOOLS.finish], { model: 'm', maxOutputTokens: 1 });
  it('counts messages and tool calls as inputs', () => {
    expect(inputCount(messages)).toBe(5);
    expect(contextFits(request)).toBe(true);
    expect(contextFits(request, { maxMessages: 3 })).toBe(false);
    expect(contextFits(request, { maxInputs: 4 })).toBe(false);
    expect(contextFits(request, { maxBytes: 100 })).toBe(false);
  });
  it('caps bytes at the hard maximum even when a larger limit is passed', () => {
    const huge = buildInferenceRequest([{ role: 'user', content: 'x'.repeat(MAX_CONTEXT_BYTES) }], [], { model: 'm', maxOutputTokens: 1 });
    expect(contextFits(huge, { maxBytes: 10 * MAX_CONTEXT_BYTES })).toBe(false);
    const eighty = Array.from({ length: 80 }, (): ChatMessage => ({ role: 'user', content: 'a' }));
    expect(contextFits(buildInferenceRequest(eighty, [], { model: 'm', maxOutputTokens: 1 }))).toBe(true);
    expect(contextFits(buildInferenceRequest([...eighty, eighty[0]!], [], { model: 'm', maxOutputTokens: 1 }))).toBe(false);
  });
});

describe('inferenceIdempotencyKey', () => {
  it('is stable per agent and cycle', () => {
    expect(inferenceIdempotencyKey('a', 1)).toBe(inferenceIdempotencyKey('a', 1));
    expect(inferenceIdempotencyKey('a', 1)).not.toBe(inferenceIdempotencyKey('a', 2));
    expect(inferenceIdempotencyKey('a', 1)).not.toBe(inferenceIdempotencyKey('b', 1));
    expect(inferenceIdempotencyKey('a', 1)).toMatch(/^inference:[0-9a-f]{32}$/);
  });
});

describe('maxQuoteFor', () => {
  it('matches OpenRouter provider-prefixed ids on the bare model name', () => {
    expect(maxQuoteFor('anthropic/claude-haiku-4.5')).toBe(MAX_QUOTE_MICRO_USDC['claude-haiku']);
    expect(maxQuoteFor('anthropic/claude-opus-4.8')).toBe(MAX_QUOTE_MICRO_USDC['claude-opus']);
    expect(maxQuoteFor('openai/gpt-5.6-terra')).toBe(MAX_QUOTE_MICRO_USDC['gpt-5.6-terra']);
    expect(maxQuoteFor('google/gemini-3.5-flash-lite')).toBe(MAX_QUOTE_MICRO_USDC['gemini-3.5-flash-lite']);
    expect(maxQuoteFor('vendor/unknown-model')).toBe(MAX_QUOTE_MICRO_USDC.default);
  });
  it('uses the longest matching prefix and falls back to default', () => {
    expect(maxQuoteFor('gpt-5-mini-2026')).toBe(MAX_QUOTE_MICRO_USDC['gpt-5-mini']);
    expect(maxQuoteFor('gpt-5')).toBe(MAX_QUOTE_MICRO_USDC['gpt-5']);
    expect(maxQuoteFor('claude-sonnet-4-5')).toBe(MAX_QUOTE_MICRO_USDC['claude-sonnet']);
    expect(maxQuoteFor('mystery')).toBe(MAX_QUOTE_MICRO_USDC.default);
    expect(maxQuoteFor('mystery', { default: 1 })).toBe(1);
    expect(maxQuoteFor('mystery', { custom: 9 })).toBe(MAX_QUOTE_MICRO_USDC.default);
  });
});
