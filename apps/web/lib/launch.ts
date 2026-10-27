import { keccak256, toHex, type Hex } from 'viem';
import { UPLOAD_IMAGE_TYPES, UPLOAD_MAX_BYTES, type UploadResult } from './ipfs';
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

/** Client-side pre-check for `/api/upload` (the server re-checks by magic bytes). Null when acceptable. */
export function imageFileProblem(file: File): string | null {
  if (!(UPLOAD_IMAGE_TYPES as readonly string[]).includes(file.type)) return 'Use a PNG, JPG, WebP or SVG image.';
  if (file.size > UPLOAD_MAX_BYTES) return 'Image must be at most 2 MB.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

/**
 * Pins a token image to IPFS via `POST /api/upload` (XHR, for upload progress). Rejects with a
 * user-facing message. `signal` aborts the request.
 */
export function uploadImage(file: File, draftId: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file);
    form.append('draftId', draftId);
    xhr.open('POST', '/api/upload');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as (Partial<UploadResult> & { message?: unknown }) | null;
      if (xhr.status === 200 && typeof body?.url === 'string' && typeof body.ipfsUri === 'string' && typeof body.cid === 'string') {
        resolve({ cid: body.cid, ipfsUri: body.ipfsUri, url: body.url, ...(body.mock ? { mock: true as const } : {}) });
      } else {
        reject(new Error(typeof body?.message === 'string' ? body.message : `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
