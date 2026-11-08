import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchImageFromUrl } from './image-fetch';

/**
 * `POST /api/agent/launch` fetches the image a caller names. It used to follow redirects blindly and buffer the whole
 * body before looking at the size, so a redirect could reach a private address and a compressed bomb could fill the
 * web process. Now: public hosts only on every hop, no compression asked for, the body streamed under the cap.
 */

const MB = 1024 * 1024;
const CAP = 2 * MB;
const PUBLIC_IP = [{ address: '93.184.216.34' }];
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** `https://img.example/...` reaches the local server; the host check is told it is public. */
const viaLocal =
  (origin: string): typeof fetch =>
  (input, init) =>
    fetch(String(input).replace('https://img.example', origin), init);
const publicHosts = async (host: string) => {
  if (host === 'img.example' || host === 'cdn.example') return PUBLIC_IP;
  throw new Error('unknown host');
};

describe('fetchImageFromUrl', () => {
  it('refuses a redirect to a private address, and a non-https hop, before contacting it', async () => {
    let hits = 0;
    const origin = await serve((req, res) => {
      hits += 1;
      if (req.url === '/to-private') return res.writeHead(302, { location: 'https://127.0.0.1/secret.png' }).end();
      if (req.url === '/to-http') return res.writeHead(302, { location: 'http://cdn.example/a.png' }).end();
      res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from(PNG));
    });
    const privateHop = await fetchImageFromUrl('https://img.example/to-private', CAP, { fetch: viaLocal(origin), resolve: publicHosts });
    expect(privateHop).toEqual({ ok: false, error: expect.stringContaining('public host') });
    const httpHop = await fetchImageFromUrl('https://img.example/to-http', CAP, { fetch: viaLocal(origin), resolve: publicHosts });
    expect(httpHop).toEqual({ ok: false, error: expect.stringContaining('not plain https') });
    expect(hits).toBe(2);
    expect(await fetchImageFromUrl('http://img.example/a.png', CAP, { fetch: viaLocal(origin), resolve: publicHosts })).toEqual({ ok: false, error: expect.stringContaining('must use https') });
    expect(await fetchImageFromUrl('https://127.0.0.1/a.png', CAP, { fetch: viaLocal(origin), resolve: publicHosts })).toEqual({ ok: false, error: expect.stringContaining('public host') });
  });

  it('follows a redirect chain by hand to a public host, and stops after three hops', async () => {
    const encodings: (string | undefined)[] = [];
    const origin = await serve((req, res) => {
      encodings.push(req.headers['accept-encoding'] as string | undefined);
      const n = Number(/^\/hop(\d+)/.exec(req.url ?? '')?.[1] ?? 0);
      if (req.url?.startsWith('/hop')) return res.writeHead(302, { location: n >= 2 ? '/final.png' : `/hop${n + 1}` }).end();
      if (req.url?.startsWith('/loop')) return res.writeHead(302, { location: '/loop' }).end();
      res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from(PNG));
    });
    const ok = await fetchImageFromUrl('https://img.example/hop0', CAP, { fetch: viaLocal(origin), resolve: publicHosts });
    expect(ok.ok).toBe(true);
    expect(ok.ok && Buffer.from(ok.bytes).equals(Buffer.from(PNG))).toBe(true);
    expect(encodings.every((e) => e === 'identity')).toBe(true);
    const loop = await fetchImageFromUrl('https://img.example/loop', CAP, { fetch: viaLocal(origin), resolve: publicHosts });
    expect(loop).toEqual({ ok: false, error: expect.stringContaining('redirects more than 3 times') });
  });

  it('cuts a compressed bomb at the cap instead of inflating it whole', async () => {
    const payload = gzipSync(Buffer.alloc(256 * MB));
    const origin = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': String(payload.byteLength) });
      res.end(payload);
    });
    const before = process.memoryUsage().rss;
    const out = await fetchImageFromUrl('https://img.example/bomb.png', CAP, { fetch: viaLocal(origin), resolve: publicHosts });
    expect(out).toEqual({ ok: false, error: expect.stringContaining('larger than 2 MB') });
    expect((process.memoryUsage().rss - before) / MB).toBeLessThan(128);
    // ...while an honest content-length past the cap is refused before a byte is read.
    const declared = await serve((_req, res) => res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(3 * MB) }).end(Buffer.alloc(3 * MB)));
    expect(await fetchImageFromUrl('https://img.example/big.png', CAP, { fetch: viaLocal(declared), resolve: publicHosts })).toEqual({ ok: false, error: expect.stringContaining('at most 2 MB') });
  });
});
