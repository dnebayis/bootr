import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, erc20Abi, http } from 'viem';
import { base } from 'viem/chains';
import { afterEach, describe, expect, it } from 'vitest';
import { billingUnitsOf, createRpcCounter, defaultUnlessRateLimited, isRateLimited, RATE_LIMIT_DELAYS_MS, withRateLimitRetry } from '../src/rpc-retry.js';
import { readTreasuryOnChain, runFeePolicy } from '../src/treasury.js';
import { tick } from '../src/tick.js';
import { registerAgent } from '../src/onboarding.js';
import { KERNEL, TOKEN, makeWorld, seedAgent } from './helpers.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Answers like CDP: the first `refusals` requests get HTTP 429 with a `-32002` body. */
async function cdpLike(refusals: number): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const { id } = JSON.parse(raw) as { id: number };
      hits += 1;
      if (hits <= refusals) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32002, message: 'rate limited' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: `0x${'0'.repeat(63)}7` }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, hits: () => hits };
}

const clientFor = (url: string, slept: number[]) =>
  createPublicClient({
    chain: base,
    transport: withRateLimitRetry(http(url), {
      sleep: async (ms) => {
        slept.push(ms);
      },
      random: () => 0,
    }),
  });

const readUsdc = (client: ReturnType<typeof clientFor>) => client.readContract({ address: ZERO_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ZERO_ADDRESS] });

/** The error viem gives for CDP's answer, wrapped the way a contract read wraps it. */
const rateLimitedError = () => Object.assign(new Error('Requested resource not available.'), { cause: Object.assign(new Error('rpc'), { code: -32002 }) });

describe('withRateLimitRetry', () => {
  it('waits out a 429 with a -32002 body, which viem alone gives up on at the first answer', async () => {
    const plain = await cdpLike(1);
    const alone = createPublicClient({ chain: base, transport: http(plain.url) });
    await expect(alone.readContract({ address: ZERO_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ZERO_ADDRESS] })).rejects.toSatisfy(isRateLimited);
    expect(plain.hits()).toBe(1);

    const rpc = await cdpLike(3);
    const slept: number[] = [];
    expect(await readUsdc(clientFor(rpc.url, slept))).toBe(7n);
    expect(rpc.hits()).toBe(4);
    expect(slept).toEqual([250, 500, 1_000]);
  });

  it('gives up after spanning more than one 5 second window, and the caller sees the rate limit', async () => {
    expect(RATE_LIMIT_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThan(5_000);
    const rpc = await cdpLike(100);
    const slept: number[] = [];
    await expect(readUsdc(clientFor(rpc.url, slept))).rejects.toSatisfy(isRateLimited);
    expect(rpc.hits()).toBe(RATE_LIMIT_DELAYS_MS.length + 1);
    expect(slept).toEqual([...RATE_LIMIT_DELAYS_MS]);
  });

  it('a real viem multicall reports a limited batch as failures that say so, so the snapshot cannot read them as reverts', async () => {
    const rpc = await cdpLike(100);
    const results = await clientFor(rpc.url, []).multicall({
      allowFailure: true,
      contracts: [{ address: ZERO_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ZERO_ADDRESS] }],
    });
    expect(results[0]?.status).toBe('failure');
    expect(isRateLimited(results[0]?.error)).toBe(true);
  });

  it('does not retry an answer that is not about rate', () => {
    expect(isRateLimited(new Error('execution reverted'))).toBe(false);
    expect(isRateLimited(Object.assign(new Error('reverted'), { code: 3 }))).toBe(false);
    expect(isRateLimited(rateLimitedError())).toBe(true);
    expect(isRateLimited(Object.assign(new Error('http'), { status: 429 }))).toBe(true);
    expect(defaultUnlessRateLimited(0n)(new Error('execution reverted'))).toBe(0n);
    expect(() => defaultUnlessRateLimited(0n)(rateLimitedError())).toThrow();
  });
});

type Client = { readContract: (a: { functionName: string; address: string; args?: unknown[] }) => Promise<unknown> };
const asClient = (w: { ctx: { chain: { publicClient: unknown } } }) => w.ctx.chain.publicClient as Client;

/** Every read of `functionName` fails with the rate limit, as long as `limited.on` holds. */
function rateLimit(w: { ctx: { chain: { publicClient: unknown } } }, match: (a: { functionName: string; address: string }) => boolean, limited = { on: true }) {
  const pc = asClient(w);
  const inner = pc.readContract.bind(pc);
  pc.readContract = async (a) => {
    if (limited.on && match(a)) throw rateLimitedError();
    return inner(a);
  };
  return limited;
}

