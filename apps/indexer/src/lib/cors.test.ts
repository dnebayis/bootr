import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CORS_ORIGIN,
  corsMiddleware,
  corsPolicy,
  originResolver,
  parseOrigins,
} from './cors';

/** Mirrors Ponder's server: a global `cors({ origin: '*' })` in front of the user API app. */
function ponderLikeServer(policy = corsPolicy({ NODE_ENV: 'production' })) {
  const api = new Hono();
  api.use('*', corsMiddleware(policy));
  api.get('/search', (c) => c.json([]));
  return new Hono().use(cors({ origin: '*', maxAge: 86400 })).route('/', api);
}

describe('indexer CORS policy', () => {
  it('defaults to https://bootr.fun, never *', () => {
    const p = corsPolicy({ NODE_ENV: 'production' });
    expect(p).toEqual({ origins: [DEFAULT_CORS_ORIGIN], allowLocalhost: false, source: 'default' });
    const allow = originResolver(p);
    expect(allow('https://bootr.fun')).toBe('https://bootr.fun');
    expect(allow('https://evil.example')).toBeNull();
    expect(allow('http://localhost:3000')).toBeNull();
    expect(allow('')).toBeNull();
  });

  it('reads a comma-separated INDEXER_CORS_ORIGIN and ignores trailing slashes', () => {
    const p = corsPolicy({
      INDEXER_CORS_ORIGIN: 'https://bootr.fun/, https://www.bootr.fun',
      NODE_ENV: 'production',
    });
    expect(p.origins).toEqual(['https://bootr.fun', 'https://www.bootr.fun']);
    const allow = originResolver(p);
    expect(allow('https://www.bootr.fun')).toBe('https://www.bootr.fun');
    expect(allow('https://staging.bootr.fun')).toBeNull();
  });

  it('prefers INDEXER_CORS_ORIGIN over the legacy NEXT_PUBLIC_WEB_ORIGIN', () => {
    expect(
      corsPolicy({
        INDEXER_CORS_ORIGIN: 'https://a.example',
        NEXT_PUBLIC_WEB_ORIGIN: 'https://b.example',
      }).origins,
    ).toEqual(['https://a.example']);
    const legacy = corsPolicy({ NEXT_PUBLIC_WEB_ORIGIN: 'https://b.example' });
    expect(legacy).toMatchObject({
      origins: ['https://b.example'],
      source: 'NEXT_PUBLIC_WEB_ORIGIN',
    });
  });

  it('accepts loopback origins outside production only', () => {
    const dev = originResolver(corsPolicy({}));
    expect(dev('http://localhost:3000')).toBe('http://localhost:3000');
    expect(dev('http://127.0.0.1:3210')).toBe('http://127.0.0.1:3210');
    expect(dev('http://localhost.evil.example')).toBeNull();
    expect(dev('https://bootr.fun')).toBe('https://bootr.fun');
    const prod = originResolver(corsPolicy({ NODE_ENV: 'production' }));
    expect(prod('http://localhost:3000')).toBeNull();
  });

  it('treats an explicit * as any origin', () => {
    const p = corsPolicy({ INDEXER_CORS_ORIGIN: '*', NODE_ENV: 'production' });
    expect(p.origins).toEqual(['*']);
    expect(originResolver(p)('https://anything.example')).toBe('*');
  });

  it('parses empty input to an empty list', () => {
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins(' , ')).toEqual([]);
  });
});

describe("corsMiddleware behind Ponder's wildcard cors", () => {
  const get = (origin?: string) =>
    ponderLikeServer().request('/search?q=x', { headers: origin ? { origin } : {} });

  it('echoes an allowed origin and varies on Origin', async () => {
    const res = await get('https://bootr.fun');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://bootr.fun');
    expect(res.headers.get('vary')).toMatch(/origin/i);
  });

  it('removes the wildcard for a disallowed origin', async () => {
    const res = await get('https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sends no CORS header for server-to-server calls without Origin', async () => {
    const res = await get();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps * when explicitly configured', async () => {
    const res = await ponderLikeServer(corsPolicy({ INDEXER_CORS_ORIGIN: '*' })).request(
      '/search',
      {
        headers: { origin: 'https://anything.example' },
      },
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
