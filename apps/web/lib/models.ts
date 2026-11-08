/**
 * The models the launch form and the creator console offer, priced the way the agent pays for them at BlockRun.
 * Browser-safe (no env, no Node APIs): the list and its prices come from the model catalog in agent-core
 * (`MODEL_CATALOG`), the server route `app/api/models/route.ts` applies the admin allow-list, the form renders it.
 */
import {
  BLOCKRUN_CALL_FEE_MICRO_USDC,
  BLOCKRUN_MIN_QUOTE_MICRO_USDC,
  DEFAULT_MIND_MODEL,
  DEFAULT_PLATFORM_IMAGE_MODEL,
  imageModels,
  mindModels,
  MODEL_VENDORS,
  modelDisplayName,
  pictureQuoteMicroUsdc,
  THOUGHT_SIZE,
  thoughtQuoteMicroUsdc,
  vendorName,
  type CatalogModel,
} from '@bootr/agent-core';

export type ModelOption = {
  id: string;
  label: string;
  provider: string;
  /** Estimated USDC cost of one thought (see THOUGHT), null when the model is not priced. */
  pricePerThoughtUsd: number | null;
};

export type ModelsResponse = {
  /** Where the list and its prices come from: the catalog of the models BlockRun serves. */
  source: 'blockrun';
  thought: typeof THOUGHT;
  models: ModelOption[];
};

/** An image generation model (`/api/models?kind=image`), priced per picture. */
export type ImageModelOption = {
  id: string;
  label: string;
  provider: string;
  /** Estimated USDC cost of one picture, null when the model is not priced. */
  pricePerImageUsd: number | null;
};

export type ImageModelsResponse = {
  source: 'blockrun';
  image: typeof IMAGE;
  models: ImageModelOption[];
};

/** Default model for new agents: cheap, fast, good at short tool-using turns. */
export const RECOMMENDED_MODEL = DEFAULT_MIND_MODEL;
/** The supervisor's default image model for the platform agent (apps/supervisor/src/images.ts). */
export const DEFAULT_IMAGE_MODEL = DEFAULT_PLATFORM_IMAGE_MODEL;

/**
 * One thought = one paid inference call by the supervisor. The prompt (identity, recent state,
 * tool definitions) is typically ~4k tokens; output is capped at INFERENCE_MAX_OUTPUT_TOKENS (1024),
 * and BlockRun quotes the whole allowance, so the estimate uses it.
 */
export const THOUGHT = THOUGHT_SIZE;

/** One picture = one `generate_image` call at BlockRun's fixed price per picture (no token arithmetic). */
export const IMAGE = { promptTokens: 0, outputTokens: 0 } as const;

/** What BlockRun adds to every call: a flat fee, and a floor under the smallest quote (micro-USDC). */
export const BLOCKRUN_FEES = { callFeeMicroUsdc: BLOCKRUN_CALL_FEE_MICRO_USDC, minQuoteMicroUsdc: BLOCKRUN_MIN_QUOTE_MICRO_USDC } as const;

export type TokenPrice = { inputMicroUsdcPerKTokens: number; outputMicroUsdcPerKTokens: number };

/** Mirrors BlockRun's quote for one thought: the prompt and the whole output allowance at list price, plus the fee, floored. */
export function thoughtPriceUsd(p: TokenPrice): number {
  return thoughtQuoteMicroUsdc({ price: p })! / 1_000_000;
}

/** BlockRun's price for one picture plus its fee. */
export function imagePriceUsd(perImageMicroUsdc: number): number {
  return pictureQuoteMicroUsdc({ price: { perImageMicroUsdc } })! / 1_000_000;
}

/** Provider display order in the picker; ids are `<vendor>/<model>`. */
export const PROVIDERS: readonly { vendor: string; name: string }[] = MODEL_VENDORS;

export function providerName(id: string): string {
  const vendor = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
  return vendor ? vendorName(vendor) : 'Other';
}

export function modelLabel(id: string): string {
  return modelDisplayName(id);
}

function mindOption(m: CatalogModel): ModelOption {
  const quote = thoughtQuoteMicroUsdc(m);
  return { id: m.id, label: m.name, provider: vendorName(m.vendor), pricePerThoughtUsd: quote === null ? null : quote / 1_000_000 };
}

function imageOption(m: CatalogModel): ImageModelOption {
  const quote = pictureQuoteMicroUsdc(m);
  return { id: m.id, label: m.name, provider: vendorName(m.vendor), pricePerImageUsd: quote === null ? null : quote / 1_000_000 };
}

/** Every model an agent may think with, priced per thought. The admin allow-list narrows it (`filterAllowedModels`). */
export const CATALOG_MODELS: readonly ModelOption[] = mindModels().map(mindOption);
/** Every image model, priced per picture. */
export const CATALOG_IMAGE_MODELS: readonly ImageModelOption[] = imageModels().map(imageOption);

/** The list the browser falls back to when `/api/models` cannot be reached: the whole catalog, unfiltered. */
export const FALLBACK_MODELS: ModelOption[] = [...CATALOG_MODELS];
export const FALLBACK_IMAGE_MODELS: ImageModelOption[] = [...CATALOG_IMAGE_MODELS];

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

type Priced = { provider: string; label: string; pricePerThoughtUsd?: number | null; pricePerImageUsd?: number | null };

/** Picker groups in PROVIDERS order; unknown vendors last. Within a group: cheapest first (per thought, or per image for image models). */
export function groupByProvider<T extends Priced>(models: readonly T[]): { provider: string; models: T[] }[] {
  const order = (name: string) => {
    const i = PROVIDERS.findIndex((p) => p.name === name);
    return i === -1 ? PROVIDERS.length : i;
  };
  const price = (m: T) => m.pricePerThoughtUsd ?? m.pricePerImageUsd ?? Infinity;
  const groups = new Map<string, T[]>();
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([provider, list]) => ({
      provider,
      models: [...list].sort((a, b) => price(a) - price(b) || a.label.localeCompare(b.label)),
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
