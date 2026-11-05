import { z } from 'zod';

/**
 * The plain public page at `GET /` of the sender's host: Bootr's public APIs, as the web app's `GET /api/catalog`
 * lists them. Pure rendering: no fetching, no clock, no database. Catalogue text is untrusted, so every field is
 * escaped and a URL only becomes a link when it is http(s). The sender's own `/public/*` and OAuth routes appear
 * only if the catalogue lists them.
 */

export const DEFAULT_SITE_URL = 'https://bootr.fun';
export const X_URL = 'https://x.com/bootrfun';

/** Above this many models the table stops and the rest stay in the catalogue. */
export const MAX_MODEL_ROWS = 50;

export const API_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};

// ---------------- The catalogue, read defensively ----------------

const optionalString = z.string().optional().catch(undefined);

const endpointSchema = z.object({
  service: optionalString,
  method: z.string().min(1),
  url: z.string().min(1),
  description: optionalString,
  auth: z.object({ type: z.string() }).optional().catch(undefined),
  rateLimit: z
    .object({
      limit: z.number().int().positive(),
      windowSeconds: z.number().int().positive(),
      per: optionalString,
    })
    .optional()
    .catch(undefined),
  response: z.object({ contentType: z.string() }).optional().catch(undefined),
});

const modelSchema = z.object({
  id: z.string().min(1),
  pricePerThoughtUsd: z.number().finite().nonnegative().nullable().catch(null),
});

export type ApiEndpoint = z.infer<typeof endpointSchema>;
export type ApiModel = z.infer<typeof modelSchema>;

export interface ApiCatalog {
  docs?: string;
  endpoints: ApiEndpoint[];
  pricing?: { note?: string; models: ApiModel[] };
}

/** Keeps the entries that make sense and drops the rest, row by row. Null when no endpoint is usable. */
export function parseCatalog(value: unknown): ApiCatalog | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.endpoints)) return null;
  const endpoints = keepValid(endpointSchema, raw.endpoints);
  if (endpoints.length === 0) return null;

  const pricing = raw.pricing as { note?: unknown; models?: unknown } | null | undefined;
  const models = Array.isArray(pricing?.models) ? keepValid(modelSchema, pricing.models) : [];
  return {
    docs: optionalString.parse(raw.docs),
    endpoints,
    ...(models.length > 0
      ? { pricing: { note: optionalString.parse(pricing?.note), models } }
      : {}),
  };
}

function keepValid<S extends z.ZodTypeAny>(schema: S, rows: unknown[]): z.infer<S>[] {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data as z.infer<S>] : [];
  });
}

// ---------------- Safe output ----------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** The URL's normal form when it is http(s) without credentials; null for anything else. */
export function safeHttpUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.href;
}

