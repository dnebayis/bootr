import { keccak256, toHex, type Hex } from 'viem';
import { env } from './env';

export type ModelOption = { id: string; label: string; pricePerThoughtUsd: number | null };

/**
 * Fallback when NEXT_PUBLIC_INFERENCE_URL is unset or unreachable.
 * TODO(inference): prices are estimates; the inference gateway's /v1/models is authoritative.
 */
export const FALLBACK_MODELS: ModelOption[] = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', pricePerThoughtUsd: 0.002 },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', pricePerThoughtUsd: 0.012 },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', pricePerThoughtUsd: 0.003 },
  { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', pricePerThoughtUsd: 0.001 },
];

type RawModel = {
  id: string;
  name?: string;
  pricePerThoughtUsd?: number;
  price_per_thought_usd?: number;
  pricing?: { thought?: number | string; per_thought_usd?: number | string };
};

export async function fetchModels(): Promise<{ models: ModelOption[]; source: 'gateway' | 'fallback' }> {
  if (!env.inferenceUrl) return { models: FALLBACK_MODELS, source: 'fallback' };
  try {
    const res = await fetch(`${env.inferenceUrl}/v1/models`);
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as { data?: RawModel[] } | RawModel[];
    const list = Array.isArray(json) ? json : (json.data ?? []);
    if (list.length === 0) throw new Error('empty');
    return {
      source: 'gateway',
      models: list.map((m) => {
        const p = m.pricePerThoughtUsd ?? m.price_per_thought_usd ?? m.pricing?.per_thought_usd ?? m.pricing?.thought;
        const n = p == null ? null : Number(p);
        return { id: m.id, label: m.name ?? m.id, pricePerThoughtUsd: n != null && Number.isFinite(n) ? n : null };
      }),
    };
  } catch {
    return { models: FALLBACK_MODELS, source: 'fallback' };
  }
}

export type PlatformFlags = { launchesPaused: boolean; allowedModels: string[] };

/** Public platform switches set in the admin console (`/api/platform`). Null when unavailable. */
export async function fetchPlatformFlags(): Promise<PlatformFlags | null> {
  try {
    const res = await fetch('/api/platform', { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<PlatformFlags>;
    return {
      launchesPaused: j.launchesPaused === true,
      allowedModels: Array.isArray(j.allowedModels) ? j.allowedModels.filter((m): m is string => typeof m === 'string') : [],
    };
  } catch {
    return null;
  }
}

/** `anthropic/claude-haiku-4.5` and `claude-haiku-4-5` name the same model. */
function modelKey(id: string): string {
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

export type WorkerTemplate = { id: 'trader' | 'researcher' | 'community'; label: string; description: string; hash: Hex };

/** TODO(agent-core): replace placeholder hashes with the published worker bundle hashes. */
export const WORKER_TEMPLATES: WorkerTemplate[] = [
  {
    id: 'trader',
    label: 'Trader',
    description: 'Watches its own market, claims fees, rebalances the treasury and reports trades.',
    hash: keccak256(toHex('bootr-worker:trader:v0')),
  },
  {
    id: 'researcher',
    label: 'Researcher',
    description: 'Reads onchain data and X, posts short findings about its niche on a schedule.',
    hash: keccak256(toHex('bootr-worker:researcher:v0')),
  },
  {
    id: 'community',
    label: 'Community',
    description: 'Answers mentions, welcomes new holders and posts updates about the coin.',
    hash: keccak256(toHex('bootr-worker:community:v0')),
  },
];

/** Downscale an uploaded image to a small square data URL (calldata-friendly). TODO: upload to IPFS. */
export async function fileToSquareDataUrl(file: File, size = 192): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  const s = Math.min(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, (bitmap.width - s) / 2, (bitmap.height - s) / 2, s, s, 0, 0, size, size);
  return canvas.toDataURL('image/webp', 0.82);
}
