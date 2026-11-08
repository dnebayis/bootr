import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TOOLS } from '@bootr/agent-core/tools';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { GET as models } from '@/app/api/models/route';
import { buildCatalog, publicIndexerUrl, PUBLIC_INDEXER_URL, type Catalog, type SiweAuth } from '@/lib/server/catalog';
import { GET } from './route';

// `connection()` needs a request scope, which a direct handler call does not have.
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), connection: async () => {} }));

const REPO = path.resolve(import.meta.dirname, '../../../../..');
const APP = path.join(REPO, 'apps/web/app');
const SITE = 'https://site.example';
const INDEXER = 'https://indexer.example';
const NO_MODELS = { source: 'blockrun', thought: { promptTokens: 4000, outputTokens: 1024 }, models: [] } as const;
const catalog = (indexerUrl = INDEXER) => buildCatalog({ siteUrl: SITE, indexerUrl, chainId: 8453, models: { ...NO_MODELS, models: [] } });

/** The URL of an endpoint without its origin, `{name}` kept. */
const pathOf = (url: string, origin: string) => url.slice(origin.length);

/** The route file of a web path: every dynamic segment is `[id]`, and the `.json` in the URL is part of the segment. */
function routeFile(p: string): string {
  if (p === '/sitemap.xml') return path.join(APP, 'sitemap.ts');
  return path.join(APP, p.replace(/\{\w+\}(\.json)?/g, '[id]'), 'route.ts');
}

