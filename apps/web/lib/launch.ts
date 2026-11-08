import { WORKER_TEMPLATES as SHARED_WORKER_TEMPLATES, type WorkerTemplate as SharedWorkerTemplate } from '@bootr/shared/workers';
import { UPLOAD_IMAGE_TYPES, UPLOAD_MAX_BYTES, type UploadResult } from './ipfs';
import { FALLBACK_IMAGE_MODELS, FALLBACK_MODELS, IMAGE, THOUGHT, type ImageModelsResponse, type ModelsResponse } from './models';

export { FALLBACK_MODELS, filterAllowedModels, type ModelOption } from './models';

/**
 * Models offered to new agents, priced per thought as the agent pays BlockRun for one. Always via this app's
 * `/api/models`, which applies the admin allowlist. Falls back to the whole catalog (unfiltered) only when the route
 * itself is unreachable.
 */
/** The image models a creator can pick for an agent, priced per picture (`/api/models?kind=image`). */
export async function fetchImageModels(): Promise<ImageModelsResponse> {
  try {
    const res = await fetch('/api/models?kind=image');
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as Partial<ImageModelsResponse>;
    if (!Array.isArray(j.models)) throw new Error('bad response');
    return { source: 'blockrun', image: IMAGE, models: j.models };
  } catch {
    return { source: 'blockrun', image: IMAGE, models: FALLBACK_IMAGE_MODELS };
  }
}

export async function fetchModels(): Promise<ModelsResponse> {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as Partial<ModelsResponse>;
    if (!Array.isArray(j.models)) throw new Error('bad response');
    return { source: 'blockrun', thought: THOUGHT, models: j.models };
  } catch {
    return { source: 'blockrun', thought: THOUGHT, models: FALLBACK_MODELS };
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

export type WorkerTemplate = SharedWorkerTemplate;

/** The worker templates, shared with the supervisor (`@bootr/shared` workers): the hash on-chain commits to the preset. */
export const WORKER_TEMPLATES: readonly WorkerTemplate[] = SHARED_WORKER_TEMPLATES;

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
