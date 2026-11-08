import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_CARD_BYTES, fetchAgentCard } from '../src/agent-card.js';
import { MAX_BODY_BYTES, readUrl } from '../src/web-reader.js';

/**
 * A page or an agent card is read by a process that serves every agent. Its body used to be buffered whole before
 * the cap applied, so a few hundred kilobytes of gzip that inflate to hundreds of megabytes cost that much memory.
 * The bodies are now streamed and cut at the cap, whatever the server sends.
 */

const MB = 1024 * 1024;
const PUBLIC_IP = [{ address: '93.184.216.34' }];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A server whose every response is `inflated` bytes of zeros, gzip-compressed, whatever the client asked for. */
async function bomb(inflated: number, contentType: string): Promise<{ origin: string; compressedBytes: number; requests: () => { encoding: string | undefined }[] }> {
  const payload = gzipSync(Buffer.alloc(inflated));
  const requests: { encoding: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ encoding: req.headers['accept-encoding'] as string | undefined });
    res.writeHead(200, { 'content-type': contentType, 'content-encoding': 'gzip', 'content-length': String(payload.byteLength) });
    res.end(payload);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, compressedBytes: payload.byteLength, requests: () => requests };
}

/** `https://bomb.example/...` reaches the local server; the public-host check sees a public address for it. */
function viaLocal(origin: string): typeof fetch {
  return (input, init) => fetch(String(input).replace('https://bomb.example', origin), init);
}
const rssMb = () => process.memoryUsage().rss / MB;

describe('a compressed body that inflates far past the cap', () => {
  it('is what fetch would hand over whole: the server ignores accept-encoding and fetch inflates it', async () => {
    const b = await bomb(16 * MB, 'text/html');
    expect(b.compressedBytes).toBeLessThan(64 * 1024);
    const res = await fetch(`${b.origin}/page`, { headers: { 'accept-encoding': 'identity' } });
    expect((await res.arrayBuffer()).byteLength).toBe(16 * MB);
  });

  it('read_url stops at MAX_BODY_BYTES: the text comes back truncated and memory stays bounded', async () => {
    const b = await bomb(256 * MB, 'text/html');
    const before = rssMb();
    const res = await readUrl('https://bomb.example/page', { fetch: viaLocal(b.origin), resolve: async () => PUBLIC_IP });
    expect(res.truncated).toBe(true);
    expect(res.status).toBe(200);
    expect(b.requests()[0]?.encoding).toBe('identity');
    expect(rssMb() - before).toBeLessThan(128);
    expect(MAX_BODY_BYTES).toBeLessThanOrEqual(1 * MB);
  });

  it('an agent card past MAX_CARD_BYTES is unreadable, final, and never buffered', async () => {
    const b = await bomb(256 * MB, 'application/json');
    const before = rssMb();
    expect(await fetchAgentCard('https://bomb.example/agents/x.json', { fetch: viaLocal(b.origin), resolve: async () => PUBLIC_IP })).toBe('none');
    expect(b.requests()[0]?.encoding).toBe('identity');
    expect(rssMb() - before).toBeLessThan(128);
    expect(MAX_CARD_BYTES).toBe(256 * 1024);
  });
});
