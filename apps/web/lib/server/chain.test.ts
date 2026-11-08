import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, encodeErrorResult, erc20Abi, http, parseAbiItem, toHex, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterEach, describe, expect, it } from 'vitest';
import { serverPublicClient } from './chain';

/**
 * The server routes read contracts the caller names: a signer's smart account (SIWE), a locker, a launcher. A contract
 * that reverts with `OffchainLookup` (ERC-3668) would make a default viem client fetch the URLs it names; the shared
 * client refuses that, so the read fails at once and nothing is fetched.
 */

const OFFCHAIN_LOOKUP = parseAbiItem('error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)');
const TOKEN: Address = '0x3000000000000000000000000000000000000003';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

const servers: Server[] = [];
const saved = process.env.BASE_SEPOLIA_RPC_URL;
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  if (saved === undefined) delete process.env.BASE_SEPOLIA_RPC_URL;
  else process.env.BASE_SEPOLIA_RPC_URL = saved;
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

async function gateway(): Promise<{ template: string; hits: () => number }> {
  let hits = 0;
  const origin = await listen((_req, res) => {
    hits += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return { template: `${origin}/{sender}/{data}.json`, hits: () => hits };
}

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

describe('serverPublicClient', () => {
  it('a default viem client follows an OffchainLookup to the URL the contract names', async () => {
    const gw = await gateway();
    const rpc = await hostileRpc(gw.template);
    const plain = createPublicClient({ chain: baseSepolia, transport: http(rpc.url, { retryCount: 0 }) });
    await expect(plain.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [ZERO] })).rejects.toThrow();
    expect(gw.hits()).toBeGreaterThanOrEqual(1);
  });

  it('refuses the lookup: no fetch, one RPC call, a fast failure, and the same client on the next call', async () => {
    const gw = await gateway();
    const rpc = await hostileRpc(gw.template);
    process.env.BASE_SEPOLIA_RPC_URL = rpc.url;
    const client = serverPublicClient(84532);
    expect(serverPublicClient(84532)).toBe(client);
    const started = Date.now();
    await expect(client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [ZERO] })).rejects.toThrow(/reverted|OffchainLookup/i);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(gw.hits()).toBe(0);
    expect(rpc.calls()).toBeGreaterThanOrEqual(1);
  });
});