describe('GET /api/catalog', () => {
  it('is public, cacheable and open to any origin', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=\d+/);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('answers the documented shape', async () => {
    const body = (await (await GET()).json()) as Catalog;
    expect(body).toMatchObject({ schemaVersion: 1, name: 'Bootr' });
    expect(Object.keys(body).sort()).toEqual(['agentTools', 'chainId', 'description', 'docs', 'endpoints', 'name', 'pricing', 'schemaVersion', 'site']);
    expect(body.endpoints.length).toBeGreaterThan(10);
    const seen = new Set<string>();
    for (const e of body.endpoints) {
      const label = `${e.method} ${e.url}`;
      expect(seen.has(label), `${label} twice`).toBe(false);
      seen.add(label);
      expect(['web', 'indexer'], label).toContain(e.service);
      expect(['GET', 'POST'], label).toContain(e.method);
      expect(e.url, label).toMatch(/^https?:\/\//);
      expect(e.description.length, label).toBeGreaterThan(10);
      expect(['none', 'siwe'], label).toContain(e.auth.type);
      expect(['any-origin', 'none'], label).toContain(e.cors);
      expect(e.response.contentType, label).toBeTruthy();
      expect(e.response.shape, label).toBeTruthy();
      // Every `{name}` in the URL is a required path parameter, and the other way round.
      const names = [...e.url.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(Object.keys((e.parameters?.path?.properties as object | undefined) ?? {}), label).toEqual(names);
      if (names.length) expect(e.parameters?.path?.required, label).toEqual(names);
    }
  });

  it('prices what /api/models prices', async () => {
    const body = (await (await GET()).json()) as Catalog;
    const own = await (await models(new NextRequest('http://localhost:3000/api/models'))).json();
    expect(body.pricing).toMatchObject(own);
    expect(body.pricing.models.length).toBeGreaterThan(0);
    for (const m of body.pricing.models) expect(Object.keys(m).sort()).toEqual(['id', 'label', 'pricePerThoughtUsd', 'provider']);
    expect(body.pricing).toMatchObject({ currency: 'USDC', paidToolCalls: false });
    expect(body.pricing.note).toContain('no paid tool call');
    // No per-tool price: a tool carries these fields and no other.
    for (const t of body.agentTools.tools) expect(Object.keys(t).sort()).toEqual(['capability', 'description', 'effect', 'name', 'parameters']);
  });
});

describe('agentTools', () => {
  it('lists exactly the tools of agent-core, with their real parameters', () => {
    const src = readFileSync(path.join(REPO, 'packages/agent-core/src/tools.ts'), 'utf8');
    const inSource = [...src.matchAll(/^\s+(\w+): define\(/gm)].map((m) => m[1]);
    expect(inSource.length).toBeGreaterThan(10);
    const { tools } = catalog().agentTools;
    // The source too, not only the import: agent-core is consumed from its build, so this also catches a stale dist.
    expect(tools.map((t) => t.name), 'differs from agent-core: pnpm --filter @bootr/agent-core build').toEqual(inSource);
    for (const t of tools) {
      expect(Object.keys(TOOLS)).toContain(t.name);
      expect(t.description).toBe(TOOLS[t.name as keyof typeof TOOLS].description);
      expect(t.parameters.type, t.name).toBe('object');
    }
  });

  it('says they are run by the agent, not by the public', () => {
    const a = catalog().agentTools;
    expect(a).toMatchObject({ runBy: 'agent', publiclyCallable: false });
    expect(a.note).toContain('nobody outside can call them');
  });
});

describe('nothing private', () => {
  it('names no internal, signed-service or admin route', async () => {
    const text = JSON.stringify(await (await GET()).json()).toLowerCase();
    for (const banned of ['/internal', '/api/admin', 'console', 'hmac', 'service_key', 'service key', '/sql', '/oauth', '/api/siwe', 'railway', '.internal', 'supervisor', 'process.env', 'next_public']) {
      expect(text, banned).not.toContain(banned);
    }
    for (const e of catalog().endpoints) expect(e.url, e.url).not.toMatch(/\/(internal|admin|console)/);
  });

  it('never publishes a private indexer host or credentials in the URL', () => {
    for (const bad of ['http://indexer.railway.internal:42069', 'http://10.0.0.4:42069', 'http://192.168.1.2', 'http://172.20.0.1', 'http://host.local', 'http://localhost:42069', 'http://127.0.0.1:42069', 'not a url', '']) {
      expect(publicIndexerUrl(bad, 'production'), bad).toBe(PUBLIC_INDEXER_URL);
    }
    expect(publicIndexerUrl('http://localhost:42069', 'development')).toBe('http://localhost:42069');
    expect(publicIndexerUrl('https://user:secret@indexer.example/path?key=1', 'production')).toBe('https://indexer.example');
    const leaked = catalog('http://indexer.railway.internal:42069').endpoints.filter((e) => e.service === 'indexer');
    expect(leaked.every((e) => e.url.startsWith(PUBLIC_INDEXER_URL))).toBe(true);
  });
});

/** Each claim in the catalogue, read back from the code it describes. */
describe('matches the routes', () => {
  const web = catalog().endpoints.filter((e) => e.service === 'web');
  const source = (url: string) => readFileSync(routeFile(pathOf(url, SITE)), 'utf8');

  it('has a route exporting the method for every web endpoint', () => {
    for (const e of web) {
      const file = routeFile(pathOf(e.url, SITE));
      expect(existsSync(file), file).toBe(true);
      if (file.endsWith('sitemap.ts')) continue;
      expect(readFileSync(file, 'utf8'), e.url).toMatch(new RegExp(`export (async )?function ${e.method}\\b`));
    }
  });

  it('has a handler for every indexer endpoint', () => {
    const src = readFileSync(path.join(REPO, 'apps/indexer/src/api/index.ts'), 'utf8');
    const indexer = catalog().endpoints.filter((e) => e.service === 'indexer');
    expect(indexer.length).toBeGreaterThan(3);
    for (const e of indexer) {
      const p = pathOf(e.url, INDEXER).replace(/\{(\w+)\}/g, ':$1');
      if (p === '/graphql') expect(src).toContain("app.use('/graphql', graphql(");
      else expect(src, p).toContain(`app.${e.method.toLowerCase()}('${p}'`);
    }
  });

  it('states the rate limit each route enforces, and none where it enforces none', () => {
    for (const e of web) {
      if (e.url.endsWith('/sitemap.xml')) continue;
      const m = /new RateLimiter\((\d+), (\d+)_000\)/.exec(source(e.url));
      if (m) expect(e.rateLimit, e.url).toEqual({ limit: Number(m[1]), windowSeconds: Number(m[2]), per: 'ip' });
      else expect(e.rateLimit, e.url).toBeUndefined();
    }
    expect(web.filter((e) => e.rateLimit).length).toBe(3);
  });

  it('claims any-origin only where the route sends the header', () => {
    for (const e of web) {
      if (e.url.endsWith('/sitemap.xml')) continue;
      expect(source(e.url).includes('Access-Control-Allow-Origin'), e.url).toBe(e.cors === 'any-origin');
    }
  });

  it('gives the SIWE statements the routes accept', () => {
    const signed = web.filter((e) => e.auth.type === 'siwe');
    expect(signed.map((e) => pathOf(e.url, SITE))).toEqual(['/api/agent/launch', '/api/agent/x-connect']);
    for (const e of signed) {
      const auth = e.auth as SiweAuth;
      expect(auth).toMatchObject({ domain: 'site.example', uri: SITE, chainId: 8453, nonceUrl: `${SITE}/api/agent/nonce` });
      const accepted = /const STATEMENT = \/(.+)\/;/.exec(source(e.url))?.[1];
      expect(accepted, e.url).toBeTruthy();
      const filled = auth.statement.replace('<agentId>', '123').replace('<kernel>', `0x${'a'.repeat(40)}`);
      expect(new RegExp(accepted!).test(filled), e.url).toBe(true);
    }
  });

  it('states the launch defaults the route uses', () => {
    const src = source(`${SITE}/api/agent/launch`);
    expect(src).toContain("GAS_DEFAULT_ETH = '0.001'");
    expect(src).toContain("GAS_MIN_ETH = '0.0001'");
    expect(src).toContain("l.fuelUsdc === undefined ? '20'");
    const launch = JSON.stringify(web.find((e) => e.url.endsWith('/api/agent/launch'))?.parameters?.body);
    for (const s of ['default 0.001', 'at least 0.0001', 'default 20']) expect(launch).toContain(s);
  });

  it('lists every route the SDK calls, by method and path', () => {
    const src = readFileSync(path.join(REPO, 'packages/sdk/src/routes.ts'), 'utf8');
    const routes = [...src.matchAll(/method: '(GET|POST)', path: '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(routes.length).toBeGreaterThan(10);
    const listed = catalog().endpoints.map((e) => `${e.method} ${e.url.replace(e.service === 'web' ? SITE : INDEXER, '')}`);
    for (const r of routes) expect(listed, r).toContain(r);
  });

  it('is linked from the docs', () => {
    const docs = readFileSync(path.join(REPO, 'apps/web/components/docs/content.ts'), 'utf8');
    const llms = readFileSync(path.join(REPO, 'apps/web/lib/docs/markdown.ts'), 'utf8');
    expect(docs).toContain('/api/catalog');
    expect(llms).toContain('/api/catalog');
  });
});
