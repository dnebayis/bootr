/**
 * The image models a creator may pick (`imageModel` in the agent config) and what one picture costs on each.
 *
 * In direct mode (blockrun.ts) the list is the model catalog's image models (`@bootr/agent-core`), each at BlockRun's
 * fixed price per picture plus its per-call fee: no listing is fetched. Agents still on the relay read the relay's
 * `GET /v1/models` entries whose `output_modalities` include `image`, with their pricing (apps/inference/src/pricing.ts
 * prices them; the listing carries the relay's margin too), cached a few minutes per process; when the relay cannot be
 * reached the built-in list and its prices of 2026-11-04 stand in, marked as such, so the console and the turn keep working.
 */
import { BLOCKRUN_CALL_FEE_MICRO_USDC, catalogModel, imageModels, relayModelId } from '@bootr/agent-core';
import { directEnabled } from './blockrun.js';
import type { AgentRow, SupervisorContext } from './context.js';

export interface RelayImageModel {
  id: string;
  /** Micro-USDC per 1K prompt tokens; null when the listing gave no price. */
  inputMicroUsdcPerKTokens: number | null;
  /** Micro-USDC per 1K completion (text) tokens; null when the listing gave no price. */
  outputMicroUsdcPerKTokens: number | null;
  /** Micro-USDC per 1K image output tokens; null when the listing gave no price. */
  imageOutputMicroUsdcPerKTokens: number | null;
  /** Output tokens the relay bills one picture as; null when the listing gave no figure. */
  imageOutputTokensPerImage: number | null;
  /** BlockRun's fixed price for one picture before its fee (direct mode); null on a relay entry. */
  perImageMicroUsdc?: number | null;
}

export interface RelayImageCatalog {
  models: readonly RelayImageModel[];
  /** The relay's margin on every quote: basis points and a fixed amount in micro-USDC. */
  margin: { bps: number; fixedMicroUsdc: number };
  /** False when this is the built-in list because the relay did not answer. */
  live: boolean;
}

/** The relay's image models as of 2026-11-04 (apps/inference/src/pricing.ts); the relay's own list wins when it answers. */
export const FALLBACK_IMAGE_CATALOG: RelayImageCatalog = {
  live: false,
  margin: { bps: 1000, fixedMicroUsdc: 100 },
  models: [
    { id: 'google/gemini-3-pro-image', inputMicroUsdcPerKTokens: 2000, outputMicroUsdcPerKTokens: 12000, imageOutputMicroUsdcPerKTokens: 120000, imageOutputTokensPerImage: 1120 },
    { id: 'google/gemini-3.1-flash-image', inputMicroUsdcPerKTokens: 500, outputMicroUsdcPerKTokens: 3000, imageOutputMicroUsdcPerKTokens: 60000, imageOutputTokensPerImage: 1120 },
    { id: 'openai/gpt-5.4-image-2', inputMicroUsdcPerKTokens: 8000, outputMicroUsdcPerKTokens: 15000, imageOutputMicroUsdcPerKTokens: 30000, imageOutputTokensPerImage: 4160 },
  ],
};
export const FALLBACK_IMAGE_MODELS: readonly string[] = FALLBACK_IMAGE_CATALOG.models.map((m) => m.id);

/** The catalog's image models at BlockRun's prices: what every agent in direct mode draws with. */
export const BLOCKRUN_IMAGE_CATALOG: RelayImageCatalog = {
  live: true,
  margin: { bps: 0, fixedMicroUsdc: BLOCKRUN_CALL_FEE_MICRO_USDC },
  models: imageModels().map((m) => ({ id: m.id, inputMicroUsdcPerKTokens: null, outputMicroUsdcPerKTokens: null, imageOutputMicroUsdcPerKTokens: null, imageOutputTokensPerImage: null, perImageMicroUsdc: 'perImageMicroUsdc' in m.price ? m.price.perImageMicroUsdc : null })),
};

/**
 * Prompt tokens one picture request is billed for: the illustrator instructions, the prompt and the alt text (a few
 * hundred tokens) plus the style reference, which the relay prices as `IMAGE_INPUT_TOKENS_PER_IMAGE` (1600) prompt tokens.
 */
export const PICTURE_PROMPT_TOKENS = 2200;
/** Completion text tokens a picture answer carries besides the image (a sentence or two). */
export const PICTURE_TEXT_TOKENS = 64;

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

/** One cache per supervisor config object (one per process; tests get their own). */
const cache = new WeakMap<object, { at: number; catalog: RelayImageCatalog }>();

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The image models this agent may draw with and their prices: the catalog at BlockRun's prices in direct mode (for every
 * agent with `all`, the named ones with `agents`; no agent given means the mode's general answer), else the relay's list,
 * or the built-in list (`live: false`) when the relay does not answer.
 */
