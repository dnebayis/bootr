import { readConfig } from '@/lib/server/admin-config';
import { inferenceUrl, pictureRoute } from '@/lib/server/env';
import { CATALOG_IMAGE_MODELS, CATALOG_MODELS, FALLBACK_RELAY_IMAGE_MODELS, filterAllowedModels, relayImageOptions, THOUGHT, type ImageModelOption, type ImageModelsResponse, type ModelOption, type ModelsResponse } from '@/lib/models';
import { RELAY_DEFAULT_MARGIN, type RelayImagePrice } from '@bootr/agent-core';

/**
 * The model lists `GET /api/models` and `GET /api/catalog` answer with.
 *
 * Minds: the catalog of the models BlockRun serves (`@bootr/agent-core` `MODEL_CATALOG`), priced per thought the way
 * the agent pays BlockRun for one. No service is asked: the catalog is the source of truth and the supervisor checks it
 * against BlockRun at start.
 *
 * Image models follow the route a picture takes (BLOCKRUN_IMAGE_ROUTE, the same setting the supervisor reads). On the
 * default `relay` route pictures pay Bootr's relay, so the list is the relay's `GET /v1/models` image entries at the
 * relay's prices (cached 60 s per instance; its built-in list of 2026-11-04 when the relay cannot be read), each under
 * its catalog id so the console stores what the supervisor accepts. On the `direct` route the list is the catalog's
 * image models at BlockRun's fixed prices.
 */

export type ModelLists = { source: ModelsResponse['source']; models: ModelOption[]; imageModels: ImageModelOption[]; imageSource: ImageModelsResponse['source'] };

const TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const TIMEOUT_MS = 5_000;

type RelayModel = { id?: unknown; output_modalities?: unknown; pricing?: Record<string, unknown> };
type RelayList = { data?: RelayModel[]; margin?: { bps?: unknown; fixedMicroUsdc?: unknown } };

let imageCache: { at: number; ttl: number; source: ImageModelsResponse['source']; models: ImageModelOption[] } | null = null;

function finite(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** The relay's image entries (`output_modalities` with `image`) as price rows; a listing without any is an error. */
export function relayImageRows(body: RelayList): { rows: (RelayImagePrice & { id: string })[]; margin: { bps: number; fixedMicroUsdc: number } } {
  const rows: (RelayImagePrice & { id: string })[] = [];
  for (const m of Array.isArray(body.data) ? body.data : []) {
    if (typeof m?.id !== 'string' || !/^[\w.:/-]{1,80}$/.test(m.id) || !Array.isArray(m.output_modalities) || !m.output_modalities.includes('image')) continue;
    const p = m.pricing ?? {};
    const perImage = finite(p.image_output_tokens_per_image);
    rows.push({ id: m.id, inputMicroUsdcPerKTokens: finite(p.input_micro_usdc_per_1k_tokens), outputMicroUsdcPerKTokens: finite(p.output_micro_usdc_per_1k_tokens), imageOutputMicroUsdcPerKTokens: finite(p.image_output_micro_usdc_per_1k_tokens), imageOutputTokensPerImage: perImage && perImage > 0 ? perImage : null });
  }
  return { rows, margin: { bps: finite(body.margin?.bps) ?? RELAY_DEFAULT_MARGIN.bps, fixedMicroUsdc: finite(body.margin?.fixedMicroUsdc) ?? RELAY_DEFAULT_MARGIN.fixedMicroUsdc } };
}

/** The relay's image models, read server-side and cached; the built-in relay list when it cannot be read. */
async function relayImageModels(): Promise<NonNullable<typeof imageCache>> {
  const now = Date.now();
  if (imageCache && now - imageCache.at < imageCache.ttl) return imageCache;
  const base = inferenceUrl();
  let next: NonNullable<typeof imageCache> = { at: now, ttl: base ? FAILURE_TTL_MS : TTL_MS, source: 'fallback', models: [...FALLBACK_RELAY_IMAGE_MODELS] };
  if (base) {
    try {
      const res = await fetch(`${base}/v1/models`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`relay responded ${res.status}`);
      const { rows, margin } = relayImageRows((await res.json()) as RelayList);
      if (rows.length === 0) throw new Error('relay listed no image models');
      next = { at: now, ttl: TTL_MS, source: 'relay', models: relayImageOptions(rows, margin) };
    } catch (e) {
      console.warn(`[api/models] relay image list unavailable, using the built-in list: ${(e as Error).message}`);
    }
  }
  imageCache = next;
  return next;
}

/** Forgets the cached relay image list (tests). */
export function resetRelayModelsCache(): void {
  imageCache = null;
}

export async function relayModels(): Promise<ModelLists> {
  const minds = { source: 'blockrun' as const, models: [...CATALOG_MODELS] };
  if (pictureRoute() === 'direct') return { ...minds, imageModels: [...CATALOG_IMAGE_MODELS], imageSource: 'blockrun' };
  const images = await relayImageModels();
  return { ...minds, imageModels: [...images.models], imageSource: images.source };
}

/** The models a new agent may use: the catalog filtered by the admin's `allowedModels`, one thought priced for each. */
export async function currentModels(): Promise<ModelsResponse> {
  const [{ source, models }, cfg] = await Promise.all([relayModels(), readConfig()]);
  return { source, thought: THOUGHT, models: filterAllowedModels(models, cfg.allowedModels) };
}
