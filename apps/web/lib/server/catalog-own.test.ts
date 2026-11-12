import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { connectCoinStatement, CONNECT_COIN_STATEMENT, CONNECT_DRAFT_STATEMENT, DEVICE_POLL_INTERVAL_S } from '@bootr/shared/own-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCatalog, type SiweAuth } from '@/lib/server/catalog';
import { ownAgentEndpointList, ownAgentEndpoints, type BearerAuth } from '@/lib/server/catalog-own';
import { RUN_PER_MINUTE, UPLOAD_BODY_BYTES } from '@/lib/server/own-agent';

/**
 * The own-agent routes in the catalog (docs/design/byo-agent.md section 13.6): listed only while the flag is on, and
 * each claim read back from the route it describes, the way `app/api/catalog/route.test.ts` does for the others.
 */
const REPO = path.resolve(import.meta.dirname, '../../../..');
const APP = path.join(REPO, 'apps/web/app');
const SITE = 'https://site.example';
const NO_MODELS = { source: 'blockrun', thought: { promptTokens: 4000, outputTokens: 1024 }, models: [] } as const;
const catalog = () => buildCatalog({ siteUrl: SITE, indexerUrl: 'https://indexer.example', chainId: 8453, models: { ...NO_MODELS, models: [] } });
const own = ownAgentEndpointList(SITE, 8453);
const source = (url: string) => readFileSync(path.join(APP, url.slice(SITE.length), 'route.ts'), 'utf8');

afterEach(() => vi.unstubAllEnvs());

describe('the flag', () => {
  it('leaves the catalog as it was while own agents are off', () => {
    vi.stubEnv('OWN_AGENT_ENABLED', '');
    expect(ownAgentEndpoints(SITE, 8453)).toEqual([]);
    const text = JSON.stringify(catalog());
    for (const absent of ['/api/agent/connect', '/api/agent/run', 'bearer', 'bootr_agt_']) expect(text, absent).not.toContain(absent);
  });

  it('lists routes 1 to 12 and 16 while they are on, each once, after the routes that were there', () => {
    vi.stubEnv('OWN_AGENT_ENABLED', '');
    const before = catalog().endpoints.map((e) => `${e.method} ${e.url}`);
    vi.stubEnv('OWN_AGENT_ENABLED', 'true');
    const after = catalog().endpoints.map((e) => `${e.method} ${e.url}`);
    const added = after.filter((e) => !before.includes(e));
    expect(added).toEqual([
      'POST /api/agent/connect/start',
      'GET /api/agent/connect/grant',
      'POST /api/agent/connect/approve',
      'POST /api/agent/connect/token',
      'GET /api/agent/connect/draft',
      ...['status', 'due', 'turn', 'act', 'finish', 'upload', 'disconnect'].map((op) => `POST /api/agent/run/${op}`),
      'GET /api/agent/connect/coins',
    ].map((e) => e.replace(' ', ` ${SITE}`)));
    expect(new Set(after).size).toBe(after.length);
    // The web endpoints stay together: the indexer's follow.
    const services = catalog().endpoints.map((e) => e.service);
    expect(services.lastIndexOf('web')).toBeLessThan(services.indexOf('indexer'));
  });
});

