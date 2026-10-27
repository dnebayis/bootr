import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { z } from 'zod';

/**
 * Pricing for the relay. All money values are micro-USDC (1e-6 USDC), which equals USDC's
 * atomic unit (6 decimals), so a quote is directly the x402 `amount`.
 *
 * Model rates are micro-USDC per 1,000 tokens. OpenRouter publishes USD per 1M tokens:
 * `$X / 1M tokens` == `1000 * X` micro-USDC per 1K tokens (e.g. $3/M -> 3000).
 */

export const modelPriceSchema = z.object({
  inputMicroUsdcPerKTokens: z.number().nonnegative().finite(),
  outputMicroUsdcPerKTokens: z.number().nonnegative().finite(),
  /** Max prompt + completion tokens we accept (keep inside the provider's base price tier). */
  contextLength: z.number().int().positive(),
  /** Hard cap on `max_tokens`. */
  maxOutputTokens: z.number().int().positive(),
});

export const priceTableSchema = z.object({
  /** Proportional margin on top of the token cost, in basis points. */
  marginBps: z.number().int().nonnegative().default(1000),
  /** Flat margin per request, micro-USDC. */
  marginFixedMicroUsdc: z.number().int().nonnegative().default(100),
  /**
   * Floor for every quote, micro-USDC. The CDP x402 facilitator rejects payments under 0.001 USDC
   * (`amount_too_low`); 1000 keeps every quote settleable there. The x402.org testnet facilitator has no minimum.
   */
  minQuoteMicroUsdc: z.number().int().nonnegative().default(1000),
  models: z.record(z.string().min(1), modelPriceSchema).refine((m) => Object.keys(m).length > 0, {
    message: 'price table must list at least one model',
  }),
});

export type ModelPrice = z.infer<typeof modelPriceSchema>;
export type PriceTable = z.infer<typeof priceTableSchema>;

