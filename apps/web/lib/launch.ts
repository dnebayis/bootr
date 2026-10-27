import { keccak256, toHex, type Hex } from 'viem';
import { FALLBACK_MODELS, THOUGHT, type ModelsResponse } from './models';

export { FALLBACK_MODELS, filterAllowedModels, type ModelOption } from './models';

/**
 * Models offered to new agents, priced per thought. Always via this app's `/api/models`: the relay
 * is internal in production, and the route applies the admin allowlist. Falls back to the built-in
 * list (unfiltered) only when the route itself is unreachable.
 */
export async function fetchModels(): Promise<ModelsResponse> {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as Partial<ModelsResponse>;
    if (!Array.isArray(j.models)) throw new Error('bad response');
    return { source: j.source === 'relay' ? 'relay' : 'fallback', thought: THOUGHT, models: j.models };
  } catch {
    return { source: 'fallback', thought: THOUGHT, models: FALLBACK_MODELS };
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
