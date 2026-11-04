import { connection, NextResponse, type NextRequest } from 'next/server';
import { readConfig } from '@/lib/server/admin-config';
import { inferenceUrl } from '@/lib/server/env';
import {
  FALLBACK_IMAGE_MODELS,
  FALLBACK_MODELS,
  filterAllowedModels,
  IMAGE,
  imagePriceUsd,
  modelLabel,
  providerName,
  RELAY_MARGIN,
  THOUGHT,
  thoughtPriceUsd,
  type ImageModelOption,
  type ImageModelsResponse,
  type ModelOption,
  type ModelsResponse,
} from '@/lib/models';

/**
 * GET /api/models -> ModelsResponse
 * The relay is internal in production, so the browser never calls `/v1/models` itself. This route
 * reads it server-side (cached 60 s per instance), prices one thought per model the way the relay
 * quotes, and keeps only the admin's `allowedModels` (same matching as the launch form used to do).
 * Unreachable or unset relay: the built-in list, filtered the same way.
 *
 * GET /api/models?kind=image -> ImageModelsResponse
 * The relay's image generation models (`output_modalities` with `image`) priced per picture, for the
 * creator console's image model select. Not subject to the admin allow-list, which names minds.
 */

const TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const TIMEOUT_MS = 5_000;

type RelayModel = {
  id?: unknown;
  name?: unknown;
  pricing?: {
    input_micro_usdc_per_1k_tokens?: unknown;
    output_micro_usdc_per_1k_tokens?: unknown;
    image_output_micro_usdc_per_1k_tokens?: unknown;
    image_output_tokens_per_image?: unknown;
  };
  price_per_thought_usd?: unknown;
  /** `['text', 'image']` for the relay's image generation models, which are not minds. */
  output_modalities?: unknown;
};
type RelayList = { data?: RelayModel[]; margin?: { bps?: unknown; fixedMicroUsdc?: unknown } };

type Lists = { minds: ModelOption[]; images: ImageModelOption[] };
let cache: { at: number; ttl: number; source: ModelsResponse['source']; models: ModelOption[]; imageModels: ImageModelOption[] } | null = null;

function finite(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Maps the relay's `/v1/models` body to picker options: minds (priced per thought) and image models (per picture). */
function fromRelay(body: RelayList): Lists {
  const margin = {
    bps: finite(body.margin?.bps) ?? RELAY_MARGIN.bps,
    fixedMicroUsdc: finite(body.margin?.fixedMicroUsdc) ?? RELAY_MARGIN.fixedMicroUsdc,
  };
  const minds: ModelOption[] = [];
  const images: ImageModelOption[] = [];
  for (const m of body.data ?? []) {
    if (typeof m.id !== 'string' || !/^[\w.:/-]{1,80}$/.test(m.id)) continue;
    const label = typeof m.name === 'string' && m.name ? m.name.slice(0, 60) : modelLabel(m.id);
    const input = finite(m.pricing?.input_micro_usdc_per_1k_tokens);
    const output = finite(m.pricing?.output_micro_usdc_per_1k_tokens);
    if (Array.isArray(m.output_modalities) && m.output_modalities.includes('image')) {
      const imageOutput = finite(m.pricing?.image_output_micro_usdc_per_1k_tokens);
      const perImage = finite(m.pricing?.image_output_tokens_per_image);
      images.push({
        id: m.id,
        label,
        provider: providerName(m.id),
        pricePerImageUsd:
          input != null && output != null && imageOutput != null && perImage != null
            ? imagePriceUsd({ inputMicroUsdcPerKTokens: input, outputMicroUsdcPerKTokens: output, imageOutputMicroUsdcPerKTokens: imageOutput, imageOutputTokensPerImage: perImage }, margin)
            : null,
      });
      continue;
    }
    const direct = finite(m.price_per_thought_usd);
    minds.push({
      id: m.id,
      label,
      provider: providerName(m.id),
      pricePerThoughtUsd:
        direct ?? (input != null && output != null ? thoughtPriceUsd({ inputMicroUsdcPerKTokens: input, outputMicroUsdcPerKTokens: output }, margin) : null),
    });
  }
  return { minds, images };
}

async function relayModels(): Promise<NonNullable<typeof cache>> {
  const now = Date.now();
  if (cache && now - cache.at < cache.ttl) return cache;
  const base = inferenceUrl();
  let next: NonNullable<typeof cache> = { at: now, ttl: FAILURE_TTL_MS, source: 'fallback', models: FALLBACK_MODELS, imageModels: FALLBACK_IMAGE_MODELS };
  if (base) {
    try {
      const res = await fetch(`${base}/v1/models`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`relay responded ${res.status}`);
      const { minds, images } = fromRelay((await res.json()) as RelayList);
      if (minds.length === 0) throw new Error('relay listed no models');
      // a relay without image models (an older price table) keeps the built-in image list
      next = { at: now, ttl: TTL_MS, source: 'relay', models: minds, imageModels: images.length ? images : FALLBACK_IMAGE_MODELS };
    } catch (e) {
      console.warn(`[api/models] relay unavailable, using the built-in list: ${(e as Error).message}`);
    }
  } else {
    next.ttl = TTL_MS;
  }
  cache = next;
  return next;
}

export async function GET(req: NextRequest) {
  await connection();
  const headers = { 'Cache-Control': 'public, max-age=60' };
  if (req.nextUrl.searchParams.get('kind') === 'image') {
    const { source, imageModels } = await relayModels();
    const body: ImageModelsResponse = { source, image: IMAGE, models: imageModels };
    return NextResponse.json(body, { headers });
  }
  const [{ source, models }, cfg] = await Promise.all([relayModels(), readConfig()]);
  const body: ModelsResponse = { source, thought: THOUGHT, models: filterAllowedModels(models, cfg.allowedModels) };
  return NextResponse.json(body, { headers });
}