/**
 * Defaults derived from OpenRouter list prices on 2026-10-27 (https://openrouter.ai/api/v1/models). Re-verify against
 * https://openrouter.ai/models before mainnet; override with INFERENCE_PRICE_TABLE_JSON.
 * Context limits are clamped to each model's base price tier where long-context pricing differs.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  marginBps: 1000,
  marginFixedMicroUsdc: 100,
  minQuoteMicroUsdc: 1000,
  models: {
    'anthropic/claude-opus-4.8': { inputMicroUsdcPerKTokens: 5000, outputMicroUsdcPerKTokens: 25000, contextLength: 400000, maxOutputTokens: 32768 },
    'anthropic/claude-sonnet-4.6': { inputMicroUsdcPerKTokens: 3000, outputMicroUsdcPerKTokens: 15000, contextLength: 400000, maxOutputTokens: 32768 },
    'anthropic/claude-sonnet-4.5': { inputMicroUsdcPerKTokens: 3000, outputMicroUsdcPerKTokens: 15000, contextLength: 400000, maxOutputTokens: 32768 },
    'anthropic/claude-haiku-4.5': { inputMicroUsdcPerKTokens: 1000, outputMicroUsdcPerKTokens: 5000, contextLength: 200000, maxOutputTokens: 32768 },
    'openai/gpt-5.6-luna': { inputMicroUsdcPerKTokens: 200, outputMicroUsdcPerKTokens: 1200, contextLength: 400000, maxOutputTokens: 32768 },
    'openai/gpt-5.6-terra': { inputMicroUsdcPerKTokens: 2000, outputMicroUsdcPerKTokens: 12000, contextLength: 400000, maxOutputTokens: 32768 },
    'openai/gpt-5.5': { inputMicroUsdcPerKTokens: 5000, outputMicroUsdcPerKTokens: 30000, contextLength: 400000, maxOutputTokens: 32768 },
    'openai/gpt-5.4': { inputMicroUsdcPerKTokens: 2500, outputMicroUsdcPerKTokens: 15000, contextLength: 400000, maxOutputTokens: 32768 },
    'openai/gpt-5.4-mini': { inputMicroUsdcPerKTokens: 750, outputMicroUsdcPerKTokens: 4500, contextLength: 400000, maxOutputTokens: 32768 },
    'openai/gpt-5.4-nano': { inputMicroUsdcPerKTokens: 200, outputMicroUsdcPerKTokens: 1250, contextLength: 400000, maxOutputTokens: 32768 },
    'openai/gpt-5-mini': { inputMicroUsdcPerKTokens: 250, outputMicroUsdcPerKTokens: 2000, contextLength: 400000, maxOutputTokens: 32768 },
    'openai/gpt-5-nano': { inputMicroUsdcPerKTokens: 50, outputMicroUsdcPerKTokens: 400, contextLength: 400000, maxOutputTokens: 32768 },
    'openai/gpt-4.1': { inputMicroUsdcPerKTokens: 2000, outputMicroUsdcPerKTokens: 8000, contextLength: 400000, maxOutputTokens: 32768 },
    'openai/gpt-4.1-mini': { inputMicroUsdcPerKTokens: 400, outputMicroUsdcPerKTokens: 1600, contextLength: 400000, maxOutputTokens: 32768 },
    'google/gemini-3.8-flash': { inputMicroUsdcPerKTokens: 825, outputMicroUsdcPerKTokens: 4125, contextLength: 400000, maxOutputTokens: 32768 },
    'google/gemini-3.1-pro-preview': { inputMicroUsdcPerKTokens: 2000, outputMicroUsdcPerKTokens: 12000, contextLength: 400000, maxOutputTokens: 32768 },
    'google/gemini-3.5-flash-lite': { inputMicroUsdcPerKTokens: 300, outputMicroUsdcPerKTokens: 2500, contextLength: 400000, maxOutputTokens: 32768 },
    'google/gemini-2.5-flash': { inputMicroUsdcPerKTokens: 300, outputMicroUsdcPerKTokens: 2500, contextLength: 400000, maxOutputTokens: 32768 },
    'x-ai/grok-4.7': { inputMicroUsdcPerKTokens: 2000, outputMicroUsdcPerKTokens: 6000, contextLength: 400000, maxOutputTokens: 32768 },
    'x-ai/grok-4.20': { inputMicroUsdcPerKTokens: 1250, outputMicroUsdcPerKTokens: 2500, contextLength: 400000, maxOutputTokens: 32768 },
    'deepseek/deepseek-v3.2': { inputMicroUsdcPerKTokens: 280, outputMicroUsdcPerKTokens: 420, contextLength: 163840, maxOutputTokens: 32768 },
    'moonshotai/kimi-k2.6': { inputMicroUsdcPerKTokens: 650, outputMicroUsdcPerKTokens: 3410, contextLength: 262144, maxOutputTokens: 32768 },
    'minimax/minimax-m2.7': { inputMicroUsdcPerKTokens: 300, outputMicroUsdcPerKTokens: 1200, contextLength: 204800, maxOutputTokens: 32768 },
    'qwen/qwen3-235b-a22b-2507': { inputMicroUsdcPerKTokens: 90, outputMicroUsdcPerKTokens: 550, contextLength: 262144, maxOutputTokens: 16384 },
    'meta-llama/llama-4-maverick': { inputMicroUsdcPerKTokens: 188, outputMicroUsdcPerKTokens: 652, contextLength: 400000, maxOutputTokens: 16384 },
    'mistralai/mistral-medium-3.1': { inputMicroUsdcPerKTokens: 400, outputMicroUsdcPerKTokens: 2000, contextLength: 131072, maxOutputTokens: 32768 },
    'z-ai/glm-4.6': { inputMicroUsdcPerKTokens: 550, outputMicroUsdcPerKTokens: 2200, contextLength: 204800, maxOutputTokens: 32768 },
  },
};

export function loadPriceTable(json: string | undefined): PriceTable {
  if (!json) return DEFAULT_PRICE_TABLE;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`INFERENCE_PRICE_TABLE_JSON is not valid JSON: ${(err as Error).message}`);
  }
  return priceTableSchema.parse(raw);
}

/** Rates are scaled to integers (1e-6 precision) so all quote math is exact BigInt math. */
const RATE_SCALE = 1_000_000n;
const TOKENS_PER_K = 1000n;

function scaleRate(rate: number): bigint {
  return BigInt(Math.round(rate * Number(RATE_SCALE)));
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a + b - 1n) / b;
}

/** ceil(inRate * inTokens / 1000 + outRate * outTokens / 1000), in micro-USDC. */
export function tokenCostMicroUsdc(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): bigint {
  const numerator =
    scaleRate(price.inputMicroUsdcPerKTokens) * BigInt(inputTokens) +
    scaleRate(price.outputMicroUsdcPerKTokens) * BigInt(outputTokens);
  return ceilDiv(numerator, TOKENS_PER_K * RATE_SCALE);
}

export function marginMicroUsdc(
  table: Pick<PriceTable, 'marginBps' | 'marginFixedMicroUsdc'>,
  cost: bigint,
): bigint {
  return ceilDiv(cost * BigInt(table.marginBps), 10_000n) + BigInt(table.marginFixedMicroUsdc);
}

/** Price of a request with the given token counts, including margin. Always >= 1. */
export function priceMicroUsdc(
  table: PriceTable,
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): bigint {
  const cost = tokenCostMicroUsdc(price, inputTokens, outputTokens);
  const total = cost + marginMicroUsdc(table, cost);
  return total > 0n ? total : 1n;
}

// ---------------------------------------------------------------------------------------------
// Input token estimation
// ---------------------------------------------------------------------------------------------

