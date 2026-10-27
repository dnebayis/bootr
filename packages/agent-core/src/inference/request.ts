import { digest, byteLength } from '../hash.js';
import { toFunctionDefinitions, type FunctionDefinition, type ToolDefinition } from '../tools.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface InferenceSettings {
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  seed?: number;
}

export interface InferenceRequest {
  model: string;
  messages: ChatMessage[];
  tools: FunctionDefinition[];
  tool_choice: 'auto' | 'none';
  parallel_tool_calls: false;
  max_tokens: number;
  stream: false;
  store: false;
  temperature?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
  seed?: number;
}

/** OpenAI chat-completions request. Tool choice stays 'auto' with parallel calls disabled: one tool at a time. */
export function buildInferenceRequest(
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
  settings: InferenceSettings,
): InferenceRequest {
  const definitions = toFunctionDefinitions(tools);
  return {
    model: settings.model,
    messages: [...messages],
    tools: definitions,
    tool_choice: definitions.length ? 'auto' : 'none',
    parallel_tool_calls: false,
    max_tokens: settings.maxOutputTokens,
    stream: false,
    store: false,
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
    ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
  };
}

export interface ContextLimits {
  maxBytes: number;
  maxMessages: number;
  /** Messages plus tool calls plus tool results. */
  maxInputs: number;
}

export const MAX_CONTEXT_BYTES = 400_000;
export const DEFAULT_CONTEXT_LIMITS: ContextLimits = { maxBytes: MAX_CONTEXT_BYTES, maxMessages: 80, maxInputs: 160 };

export function inputCount(messages: readonly ChatMessage[]): number {
  return messages.reduce((n, m) => n + 1 + (m.tool_calls?.length ?? 0), 0);
}

/** A request must checkpoint before it exceeds any limit; the byte cap can only be lowered, never raised above MAX_CONTEXT_BYTES. */
export function contextFits(request: InferenceRequest, limits: Partial<ContextLimits> = {}): boolean {
  const { maxBytes, maxMessages, maxInputs } = { ...DEFAULT_CONTEXT_LIMITS, ...limits };
  return (
    request.messages.length <= maxMessages &&
    inputCount(request.messages) <= maxInputs &&
    byteLength(JSON.stringify(request)) <= Math.min(maxBytes, MAX_CONTEXT_BYTES)
  );
}

/** One key per agent cycle so a retried submission is the same paid request. */
export function inferenceIdempotencyKey(agentId: string, cycle: number): string {
  return 'inference:' + digest({ agentId, cycle }).slice(0, 32);
}

/** Maximum quote (micro-USDC) accepted for one request, per model prefix. */
export const MAX_QUOTE_MICRO_USDC: Readonly<Record<string, number>> = {
  default: 500_000,
  'gpt-5': 2_000_000,
  'gpt-5-mini': 400_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 300_000,
  'claude-opus': 3_000_000,
  'claude-sonnet': 1_500_000,
  'claude-haiku': 300_000,
};

/** Longest matching model prefix wins; unknown models fall back to `default`. */
export function maxQuoteFor(model: string, table: Readonly<Record<string, number>> = MAX_QUOTE_MICRO_USDC): number {
  const match = Object.keys(table)
    .filter((prefix) => prefix !== 'default' && model.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  return match !== undefined ? table[match]! : (table.default ?? MAX_QUOTE_MICRO_USDC.default!);
}
