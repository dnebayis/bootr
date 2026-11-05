import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Each call starts a real process, which takes a while when the whole workspace runs its tests at once.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** The built command as a user runs it, as a real process, against a small HTTP server speaking the catalog's routes. */
const BIN = path.resolve(import.meta.dirname, '../dist/cli.js');
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const KEY = `0x${'ab'.repeat(32)}`;
const CLAIM = {
  target: OWNER,
  data: '0x12',
  value: '0',
  path: 'clanker',
  amountWei: '5',
  sendFrom: null,
  description: 'Pays WETH.',
};

let server: Server;
let site: string;
const seen: { method: string; url: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const url = req.url!;
      if (url === '/api/catalog') {
        const web = [
          ['GET', '/api/agent/claim/{address}'],
          ['POST', '/api/agent/nonce'],
          ['GET', '/market/{token}'],
          ['GET', '/search'],
          ['GET', '/treasury/{kernel}'],
          ['GET', '/platform/feed'],
          ['GET', '/token/{id}/fees'],
          ['GET', '/api/agents/{id}/posts'],
        ];
        return send(200, {
          endpoints: [
            ...web.map(([method, p]) => ({
              service: p!.startsWith('/api/') ? 'web' : 'indexer',
              method,
              url: `${site}${p}`,
              auth: { type: 'none' },
            })),
            {
              method: 'POST',
              url: `${site}/api/agent/launch`,
              auth: {
                type: 'siwe',
                statement: 'Prepare a Bootr launch.',
                domain: new URL(site).host,
                uri: site,
                chainId: 8453,
              },
            },
          ],
        });
      }
      if (url.startsWith('/api/agent/claim/'))
        return send(200, {
          address: OWNER,
          asset: '0x42',
          totalWei: '5',
          coins: { bootr: [], clanker: [] },
          claims: [CLAIM],
          note: 'Nothing was signed or sent.',
        });
      if (url === '/api/agent/nonce')
        return send(200, { nonce: 'abcdef0123456789', expiresIn: 600 });
      if (url === '/api/agent/launch')
        return send(200, {
          creator: OWNER,
          chainId: 8453,
          transactions: [{ step: 'approve', to: OWNER, data: '0x', value: '0', note: '' }],
        });
      if (url.startsWith('/market/')) return send(200, { symbol: 'AA' });
      if (url.startsWith('/search')) return send(200, [{ symbol: 'BB' }]);
      if (url.startsWith('/treasury/')) return send(404, { error: 'not_found' });
      if (url.startsWith('/platform/feed')) return send(200, { launches: [] });
      if (url.startsWith('/token/')) return send(200, { byKind: {} });
      if (url.startsWith('/api/agents/')) return send(200, { handle: null, items: [] });
      return send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  site = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => {
  server.close();
});

async function bootr(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args], {
      env: { ...process.env, BOOTR_SITE_URL: site },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe('read commands', () => {
  it('coin takes an address or a search', async () => {
    expect(JSON.parse((await bootr('coin', OWNER)).stdout)).toEqual({ symbol: 'AA' });
    expect(JSON.parse((await bootr('coin', 'quiet', 'engine')).stdout)).toEqual([{ symbol: 'BB' }]);
    expect(seen.at(-1)!.url).toBe('/search?q=quiet+engine');
  });

  it('agent, feed and fees call their routes', async () => {
    expect(await bootr('agent', '--posts', '7', '--limit', '2')).toMatchObject({ code: 0 });
    expect(seen.at(-1)!.url).toBe('/api/agents/7/posts?limit=2');
    expect(await bootr('feed', '--since', '100')).toMatchObject({ code: 0 });
    expect(seen.at(-1)!.url).toBe('/platform/feed?since=100');
    expect(await bootr('fees', '--coin', OWNER)).toMatchObject({ code: 0 });
    expect(seen.at(-1)!.url).toBe(`/token/${OWNER.toLowerCase()}/fees`);
  });

  it('fees shows amounts without calldata', async () => {
    const out = JSON.parse((await bootr('fees', OWNER)).stdout) as { claims: object[] };
    expect(out.claims).toEqual([{ path: 'clanker', amountWei: '5', sendFrom: null }]);
  });

  it('reports a refusal on stderr with exit code 1', async () => {
    expect(await bootr('agent', OWNER)).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('not_found'),
    });
  });
});

describe('prepare commands', () => {
  it('prints the unsigned claim and says nothing was sent', async () => {
    const { code, stdout, stderr } = await bootr('prepare', 'claim', OWNER);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { claims: object[] }).claims).toEqual([CLAIM]);
    expect(stderr).toContain('Nothing was signed or sent');
  });

  it('builds a launch from a spec, a signed message and a local image', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bootr-cli-'));
    const { stdout } = await bootr('prepare', 'launch-message', OWNER);
    const { message } = JSON.parse(stdout) as { message: string };
    expect(message).toContain('Prepare a Bootr launch.');
    await writeFile(path.join(dir, 'message.txt'), `${message}\n`);
    await writeFile(
      path.join(dir, 'launch.json'),
      JSON.stringify({
        name: 'A',
        symbol: 'AA',
        identity: 'x'.repeat(20),
        image: { url: 'https://x/a.png' },
      }),
    );
    await writeFile(path.join(dir, 'coin.png'), 'png-bytes');
    const out = await bootr(
      'prepare',
      'launch',
      '--spec',
      path.join(dir, 'launch.json'),
      '--message',
      path.join(dir, 'message.txt'),
      '--signature',
      '0xabcd',
      '--image',
      path.join(dir, 'coin.png'),
    );
    expect(out.code).toBe(0);
    expect(out.stderr).toContain('Nothing was signed or sent');
    expect((JSON.parse(out.stdout) as { transactions: object[] }).transactions).toHaveLength(1);
    const sent = JSON.parse(seen.at(-1)!.body) as {
      message: string;
      signature: string;
      launch: { image: { dataUrl: string } };
    };
    expect(sent.message).toBe(message);
    expect(sent.signature).toBe('0xabcd');
    expect(sent.launch.image.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
    );
  });
});

describe('keys', () => {
  it('has no flag for one', async () => {
    for (const flag of ['--private-key', '--key', '--mnemonic']) {
      const { code, stderr } = await bootr('prepare', 'claim', OWNER, flag, KEY);
      expect(code).toBe(2);
      expect(stderr).toContain('never takes a private key');
      expect(stderr).not.toContain(KEY);
    }
  });

  it('refuses one given as an argument, without sending or repeating it', async () => {
    const before = seen.length;
    const { code, stderr, stdout } = await bootr('prepare', 'claim', KEY);
    expect(code).toBe(2);
    expect(stderr).toContain('private key');
    expect(`${stderr}${stdout}`).not.toContain(KEY);
    expect(seen.length).toBe(before);
  });
});

describe('help', () => {
  it('lists the commands and the promise', async () => {
    const { stdout } = await bootr('--help');
    for (const s of [
      'coin',
      'agent',
      'feed',
      'fees',
      'prepare claim',
      'prepare launch',
      'never asks for a private key',
    ])
      expect(stdout).toContain(s);
  });
});