describe('a rate-limited treasury read is unknown, never zero', () => {
  it('rejects when the kernel USDC cannot be read', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      rateLimit(w, (a) => a.functionName === 'balanceOf' && a.address.toLowerCase() === w.ctx.chain.addresses.usdc.toLowerCase());
      await expect(readTreasuryOnChain(w.ctx, agent)).rejects.toSatisfy(isRateLimited);
    } finally {
      await w.close();
    }
  });

  it('rejects when only the fee or coin reads are limited, where a revert still counts as 0', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      const limited = rateLimit(w, (a) => a.functionName === 'claimableQuote');
      await expect(readTreasuryOnChain(w.ctx, agent)).rejects.toSatisfy(isRateLimited);
      limited.on = false;
      const pc = asClient(w);
      const inner = pc.readContract.bind(pc);
      pc.readContract = async (a) => {
        if (a.functionName === 'claimableQuote') throw new Error('execution reverted');
        return inner(a);
      };
      expect((await readTreasuryOnChain(w.ctx, agent)).claimable.settled).toBe('0');
    } finally {
      await w.close();
    }
  });

  it('reads the whole snapshot in one batch', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      const pc = w.ctx.chain.publicClient as unknown as { multicall: (a: unknown) => Promise<unknown> };
      const inner = pc.multicall.bind(pc);
      let batches = 0;
      pc.multicall = (a) => {
        batches += 1;
        return inner(a);
      };
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(batches).toBe(1);
      expect(snap.kernel).toBe(KERNEL);
      expect(snap.balances.eth).toBe('0');
    } finally {
      await w.close();
    }
  });
});

describe('the tick with a rate-limited treasury', () => {
  const usdcLimited = (w: { ctx: { chain: { addresses: { usdc: string } } } }) => (a: { functionName: string; address: string }) => a.functionName === 'balanceOf' && a.address.toLowerCase() === w.ctx.chain.addresses.usdc.toLowerCase();

  it('does not put an awake agent to sleep', async () => {
    const w = await makeWorld({ chain: { usdc: 5_000_000n } });
    try {
      await seedAgent(w);
      rateLimit(w, usdcLimited(w));
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      const row = await w.ctx.db.query.runtimes.findFirst();
      expect(row?.status).not.toBe('sleeping');
    } finally {
      await w.close();
    }
  });

  it('keeps a sleeping agent asleep without a turn, and wakes it once the read works', async () => {
    const w = await makeWorld({ chain: { usdc: 0n, spenderUsdc: 0n } });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      expect((await w.ctx.db.query.runtimes.findFirst())?.status).toBe('sleeping');

      // Funded while the RPC refuses: neither woken on a guess nor charged a turn.
      w.state.usdc = 5_000_000n;
      const limited = rateLimit(w, usdcLimited(w));
      w.setNow(w.ctx.now() + 3_600_000);
      const during = await tick(w.ctx);
      expect(during.ran).toEqual([]);
      expect((await w.ctx.db.query.runtimes.findFirst())?.status).toBe('sleeping');

      limited.on = false;
      w.setNow(w.ctx.now() + 60_000);
      await tick(w.ctx);
      expect((await w.ctx.db.query.runtimes.findFirst())?.status).not.toBe('sleeping');
    } finally {
      await w.close();
    }
  });

  it('reads a sleeping agent once a tick when the fee policy moved nothing', async () => {
    const w = await makeWorld({ chain: { usdc: 0n, spenderUsdc: 0n } });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const calls = () => w.state.calls.filter((c) => c.fn === 'latestRoundData').length;
      const before = calls();
      w.setNow(w.ctx.now() + 60_000);
      await tick(w.ctx);
      expect(calls() - before).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('fee policy does not run on an unknown treasury', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      rateLimit(w, usdcLimited(w));
      await expect(runFeePolicy(w.ctx, agent)).rejects.toSatisfy(isRateLimited);
    } finally {
      await w.close();
    }
  });
});

describe('registering a launch', () => {
  it('fails on a rate-limited name read instead of storing "Unknown"', async () => {
    const w = await makeWorld();
    try {
      rateLimit(w, (a) => a.functionName === 'name');
      await expect(registerAgent(w.ctx, { agentId: 777n, token: TOKEN, kernel: KERNEL } as never)).rejects.toSatisfy(isRateLimited);
    } finally {
      await w.close();
    }
  });
});

describe('createRpcCounter', () => {
  it('counts every request the transport sends (retries included), by method and in CDP billing units; a drain resets it', async () => {
    const rpc = await cdpLike(1);
    const counter = createRpcCounter();
    const client = createPublicClient({ chain: base, transport: withRateLimitRetry(http(rpc.url), { sleep: async () => {}, random: () => 0, counter }) });
    expect(await client.readContract({ address: ZERO_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ZERO_ADDRESS] })).toBe(7n);
    expect(counter.peek()).toEqual({ requests: { eth_call: 2 }, total: 2, bu: 60, rateLimited: 1 });
    expect(counter.drain()).toEqual({ requests: { eth_call: 2 }, total: 2, bu: 60, rateLimited: 1 });
    expect(counter.peek()).toEqual({ requests: {}, total: 0, bu: 0, rateLimited: 0 });
    expect(billingUnitsOf('eth_getLogs')).toBe(100);
    expect(billingUnitsOf('eth_getBlockByNumber')).toBe(100);
    expect(billingUnitsOf('eth_getBalance')).toBe(30);
  });
});