/**
 * Floor: never estimate fewer than one token per 2 UTF-8 bytes. o200k is among the most efficient
 * tokenizers; other families (Llama/DeepSeek SentencePiece byte-fallback, Claude, Gemini) emit more
 * tokens for the same text, so the floor keeps the `exact` quote an upper bound across providers.
 */
const MIN_TOKENS_PER_BYTE_DIVISOR = 2;
const PER_MESSAGE_OVERHEAD = 4;
const PER_REQUEST_OVERHEAD = 16;

export interface EstimatableRequest {
  messages: readonly unknown[];
  tools?: readonly unknown[] | undefined;
  tool_choice?: unknown;
}

/**
 * Upper-bound estimate of prompt tokens (M-5): the larger of
 *  - the o200k_base token count of the serialized messages, tools and tool_choice (a real BPE
 *    tokenizer, so adversarial Unicode that expands to ~1 token per byte is counted as such), and
 *  - UTF-8 bytes / 2 (cross-family floor),
 * plus per-message framing overhead.
 */
export function estimateInputTokens(req: EstimatableRequest): number {
  const parts: string[] = req.messages.map((m) => JSON.stringify(m));
  if (req.tools?.length) parts.push(JSON.stringify(req.tools));
  if (req.tool_choice !== undefined) parts.push(JSON.stringify(req.tool_choice));
  let bytes = 0;
  let tokens = 0;
  for (const part of parts) {
    bytes += Buffer.byteLength(part, 'utf8');
    tokens += countTokens(part);
  }
  const counted = Math.max(tokens, Math.ceil(bytes / MIN_TOKENS_PER_BYTE_DIVISOR));
  return counted + PER_MESSAGE_OVERHEAD * req.messages.length + PER_REQUEST_OVERHEAD;
}

// ---------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------

export interface QuoteInput extends EstimatableRequest {
  model: string;
  max_tokens: number;
}

export interface Quote {
  model: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  costMicroUsdc: bigint;
  marginMicroUsdc: bigint;
  quoteMicroUsdc: bigint;
}

export type QuoteError =
  | { code: 'model_not_allowed'; message: string }
  | { code: 'max_tokens_too_large'; message: string; limit: number }
  | { code: 'context_length_exceeded'; message: string; limit: number; estimated: number };

export function computeQuote(
  table: PriceTable,
  req: QuoteInput,
): { ok: true; quote: Quote } | { ok: false; error: QuoteError } {
  const price = table.models[req.model];
  if (!price) {
    return {
      ok: false,
      error: {
        code: 'model_not_allowed',
        message: `model "${req.model}" is not offered by this relay`,
      },
    };
  }
  if (req.max_tokens > price.maxOutputTokens) {
    return {
      ok: false,
      error: {
        code: 'max_tokens_too_large',
        message: `max_tokens ${req.max_tokens} exceeds the limit ${price.maxOutputTokens} for ${req.model}`,
        limit: price.maxOutputTokens,
      },
    };
  }
  const estimatedInputTokens = estimateInputTokens(req);
  if (estimatedInputTokens + req.max_tokens > price.contextLength) {
    return {
      ok: false,
      error: {
        code: 'context_length_exceeded',
        message: `estimated prompt (${estimatedInputTokens}) + max_tokens (${req.max_tokens}) exceeds ${price.contextLength}`,
        limit: price.contextLength,
        estimated: estimatedInputTokens,
      },
    };
  }
  const cost = tokenCostMicroUsdc(price, estimatedInputTokens, req.max_tokens);
  let margin = marginMicroUsdc(table, cost);
  const floor = BigInt(table.minQuoteMicroUsdc);
  // Raise the margin so the quote never falls under the facilitator's minimum; the surplus stays with the relay.
  if (cost + margin < floor) margin = floor - cost;
  const total = cost + margin;
  return {
    ok: true,
    quote: {
      model: req.model,
      estimatedInputTokens,
      maxOutputTokens: req.max_tokens,
      costMicroUsdc: cost,
      marginMicroUsdc: margin,
      quoteMicroUsdc: total > 0n ? total : 1n,
    },
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  [k: string]: unknown;
}

/** Usage-based price (for the `upto` scheme), never above the authorized quote. */
export function actualChargeMicroUsdc(
  table: PriceTable,
  model: string,
  usage: Usage | undefined,
  quote: bigint,
): bigint {
  const price = table.models[model];
  if (!price || !usage) return quote;
  const actual = priceMicroUsdc(table, price, usage.prompt_tokens, usage.completion_tokens);
  return actual < quote ? actual : quote;
}

/** `$0.001234` string for the x402 `price` field; exact because USDC has 6 decimals. */
export function microUsdcToDollarString(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  return `$${whole}.${frac}`;
}
