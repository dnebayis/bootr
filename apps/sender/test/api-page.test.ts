import { describe, expect, it } from 'vitest';
import {
  groupEndpoints,
  MAX_MODEL_ROWS,
  parseCatalog,
  renderApiPage,
  safeHttpUrl,
  type ApiCatalog,
  type ApiEndpoint,
} from '../src/api-page.js';

const SITE = 'https://bootr.fun';
const INDEXER = 'https://indexer.bootr.fun';

const endpoint = (over: Partial<ApiEndpoint> & { url: string }): ApiEndpoint => ({
  service: 'web',
  method: 'GET',
  description: 'A description.',
  auth: { type: 'none' },
  response: { contentType: 'application/json' },
  ...over,
});

const catalog = (endpoints: ApiEndpoint[], over: Partial<ApiCatalog> = {}): ApiCatalog => ({
  docs: `${SITE}/docs/api`,
  endpoints,
  ...over,
});

const render = (c: ApiCatalog | null) => renderApiPage(c, { siteUrl: SITE });

/** Every href on the page, in order. */
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const headings = (html: string) => [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('renderApiPage', () => {
  it('escapes a hostile description, method and model note', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror="alert(2)">\'&';
    const html = render(
      catalog(
        [endpoint({ url: `${SITE}/api/models`, description: hostile, method: `<b>"GET"</b>` })],
        {
          pricing: { note: hostile, models: [{ id: hostile, pricePerThoughtUsd: 0.01 }] },
        },
      ),
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&quot;alert(2)&quot;&gt;&#39;&amp;',
    );
  });

  it('does not turn a javascript: URL into a link, wherever it appears', () => {
    const html = render(
      catalog(
        [endpoint({ url: 'javascript:alert(1)' }), endpoint({ url: 'JaVaScRiPt:alert(2)' })],
        {
          docs: 'javascript:alert(3)',
        },
      ),
    );
    expect(html).toContain('<code class="url">javascript:alert(1)</code>');
    expect(html).toContain('<code class="url">JaVaScRiPt:alert(2)</code>');
    for (const href of hrefs(html)) expect(href).toMatch(/^https:\/\//);
    expect(hrefs(html)).toContain(`${SITE}/docs/api`);
  });

  it('cannot break out of an href attribute', () => {
    const html = render(
      catalog([endpoint({ url: 'https://evil.test/"><script>alert(1)</script>' })]),
    );
    expect(html).not.toContain('<script');
    expect(hrefs(html)).toContain('https://evil.test/%22%3E%3Cscript%3Ealert(1)%3C/script%3E');
    expect(html).toContain('https://evil.test/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</a>');
  });

  it('accepts http and https only, without credentials', () => {
    expect(safeHttpUrl('https://bootr.fun/a')).toBe('https://bootr.fun/a');
    expect(safeHttpUrl('http://bootr.fun/')).toBe('http://bootr.fun/');
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://a.test/',
      '/relative',
      'https://u:p@a.test/',
      '',
    ]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });

  it('links a concrete GET, and not a template, a POST or an event stream', () => {
    const html = render(
      catalog([
        endpoint({ url: `${SITE}/api/models` }),
        endpoint({ url: `${SITE}/agents/{id}.json` }),
        endpoint({ url: `${SITE}/api/agent/nonce`, method: 'POST' }),
        endpoint({ url: `${INDEXER}/stream`, response: { contentType: 'text/event-stream' } }),
      ]),
    );
    expect(hrefs(html)).toContain(`${SITE}/api/models`);
    expect(html).toContain(`<code class="url">${SITE}/agents/{id}.json</code>`);
    expect(html).toContain(`<code class="url">${SITE}/api/agent/nonce</code>`);
    expect(html).toContain(`<code class="url">${INDEXER}/stream</code>`);
  });

  it('groups endpoints under sections in a fixed order, keeping catalogue order inside each', () => {
    const groups = groupEndpoints([
      endpoint({ url: `${SITE}/llms.txt` }),
      endpoint({ url: `${INDEXER}/market/{token}` }),
      endpoint({ url: `${SITE}/api/models` }),
      endpoint({ url: `${SITE}/api/agent/launch`, method: 'POST' }),
      endpoint({ url: `${SITE}/api/catalog` }),
      endpoint({ url: `${INDEXER}/treasury/{kernel}` }),
      endpoint({ url: `${INDEXER}/token/{id}/fees` }),
      endpoint({ url: `${SITE}/tokens/{id}.json` }),
      endpoint({ url: `${SITE}/agents/{id}.json` }),
      endpoint({ url: `${INDEXER}/platform/feed` }),
      endpoint({ url: `${SITE}/api/platform` }),
      endpoint({ url: `${SITE}/sitemap.xml` }),
    ]);
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.url)])).toEqual([
      [
        'Launch and agents',
        [
          `${SITE}/api/agent/launch`,
          `${INDEXER}/treasury/{kernel}`,
          `${SITE}/agents/{id}.json`,
          `${SITE}/api/platform`,
        ],
      ],
      [
        'Coins and market',
        [
          `${INDEXER}/market/{token}`,
          `${INDEXER}/token/{id}/fees`,
          `${SITE}/tokens/{id}.json`,
          `${INDEXER}/platform/feed`,
        ],
      ],
      ['Models and pricing', [`${SITE}/api/models`]],
      ['Docs and discovery', [`${SITE}/llms.txt`, `${SITE}/api/catalog`, `${SITE}/sitemap.xml`]],
    ]);
  });

  it('keeps an endpoint it has no section for, under Other', () => {
    const html = render(
      catalog([endpoint({ url: `${SITE}/api/brand-new` }), endpoint({ url: 'not a url' })]),
    );
    expect(headings(html)).toEqual(['Base URLs', 'For programs', 'Other']);
    expect(html).toContain(`${SITE}/api/brand-new`);
    expect(html).toContain('not a url');
  });

  it('renders the row: method, url, description, auth and rate limit, and omits what is unknown', () => {
    const html = render(
      catalog([
        endpoint({
          url: `${SITE}/api/agent/launch`,
          method: 'POST',
          description: 'Prepare a launch.',
          auth: { type: 'siwe' },
          rateLimit: { limit: 5, windowSeconds: 60, per: 'ip' },
        }),
        endpoint({
          url: `${SITE}/api/agent/other`,
          auth: undefined,
          rateLimit: { limit: 3, windowSeconds: 10 },
        }),
        endpoint({
          url: `${SITE}/api/agent/third`,
          auth: { type: 'mystery' },
          description: undefined,
        }),
      ]),
    );
    expect(html).toContain('<span class="method">POST</span>');
    expect(html).toContain('Prepare a launch.');
    expect(html).toContain('Signed wallet message (SIWE) · 5 requests per minute per IP');
    expect(html).toContain('<p class="meta">3 requests per 10 s</p>');
    expect(html).not.toContain('mystery');
  });

  it('lists each base URL once, from the catalogue, and the program links', () => {
    const html = render(
      catalog([
        endpoint({ url: `${SITE}/api/models` }),
        endpoint({ url: `${SITE}/api/platform` }),
        endpoint({ url: `${INDEXER}/search`, service: 'indexer' }),
      ]),
    );
    expect(html).toContain(`<span>Site and agent API</span><code class="url">${SITE}</code>`);
    expect(html).toContain(`<span>Indexer</span><code class="url">${INDEXER}</code>`);
    expect(html.match(new RegExp(`<code class="url">${INDEXER}</code>`, 'g'))).toHaveLength(1);
    for (const url of [`${SITE}/api/catalog`, `${SITE}/llms.txt`, `${SITE}/skill/skill.md`]) {
      expect(hrefs(html)).toContain(url);
    }
  });

  it('shows model prices under Models and pricing, capped, null as no price', () => {
    const models = Array.from({ length: MAX_MODEL_ROWS + 2 }, (_, i) => ({
      id: `vendor/model-${i}`,
      pricePerThoughtUsd: i === 0 ? null : i === 1 ? 0.0101 : 1.5,
    }));
    const html = render(
      catalog([endpoint({ url: `${SITE}/api/models` })], { pricing: { models } }),
    );
    expect(html).toContain('<td class="price">No price</td>');
    expect(html).toContain('<td class="price">$0.0101</td>');
    expect(html).toContain('<td class="price">$1.50</td>');
    expect(html).toContain(`vendor/model-${MAX_MODEL_ROWS - 1}<`);
    expect(html).not.toContain(`vendor/model-${MAX_MODEL_ROWS}<`);
    expect(html).toContain('2 more in the');
  });

  it('renders the empty state with a sentence and links to the catalogue and docs', () => {
    for (const html of [render(null), render(catalog([]))]) {
      expect(html).toContain('<h1>Bootr API</h1>');
      expect(html).toContain('not available right now');
      expect(hrefs(html)).toContain(`${SITE}/api/catalog`);
      expect(hrefs(html)).toContain(`${SITE}/docs/api`);
      expect(headings(html)).toEqual([]);
      expect(html).toContain('<footer>');
    }
  });

  it('is self-contained with a footer and no nav: no script, external asset or header', () => {
    const html = render(catalog([endpoint({ url: `${SITE}/api/models` })]));
    expect(html).not.toMatch(/<(script|nav|header|link|img|iframe|form)\b/i);
    expect(html).not.toMatch(/@import|@font-face|url\(/);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    const footer = html.slice(html.indexOf('<footer>'));
    expect(hrefs(footer)).toEqual([
      `${SITE}/`,
      `${SITE}/docs/api`,
      `${SITE}/skill/skill.md`,
      'https://x.com/bootrfun',
    ]);
    expect(footer).toContain('>bootr.fun</a>');
    expect(footer).toContain('Built on Base');
  });

  it('has dark tokens by default and a light variant', () => {
    const html = render(null);
    expect(html).toMatch(/:root \{[^}]*--canvas: #0a0b0d/);
    expect(html).toMatch(
      /@media \(prefers-color-scheme: light\) \{\s*:root \{[^}]*--canvas: #ffffff/,
    );
    expect(html).toMatch(/body \{[^}]*background: var\(--canvas\)/);
  });
});

describe('parseCatalog', () => {
  it('refuses what is not a catalogue', () => {
    for (const bad of [
      null,
      'x',
      1,
      [],
      {},
      { endpoints: 'x' },
      { endpoints: [] },
      { endpoints: [{ url: 1 }] },
    ]) {
      expect(parseCatalog(bad)).toBeNull();
    }
  });

  it('drops malformed rows and fields, and keeps the rest', () => {
    const parsed = parseCatalog({
      docs: 42,
      agentTools: { tools: [{ name: 'secret_tool' }] },
      endpoints: [
        {
          method: 'GET',
          url: `${SITE}/a`,
          description: 7,
          auth: 'none',
          rateLimit: { limit: 'many' },
          extra: 'x',
        },
        { method: 'GET' },
        null,
      ],
      pricing: { note: 3, models: [{ id: 'a/b', pricePerThoughtUsd: 'free' }, { nope: true }] },
    });
    expect(parsed).toEqual({
      docs: undefined,
      endpoints: [
        {
          method: 'GET',
          url: `${SITE}/a`,
          service: undefined,
          description: undefined,
          auth: undefined,
          rateLimit: undefined,
          response: undefined,
        },
      ],
      pricing: { note: undefined, models: [{ id: 'a/b', pricePerThoughtUsd: null }] },
    });
    expect(JSON.stringify(parsed)).not.toContain('secret_tool');
  });
});