/** A link when the URL is safe, its label as plain text when not. */
function link(href: string, label: string): string {
  const safe = safeHttpUrl(href);
  return safe ? `<a href="${escapeHtml(safe)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

// ---------------- Grouping ----------------

export const SECTION_TITLES = [
  'Launch and agents',
  'Coins and market',
  'Models and pricing',
  'Docs and discovery',
  'Other',
] as const;
export type SectionTitle = (typeof SECTION_TITLES)[number];

const SECTION_RULES: readonly (readonly [SectionTitle, RegExp])[] = [
  ['Docs and discovery', /^\/(api\/catalog|llms[\w-]*\.txt|sitemap\.xml|docs|skill)(\/|\.|$)/],
  ['Models and pricing', /^\/api\/models(\/|$)/],
  ['Launch and agents', /^\/(api\/agents?|agents|treasury|api\/platform)(\/|$)/],
  ['Coins and market', /^\/(market|tokens?|search|holdings|fuel|platform|graphql|stream)(\/|$)/],
];

function pathOf(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(url)?.[1] ?? '';
}

/** Non-empty sections in display order, rows in catalogue order. An endpoint no rule knows goes under Other. */
export function groupEndpoints(
  endpoints: ApiEndpoint[],
): { title: SectionTitle; rows: ApiEndpoint[] }[] {
  const groups = new Map<SectionTitle, ApiEndpoint[]>();
  for (const endpoint of endpoints) {
    const path = pathOf(endpoint.url);
    const title = SECTION_RULES.find(([, rule]) => rule.test(path))?.[0] ?? 'Other';
    groups.set(title, [...(groups.get(title) ?? []), endpoint]);
  }
  return SECTION_TITLES.flatMap((title) => {
    const rows = groups.get(title);
    return rows ? [{ title, rows }] : [];
  });
}

// ---------------- Rendering ----------------

const SERVICE_LABELS: Record<string, string> = { web: 'Site and agent API', indexer: 'Indexer' };

function authLabel(endpoint: ApiEndpoint): string | null {
  if (endpoint.auth?.type === 'none') return 'No auth';
  if (endpoint.auth?.type === 'siwe') return 'Signed wallet message (SIWE)';
  return null;
}

function rateLimitLabel({ rateLimit }: ApiEndpoint): string | null {
  if (!rateLimit) return null;
  const window = rateLimit.windowSeconds === 60 ? 'minute' : `${rateLimit.windowSeconds} s`;
  const per = rateLimit.per === 'ip' ? ' per IP' : '';
  return `${rateLimit.limit} requests per ${window}${per}`;
}

/** A row links only where opening it does something: a concrete GET, not a template, a POST or an endless stream. */
function isOpenable(endpoint: ApiEndpoint): boolean {
  return (
    endpoint.method === 'GET' &&
    !endpoint.url.includes('{') &&
    endpoint.response?.contentType !== 'text/event-stream'
  );
}

function renderRow(endpoint: ApiEndpoint): string {
  const target = isOpenable(endpoint) ? link(endpoint.url, endpoint.url) : escapeHtml(endpoint.url);
  const meta = [authLabel(endpoint), rateLimitLabel(endpoint)]
    .filter((part) => part !== null)
    .join(' · ');
  return [
    '<li class="row">',
    `<span class="method">${escapeHtml(endpoint.method)}</span>`,
    '<div class="detail">',
    `<code class="url">${target}</code>`,
    endpoint.description ? `<p>${escapeHtml(endpoint.description)}</p>` : '',
    meta ? `<p class="meta">${escapeHtml(meta)}</p>` : '',
    '</div></li>',
  ].join('');
}

/** `$0.0101` style: three significant digits, never scientific notation (apps/web's formatThoughtPrice). */
function formatPrice(usd: number | null): string {
  if (usd === null) return 'No price';
  if (usd === 0) return '$0';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const digits = Math.max(2, Math.min(6, 2 - Math.floor(Math.log10(usd))));
  return `$${usd.toFixed(digits)}`;
}

function renderPricing(pricing: NonNullable<ApiCatalog['pricing']>, catalogUrl: string): string {
  const shown = pricing.models.slice(0, MAX_MODEL_ROWS);
  const hidden = pricing.models.length - shown.length;
  const rows = shown
    .map(
      (m) =>
        `<tr><td><code>${escapeHtml(m.id)}</code></td><td class="price">${formatPrice(m.pricePerThoughtUsd)}</td></tr>`,
    )
    .join('');
  return [
    '<table><thead><tr><th scope="col">Model</th><th scope="col" class="price">USDC per thought</th></tr></thead>',
    `<tbody>${rows}</tbody></table>`,
    hidden > 0 ? `<p class="meta">${hidden} more in the ${link(catalogUrl, 'catalogue')}.</p>` : '',
    pricing.note ? `<p class="meta">${escapeHtml(pricing.note)}</p>` : '',
  ].join('');
}

/** Each distinct origin the catalogue names, with the service that answers there. */
function baseUrls(catalog: ApiCatalog): { label: string; url: string }[] {
  const origins = new Map<string, string>();
  for (const endpoint of catalog.endpoints) {
    const safe = safeHttpUrl(endpoint.url);
    if (!safe) continue;
    const origin = new URL(safe).origin;
    if (!origins.has(origin))
      origins.set(origin, SERVICE_LABELS[endpoint.service ?? ''] ?? endpoint.service ?? 'API');
  }
  return [...origins].map(([url, label]) => ({ label, url }));
}

const STYLES = `
:root {
  color-scheme: dark light;
  --canvas: #0a0b0d;
  --ink: #ffffff;
  --body: #b1b7c3;
  --mute: #818895;
  --hairline: #32353d;
  --link: #3c8aff;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    --canvas: #ffffff;
    --ink: #0a0b0d;
    --body: #32353d;
    --mute: #5b616e;
    --hairline: #dee1e7;
    --link: #0000ff;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; background: var(--canvas); }
body {
  margin: 0 auto;
  max-width: 860px;
  padding: 48px 24px 32px;
  background: var(--canvas);
  color: var(--body);
  font: 15px/1.55 var(--sans);
  overflow-wrap: break-word;
}
h1, h2 { color: var(--ink); font-weight: 600; margin: 0; }
h1 { font-size: 28px; line-height: 1.2; letter-spacing: -0.02em; }
h2 { font-size: 16px; line-height: 1.3; padding-bottom: 10px; border-bottom: 1px solid var(--hairline); }
p { margin: 0; }
a { color: var(--link); text-underline-offset: 2px; }
a:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
code { font-family: var(--mono); font-size: 13.5px; overflow-wrap: anywhere; }
main > p { margin-top: 12px; }
section { margin-top: 40px; }
ul { list-style: none; margin: 0; padding: 0; }
.row { display: grid; grid-template-columns: 3.5em minmax(0, 1fr); gap: 0 8px; padding: 12px 0; border-bottom: 1px solid var(--hairline); }
.method { font: 500 13px/1.6 var(--mono); color: var(--mute); }
.url { color: var(--ink); line-height: 1.6; }
.detail p { margin-top: 4px; }
.meta { color: var(--mute); font-size: 13px; }
.detail .meta { margin-top: 2px; }
.pair { display: grid; grid-template-columns: minmax(0, 11em) minmax(0, 1fr); gap: 0 16px; padding: 10px 0; border-bottom: 1px solid var(--hairline); }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { padding: 8px 0; border-bottom: 1px solid var(--hairline); text-align: left; vertical-align: top; }
th { color: var(--mute); font-size: 13px; font-weight: 500; }
td code { color: var(--ink); }
th.price, td.price { padding-left: 16px; text-align: right; white-space: nowrap; }
td.price { font-family: var(--mono); font-size: 13.5px; font-variant-numeric: tabular-nums; }
table + .meta, .meta + .meta { margin-top: 12px; }
footer { margin-top: 56px; padding-top: 12px; border-top: 1px solid var(--hairline); color: var(--mute); font-size: 13px; }
footer ul { display: flex; flex-wrap: wrap; gap: 0 20px; }
footer li { padding: 8px 0; }
@media (max-width: 520px) {
  body { padding: 32px 16px 24px; }
  .pair { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
`;

export interface ApiPageOptions {
  /** The web app's origin, from the sender's config (SENDER_SITE_URL), never from a request. */
  siteUrl: string;
}

export function renderApiPage(catalog: ApiCatalog | null, opts: ApiPageOptions): string {
  const site = opts.siteUrl.replace(/\/+$/, '');
  const catalogUrl = `${site}/api/catalog`;
  const fallbackDocs = `${site}/docs/api`;
  const docsUrl = catalog?.docs && safeHttpUrl(catalog.docs) ? catalog.docs : fallbackDocs;
  const skillUrl = `${site}/skill/skill.md`;
  const siteLabel = safeHttpUrl(site) ? new URL(site).host : site;

  const body =
    catalog && catalog.endpoints.length > 0
      ? renderListing(catalog, { catalogUrl, docsUrl, llmsUrl: `${site}/llms.txt`, skillUrl })
      : `<p>The endpoint list is not available right now. See the ${link(catalogUrl, 'catalogue')} or the ${link(fallbackDocs, 'docs')}.</p>`;

  const footerItems = [
    link(site, siteLabel),
    link(docsUrl, 'Docs'),
    link(skillUrl, 'Skill'),
    link(X_URL, 'X'),
    'Built on Base',
  ];

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Bootr API</title>',
    '<meta name="description" content="Public HTTP endpoints for launching a coin with an AI agent on Base and reading its market data.">',
    `<style>${STYLES}</style>`,
    '</head><body><main>',
    '<h1>Bootr API</h1>',
    body,
    '</main><footer><ul>',
    footerItems.map((item) => `<li>${item}</li>`).join(''),
    '</ul></footer></body></html>',
  ].join('');
}

function renderListing(
  catalog: ApiCatalog,
  urls: { catalogUrl: string; docsUrl: string; llmsUrl: string; skillUrl: string },
): string {
  const sections = groupEndpoints(catalog.endpoints).map(({ title, rows }) =>
    [
      `<section><h2>${escapeHtml(title)}</h2>`,
      `<ul>${rows.map(renderRow).join('')}</ul>`,
      title === 'Models and pricing' && catalog.pricing
        ? renderPricing(catalog.pricing, urls.catalogUrl)
        : '',
      '</section>',
    ].join(''),
  );
  const bases = baseUrls(catalog)
    .map(
      ({ label, url }) =>
        `<li class="pair"><span>${escapeHtml(label)}</span><code class="url">${escapeHtml(url)}</code></li>`,
    )
    .join('');
  const forPrograms = (
    [
      ['Catalogue JSON', urls.catalogUrl],
      ['API docs', urls.docsUrl],
      ['llms.txt', urls.llmsUrl],
      ['skill.md', urls.skillUrl],
      ['SDK, CLI and MCP', `${urls.docsUrl}#developer-tools`],
    ] as const
  )
    .map(
      ([label, url]) =>
        `<li class="pair"><span>${escapeHtml(label)}</span><code class="url">${link(url, url)}</code></li>`,
    )
    .join('');
  return [
    '<p>Public HTTP endpoints for launching a coin with an AI agent on Base and reading its market data.</p>',
    `<section><h2>Base URLs</h2><ul>${bases}</ul></section>`,
    `<section><h2>For programs</h2><ul>${forPrograms}</ul></section>`,
    ...sections,
  ].join('');
}
