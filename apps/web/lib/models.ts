/**
 * Model catalogue for the launch form. Browser-safe (no env, no Node APIs): the server route
 * `app/api/models/route.ts` builds the list from the relay's `GET /v1/models`, the form renders it.
 */

export type ModelOption = {
  id: string;
  label: string;
  provider: string;
  /** Estimated USDC cost of one thought (see THOUGHT), null when the relay gave no price. */
  pricePerThoughtUsd: number | null;
};

export type ModelsResponse = {
  source: 'relay' | 'fallback';
  thought: typeof THOUGHT;
  models: ModelOption[];
};

/** Default model for new agents: cheap, fast, good at short tool-using turns. */
export const RECOMMENDED_MODEL = 'anthropic/claude-haiku-4.5';

/**
 * One thought = one paid inference call by the supervisor. The prompt (identity, recent state,
 * tool definitions) is typically ~4k tokens; output is capped at INFERENCE_MAX_OUTPUT_TOKENS (1024),
 * and the relay's default x402 `exact` scheme charges that cap, so the estimate uses it.
 */
export const THOUGHT = { promptTokens: 4000, outputTokens: 1024 } as const;

/** Relay pricing defaults (apps/inference/src/pricing.ts): 10% + 100 micro-USDC margin, 1000 micro-USDC floor. */
export const RELAY_MARGIN = { bps: 1000, fixedMicroUsdc: 100, minQuoteMicroUsdc: 1000 } as const;

export type RelayPrice = { inputMicroUsdcPerKTokens: number; outputMicroUsdcPerKTokens: number };

/** Mirrors the relay's quote: ceil(token cost) + ceil(cost * bps / 1e4) + fixed, floored at the minimum quote. */
export function thoughtPriceUsd(p: RelayPrice, margin: { bps: number; fixedMicroUsdc: number; minQuoteMicroUsdc?: number } = RELAY_MARGIN): number {
  const cost = Math.ceil((p.inputMicroUsdcPerKTokens * THOUGHT.promptTokens + p.outputMicroUsdcPerKTokens * THOUGHT.outputTokens) / 1000);
  const total = cost + Math.ceil((cost * margin.bps) / 10_000) + margin.fixedMicroUsdc;
  return Math.max(total, margin.minQuoteMicroUsdc ?? RELAY_MARGIN.minQuoteMicroUsdc) / 1_000_000;
}

/** Provider display order in the picker; relay ids are `<vendor>/<model>`. */
export const PROVIDERS: { vendor: string; name: string }[] = [
  { vendor: 'anthropic', name: 'Anthropic' },
  { vendor: 'openai', name: 'OpenAI' },
  { vendor: 'google', name: 'Google' },
  { vendor: 'x-ai', name: 'xAI' },
  { vendor: 'deepseek', name: 'DeepSeek' },
  { vendor: 'moonshotai', name: 'Moonshot' },
  { vendor: 'minimax', name: 'MiniMax' },
  { vendor: 'qwen', name: 'Qwen' },
  { vendor: 'meta-llama', name: 'Meta' },
  { vendor: 'mistralai', name: 'Mistral' },
  { vendor: 'z-ai', name: 'Z.ai' },
];

const LABELS: Record<string, string> = {
  'anthropic/claude-opus-4.8': 'Claude Opus 4.8',
  'anthropic/claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5',
  'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
  'openai/gpt-5.6-luna': 'GPT-5.6 Luna',
  'openai/gpt-5.6-terra': 'GPT-5.6 Terra',
  'openai/gpt-5.5': 'GPT-5.5',
  'openai/gpt-5.4': 'GPT-5.4',
  'openai/gpt-5.4-mini': 'GPT-5.4 mini',
  'openai/gpt-5.4-nano': 'GPT-5.4 nano',
  'openai/gpt-5-mini': 'GPT-5 mini',
  'openai/gpt-5-nano': 'GPT-5 nano',
  'openai/gpt-4.1': 'GPT-4.1',
  'openai/gpt-4.1-mini': 'GPT-4.1 mini',
  'google/gemini-3.8-flash': 'Gemini 3.8 Flash',
  'google/gemini-3.1-pro-preview': 'Gemini 3.1 Pro (preview)',
  'google/gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
  'x-ai/grok-4.7': 'Grok 4.7',
  'x-ai/grok-4.20': 'Grok 4.20',
  'deepseek/deepseek-v3.2': 'DeepSeek V3.2',
  'moonshotai/kimi-k2.6': 'Kimi K2.6',
  'minimax/minimax-m2.7': 'MiniMax M2.7',
  'qwen/qwen3-235b-a22b-2507': 'Qwen3 235B A22B',
  'meta-llama/llama-4-maverick': 'Llama 4 Maverick',
  'mistralai/mistral-medium-3.1': 'Mistral Medium 3.1',
  'z-ai/glm-4.6': 'GLM 4.6',
};

