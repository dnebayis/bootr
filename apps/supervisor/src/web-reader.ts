/**
 * `read_url` / `search_web` executors. Public https only: the host is resolved first and every
 * address must be public (no loopback, link-local, RFC1918, CGNAT, multicast or IPv6 private ranges),
 * redirects are followed manually with the same check, bodies are capped and reduced to text.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PolicyError } from '@bootr/agent-core';

export const MAX_TEXT_CHARS = 4000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
    return false;
  }
  return true;
}

export async function assertPublicHost(hostname: string, resolve: (h: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true })): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new PolicyError('url_private_host');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new PolicyError('url_private_host');
    return;
  }
  let records: { address: string }[];
  try {
    records = await resolve(host);
  } catch {
    throw new PolicyError('url_unresolvable_host');
  }
  if (!records.length || records.some((r) => isPrivateIp(r.address))) throw new PolicyError('url_private_host');
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

export async function readUrl(rawUrl: string, opts: WebReaderOptions = {}): Promise<ReadUrlResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  let current = new URL(rawUrl);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:' || current.username || current.password) throw new PolicyError('url_not_public_https');
    await assertPublicHost(current.hostname, opts.resolve);
    res = await doFetch(current.toString(), {
      redirect: 'manual',
      headers: { 'user-agent': 'BootrAgent/1.0 (+https://bootr.fun)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location') as string, current);
      continue;
    }
    break;
  }
  if (!res) throw new PolicyError('url_unreachable');
  const contentType = res.headers.get('content-type');
  const buf = Buffer.from(await res.arrayBuffer());
  const body = buf.subarray(0, MAX_BODY_BYTES).toString('utf8');
  const isHtml = !contentType || /html|xml/i.test(contentType);
  const full = isHtml ? htmlToText(body) : body.replace(/\s+/g, ' ').trim();
  return {
    url: rawUrl,
    finalUrl: current.toString(),
    status: res.status,
    contentType,
    fetchedAt: new Date().toISOString(),
    text: full.slice(0, MAX_TEXT_CHARS),
    truncated: full.length > MAX_TEXT_CHARS,
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
