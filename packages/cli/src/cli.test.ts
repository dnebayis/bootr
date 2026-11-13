import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HIDDEN_CHARS, hide, TAG_SENTENCE } from '../../mcp/test/fake-supervisor.mjs';

// Each call starts a real process, which takes a while when the whole workspace runs its tests at once.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** The built command as a user runs it, as a real process, against a small HTTP server speaking the catalog's routes. */
const BIN = path.resolve(import.meta.dirname, '../dist/cli.js');
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const KEY = `0x${'ab'.repeat(32)}`;
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const COIN = '0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c';
const ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
const CLAIM = {
  target: OWNER,
  data: '0x12',
  value: '0',
  path: 'clanker',
  asset: WETH,
  amountWei: '5',
  sendFrom: null,
  description: 'Pays WETH.',
};
const USDC_CLAIM = {
  ...CLAIM,
  path: 'clanker-v5',
  asset: USDC,
  amountWei: '2500000',
  description: 'Pays 2.5 USDC.',
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
          ['POST', '/api/agent/swap'],
          ['GET', '/market/{token}'],
          ['GET', '/search'],
          ['GET', '/treasury/{kernel}'],
          ['GET', '/platform/feed'],
          ['GET', '/token/{id}/fees'],
          ['GET', '/api/agents/{id}/posts'],
        ];
        return send(200, {
          chainId: 8453,
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
          asset: WETH,
          totalWei: '5',
          coins: {
            bootr: [],
            clanker: [],
            clankerV5: [{ token: OWNER, symbol: 'CC', pairedAsset: 'USDC' }],
          },
          claims: [CLAIM, USDC_CLAIM],
          note: 'Nothing was signed or sent.',
        });
      if (url === '/api/agent/nonce')
        return send(200, { nonce: 'abcdef0123456789', expiresIn: 600 });
      if (url === '/api/agent/swap') {
        const asked = JSON.parse(body) as { token: string; side: string; amount: string; wallet: string; payWith?: string; slippagePct?: number };
        if (asked.amount === '777') return send(409, { error: 'trading_not_open', message: hide('This coin launched moments ago. Trading opens in 12 seconds.') });
        const swap = { kind: 'swap', to: ROUTER, data: '0x3593564c', value: asked.side === 'buy' ? '10000000000000000' : '0', sendFrom: asked.wallet, description: 'The swap.' };
        const approve = { kind: 'approve_token', to: asked.token, data: '0x095ea7b3', value: '0', sendFrom: asked.wallet, description: 'An exact approval.' };
        return send(200, {
          chainId: 8453,
          token: asked.token,
          symbol: hide('OWL'),
          side: asked.side,
          path: 'clanker-v5',
          pairedAsset: 'ETH',
          amountIn: { raw: '1', formatted: asked.amount, asset: asked.side === 'buy' ? (asked.payWith ?? 'ETH') : 'OWL' },
          quote: { amountOut: { raw: '5', formatted: '5', asset: 'OWL' }, feePct: 1.5, impactPct: 0.1, quotedAt: 1 },
          minReceived: { raw: '4', formatted: '4', asset: 'OWL' },
          slippagePct: asked.slippagePct ?? 1,
          deadline: 1201,
          steps: asked.side === 'sell' ? [approve, swap] : [swap],
          warnings: [],
          note: 'Nothing was signed or sent.',
        });
      }
      if (url === '/api/agent/launch')
        return send(200, {
          creator: OWNER,
          chainId: 8453,
          transactions: [{ step: 'approve', to: OWNER, data: '0x', value: '0', note: '' }],
        });
      if (url.startsWith('/market/'))
        return send(200, {
          symbol: 'AA',
          source: 'clanker-v5',
          pairedToken: USDC,
          pairedSymbol: 'USDC',
          buyTaxBps: 20000,
          sellTaxBps: 30000,
          antiSnipe: false,
        });
      // A coin whose name and an error whose words carry every kind of hidden character.
      if (url.startsWith('/search?q=hidden')) return send(200, [{ symbol: 'HH', [hide('name')]: hide('A fine coin') }]);
      if (url.startsWith('/search')) return send(200, [{ symbol: 'BB' }]);
      if (url.startsWith('/treasury/')) return send(404, { error: 'not_found' });
      if (url.startsWith('/platform/feed?since=666')) return send(400, { error: 'invalid_request', message: hide('since is too far back.') });
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
  it('coin takes an address or a search, and states a coin’s terms', async () => {
    expect(JSON.parse((await bootr('coin', OWNER)).stdout)).toMatchObject({
      symbol: 'AA',
      terms: {
        source: 'clanker-v5',
        pairedAsset: 'USDC',
        buyTaxPct: 2,
        sellTaxPct: 3,
        sniperTax: false,
      },
    });
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

  it('fees shows amounts per asset, without calldata', async () => {
    const out = JSON.parse((await bootr('fees', OWNER)).stdout) as { byAsset: object[] };
    expect(out.byAsset).toEqual([
      {
        asset: WETH,
        symbol: 'WETH',
        amount: '5',
        amountText: '0.000000000000000005',
        claims: [{ path: 'clanker', amountWei: '5', sendFrom: null }],
      },
      {
        asset: USDC,
        symbol: 'USDC',
        amount: '2500000',
        amountText: '2.5',
        claims: [{ path: 'clanker-v5', amountWei: '2500000', sendFrom: null }],
      },
    ]);
    expect(JSON.stringify(out)).not.toContain('0x12');
  });

  it('prints nothing a person cannot see: hidden characters are removed from the JSON and from an error (security review M3)', async () => {
    const found = await bootr('coin', 'hidden');
    expect(JSON.parse(found.stdout)).toEqual([{ symbol: 'HH', name: 'A fine coin' }]);
    const refused = await bootr('feed', '--since', '666');
    expect(refused).toMatchObject({ code: 1, stdout: '', stderr: 'invalid_request: since is too far back.\n' });
    for (const printed of [found.stdout, found.stderr, refused.stderr]) {
      for (const [name, char] of Object.entries(HIDDEN_CHARS)) expect([name, printed.includes(char)]).toEqual([name, false]);
      for (const char of TAG_SENTENCE) expect(printed).not.toContain(char);
    }
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
    expect((JSON.parse(stdout) as { claims: object[] }).claims).toEqual([CLAIM, USDC_CLAIM]);
    expect(stderr).toContain('Nothing was signed or sent');
  });

  it('keeps only the claims paying one asset', async () => {
    const usdc = await bootr('prepare', 'claim', OWNER, '--asset', 'usdc');
    expect((JSON.parse(usdc.stdout) as { claims: object[] }).claims).toEqual([USDC_CLAIM]);
    expect(JSON.parse(usdc.stdout)).toMatchObject({ totalWei: '0' });
    const eth = await bootr('prepare', 'claim', OWNER, '--asset', 'ETH');
    expect((JSON.parse(eth.stdout) as { claims: object[] }).claims).toEqual([]);
    expect(eth.stderr).toContain('Nothing is waiting to be claimed in ETH');
    expect(await bootr('prepare', 'claim', OWNER, '--asset', 'DAI')).toMatchObject({ code: 2 });
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

describe('preparing a swap', () => {
  const sent = () => JSON.parse(seen.filter((s) => s.url === '/api/agent/swap').at(-1)!.body) as Record<string, unknown>;

  it('prints a buy as unsigned steps for the wallet named, and says nothing was sent', async () => {
    const { code, stdout, stderr } = await bootr('prepare', 'swap', '--coin', COIN, '--buy', '0.01', '--wallet', OWNER);
    expect(code).toBe(0);
    expect(sent()).toEqual({ token: COIN, side: 'buy', amount: '0.01', wallet: OWNER });
    const answer = JSON.parse(stdout) as { symbol: string; steps: { kind: string; to: string; sendFrom: string }[]; minReceived: { raw: string } };
    expect(answer.steps).toEqual([{ kind: 'swap', to: ROUTER, data: '0x3593564c', value: '10000000000000000', sendFrom: OWNER, description: 'The swap.' }]);
    expect(answer.minReceived.raw).toBe('4');
    // words from the site are printed without what a person cannot see
    expect(answer.symbol).toBe('OWL');
    expect(stderr).toContain('Nothing was signed or sent');
    expect(stderr).toContain('reverts if it would give less than minReceived');
    expect(stderr).toContain('A trade cannot be undone');
  });

  it('takes a sell, the asset to pay with and the slippage, with the coin before or after its switch', async () => {
    const sell = await bootr('prepare', 'swap', COIN, '--sell', '1000', '--wallet', OWNER.toLowerCase(), '--slippage', '2.5');
    expect(sell.code).toBe(0);
    expect(sent()).toEqual({ token: COIN, side: 'sell', amount: '1000', wallet: OWNER, slippagePct: 2.5 });
    expect((JSON.parse(sell.stdout) as { steps: { kind: string }[] }).steps.map((s) => s.kind)).toEqual(['approve_token', 'swap']);
    await bootr('prepare', 'swap', '--buy', '25', '--pay-with', 'usdc', '--wallet', OWNER, '--coin', COIN);
    expect(sent()).toEqual({ token: COIN, side: 'buy', amount: '25', wallet: OWNER, payWith: 'USDC' });
  });

  it('refuses a command it cannot read before any request, and says what is missing', async () => {
    const before = seen.length;
    const cases: [string[], string][] = [
      [['--buy', '1', '--wallet', OWNER], 'the coin: --coin <address>'],
      [['--coin', 'OWL', '--buy', '1', '--wallet', OWNER], '--coin must be the coin’s 0x address'],
      [['--coin', COIN, '--wallet', OWNER], 'Give one of --buy'],
      [['--coin', COIN, '--buy', '1', '--sell', '1', '--wallet', OWNER], 'Give one of --buy'],
      [['--coin', COIN, '--buy', '1'], '--wallet'],
      [['--coin', COIN, '--buy', '1', '--wallet', OWNER, '--pay-with', 'DAI'], '--pay-with must be ETH or USDC'],
      [['--coin', COIN, '--buy', '1', '--wallet', OWNER, '--slippage', 'low'], '--slippage must be a percent'],
    ];
    for (const [args, words] of cases) {
      const { code, stderr, stdout } = await bootr('prepare', 'swap', ...args);
      expect(code, args.join(' ')).toBe(2);
      expect(stderr, args.join(' ')).toContain(words);
      expect(stdout).toBe('');
    }
    // the SDK's own checks answer with a code, as every refusal does
    expect(await bootr('prepare', 'swap', '--coin', COIN, '--buy', 'all', '--wallet', OWNER)).toMatchObject({ code: 1, stderr: expect.stringContaining('invalid_request: amount must be a positive decimal') });
    expect(seen.length).toBe(before);
  });

  it('has no flag for a recipient or a key, and refuses a key where an address goes', async () => {
    const before = seen.filter((s) => s.url === '/api/agent/swap').length;
    for (const flag of ['--recipient', '--to', '--private-key']) {
      const { code, stderr } = await bootr('prepare', 'swap', '--coin', COIN, '--buy', '1', '--wallet', OWNER, flag, OWNER);
      expect(code, flag).toBe(2);
      expect(stderr).toContain('Unknown option');
    }
    const { code, stderr, stdout } = await bootr('prepare', 'swap', '--coin', COIN, '--buy', '1', '--wallet', KEY);
    expect(code).toBe(2);
    expect(stderr).toContain('private key');
    expect(`${stderr}${stdout}`).not.toContain(KEY);
    expect(seen.filter((s) => s.url === '/api/agent/swap').length).toBe(before);
  });

  it('passes the site’s refusal on, on stderr with exit code 1 and nothing hidden in it', async () => {
    const { code, stderr, stdout } = await bootr('prepare', 'swap', '--coin', COIN, '--buy', '777', '--wallet', OWNER);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.trim()).toBe('trading_not_open: This coin launched moments ago. Trading opens in 12 seconds.');
  });
});

describe('Clanker v5 launches', () => {
  it('checks the token settings before sending, so the signed message stays unused', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bootr-cli-'));
    const { stdout } = await bootr('prepare', 'launch-message', OWNER);
    await writeFile(
      path.join(dir, 'message.txt'),
      (JSON.parse(stdout) as { message: string }).message,
    );
    await writeFile(
      path.join(dir, 'launch.json'),
      JSON.stringify({
        name: 'A',
        symbol: 'AA',
        identity: 'x'.repeat(20),
        image: { url: 'https://x/a.png' },
        launchThrough: 'clanker',
        token: { pairedAsset: 'USDC', buyTaxPct: 6 },
      }),
    );
    const before = seen.length;
    const out = await bootr(
      'prepare',
      'launch',
      '--spec',
      path.join(dir, 'launch.json'),
      '--message',
      path.join(dir, 'message.txt'),
      '--signature',
      '0xabcd',
    );
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('invalid_request: Buy tax must be 1% to 5%');
    expect(out.stderr).toContain('signed message is still unused');
    expect(seen.length).toBe(before);
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
      'prepare swap --coin <address> (--buy <amount> | --sell <amount>) --wallet <address>',
      'never asks for a private key',
    ])
      expect(stdout).toContain(s);
  });
});
