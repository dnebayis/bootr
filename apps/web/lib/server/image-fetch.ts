import { IDENTITY_ENCODING, publicHostProblem, readBodyCapped, type Resolve } from '@bootr/shared/public-fetch';

if (typeof window !== 'undefined') throw new Error('lib/server/image-fetch must not be imported in the browser');

const MAX_REDIRECTS = 3;

export interface ImageFetchOptions {
  fetch?: typeof fetch;
  resolve?: Resolve;
  timeoutMs?: number;
}

export type ImageFetch = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

/**
 * The image behind a URL a caller of the agent API named (`POST /api/agent/launch`, `image.url`), under the rules
 * the agents' `read_url` follows: https only, every host resolved and checked against private ranges before it is
 * contacted, redirects followed by hand with the same check on every hop, no compression asked for, and the body
 * read as a stream that stops at `maxBytes`. The messages say what to do instead; they never echo the URL.
 */
export async function fetchImageFromUrl(url: string, maxBytes: number, opts: ImageFetchOptions = {}): Promise<ImageFetch> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { ok: false, error: 'image.url is not a URL: send a public https URL, or use image.dataUrl.' };
  }
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:' || current.username || current.password) {
      return { ok: false, error: hop === 0 ? 'image.url must use https: host the image there, or use image.dataUrl.' : 'image.url redirects to a URL that is not plain https: host the image on a public https URL, or use image.dataUrl.' };
    }
    const problem = await publicHostProblem(current.hostname, opts.resolve);
    if (problem === 'url_private_host') return { ok: false, error: 'image.url must point at a public host (a redirect to one counts): host the image on a public https URL, or use image.dataUrl.' };
    if (problem === 'url_unresolvable_host') return { ok: false, error: 'image.url names a host that does not resolve: check the URL, or use image.dataUrl.' };
    try {
      res = await doFetch(current.toString(), { redirect: 'manual', headers: { accept: 'image/*', ...IDENTITY_ENCODING }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    } catch {
      return { ok: false, error: 'image.url could not be fetched within 8 seconds: check that it is public, or use image.dataUrl.' };
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, error: 'image.url redirects to an invalid URL: host the image on a public https URL, or use image.dataUrl.' };
      }
      res = null;
      continue;
    }
    break;
  }
  if (!res) return { ok: false, error: `image.url redirects more than ${MAX_REDIRECTS} times: link the image directly, or use image.dataUrl.` };
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, error: `image.url responded ${res.status}: check that it is public, or use image.dataUrl.` };
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, error: `image is ${declared} bytes: it must be at most ${Math.floor(maxBytes / (1024 * 1024))} MB.` };
  }
  let body: { bytes: Uint8Array; exceeded: boolean };
  try {
    body = await readBodyCapped(res, maxBytes);
  } catch {
    return { ok: false, error: 'image.url could not be read: check that it is public, or use image.dataUrl.' };
  }
  if (body.exceeded) return { ok: false, error: `image is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB: send a smaller image, or use image.dataUrl.` };
  return { ok: true, bytes: body.bytes };
}
