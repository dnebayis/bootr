import { API_PAGE_HEADERS, parseCatalog, renderApiPage, type ApiCatalog } from './api-page.js';
import { log } from './log.js';

/**
 * The web app's public catalogue, for the page at `GET /`. One fixed URL from config, nothing from the request.
 * At most one fetch at a time, so a flood of page views costs the web app at most one request per TTL (or per
 * retry interval while it is down). Once data exists a reader never waits: it gets what is held, stale or not,
 * while a refresh runs behind it. Only a reader with no data at all waits, for at most `timeoutMs`.
 */

export const CATALOG_TTL_MS = 5 * 60_000;
export const CATALOG_RETRY_MS = 30_000;
export const CATALOG_TIMEOUT_MS = 3_000;
/** The real document is well under this; anything far above it is not the catalogue. */
export const CATALOG_MAX_BYTES = 2 * 1024 * 1024;

export interface CatalogSourceOptions {
  url: string;
  now: () => number;
  fetch?: typeof fetch;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

export class CatalogSource {
  private catalog: ApiCatalog | null = null;
  private nextAttemptAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: CatalogSourceOptions) {}

  /** Never rejects: a failed refresh leaves whatever was held, which may be nothing. */
  async get(): Promise<ApiCatalog | null> {
    if (!this.inflight && this.opts.now() >= this.nextAttemptAt) this.inflight = this.refresh();
    if (!this.catalog && this.inflight) await this.inflight;
    return this.catalog;
  }

  private async refresh(): Promise<void> {
    const { now, ttlMs = CATALOG_TTL_MS, retryMs = CATALOG_RETRY_MS } = this.opts;
    try {
      this.catalog = await this.load();
      this.nextAttemptAt = now() + ttlMs;
    } catch (err) {
      this.nextAttemptAt = now() + retryMs;
      log.warn('catalog fetch failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inflight = null;
    }
  }

  private async load(): Promise<ApiCatalog> {
    const {
      url,
      fetch: doFetch = fetch,
      timeoutMs = CATALOG_TIMEOUT_MS,
      maxBytes = CATALOG_MAX_BYTES,
    } = this.opts;
    const res = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'bootr-sender' },
      // The timeout also covers reading the body. A redirect could lead anywhere, so it counts as a failure.
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const catalog = parseCatalog(JSON.parse(await readCapped(res, maxBytes)));
    if (!catalog) throw new Error('unusable catalogue');
    return catalog;
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('catalogue too large');
    }
    text += decoder.decode(value, { stream: true });
  }
}

export interface ApiPageServiceOptions {
  siteUrl: string;
  now: () => number;
  fetch?: typeof fetch;
}

/** The `GET /` handler: always a 200 page. No database, tokens or sessions anywhere on this path. */
export function createApiPageHandler(opts: ApiPageServiceOptions): () => Promise<Response> {
  const site = opts.siteUrl.replace(/\/+$/, '');
  const source = new CatalogSource({
    url: `${site}/api/catalog`,
    now: opts.now,
    fetch: opts.fetch,
  });
  const options = { siteUrl: site };
  let rendered: { catalog: ApiCatalog | null; html: string } | null = null;

  return async () => {
    let html: string;
    try {
      const catalog = await source.get();
      if (!rendered || rendered.catalog !== catalog)
        rendered = { catalog, html: renderApiPage(catalog, options) };
      html = rendered.html;
    } catch (err) {
      log.error('api page render failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
      html = renderApiPage(null, options);
    }
    // A new Headers each time: the node server writes Content-Length into a plain object it is handed, so a shared
    // one would keep the first page's length and cut off (or stall) every later page of a different length.
    return new Response(html, { status: 200, headers: new Headers(API_PAGE_HEADERS) });
  };
}
