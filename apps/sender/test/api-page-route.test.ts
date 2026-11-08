import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { CATALOG_RETRY_MS } from '../src/catalog-source.js';
import type { SenderContext } from '../src/context.js';
import { XClient } from '../src/x-client.js';
import { ENC_KEY, SERVICE_KEY } from './helpers.js';

/** Fails the test on any use: the page must not reach the database. */
const forbidden = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`the page touched the database (${String(prop)})`);
    },
  },
) as SenderContext['db'];

const CATALOG = {
  docs: 'https://site.test/docs/api',
  endpoints: [
    {
      service: 'web',
      method: 'GET',
      url: 'https://site.test/api/models',
      description: 'Model prices.',
      auth: { type: 'none' },
    },
  ],
};

function appWith(doFetch: typeof fetch, now: () => Date = () => new Date()) {
  const fetchMock = vi.fn(doFetch);
  const ctx: SenderContext = {
    db: forbidden,
    x: new XClient({ baseUrl: 'https://x.test', timeoutMs: 1_000 }),
    oauth: {
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://sender.test/oauth/callback',
      authorizeUrl: 'https://x.test/authorize',
      tokenUrl: 'https://x.test/token',
      serviceKey: SERVICE_KEY,
      encryptionKey: ENC_KEY,
      timeoutMs: 1_000,
    },
    encryptionKey: ENC_KEY,
    serviceKey: SERVICE_KEY,
    now,
    defaults: { postsPerDay: 24, mentionReadIntervalSec: 300, readsPerDay: 400 },
    xTimeoutMs: 1_000,
    apiPage: { siteUrl: 'https://site.test', fetch: fetchMock },
  };
  return { app: createApp(ctx), fetchMock };
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function expectPageHeaders(res: Response) {
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  expect(res.headers.get('content-security-policy')).toBe(CSP);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

const okCatalog = async () => new Response(JSON.stringify(CATALOG), { status: 200 });

describe('GET /', () => {
  it('answers 200 HTML with the catalogue and the agreed headers, without the database', async () => {
    const { app } = appWith(okCatalog);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expectPageHeaders(res);
    const html = await res.text();
    expect(html).toContain('<h1>Bootr API</h1>');
    expect(html).toContain('https://site.test/api/models');
    expect(html).toContain('Model prices.');
  });

  it('answers 200 with the empty state when the catalogue cannot be read', async () => {
    const { app } = appWith(() => Promise.reject(new Error('down')));
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expectPageHeaders(res);
    const html = await res.text();
    expect(html).toContain('not available right now');
    expect(html).toContain('href="https://site.test/api/catalog"');
    expect(html).toContain('href="https://site.test/docs/api"');
  });

  it('answers 200 when fetch throws synchronously', async () => {
    const { app } = appWith(() => {
      throw new Error('sync');
    });
    expect((await app.request('/')).status).toBe(200);
  });

  it('never takes the site from the request', async () => {
    const { app, fetchMock } = appWith(okCatalog);
    const res = await app.request('http://evil.test/?site=https://evil.test', {
      headers: { host: 'evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http' },
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['https://site.test/api/catalog']);
    expect(await res.text()).not.toContain('evil.test');
  });

  it('sets no cookie and fetches only once across requests', async () => {
    const { app, fetchMock } = appWith(okCatalog);
    for (let i = 0; i < 5; i++)
      expect((await app.request('/')).headers.get('set-cookie')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers HEAD with the same headers and no body', async () => {
    const { app } = appWith(okCatalog);
    const res = await app.request('/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expectPageHeaders(res);
    expect(await res.text()).toBe('');
  });
});

describe('GET / over a real socket', () => {
  /** `app.request` skips the node server, which writes Content-Length into a plain headers object it is handed. */
  it('sends the Content-Length of this page when the page changes length', async () => {
    let nowMs = Date.parse('2026-11-05T00:00:00Z');
    const responses = [() => Promise.reject(new Error('down')), okCatalog];
    const { app } = appWith(
      () => responses.shift()!(),
      () => new Date(nowMs),
    );
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const read = async () => {
        const res = await fetch(url);
        const body = await res.text();
        expect(res.status).toBe(200);
        expectPageHeaders(res);
        expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
        return body;
      };
      const empty = await read();
      expect(empty).toContain('not available right now');
      nowMs += CATALOG_RETRY_MS;
      const listing = await read();
      expect(listing).toContain('Model prices.');
      expect(listing.endsWith('</html>')).toBe(true);
      expect(listing.length).not.toBe(empty.length);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('the rest of the host', () => {
  it('keeps /health as JSON and does not fetch the catalogue for it', async () => {
    const { app, fetchMock } = appWith(okCatalog);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'sender' });
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps unknown paths and other methods on / as 404', async () => {
    const { app, fetchMock } = appWith(okCatalog);
    expect((await app.request('/nope')).status).toBe(404);
    expect((await app.request('/index.html')).status).toBe(404);
    expect((await app.request('/', { method: 'POST' })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still refuses an unsigned /internal request', async () => {
    const { app } = appWith(okCatalog);
    expect((await app.request('/internal/quota/a1')).status).toBe(401);
  });
});