export async function relayImageCatalog(ctx: Pick<SupervisorContext, 'config' | 'fetch' | 'now' | 'log'>, agent?: Pick<AgentRow, 'agentId'> | null): Promise<RelayImageCatalog> {
  if (agent ? directEnabled(ctx.config, agent.agentId) : ctx.config.BLOCKRUN_DIRECT_MODE === 'all') return BLOCKRUN_IMAGE_CATALOG;
  const hit = cache.get(ctx.config);
  if (hit && ctx.now() - hit.at < TTL_MS) return hit.catalog;
  try {
    const res = await ctx.fetch(new URL('/v1/models', ctx.config.INFERENCE_PROVIDER_URL).toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`relay responded ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown; output_modalities?: unknown; pricing?: Record<string, unknown> }[]; margin?: { bps?: unknown; fixedMicroUsdc?: unknown } } | null;
    const models: RelayImageModel[] = [];
    for (const m of Array.isArray(body?.data) ? body.data : []) {
      if (typeof m?.id !== 'string' || !Array.isArray(m.output_modalities) || !m.output_modalities.includes('image')) continue;
      const p = m.pricing ?? {};
      const perImage = num(p.image_output_tokens_per_image);
      models.push({ id: m.id, inputMicroUsdcPerKTokens: num(p.input_micro_usdc_per_1k_tokens), outputMicroUsdcPerKTokens: num(p.output_micro_usdc_per_1k_tokens), imageOutputMicroUsdcPerKTokens: num(p.image_output_micro_usdc_per_1k_tokens), imageOutputTokensPerImage: perImage && perImage > 0 ? perImage : null });
    }
    if (!models.length) throw new Error('relay listed no image models');
    const catalog: RelayImageCatalog = { live: true, models, margin: { bps: num(body?.margin?.bps) ?? FALLBACK_IMAGE_CATALOG.margin.bps, fixedMicroUsdc: num(body?.margin?.fixedMicroUsdc) ?? FALLBACK_IMAGE_CATALOG.margin.fixedMicroUsdc } };
    cache.set(ctx.config, { at: ctx.now(), catalog });
    return catalog;
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not list the relay image models; using the built-in list and its prices');
    return FALLBACK_IMAGE_CATALOG;
  }
}

/** The ids a creator may pick for this agent. */
export async function relayImageModels(ctx: Pick<SupervisorContext, 'config' | 'fetch' | 'now' | 'log'>, agent?: Pick<AgentRow, 'agentId'> | null): Promise<readonly string[]> {
  return (await relayImageCatalog(ctx, agent)).models.map((m) => m.id);
}

/**
 * The names a stored id goes by in a list: itself, the relay's name for the same model (`relayModelId`) and its catalog
 * id, so a config written under either naming finds its entry on either route.
 */
function namesOf(id: string): string[] {
  return [...new Set([id, relayModelId(id), catalogModel(id)?.id ?? id])];
}

function findIn(models: readonly RelayImageModel[], id: string): RelayImageModel | null {
  for (const name of namesOf(id)) {
    const hit = models.find((m) => m.id === name);
    if (hit) return hit;
  }
  return null;
}

/** One model's entry from the list in force, else from the built-in one, or null for an id neither knows. */
export function imageModelEntry(catalog: RelayImageCatalog, id: string): RelayImageModel | null {
  return findIn(catalog.models, id) ?? findIn(FALLBACK_IMAGE_CATALOG.models, id);
}

/** The output tokens one picture is billed as on `id`: the live listing's figure, else the built-in one, else null. */
export function imageTokensPerImage(catalog: RelayImageCatalog, id: string): number | null {
  return findIn(catalog.models, id)?.imageOutputTokensPerImage ?? findIn(FALLBACK_IMAGE_CATALOG.models, id)?.imageOutputTokensPerImage ?? null;
}

/**
 * What one picture on `model` costs in micro-USDC, as the relay charges it: the image tokens at the image rate, the
 * prompt (instructions, prompt, alt text and the style reference) at the input rate, a sentence of text at the output
 * rate, plus the relay's margin. This is the price the agent is told, not the quote (which also reserves the text
 * headroom of `max_tokens` and is settled down to usage). Null when the entry carries no image price.
 */
export function picturePriceMicroUsdc(model: RelayImageModel, margin: RelayImageCatalog['margin'] = FALLBACK_IMAGE_CATALOG.margin): number | null {
  // A fixed price per picture (BlockRun): the price plus the margin, which there is its flat fee.
  if (typeof model.perImageMicroUsdc === 'number') return Math.ceil(model.perImageMicroUsdc + (model.perImageMicroUsdc * margin.bps) / 10_000 + margin.fixedMicroUsdc);
  if (model.imageOutputMicroUsdcPerKTokens === null || model.imageOutputTokensPerImage === null) return null;
  const image = (model.imageOutputMicroUsdcPerKTokens * model.imageOutputTokensPerImage) / 1000;
  const input = ((model.inputMicroUsdcPerKTokens ?? 0) * PICTURE_PROMPT_TOKENS) / 1000;
  const text = ((model.outputMicroUsdcPerKTokens ?? 0) * PICTURE_TEXT_TOKENS) / 1000;
  const cost = image + input + text;
  return Math.ceil(cost + (cost * margin.bps) / 10_000 + margin.fixedMicroUsdc);
}

export interface PicturePrice {
  microUsdc: number;
  /** False when the price is the built-in one of 2026-11-04 because the relay's list did not price the model. */
  live: boolean;
}

/** What one picture on `id` costs: from the relay's list when it prices the model, else the built-in price, else null. */
export function picturePriceFor(catalog: RelayImageCatalog, id: string): PicturePrice | null {
  const live = findIn(catalog.models, id);
  const fromLive = live ? picturePriceMicroUsdc(live, catalog.margin) : null;
  if (fromLive !== null) return { microUsdc: fromLive, live: catalog.live };
  const builtIn = findIn(FALLBACK_IMAGE_CATALOG.models, id);
  const fromBuiltIn = builtIn ? picturePriceMicroUsdc(builtIn, FALLBACK_IMAGE_CATALOG.margin) : null;
  return fromBuiltIn !== null ? { microUsdc: fromBuiltIn, live: false } : null;
}

/** Micro-USDC as a USDC string with cents and a third digit when the amount is small ("0.156", "0.08"). */
export function usdcText(microUsdc: number): string {
  const usdc = microUsdc / 1e6;
  return usdc.toFixed(3).replace(/0$/, '');
}