export function providerName(id: string): string {
  const vendor = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
  return PROVIDERS.find((p) => p.vendor === vendor)?.name ?? (vendor ? vendor : 'Other');
}

export function modelLabel(id: string): string {
  if (LABELS[id]) return LABELS[id];
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  return bare.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Built-in list when the relay is unreachable or unset. Prices are the relay's default price table
 * (OpenRouter list prices, Oct 2026) run through `thoughtPriceUsd`; the relay is authoritative.
 */
const FALLBACK_PRICES: Record<string, RelayPrice> = {
  'anthropic/claude-haiku-4.5': { inputMicroUsdcPerKTokens: 1000, outputMicroUsdcPerKTokens: 5000 },
  'anthropic/claude-sonnet-4.6': { inputMicroUsdcPerKTokens: 3000, outputMicroUsdcPerKTokens: 15000 },
  'openai/gpt-5.4-mini': { inputMicroUsdcPerKTokens: 750, outputMicroUsdcPerKTokens: 4500 },
  'openai/gpt-4.1-mini': { inputMicroUsdcPerKTokens: 400, outputMicroUsdcPerKTokens: 1600 },
  'google/gemini-3.5-flash-lite': { inputMicroUsdcPerKTokens: 300, outputMicroUsdcPerKTokens: 2500 },
  'deepseek/deepseek-v3.2': { inputMicroUsdcPerKTokens: 280, outputMicroUsdcPerKTokens: 420 },
  'x-ai/grok-4.20': { inputMicroUsdcPerKTokens: 1250, outputMicroUsdcPerKTokens: 2500 },
  'meta-llama/llama-4-maverick': { inputMicroUsdcPerKTokens: 188, outputMicroUsdcPerKTokens: 652 },
};

export const FALLBACK_MODELS: ModelOption[] = Object.entries(FALLBACK_PRICES).map(([id, p]) => ({
  id,
  label: modelLabel(id),
  provider: providerName(id),
  pricePerThoughtUsd: thoughtPriceUsd(p),
}));

/** `anthropic/claude-haiku-4.5` and `claude-haiku-4-5` name the same model. */
export function modelKey(id: string): string {
  return id.trim().toLowerCase().replace(/^[^/]+\//, '').replace(/\./g, '-');
}

/**
 * Models the admin allows (console `allowedModels`). An entry matches a model by full id or by its
 * vendor-less, dot-insensitive form. An empty allowlist allows nothing.
 */
export function filterAllowedModels<T extends { id: string }>(models: readonly T[], allowed: readonly string[]): T[] {
  const keys = new Set(allowed.map(modelKey));
  const full = new Set(allowed.map((a) => a.trim().toLowerCase()));
  return models.filter((m) => full.has(m.id.toLowerCase()) || keys.has(modelKey(m.id)));
}

/** Picker groups in PROVIDERS order; unknown vendors last. Within a group: cheapest first. */
export function groupByProvider(models: readonly ModelOption[]): { provider: string; models: ModelOption[] }[] {
  const order = (name: string) => {
    const i = PROVIDERS.findIndex((p) => p.name === name);
    return i === -1 ? PROVIDERS.length : i;
  };
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([provider, list]) => ({
      provider,
      models: [...list].sort((a, b) => (a.pricePerThoughtUsd ?? Infinity) - (b.pricePerThoughtUsd ?? Infinity) || a.label.localeCompare(b.label)),
    }));
}

/**
 * The cheapest priced mind of a list, skipping `exclude` (the writer itself: economy mode needs a second, cheaper
 * model). Unpriced models never win; null when nothing qualifies.
 */
export function cheapestModel(models: readonly ModelOption[], exclude?: string | null): ModelOption | null {
  let best: ModelOption | null = null;
  for (const m of models) {
    if (m.id === exclude || m.pricePerThoughtUsd == null) continue;
    if (!best || m.pricePerThoughtUsd < best.pricePerThoughtUsd! || (m.pricePerThoughtUsd === best.pricePerThoughtUsd && m.id < best.id)) best = m;
  }
  return best;
}

/** Micro-USDC totals as money: `$0.14`, tiny sums with four decimals, `$0` for nothing. */
export function formatMicroUsdc(micro: string | number): string {
  const n = Number(micro) / 1_000_000;
  if (!Number.isFinite(n) || n <= 0) return '$0';
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

/** `$0.0101` style: three significant digits, never scientific notation. */
export function formatThoughtPrice(usd: number | null): string {
  if (usd == null) return '—';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const digits = Math.max(2, Math.min(6, 2 - Math.floor(Math.log10(usd))));
  return `$${usd.toFixed(digits)}`;
}
