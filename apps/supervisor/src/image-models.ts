/**
 * The image models a creator may pick (`imageModel` in the agent config): the relay's `GET /v1/models` entries whose
 * `output_modalities` include `image` (apps/inference/src/pricing.ts prices them). Read with the supervisor's plain
 * fetch (the listing is public and unpaid), cached a few minutes per process; when the relay cannot be reached the
 * built-in three are accepted so the console keeps working.
 */
import type { SupervisorContext } from './context.js';

/** The relay's image models as of 2026-11-04; the relay's own list wins when it answers. */
export const FALLBACK_IMAGE_MODELS: readonly string[] = ['google/gemini-3-pro-image', 'google/gemini-3.1-flash-image', 'openai/gpt-5.4-image-2'];

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

/** One cache per supervisor config object (one per process; tests get their own). */
const cache = new WeakMap<object, { at: number; ids: readonly string[] }>();

export async function relayImageModels(ctx: Pick<SupervisorContext, 'config' | 'fetch' | 'now' | 'log'>): Promise<readonly string[]> {
  const hit = cache.get(ctx.config);
  if (hit && ctx.now() - hit.at < TTL_MS) return hit.ids;
  try {
    const res = await ctx.fetch(new URL('/v1/models', ctx.config.INFERENCE_PROVIDER_URL).toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`relay responded ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown; output_modalities?: unknown }[] } | null;
    const ids = (Array.isArray(body?.data) ? body.data : [])
      .filter((m) => typeof m?.id === 'string' && Array.isArray(m.output_modalities) && m.output_modalities.includes('image'))
      .map((m) => m.id as string);
    if (!ids.length) throw new Error('relay listed no image models');
    cache.set(ctx.config, { at: ctx.now(), ids });
    return ids;
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not list the relay image models; accepting the built-in list');
    return FALLBACK_IMAGE_MODELS;
  }
}
