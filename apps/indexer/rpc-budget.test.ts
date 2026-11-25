import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpRequestError, TimeoutError, createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

import { BLOCKS_URL_REST_MS, SIDE_URL_MAX_REST_MS, budgetedTransport, isLogsByBlockHash, parseUrlList, restAfter, costOf, createBudget, indexerRpc, indexerTransport, isRateLimited, safeMessage, scrubError, scrubUrls, withRateLimitRetry, type Budget } from './rpc-budget';

type Reply = { status: number; body: unknown };

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A local JSON-RPC server; the url's path stands for the API key a real provider keeps there. */
async function rpcServer(reply: (method: string) => Reply): Promise<{ url: string; methods: string[] }> {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const { id, method } = JSON.parse(raw) as { id: number; method: string };
      methods.push(method);
      const { status, body } = reply(method);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, ...(body as object) }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc/v1/base/SECRETKEY`, methods };
}

const ok = (): Reply => ({ status: 200, body: { result: '0x1' } });
const limited = (): Reply => ({ status: 429, body: { error: { code: -32002, message: 'rate limited' } } });
const connect = (t: ReturnType<typeof budgetedTransport>) => t({ chain: base, retryCount: 0, timeout: 2_000 });
const noBudget: Budget = { take: async () => {}, tryTake: () => false };

describe('createBudget', () => {
  it('holds a steady stream of 100 BU calls to the budget', async () => {
    let t = 0;
    const budget = createBudget(1_300, () => t, async (ms) => {
      t += ms;
    });
    for (let i = 0; i < 100; i++) await budget.take(costOf('eth_getLogs'));
    // 10,000 BU at 1,300 BU/s, less the half second of burst the bucket starts with.
    expect(t / 1000).toBeCloseTo((10_000 - 650) / 1_300, 5);
  });

  it('never lets a 5 second window pass the CDP limit, even from a full bucket', async () => {
    let t = 0;
    const budget = createBudget(1_300, () => t, async (ms) => {
      t += ms;
    });
    let spent = 0;
    while (t < 5_000) {
      await budget.take(100);
      spent += 100;
    }
    expect(spent).toBeLessThanOrEqual(7_500);
  });

  it('tryTake refuses instead of going into debt', () => {
    const budget = createBudget(200, () => 0);
    expect(budget.tryTake(100)).toBe(true);
    expect(budget.tryTake(100)).toBe(false);
  });
});

describe('costOf', () => {
  it('prices the methods Ponder follows blocks with as enhanced', () => {
    expect(costOf('eth_getLogs')).toBe(100);
    expect(costOf('eth_getBlockByNumber')).toBe(100);
    expect(costOf('eth_call')).toBe(30);
  });
});

describe('budgetedTransport', () => {
  it('turns a CDP 429 into the status Ponder backs off on, without the key', async () => {
    const rpc = await rpcServer(limited);
    const err = await connect(budgetedTransport({ url: rpc.url, buPerSecond: 1_000 }))
      .request({ method: 'eth_getLogs', params: [] } as never)
      .catch((e: unknown) => e as Error & { status?: number });
    expect((err as { status?: number }).status).toBe(429);
    expect(isRateLimited(err)).toBe(true);
    expect((err as Error).message).not.toContain('SECRETKEY');
    expect(JSON.stringify(err)).not.toContain('SECRETKEY');
  });

  it('passes answers through and leaves other errors as they are', async () => {
    const good = await rpcServer(ok);
    await expect(connect(budgetedTransport({ url: good.url, buPerSecond: 1_000 })).request({ method: 'eth_chainId' } as never)).resolves.toBe('0x1');
    const reverting = await rpcServer(() => ({ status: 200, body: { error: { code: 3, message: 'execution reverted' } } }));
    const err = await connect(budgetedTransport({ url: reverting.url, buPerSecond: 1_000 }))
      .request({ method: 'eth_call', params: [] } as never)
      .catch((e: unknown) => e);
    expect(isRateLimited(err)).toBe(false);
  });

  it('sends what the budget cannot cover to the fallback, not to the primary', async () => {
    const primary = await rpcServer(ok);
    const fallback = await rpcServer(ok);
    await connect(budgetedTransport({ url: primary.url, fallbackUrl: fallback.url, buPerSecond: 1_000, budget: noBudget })).request({ method: 'eth_getLogs', params: [] } as never);
    expect(primary.methods).toEqual([]);
    expect(fallback.methods).toEqual(['eth_getLogs']);
  });

  it('tries the fallback when the primary answers 429', async () => {
    const primary = await rpcServer(limited);
    const fallback = await rpcServer(ok);
    const answer = await connect(budgetedTransport({ url: primary.url, fallbackUrl: fallback.url, buPerSecond: 1_000 })).request({ method: 'eth_getLogs', params: [] } as never);
    expect(answer).toBe('0x1');
    expect(primary.methods).toEqual(['eth_getLogs']);
    expect(fallback.methods).toEqual(['eth_getLogs']);
  });

  it('sends the block reads to the blocks url, spending nothing, and everything else to the primary', async () => {
    const primary = await rpcServer(ok);
    const blocks = await rpcServer(ok);
    // a budget that refuses everything: a block read that spent from it would wait here forever
    const t = connect(budgetedTransport({ url: primary.url, blocksUrl: blocks.url, buPerSecond: 1_000, budget: { take: async () => {}, tryTake: () => true } }));
    await t.request({ method: 'eth_getBlockByNumber', params: ['latest', true] } as never);
    await t.request({ method: 'eth_getBlockByHash', params: ['0x1', true] } as never);
    await t.request({ method: 'eth_blockNumber', params: [] } as never);
    await t.request({ method: 'eth_getLogs', params: [] } as never);
    await t.request({ method: 'eth_call', params: [] } as never);
    expect(blocks.methods).toEqual(['eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_blockNumber']);
    expect(primary.methods).toEqual(['eth_getLogs', 'eth_call']);
  });

  it('a block read the blocks url fails goes to the primary, and the blocks url rests before it is asked again', async () => {
    const primary = await rpcServer(ok);
    const blocks = await rpcServer(limited);
    let clock = 1_000_000;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => void warnings.push(line);
    try {
      const t = connect(budgetedTransport({ url: primary.url, blocksUrl: blocks.url, buPerSecond: 1_000, now: () => clock }));
      await expect(t.request({ method: 'eth_getBlockByNumber', params: ['latest', true] } as never)).resolves.toBe('0x1');
      clock += BLOCKS_URL_REST_MS - 1;
      await expect(t.request({ method: 'eth_getBlockByNumber', params: ['0x2', true] } as never)).resolves.toBe('0x1');
      expect(blocks.methods).toEqual(['eth_getBlockByNumber']);
      expect(primary.methods).toEqual(['eth_getBlockByNumber', 'eth_getBlockByNumber']);
      clock += 1;
      await t.request({ method: 'eth_getBlockByNumber', params: ['0x3', true] } as never);
      expect(blocks.methods).toHaveLength(2);
      expect(warnings).toHaveLength(2);
      expect(warnings.join('\n')).toContain('127.0.0.1');
      expect(warnings.join('\n')).not.toContain('SECRETKEY');
    } finally {
      console.warn = warn;
    }
  });
});

describe('indexerRpc', () => {
  const cdp = 'https://api.developer.coinbase.com/rpc/v1/base/k';
  const other = 'https://base.example.org/k';

  it('budgets a CDP url by default and any url when asked', () => {
    expect(typeof indexerRpc({ urls: [cdp] })).toBe('function');
    expect(typeof indexerRpc({ urls: [other], budget: '500' })).toBe('function');
  });

  it('applies a blocks url through the transport, since Ponder itself cannot route by method', () => {
    expect(typeof indexerRpc({ urls: ['https://mainnet.base.org'], budget: '0', blocksUrl: 'https://mainnet.base.org' })).toBe('function');
    expect(indexerRpc({ urls: ['https://mainnet.base.org'], budget: '0', blocksUrl: '' })).toBe('https://mainnet.base.org');
  });

  it('leaves urls with nothing to hide to Ponder', () => {
    expect(indexerRpc({ urls: ['https://mainnet.base.org'] })).toBe('https://mainnet.base.org');
    expect(indexerRpc({ urls: ['http://127.0.0.1:8555'] })).toBe('http://127.0.0.1:8555');
    expect(indexerRpc({ urls: ['https://mainnet.base.org'], fallbackUrl: 'https://base.llamarpc.com' })).toEqual(['https://mainnet.base.org', 'https://base.llamarpc.com']);
  });

  it('never gives Ponder a url holding a key, also with the budget off', () => {
    expect(typeof indexerRpc({ urls: [other] })).toBe('function');
    expect(typeof indexerRpc({ urls: [cdp], budget: '0' })).toBe('function');
    expect(typeof indexerRpc({ urls: ['https://mainnet.base.org'], fallbackUrl: other })).toBe('function');
    expect(typeof indexerRpc({ urls: ['https://user:pass@base.example.org'] })).toBe('function');
    expect(typeof indexerRpc({ urls: ['https://base.example.org?key=abc'] })).toBe('function');
  });

  it('keeps a bad url out of the error it throws', () => {
    expect(() => indexerRpc({ urls: ['not a url SECRETKEY'] })).toThrow(/not a valid url/);
    expect(() => indexerRpc({ urls: ['not a url SECRETKEY'] })).not.toThrow(/SECRETKEY/);
  });

  it('refuses a budget that is not a number', () => {
    expect(() => indexerRpc({ urls: [cdp], budget: 'lots' })).toThrow(/INDEXER_RPC_BU_PER_SEC/);
  });
});

describe('scrubbing', () => {
  const keyed = 'https://api.developer.coinbase.com/rpc/v1/base/SECRETKEY?x=1';

  it('cuts every url down to its origin and leaves the rest of the text', () => {
    expect(scrubUrls(`failed. URL: ${keyed} (retry)`)).toBe('failed. URL: https://api.developer.coinbase.com (retry)');
    expect(scrubUrls('wss://a.example/SECRETKEY and https://b.example/SECRETKEY')).toBe('wss://a.example and https://b.example');
    expect(scrubUrls('no url here: execution reverted')).toBe('no url here: execution reverted');
  });

  it('takes the url out of a viem error and all it wraps, keeping what the callers go by', () => {
    const inner = new TimeoutError({ body: { method: 'eth_call' }, url: keyed });
    const outer = new HttpRequestError({ body: {}, cause: inner, status: 503, url: keyed });
    expect(outer.message).toContain('SECRETKEY');
    const same = scrubError(outer);
    expect(same).toBe(outer);
    expect(same.status).toBe(503);
    expect(same).toBeInstanceOf(HttpRequestError);
    expect(inner).toBeInstanceOf(TimeoutError);
    for (const e of [outer, inner]) {
      expect(e.message).not.toContain('SECRETKEY');
      expect(e.stack).not.toContain('SECRETKEY');
      expect(JSON.stringify(e)).not.toContain('SECRETKEY');
    }
    expect(same.url).toBe('https://api.developer.coinbase.com');
  });

  it('survives what is not an error', () => {
    expect(scrubError(undefined)).toBeUndefined();
    expect(scrubError('text')).toBe('text');
    const loop: { cause?: unknown; message: string } = { message: keyed };
    loop.cause = loop;
    expect(scrubError(loop).message).toBe('https://api.developer.coinbase.com');
  });

  it('gives a log line without the url', () => {
    expect(safeMessage(new Error(`boom ${keyed}`))).toBe('boom https://api.developer.coinbase.com');
    expect(safeMessage(keyed)).toBe('https://api.developer.coinbase.com');
  });

  it('keeps the key out of a real failed request that is not a 429', async () => {
    const down = await rpcServer(() => ({ status: 500, body: { error: { code: -32603, message: 'internal' } } }));
    const err = (await connect(budgetedTransport({ url: down.url, buPerSecond: 1_000 }))
      .request({ method: 'eth_getLogs', params: [] } as never)
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('SECRETKEY');
    expect(err.stack).not.toContain('SECRETKEY');
    expect(JSON.stringify(err)).not.toContain('SECRETKEY');
  });

  it('keeps the key out of an unreachable host and a client wrapping the error', async () => {
    const unreachable = 'http://127.0.0.1:9/rpc/v1/base/SECRETKEY';
    const client = createPublicClient({ transport: indexerTransport({ urls: [unreachable], budget: '0' }) });
    const err = (await client
      .readContract({ address: '0x0000000000000000000000000000000000000001', abi: parseAbi(['function f() view returns (uint256)']), functionName: 'f' })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('SECRETKEY');
    expect(err.stack).not.toContain('SECRETKEY');
    // The plain viem transport is what this replaces: it does print the key.
    const plain = createPublicClient({ transport: http(unreachable, { retryCount: 0 }) });
    await expect(plain.getBlockNumber()).rejects.toThrow(/SECRETKEY/);
  });
});

describe('withRateLimitRetry', () => {
  const noWait = { sleep: async () => {}, random: () => 0 };

  it('waits out a 429 and answers', async () => {
    let calls = 0;
    const rpc = await rpcServer(() => (++calls < 3 ? limited() : ok()));
    const t = withRateLimitRetry(budgetedTransport({ url: rpc.url, buPerSecond: 1_000 }), noWait)({ chain: base, retryCount: 0, timeout: 2_000 });
    await expect(t.request({ method: 'eth_chainId' } as never)).resolves.toBe('0x1');
    expect(calls).toBe(3);
  });

  it('gives up after the last delay, still without the key', async () => {
    const rpc = await rpcServer(limited);
    const t = withRateLimitRetry(budgetedTransport({ url: rpc.url, buPerSecond: 1_000 }), { ...noWait, delaysMs: [1, 1] })({ chain: base, retryCount: 0, timeout: 2_000 });
    const err = (await t.request({ method: 'eth_chainId' } as never).catch((e: unknown) => e)) as Error;
    expect(isRateLimited(err)).toBe(true);
    expect(err.message).not.toContain('SECRETKEY');
    expect(rpc.methods).toHaveLength(3);
  });

  it('does not retry what is not a rate limit', async () => {
    const rpc = await rpcServer(() => ({ status: 200, body: { error: { code: 3, message: 'execution reverted' } } }));
    const t = withRateLimitRetry(budgetedTransport({ url: rpc.url, buPerSecond: 1_000 }), noWait)({ chain: base, retryCount: 0, timeout: 2_000 });
    await expect(t.request({ method: 'eth_call', params: [] } as never)).rejects.toThrow();
    expect(rpc.methods).toHaveLength(1);
  });
});

describe('indexerTransport', () => {
  it('shares one budget between the transports of a process', async () => {
    const rpc = await rpcServer(ok);
    // 100 BU at 400 BU/s: the half second of burst covers two calls, the third has to wait. Both clients draw on the same budget.
    const a = indexerTransport({ urls: [rpc.url], budget: '400' })({ chain: base, retryCount: 0, timeout: 2_000 });
    const b = indexerTransport({ urls: [rpc.url], budget: '400' })({ chain: base, retryCount: 0, timeout: 2_000 });
    const t0 = Date.now();
    await a.request({ method: 'eth_getLogs', params: [] } as never);
    await b.request({ method: 'eth_getLogs', params: [] } as never);
    await a.request({ method: 'eth_getLogs', params: [] } as never);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });
});

describe('listed urls for the head (INDEXER_LOGS_RPC_URLS, INDEXER_BLOCKS_RPC_URL)', () => {
  type Handler = (method: string, params: unknown[]) => Reply | 'hang' | 'drop' | 'garbage';
  /** Like `rpcServer`, with the params in hand and the ways an endpoint fails without a JSON-RPC answer. */
  async function endpoint(handler: Handler): Promise<{ url: string; methods: string[]; set(h: Handler): void }> {
    let current = handler;
    const methods: string[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
        methods.push(method);
        const reply = current(method, params);
        if (reply === 'hang') return;
        if (reply === 'drop') return void req.socket.destroy();
        if (reply === 'garbage') {
          res.writeHead(200, { 'content-type': 'text/html' });
          return void res.end('<html>maintenance</html>');
        }
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, ...(reply.body as object) }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/SECRETKEY`, methods, set: (h) => void (current = h) };
  }

  const HASH = `0x${'ab'.repeat(32)}`;
  const byHash = { method: 'eth_getLogs', params: [{ blockHash: HASH, topics: [] }] } as never;
  const byRange = { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] } as never;
  const block = { method: 'eth_getBlockByNumber', params: ['0x10', true] } as never;
  const LOG = { address: '0x0000000000000000000000000000000000000001', blockHash: HASH, logIndex: '0x0' };
  const answers = (result: unknown): Handler => () => ({ status: 200, body: { result } });
  const free: Budget = { take: async () => {}, tryTake: () => true };

  /** Runs with console.warn collected. */
  async function withWarnings(run: (warnings: string[]) => Promise<void>): Promise<void> {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => void warnings.push(line);
    try {
      await run(warnings);
    } finally {
      console.warn = warn;
    }
  }

  const failures: Array<[string, Handler]> = [
    ['a JSON-RPC error (unknown block hash)', () => ({ status: 200, body: { error: { code: -32000, message: 'block not found' } } })],
    ['an HTTP 500', () => ({ status: 500, body: { error: { code: -32603, message: 'internal' } } })],
    ['an HTTP 429', limited],
    ['a null result', answers(null)],
    ['a missing result', () => ({ status: 200, body: {} })],
    ['a result that is not a list', answers('0x')],
    ['a body that is not JSON', () => 'garbage'],
    ['a dropped connection', () => 'drop'],
    ['a timeout', () => 'hang'],
  ];

  it('knows the logs of one block from a range query', () => {
    expect(isLogsByBlockHash({ method: 'eth_getLogs', params: [{ blockHash: HASH }] })).toBe(true);
    expect(isLogsByBlockHash({ method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] })).toBe(false);
    expect(isLogsByBlockHash({ method: 'eth_getLogs', params: [{ blockHash: null }] })).toBe(false);
    expect(isLogsByBlockHash({ method: 'eth_getLogs', params: [] })).toBe(false);
    expect(isLogsByBlockHash({ method: 'eth_getLogs' })).toBe(false);
    expect(isLogsByBlockHash({ method: 'eth_getBlockByHash', params: [{ blockHash: HASH }] })).toBe(false);
  });

  it('reads a comma-separated list in order, without blanks or repeats', () => {
    expect(parseUrlList(' https://a.example , https://b.example,,https://a.example ')).toEqual(['https://a.example', 'https://b.example']);
    expect(parseUrlList('https://a.example')).toEqual(['https://a.example']);
    expect(parseUrlList('')).toEqual([]);
    expect(parseUrlList(undefined)).toEqual([]);
  });

  it('rests a url 10 s after the first failure, doubling up to 5 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(restAfter)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(SIDE_URL_MAX_REST_MS).toBe(300_000);
  });

  it('sends logs by block hash to the first listed url, outside the budget, and range queries to the primary', async () => {
    const primary = await endpoint(answers([]));
    const first = await endpoint(answers([LOG]));
    const second = await endpoint(answers([]));
    let spent = 0;
    const budget: Budget = { take: async (c) => void (spent += c), tryTake: () => true };
    const t = connect(budgetedTransport({ url: primary.url, logsUrls: [first.url, second.url], buPerSecond: 1_000, budget }));
    await expect(t.request(byHash)).resolves.toEqual([LOG]);
    expect(spent).toBe(0);
    await t.request(byRange);
    await t.request({ method: 'eth_call', params: [] } as never);
    await t.request(block);
    expect(first.methods).toEqual(['eth_getLogs']);
    expect(second.methods).toEqual([]);
    expect(primary.methods).toEqual(['eth_getLogs', 'eth_call', 'eth_getBlockByNumber']);
    expect(spent).toBe(100 + 30 + 100);
  });

  it('takes an empty list as the answer: most blocks hold none of our logs', async () => {
    const primary = await endpoint(answers([LOG]));
    const first = await endpoint(answers([]));
    await withWarnings(async (warnings) => {
      const t = connect(budgetedTransport({ url: primary.url, logsUrls: [first.url], buPerSecond: 0, budget: free }));
      await expect(t.request(byHash)).resolves.toEqual([]);
      expect(primary.methods).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });

  for (const [name, handler] of failures) {
    it(`moves on to the next listed url on ${name}, and never answers [] for it`, async () => {
      const primary = await endpoint(answers([]));
      const first = await endpoint(handler);
      const second = await endpoint(answers([LOG]));
      await withWarnings(async (warnings) => {
        const t = connect(budgetedTransport({ url: primary.url, logsUrls: [first.url, second.url], buPerSecond: 0, budget: free, sideTimeoutMs: 150 }));
        await expect(t.request(byHash)).resolves.toEqual([LOG]);
        expect(first.methods).toEqual(['eth_getLogs']);
        expect(second.methods).toEqual(['eth_getLogs']);
        expect(primary.methods).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('resting it for 10 s');
        expect(warnings[0]).toContain(new URL(second.url).origin);
        expect(warnings[0]).not.toContain('SECRETKEY');
      });
    });

    it(`gives the primary's own error, not an empty list, when every url fails with ${name}`, async () => {
      const primary = await endpoint(() => ({ status: 200, body: { error: { code: -32000, message: 'block not found' } } }));
      const first = await endpoint(handler);
      await withWarnings(async () => {
        const t = connect(budgetedTransport({ url: primary.url, logsUrls: [first.url], buPerSecond: 0, budget: free, sideTimeoutMs: 150 }));
        const outcome = await t.request(byHash).then(
          (result: unknown) => ({ result }),
          (error: unknown) => ({ error }),
        );
        expect(outcome).not.toHaveProperty('result');
        expect(safeMessage((outcome as { error: unknown }).error)).not.toContain('SECRETKEY');
        expect(primary.methods).toEqual(['eth_getLogs']);
      });
    });
  }

  it('falls back to the primary, under its budget, after the whole list', async () => {
    const primary = await endpoint(answers([LOG]));
    const first = await endpoint(() => 'drop');
    const second = await endpoint(limited);
    let spent = 0;
    const budget: Budget = { take: async (c) => void (spent += c), tryTake: () => true };
    await withWarnings(async (warnings) => {
      const t = connect(budgetedTransport({ url: primary.url, logsUrls: [first.url, second.url], buPerSecond: 1_000, budget }));
      await expect(t.request(byHash)).resolves.toEqual([LOG]);
      expect([first.methods, second.methods, primary.methods]).toEqual([['eth_getLogs'], ['eth_getLogs'], ['eth_getLogs']]);
      expect(spent).toBe(100);
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toContain('using the primary meanwhile');
    });
  });

  it('rests a failing url with a growing cooldown, logs once per cooldown, and takes it back when it answers', async () => {
    const primary = await endpoint(answers([]));
    const first = await endpoint(limited);
    const second = await endpoint(answers([LOG]));
    let clock = 1_000_000;
    await withWarnings(async (warnings) => {
      const t = connect(budgetedTransport({ url: primary.url, logsUrls: [first.url, second.url], buPerSecond: 0, budget: free, now: () => clock }));
      // first failure: 10 s of rest, during which the url is not asked and nothing more is logged
      for (let i = 0; i < 5; i++) await t.request(byHash);
      clock += 9_999;
      await t.request(byHash);
      expect(first.methods).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      // asked again after the rest; a second failure in a row rests it 20 s
      clock += 1;
      await t.request(byHash);
      expect(first.methods).toHaveLength(2);
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toContain('failure 2 in a row');
      expect(warnings[1]).toContain('resting it for 20 s');
      clock += 19_999;
      await t.request(byHash);
      expect(first.methods).toHaveLength(2);
      // it answers again: back in first place, one line saying so, and the cooldown starts over at 10 s
      first.set(answers([]));
      clock += 1;
      await expect(t.request(byHash)).resolves.toEqual([]);
      await expect(t.request(byHash)).resolves.toEqual([]);
      expect(first.methods).toHaveLength(4);
      expect(warnings).toHaveLength(3);
      expect(warnings[2]).toContain('answers again');
      first.set(limited);
      await t.request(byHash);
      expect(warnings).toHaveLength(4);
      expect(warnings[3]).toContain('resting it for 10 s');
      expect(second.methods).toHaveLength(9);
      expect(primary.methods).toEqual([]);
    });
  });

  it('counts requests that were in flight together as one failure', async () => {
    const primary = await endpoint(answers([]));
    const first = await endpoint(limited);
    await withWarnings(async (warnings) => {
      const t = connect(budgetedTransport({ url: primary.url, logsUrls: [first.url], buPerSecond: 0, budget: free }));
      await Promise.all([t.request(byHash), t.request(byHash), t.request(byHash), t.request(byHash)]);
      expect(first.methods).toHaveLength(4);
      expect(primary.methods).toHaveLength(4);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('failure 1 in a row');
    });
  });

  it('tries a list of blocks urls in order, then the primary, and leaves the logs where they were', async () => {
    const primary = await endpoint(answers({ number: '0x10' }));
    const first = await endpoint(limited);
    const second = await endpoint(answers({ number: '0x10', from: 'second' }));
    let clock = 1_000_000;
    await withWarnings(async (warnings) => {
      const t = connect(budgetedTransport({ url: primary.url, blocksUrl: [first.url, second.url], buPerSecond: 0, budget: free, now: () => clock }));
      await expect(t.request(block)).resolves.toEqual({ number: '0x10', from: 'second' });
      await expect(t.request(block)).resolves.toEqual({ number: '0x10', from: 'second' });
      await t.request(byHash);
      expect([first.methods, second.methods, primary.methods]).toEqual([['eth_getBlockByNumber'], ['eth_getBlockByNumber', 'eth_getBlockByNumber'], ['eth_getLogs']]);
      expect(warnings).toHaveLength(1);
      second.set(() => 'drop');
      await expect(t.request(block)).resolves.toEqual({ number: '0x10' });
      expect(primary.methods).toEqual(['eth_getLogs', 'eth_getBlockByNumber']);
      clock += BLOCKS_URL_REST_MS;
      first.set(answers({ number: '0x11', from: 'first' }));
      await expect(t.request(block)).resolves.toEqual({ number: '0x11', from: 'first' });
    });
  });

  it('asks the next url for a block a listed url does not have yet, and the primary has the last word', async () => {
    const primary = await endpoint(answers(null));
    const first = await endpoint(answers(null));
    const second = await endpoint(answers({ number: '0x10' }));
    await withWarnings(async () => {
      const both = connect(budgetedTransport({ url: primary.url, blocksUrl: [first.url, second.url], buPerSecond: 0, budget: free }));
      await expect(both.request(block)).resolves.toEqual({ number: '0x10' });
      const one = connect(budgetedTransport({ url: primary.url, blocksUrl: first.url, buPerSecond: 0, budget: free }));
      await expect(one.request(block)).resolves.toBeNull();
      expect(primary.methods).toEqual(['eth_getBlockByNumber']);
    });
  });

  it('keeps the blocks and the logs lists apart: a failing blocks url does not rest the same url for logs', async () => {
    const primary = await endpoint(answers([]));
    const shared = await endpoint((method) => (method === 'eth_getLogs' ? { status: 200, body: { result: [LOG] } } : { status: 429, body: { error: { code: -32002, message: 'rate limited' } } }));
    await withWarnings(async () => {
      const t = connect(budgetedTransport({ url: primary.url, blocksUrl: [shared.url], logsUrls: [shared.url], buPerSecond: 0, budget: free }));
      await t.request(block);
      await expect(t.request(byHash)).resolves.toEqual([LOG]);
      expect(primary.methods).toEqual(['eth_getBlockByNumber']);
    });
  });

  describe('indexerRpc and the environment', () => {
    const saved = process.env.INDEXER_LOGS_RPC_URLS;
    afterEach(() => {
      if (saved === undefined) delete process.env.INDEXER_LOGS_RPC_URLS;
      else process.env.INDEXER_LOGS_RPC_URLS = saved;
    });

    it('uses no public url unless one is set', async () => {
      delete process.env.INDEXER_LOGS_RPC_URLS;
      expect(indexerRpc({ urls: ['https://mainnet.base.org'], budget: '0' })).toBe('https://mainnet.base.org');
      expect(indexerRpc({ urls: ['https://mainnet.base.org'], budget: '0', logsUrls: ' , ' })).toBe('https://mainnet.base.org');
      const primary = await endpoint(answers([LOG]));
      const t = connect(indexerTransport({ urls: [primary.url], budget: '0' }));
      await expect(t.request(byHash)).resolves.toEqual([LOG]);
      await t.request(block);
      expect(primary.methods).toEqual(['eth_getLogs', 'eth_getBlockByNumber']);
    });

    it('reads INDEXER_LOGS_RPC_URLS for every transport of the process, and an explicit value wins', async () => {
      const primary = await endpoint(answers([]));
      const listed = await endpoint(answers([LOG]));
      process.env.INDEXER_LOGS_RPC_URLS = ` ${listed.url} `;
      expect(typeof indexerRpc({ urls: ['https://mainnet.base.org'], budget: '0' })).toBe('function');
      await expect(connect(indexerTransport({ urls: [primary.url], budget: '0' })).request(byHash)).resolves.toEqual([LOG]);
      await expect(connect(indexerTransport({ urls: [primary.url], budget: '0', logsUrls: '' })).request(byHash)).resolves.toEqual([]);
      expect(indexerRpc({ urls: ['https://mainnet.base.org'], budget: '0', logsUrls: '' })).toBe('https://mainnet.base.org');
    });

    it('takes INDEXER_BLOCKS_RPC_URL as one url, as before, or as a list', async () => {
      delete process.env.INDEXER_LOGS_RPC_URLS;
      const primary = await endpoint(answers({ from: 'primary' }));
      const first = await endpoint(() => 'drop');
      const second = await endpoint(answers({ from: 'second' }));
      await withWarnings(async () => {
        const single = connect(indexerTransport({ urls: [primary.url], budget: '0', blocksUrl: second.url }));
        await expect(single.request(block)).resolves.toEqual({ from: 'second' });
        await single.request(byHash);
        const list = connect(indexerTransport({ urls: [primary.url], budget: '0', blocksUrl: `${first.url}, ${second.url}` }));
        await expect(list.request(block)).resolves.toEqual({ from: 'second' });
        expect(first.methods).toEqual(['eth_getBlockByNumber']);
        expect(primary.methods).toEqual(['eth_getLogs']);
      });
    });

    it('keeps a bad listed url out of the error it throws', () => {
      expect(() => indexerRpc({ urls: ['https://mainnet.base.org'], logsUrls: 'https://ok.example,not a url/SECRETKEY' })).toThrow(/not a valid url/);
      expect(() => indexerRpc({ urls: ['https://mainnet.base.org'], logsUrls: 'not a url/SECRETKEY' })).not.toThrow(/SECRETKEY/);
      expect(() => indexerRpc({ urls: ['https://mainnet.base.org'], blocksUrl: 'https://ok.example,not a url/SECRETKEY' })).toThrow(/not a valid url/);
    });
  });
});
