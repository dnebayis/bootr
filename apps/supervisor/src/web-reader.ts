/**
 * `read_url` / `search_web` executors. Public https only: the host is resolved first and every
 * address must be public (no loopback, link-local, RFC1918, CGNAT, multicast or IPv6 private ranges),
 * redirects are followed manually with the same check, bodies are read as a stream under a byte cap
 * (`@bootr/shared/public-fetch`, shared with the web's launch route) and reduced to text.
 */
import { PolicyError } from '@bootr/agent-core';
import { IDENTITY_ENCODING, publicHostProblem, readBodyCapped, type Resolve } from '@bootr/shared/public-fetch';

export { isPrivateIp } from '@bootr/shared/public-fetch';

export const MAX_TEXT_CHARS = 4000;
/** Bytes of a page read at most; the rest of the body is cancelled, never buffered. */
export const MAX_BODY_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

export async function assertPublicHost(hostname: string, resolve?: Resolve): Promise<void> {
  const problem = await publicHostProblem(hostname, resolve);
  if (problem) throw new PolicyError(problem);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export interface ReadUrlResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  fetchedAt: string;
  text: string;
  truncated: boolean;
  untrusted: true;
}

export interface WebReaderOptions {
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<{ address: string }[]>;
  timeoutMs?: number;
}

export interface PublicFetchOptions extends WebReaderOptions {
  /** Request headers on top of the reader's own (a conditional GET's `if-none-match`, an `accept`). */
  headers?: Record<string, string>;
  /** Bytes of the body read at most; MAX_BODY_BYTES when unset. */
  maxBytes?: number;
}

export interface PublicResponse {
  finalUrl: string;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  /** The body was longer than the cap: `bytes` is its start. */
  exceeded: boolean;
}

/**
 * One GET of a URL somebody else chose, under every rule of this file: https only, no credentials in the URL, the host
 * resolved and refused when any address is private, at most MAX_REDIRECTS redirects followed by hand with the same
 * checks on every hop, a time limit per hop that also covers the body, and the body read as a stream under a byte cap.
 * `read_url` and the dataset's source readers (dataset/fetch.ts) both go through here: there is no second fetcher.
 */
export async function fetchPublic(rawUrl: string, opts: PublicFetchOptions = {}): Promise<PublicResponse> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  let current = new URL(rawUrl);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:' || current.username || current.password) throw new PolicyError('url_not_public_https');
    await assertPublicHost(current.hostname, opts.resolve);
    res = await doFetch(current.toString(), {
      redirect: 'manual',
      headers: { 'user-agent': 'BootrAgent/1.0 (+https://bootr.fun)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5', ...opts.headers, ...IDENTITY_ENCODING },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(res.headers.get('location') as string, current);
      continue;
    }
    break;
  }
  if (!res) throw new PolicyError('url_unreachable');
  // The body is read as a stream and cut at the cap: a page that never ends, or a compressed bomb that fetch
  // inflates, costs at most that much memory.
  const { bytes, exceeded } = await readBodyCapped(res, opts.maxBytes ?? MAX_BODY_BYTES);
  return { finalUrl: current.toString(), status: res.status, headers: res.headers, bytes, exceeded };
}

export async function readUrl(rawUrl: string, opts: WebReaderOptions = {}): Promise<ReadUrlResult> {
  const res = await fetchPublic(rawUrl, opts);
  const contentType = res.headers.get('content-type');
  const body = Buffer.from(res.bytes.buffer, res.bytes.byteOffset, res.bytes.byteLength).toString('utf8');
  const isHtml = !contentType || /html|xml/i.test(contentType);
  const full = isHtml ? htmlToText(body) : body.replace(/\s+/g, ' ').trim();
  return {
    url: rawUrl,
    finalUrl: res.finalUrl,
    status: res.status,
    contentType,
    fetchedAt: new Date().toISOString(),
    text: full.slice(0, MAX_TEXT_CHARS),
    truncated: res.exceeded || full.length > MAX_TEXT_CHARS,
    untrusted: true,
  };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
}

/** Exa (`/search`) or Brave (`/res/v1/web/search`) depending on the configured URL. */
export async function searchWeb(query: string, api: { url: string; key: string }, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ query: string; results: SearchResult[]; searchedAt: string; untrusted: true }> {
  const url = new URL(api.url);
  const searchedAt = new Date().toISOString();
  let results: SearchResult[] = [];
  if (/brave/i.test(url.hostname)) {
    url.searchParams.set('q', query);
    url.searchParams.set('count', '5');
    const res = await fetchImpl(url.toString(), { headers: { 'X-Subscription-Token': api.key, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new PolicyError('search_unavailable', { message: `search_unavailable: ${res.status}` });
    const json = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string; age?: string }[] } };
    results = (json.web?.results ?? []).slice(0, 5).map((r) => ({ title: r.title, url: r.url, snippet: (r.description ?? '').slice(0, 400), publishedAt: r.age ?? null }));
  } else {
    const res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'x-api-key': api.key, 'content-type': 'application/json' },
      body: JSON.stringify({ query, numResults: 5, contents: { text: { maxCharacters: 400 } } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new PolicyError('search_unavailable', { message: `search_unavailable: ${res.status}` });
    const json = (await res.json()) as { results?: { title: string; url: string; text?: string; publishedDate?: string }[] };
    results = (json.results ?? []).slice(0, 5).map((r) => ({ title: r.title, url: r.url, snippet: (r.text ?? '').slice(0, 400), publishedAt: r.publishedDate ?? null }));
  }
  const text = JSON.stringify(results);
  if (text.length > MAX_TEXT_CHARS) results = results.map((r) => ({ ...r, snippet: r.snippet.slice(0, 150) }));
  return { query, results, searchedAt, untrusted: true };
}