describe('matches the routes', () => {
  it('has a route exporting the method for every endpoint', () => {
    for (const e of own) {
      const file = path.join(APP, e.url.slice(SITE.length), 'route.ts');
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8'), e.url).toMatch(new RegExp(`export (async )?function ${e.method}\\b`));
      expect(e.description.length, e.url).toBeGreaterThan(10);
      expect(e.cors, e.url).toBe('none');
      expect(source(e.url).includes('Access-Control-Allow-Origin'), e.url).toBe(false);
    }
  });

  it('states the per-IP limit each connect route enforces', () => {
    for (const e of own.filter((x) => x.rateLimit?.per === 'ip')) {
      const m = /new RateLimiter\((\d+), (\d+)_000\)/.exec(source(e.url));
      expect(m, e.url).toBeTruthy();
      expect(e.rateLimit, e.url).toEqual({ limit: Number(m![1]), windowSeconds: Number(m![2]), per: 'ip' });
    }
    expect(own.filter((x) => x.rateLimit?.per === 'ip').map((e) => e.url.slice(SITE.length))).toEqual(['/api/agent/connect/start', '/api/agent/connect/grant', '/api/agent/connect/approve', '/api/agent/connect/draft', '/api/agent/connect/coins']);
  });

  it('states the run routes’ bearer credential, their limit per client and the token poll’s interval', () => {
    const run = own.filter((e) => e.url.includes('/api/agent/run/'));
    expect(run).toHaveLength(7);
    for (const e of run) {
      expect((e.auth as BearerAuth).type, e.url).toBe('bearer');
      expect(e.rateLimit, e.url).toEqual({ limit: RUN_PER_MINUTE, windowSeconds: 60, per: 'client' });
      expect(source(e.url), e.url).toContain(`runRoute(req, '${e.url.split('/').pop()}')`);
    }
    expect(own.find((e) => e.url.endsWith('/connect/token'))!.rateLimit).toEqual({ limit: 1, windowSeconds: DEVICE_POLL_INTERVAL_S, per: 'device-code' });
    expect(own.find((e) => e.url.endsWith('/run/upload'))!.description).toContain(`${UPLOAD_BODY_BYTES / 1024 / 1024} MB`);
    expect(own.every((e) => e.rateLimit)).toBe(true);
  });

  it('gives the statements the approval route accepts', () => {
    const signed = own.filter((e) => e.auth.type === 'siwe');
    expect(signed.map((e) => e.url.slice(SITE.length))).toEqual(['/api/agent/connect/approve']);
    const auth = signed[0]!.auth as SiweAuth;
    expect(auth).toMatchObject({ domain: 'site.example', uri: SITE, chainId: 8453, nonceUrl: `${SITE}/api/agent/nonce` });
    const fill = (s: string) => s.replace('<symbol>', 'OWL').replace('<agentId>', '123').replace('<kernel>', `0x${'a'.repeat(40)}`).replace('<code>', 'BCDF-GHJK').replace('<draft>', '8b7d05c6-a4b4-415c-93cf-46f36b679889');
    expect(CONNECT_COIN_STATEMENT.test(fill(auth.statement))).toBe(true);
    expect(fill(auth.statement)).toBe(connectCoinStatement('OWL', '123', `0x${'a'.repeat(40)}`, 'BCDF-GHJK'));
    const draft = /"(Let an AI client run the agent of my next Bootr launch[^"]+)"/.exec(auth.note)?.[1];
    expect(CONNECT_DRAFT_STATEMENT.test(fill(draft ?? ''))).toBe(true);
    expect(source(signed[0]!.url)).toContain('CONNECT_COIN_STATEMENT.source}|${CONNECT_DRAFT_STATEMENT.source}');
  });

  it('lists every own-agent route the SDK calls, and the SDK calls no own-agent route it does not list', () => {
    const src = readFileSync(path.join(REPO, 'packages/sdk/src/routes.ts'), 'utf8');
    const routes = [...src.matchAll(/method: '(GET|POST)', path: '(\/api\/agent\/(?:connect|run)\/[^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(routes).toHaveLength(9);
    const listed = own.map((e) => `${e.method} ${e.url.slice(SITE.length)}`);
    for (const r of routes) expect(listed, r).toContain(r);
  });
});

describe('nothing private', () => {
  it('names no internal route, service or secret', () => {
    const text = JSON.stringify(own).toLowerCase();
    for (const banned of ['/internal', '/api/admin', 'console', 'hmac', 'service_key', 'service key', '/sql', '/oauth', '/api/siwe', 'railway', '.internal', 'supervisor', 'process.env', 'next_public']) {
      expect(text, banned).not.toContain(banned);
    }
  });
});
