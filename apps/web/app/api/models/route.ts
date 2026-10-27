import { connection, NextResponse } from 'next/server';
import { readConfig } from '@/lib/server/admin-config';
import { inferenceUrl } from '@/lib/server/env';
import {
  FALLBACK_MODELS,
  filterAllowedModels,
  modelLabel,
  providerName,
  RELAY_MARGIN,
  THOUGHT,
  thoughtPriceUsd,
  type ModelOption,
  type ModelsResponse,
} from '@/lib/models';

/**
 * GET /api/models -> ModelsResponse
 * The relay is internal in production, so the browser never calls `/v1/models` itself. This route
 * reads it server-side (cached 60 s per instance), prices one thought per model the way the relay
 * quotes, and keeps only the admin's `allowedModels` (same matching as the launch form used to do).
 * Unreachable or unset relay: the built-in list, filtered the same way.
 */

const TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const TIMEOUT_MS = 5_000;

type RelayModel = {
  id?: unknown;
  name?: unknown;
  pricing?: { input_micro_usdc_per_1k_tokens?: unknown; output_micro_usdc_per_1k_tokens?: unknown };
  price_per_thought_usd?: unknown;
};
type RelayList = { data?: RelayModel[]; margin?: { bps?: unknown; fixedMicroUsdc?: unknown } };

let cache: { at: number; ttl: number; source: ModelsResponse['source']; models: ModelOption[] } | null = null;

function finite(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Maps the relay's `/v1/models` body to picker options. */
function fromRelay(body: RelayList): ModelOption[] {
  const margin = {
    bps: finite(body.margin?.bps) ?? RELAY_MARGIN.bps,
    fixedMicroUsdc: finite(body.margin?.fixedMicroUsdc) ?? RELAY_MARGIN.fixedMicroUsdc,
  };
  const out: ModelOption[] = [];
  for (const m of body.data ?? []) {
    if (typeof m.id !== 'string' || !/^[\w.:/-]{1,80}$/.test(m.id)) continue;
    const input = finite(m.pricing?.input_micro_usdc_per_1k_tokens);
    const output = finite(m.pricing?.output_micro_usdc_per_1k_tokens);
    const direct = finite(m.price_per_thought_usd);
    out.push({
      id: m.id,
      label: typeof m.name === 'string' && m.name ? m.name.slice(0, 60) : modelLabel(m.id),
      provider: providerName(m.id),
      pricePerThoughtUsd:
        direct ?? (input != null && output != null ? thoughtPriceUsd({ inputMicroUsdcPerKTokens: input, outputMicroUsdcPerKTokens: output }, margin) : null),
    });
  }
  return out;
}

async function relayModels(): Promise<{ source: ModelsResponse['source']; models: ModelOption[] }> {
  const now = Date.now();
  if (cache && now - cache.at < cache.ttl) return cache;
  const base = inferenceUrl();
  let next: typeof cache = { at: now, ttl: FAILURE_TTL_MS, source: 'fallback', models: FALLBACK_MODELS };
  if (base) {
    try {
      const res = await fetch(`${base}/v1/models`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`relay responded ${res.status}`);
      const models = fromRelay((await res.json()) as RelayList);
      if (models.length === 0) throw new Error('relay listed no models');
      next = { at: now, ttl: TTL_MS, source: 'relay', models };
    } catch (e) {
      console.warn(`[api/models] relay unavailable, using the built-in list: ${(e as Error).message}`);
    }
  } else {
    next.ttl = TTL_MS;
  }
  cache = next;
  return next;
}

export async function GET() {
  await connection();
  const [{ source, models }, cfg] = await Promise.all([relayModels(), readConfig()]);
  const body: ModelsResponse = { source, thought: THOUGHT, models: filterAllowedModels(models, cfg.allowedModels) };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
