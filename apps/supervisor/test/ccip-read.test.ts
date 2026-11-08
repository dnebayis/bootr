import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, encodeErrorResult, erc20Abi, http, parseAbiItem, toHex, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterEach, describe, expect, it } from 'vitest';
import { createChainContext } from '../src/chain.js';
import { TOKEN, testConfig } from './helpers.js';

/**
 * CCIP-Read (ERC-3668): a contract may revert with `OffchainLookup(sender, urls, ...)`, and a viem client then fetches
 * those URLs on the contract's behalf, as many times as the contract keeps reverting. The supervisor reads contracts
 * a creator chose (its coin, a locker), so its client must refuse the lookup: no fetch, a fast failure.
 */

const OFFCHAIN_LOOKUP = parseAbiItem('error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)');

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => handler(req, res, raw));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The gateway a hostile contract names: counts what reaches it and answers so that the lookup cannot go on. */
async function gateway(): Promise<{ template: string; hits: () => number }> {
  let hits = 0;
  const origin = await listen((_req, res) => {
    hits += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return { template: `${origin}/{sender}/{data}.json`, hits: () => hits };
}

/** An RPC whose every `eth_call` reverts with OffchainLookup pointing at `template`, from the contract that was called. */
async function hostileRpc(template: string): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  const url = await listen((_req, res, raw) => {
    const body = JSON.parse(raw) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
    const answer = ({ id, method, params }: { id: number; method: string; params?: unknown[] }) => {
      if (method === 'eth_call') {
        calls += 1;
        const to = (params?.[0] as { to: Address }).to;
        const data = encodeErrorResult({ abi: [OFFCHAIN_LOOKUP], errorName: 'OffchainLookup', args: [to, [template], '0x1234', '0xabcdef12', '0x'] });
        return { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data } };
      }
      if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: toHex(84532) };
      return { jsonrpc: '2.0', id, result: '0x' };
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
  });
  return { url, calls: () => calls };
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';

describe('a contract that reverts with OffchainLookup', () => {
  it('makes a default viem client fetch the URL the contract names (what the fix removes)', async () => {
    const gw = await gateway();
    const rpc = await hostileRpc(gw.template);
    const plain = createPublicClient({ chain: baseSepolia, transport: http(rpc.url, { retryCount: 0 }) });
    await expect(plain.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [ZERO] })).rejects.toThrow();
    expect(gw.hits()).toBeGreaterThanOrEqual(1);
  });

  it("is refused by the supervisor's client: no fetch, one RPC call, a fast failure", async () => {
    const gw = await gateway();
    const rpc = await hostileRpc(gw.template);
    const { publicClient } = createChainContext(testConfig({ BASE_SEPOLIA_RPC_URL: rpc.url }));
    const started = Date.now();
    await expect(publicClient.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [ZERO] })).rejects.toThrow(/reverted|OffchainLookup/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(gw.hits()).toBe(0);
    expect(rpc.calls()).toBe(1);
  });
});
