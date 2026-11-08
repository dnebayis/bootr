/**
 * The image models a creator may pick (`imageModel` in the agent config) and what one picture costs on each.
 *
 * The list follows the route a picture takes (`picturesOnBlockRun`). Pictures on the relay, the default whatever direct
 * mode says (BLOCKRUN_IMAGE_ROUTE=relay): the relay's `GET /v1/models` entries whose `output_modalities` include `image`,
 * with their pricing (apps/inference/src/pricing.ts prices them; the listing carries the relay's margin too), cached a
 * few minutes per process; when the relay cannot be reached the built-in list and its prices of 2026-11-04 stand in,
 * marked as such, so the console and the turn keep working. Pictures on BlockRun (BLOCKRUN_IMAGE_ROUTE=direct with
 * direct mode on for the agent): the model catalog's image models (`@bootr/agent-core`), each at BlockRun's fixed price
 * per picture plus its per-call fee; no listing is fetched.
 */
import { BLOCKRUN_CALL_FEE_MICRO_USDC, directModelId, imageModels, RELAY_DEFAULT_MARGIN, RELAY_IMAGE_PRICES_FALLBACK, RELAY_PICTURE_PROMPT_TOKENS, RELAY_PICTURE_TEXT_TOKENS, relayModelId, relayPictureMicroUsdc } from '@bootr/agent-core';
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

/** The relay's image models as of 2026-11-04 (agent-core `RELAY_IMAGE_PRICES_FALLBACK`); the relay's own list wins when it answers. */
export const FALLBACK_IMAGE_CATALOG: RelayImageCatalog = {
  live: false,
  margin: { ...RELAY_DEFAULT_MARGIN },
  models: RELAY_IMAGE_PRICES_FALLBACK.map((m) => ({ ...m })),
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
 * The figures live in agent-core (`relayPictureMicroUsdc`), where the web's console reads the same formula.
 */
export const PICTURE_PROMPT_TOKENS = RELAY_PICTURE_PROMPT_TOKENS;
/** Completion text tokens a picture answer carries besides the image (a sentence or two). */
export const PICTURE_TEXT_TOKENS = RELAY_PICTURE_TEXT_TOKENS;

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

/** One cache per supervisor config object (one per process; tests get their own). */
const cache = new WeakMap<object, { at: number; catalog: RelayImageCatalog }>();

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Whether pictures are bought from BlockRun for this agent (or, with no agent given, for the fleet as a whole). */
export function picturesOnBlockRun(config: Pick<SupervisorContext['config'], 'BLOCKRUN_DIRECT_MODE' | 'BLOCKRUN_DIRECT_AGENTS' | 'BLOCKRUN_IMAGE_ROUTE'>, agent?: Pick<AgentRow, 'agentId'> | null): boolean {
  if (config.BLOCKRUN_IMAGE_ROUTE !== 'direct') return false;
  return agent ? directEnabled(config, agent.agentId) : config.BLOCKRUN_DIRECT_MODE === 'all';
}

/**
 * The image models this agent may draw with and their prices: the catalog at BlockRun's prices when its pictures go to
 * BlockRun (`picturesOnBlockRun`: BLOCKRUN_IMAGE_ROUTE=direct and direct mode on for it), else the relay's list, or the
 * built-in list (`live: false`) when the relay does not answer.
 */
export async function relayImageCatalog(ctx: Pick<SupervisorContext, 'config' | 'fetch' | 'now' | 'log'>, agent?: Pick<AgentRow, 'agentId'> | null): Promise<RelayImageCatalog> {
  if (picturesOnBlockRun(ctx.config, agent)) return BLOCKRUN_IMAGE_CATALOG;
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
 * The names a stored id goes by in a list: itself, its catalog id, and the relay's name for that catalog model
 * (`relayModelId`), so a config written under either naming finds its entry on either route.
 */
function namesOf(id: string): string[] {
  const catalog = directModelId(id) ?? id;
  return [...new Set([id, catalog, relayModelId(catalog)])];
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
  return relayPictureMicroUsdc(model, margin);
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
