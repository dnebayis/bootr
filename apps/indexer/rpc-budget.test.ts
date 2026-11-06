import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { base } from 'viem/chains';

import { budgetedTransport, costOf, createBudget, indexerRpc, isRateLimited, type Budget } from './rpc-budget';

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
});

describe('indexerRpc', () => {
  const cdp = 'https://api.developer.coinbase.com/rpc/v1/base/k';
  const other = 'https://base.example.org/k';

  it('budgets a CDP url by default and any url when asked', () => {
    expect(typeof indexerRpc({ urls: [cdp] })).toBe('function');
    expect(typeof indexerRpc({ urls: [other], budget: '500' })).toBe('function');
  });

  it('leaves other providers to Ponder, and 0 turns the budget off', () => {
    expect(indexerRpc({ urls: [other] })).toBe(other);
    expect(indexerRpc({ urls: [cdp], budget: '0' })).toBe(cdp);
    expect(indexerRpc({ urls: [other], fallbackUrl: cdp })).toEqual([other, cdp]);
    expect(indexerRpc({ urls: [other, cdp] })).toEqual([other, cdp]);
  });

  it('refuses a budget that is not a number', () => {
    expect(() => indexerRpc({ urls: [cdp], budget: 'lots' })).toThrow(/INDEXER_RPC_BU_PER_SEC/);
  });
});
