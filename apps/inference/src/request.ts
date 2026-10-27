import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * OpenAI-compatible chat-completions subset accepted by the relay. Unknown keys are stripped,
 * so the hash and the forwarded body only cover fields the relay understands and prices.
 * Text-only content: image/audio parts are rejected because they are not priced.
 */

const textPart = z.object({ type: z.literal('text'), text: z.string() });
const content = z.union([z.string(), z.array(textPart).min(1)]);

const toolCall = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content, name: z.string().optional() }),
  z.object({ role: z.literal('developer'), content, name: z.string().optional() }),
  z.object({ role: z.literal('user'), content, name: z.string().optional() }),
  z.object({
    role: z.literal('assistant'),
    content: content.nullable().optional(),
    name: z.string().optional(),
    tool_calls: z.array(toolCall).optional(),
  }),
  z.object({ role: z.literal('tool'), content, tool_call_id: z.string().min(1) }),
]);

const tool = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) }),
]);

export const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  tools: z.array(tool).optional(),
  tool_choice: toolChoice.optional(),
  max_tokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z
    .literal(false, { errorMap: () => ({ message: 'streaming is not supported' }) })
    .optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** Deterministic JSON: object keys sorted, `undefined` dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Hash of the normalized request; `stream: false` is dropped so it does not change the hash. */
export function hashRequest(req: ChatRequest): string {
  return createHash('sha256')
    .update(stableStringify({ ...req, stream: undefined }))
    .digest('hex');
}

export const MAX_QUOTE_HEADER = 'x-max-quote-micro-usdc';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const RECEIPT_HEADER = 'x-bootr-receipt';

/** Idempotency keys: 1-200 printable ASCII chars without spaces (UUIDs fit). */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7e]{1,200}$/, 'invalid Idempotency-Key');

export const maxQuoteSchema = z
  .string()
  .regex(/^\d{1,18}$/, 'X-Max-Quote-Micro-USDC must be a non-negative integer (micro-USDC)')
  .transform((v) => BigInt(v));
