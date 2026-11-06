/**
 * The owner's command, run as the owner runs it, on a local fork of Base: real USDC, real Permit2, the real x402 `upto`
 * proxy and x402's own facilitator code settling from an Anvil test key. Only BlockRun's HTTP server is a stub. The
 * wallet is generated per test and holds nothing outside the fork. Run with a Base RPC:
 * `BASE_FORK_RPC_URL=https://base-rpc.publicnode.com pnpm vitest run test/blockrun-live-check-fork.test.ts`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAddresses } from '@bootr/shared/addresses';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { UptoEvmScheme } from '@x402/evm/upto/facilitator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, erc20Abi, http, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { EXIT_FAILED, EXIT_OK, runLiveCheck } from '../scripts/blockrun-live-check.js';
import { BLOCKRUN_DEFAULT_PAYTO } from '../src/config.js';

const RPC = process.env.BASE_FORK_RPC_URL;
const PORT = 19_545 + (process.pid % 1000);
const ANVIL = `http://127.0.0.1:${PORT}`;
const USDC = getAddresses(8453).usdc;
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PAYTO = BLOCKRUN_DEFAULT_PAYTO as Address;
/** Anvil's public first test key: plays the facilitator's gas wallet on the fork. */
const facilitator = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const FUNDED = 1_000_000n;
const TINY_CEILING = 2000n;
const THOUGHT_CEILING = 99_484n;
const AMOUNTS = [1072n, 66_400n, 18_100n];

const required = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/blockrun/payment-required.json', import.meta.url)), 'utf8')).requirements as PaymentRequired;
const finish = { id: 'call_f', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ memory: 'm', agenda: 'a', summary: 's', nextAt: '2026-11-06T18:00:00.000Z' }) } };
const usage = (read: number, write: number) => ({ prompt_tokens: 16_800, completion_tokens: 300, total_tokens: 17_100, prompt_tokens_details: { cached_tokens: read, cached_creation_tokens: write } });
const MODEL = 'anthropic/claude-sonnet-4.6';
const answers = [
  { id: 'c1', model: MODEL, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 14, completion_tokens: 2, total_tokens: 16 } },
  { id: 'c2', model: MODEL, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [finish] } }], usage: usage(0, 14_000) },
  { id: 'c3', model: MODEL, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [finish] } }], usage: usage(14_000, 0) },
];

describe.skipIf(!RPC)('the live check on a Base fork', () => {
  let anvil: ChildProcess;
  const publicClient = createPublicClient({ chain: base, transport: http(ANVIL) });
  const testClient = createTestClient({ chain: base, mode: 'anvil', transport: http(ANVIL) });
  const walletClient = createWalletClient({ account: facilitator, chain: base, transport: http(ANVIL) });
  const upto = new UptoEvmScheme(
    toFacilitatorEvmSigner({
      address: facilitator.address,
      readContract: (args) => publicClient.readContract({ ...args, account: facilitator.address } as never),
      verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
      writeContract: (args) => walletClient.writeContract(args as never),
      sendTransaction: (args) => walletClient.sendTransaction(args as never),
      waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args as never),
      getCode: (args) => publicClient.getCode(args as never),
    }),
  );
  const balance = (holder: Address) => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
  const allowance = (holder: Address) => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [holder, PERMIT2] });

  beforeAll(async () => {
    anvil = spawn('anvil', ['--fork-url', RPC!, '--port', String(PORT), '--silent', '--no-storage-caching'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        await publicClient.getBlockNumber();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new Error('anvil did not start');
  });
  afterAll(() => {
    anvil?.kill();
  });

  /** A wallet with USDC on the fork only, and a stub of BlockRun that verifies and settles through x402's own code. */
  async function setup(behave: (ctx: { i: number; settle: () => Promise<Hex>; destroy: () => void; send: (status: number, body: unknown, headers?: Record<string, string>) => void }) => Promise<void>) {
    const key = generatePrivateKey();
    const wallet = privateKeyToAccount(key).address;
    await testClient.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [wallet, 9n])), value: `0x${FUNDED.toString(16).padStart(64, '0')}` });
    let paid = 0;
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        void (async () => {
          const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
            res.writeHead(status, { 'content-type': 'application/json', ...headers });
            res.end(JSON.stringify(body));
          };
          if (req.url === '/api/v1/models') return send(200, { data: [{ id: MODEL, pricing: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } }] });
          if (req.url === '/or/models') return send(200, { data: [{ id: MODEL, pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' } }] });
          const accepts = required.accepts.map((a) => ({ ...a, amount: ((JSON.parse(raw) as { max_tokens: number }).max_tokens === 32 ? TINY_CEILING : THOUGHT_CEILING).toString(), extra: a.scheme === 'upto' ? { ...a.extra, facilitatorAddress: facilitator.address } : a.extra }));
          const signature = req.headers['payment-signature'] as string | undefined;
          if (!signature) return send(402, { x402Version: 2 }, { 'payment-required': encodePaymentRequiredHeader({ ...required, accepts }) });
          const payload: PaymentPayload = decodePaymentSignatureHeader(signature);
          const requirement = accepts.find((a) => a.scheme === 'upto')!;
          const verified = await upto.verify(payload, requirement);
          if (!verified.isValid) return send(402, { error: 'Payment verification failed', code: 'PAYMENT_INVALID', debug: verified.invalidReason });
          const i = paid++;
          await behave({
            i,
            settle: async () => {
              const settled = await upto.settle(payload, { ...requirement, amount: AMOUNTS[i]!.toString() });
              if (!settled.success) throw new Error(`settle failed: ${settled.errorReason}`);
              return settled.transaction as Hex;
            },
            destroy: () => req.socket.destroy(),
            send,
          });
        })().catch((err: unknown) => {
          res.writeHead(500);
          res.end(String(err));
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const stub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const close = () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      });
    return { key, wallet, stub, close, paid: () => paid };
  }

  /** The command as documented, in its own process, with nothing in its environment but what it asks for. */
  function runCommand(key: Hex, stub: string, argv: string[]): Promise<{ code: number | null; output: string }> {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const child = spawn('./node_modules/.bin/tsx', ['scripts/blockrun-live-check.ts', ...argv], {
      cwd,
      env: { PATH: process.env.PATH!, BLOCKRUN_TEST_PRIVATE_KEY: key, BLOCKRUN_TEST_RPC_URL: ANVIL, BLOCKRUN_TEST_BASE_URL: `${stub}/api/v1`, BLOCKRUN_TEST_OPENROUTER_MODELS_URL: `${stub}/or/models` },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    return new Promise((resolve) => child.on('close', (code) => resolve({ code, output })));
  }

  const serve = async ({ i, settle, send }: { i: number; settle: () => Promise<Hex>; send: (status: number, body: unknown, headers?: Record<string, string>) => void }) => {
    const tx = await settle();
    send(200, answers[i], { 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: tx, network: 'eip155:8453', amount: AMOUNTS[i]!.toString() })).toString('base64'), 'x-payment-receipt': tx });
  };

  it('without --yes it signs nothing and moves nothing', async () => {
    const s = await setup(serve);
    try {
      const { code, output } = await runCommand(s.key, s.stub, []);
      expect(code).toBe(EXIT_OK);
      expect(output).toContain('Not paying without --yes');
      expect(output).toContain(s.wallet);
      expect(output).toContain('Total ceiling $0.200968');
      expect(output).not.toContain(s.key.slice(2));
      expect(s.paid()).toBe(0);
      expect(await balance(s.wallet)).toBe(FUNDED);
      expect(await allowance(s.wallet)).toBe(0n);
    } finally {
      await s.close();
    }
  }, 180_000);

  it('with --yes: a wallet with no ETH pays three calls, exactly the real cost moves, the approval stays limited, every risk passes', async () => {
    const s = await setup(serve);
    try {
      const payToBefore = await balance(PAYTO);
      expect(await publicClient.getBalance({ address: s.wallet })).toBe(0n);
      const { code, output } = await runCommand(s.key, s.stub, ['--yes']);
      expect(output).not.toContain(s.key);
      expect(output).not.toContain(s.key.slice(2));
      expect(code, output).toBe(EXIT_OK);
      expect(s.paid()).toBe(3);
      const total = AMOUNTS[0]! + AMOUNTS[1]! + AMOUNTS[2]!;
      expect(await balance(s.wallet)).toBe(FUNDED - total);
      expect((await balance(PAYTO)) - payToBefore).toBe(total);
      expect(await publicClient.getBalance({ address: s.wallet })).toBe(0n);
      // Only the last call's unspent ceiling is left, and Permit2 cannot use it without a new signature.
      expect(await allowance(s.wallet)).toBe(THOUGHT_CEILING - AMOUNTS[2]!);
      expect(output).toContain('Moved       $0.066400, tx 0x');
      expect(output.trim().split('\n').at(-1)).toBe('PASS');
      const txs = [...output.matchAll(/Moved +\$[\d.]+, tx (0x[0-9a-f]{64})/g)].map((m) => m[1] as Hex);
      expect(new Set(txs).size).toBe(3);
      for (const tx of txs) expect((await publicClient.getTransactionReceipt({ hash: tx })).status).toBe('success');
    } finally {
      await s.close();
    }
  }, 180_000);

  it('response lost after settling: the chain shows one payment, the command stops and does not pay again', async () => {
    const s = await setup(async ({ settle, destroy }) => {
      await settle();
      destroy();
    });
    try {
      const { code, output } = await runCommand(s.key, s.stub, ['--yes']);
      expect(code, output).toBe(EXIT_FAILED);
      expect(s.paid()).toBe(1);
      expect(await balance(s.wallet)).toBe(FUNDED - AMOUNTS[0]!);
      expect(output).toContain('Reading the chain instead of retrying');
      expect(output).toMatch(/Moved +\$0\.001072, tx 0x[0-9a-f]{64}/);
      expect(output).toMatch(/One signature, one payment: the wallet went down by \$0\.001072; the settled calls add up to \$0\.001072/);
    } finally {
      await s.close();
    }
  }, 180_000);

  it('provider failed and nothing settled: the real Permit2 nonce stays unused, nothing moved', async () => {
    const s = await setup(async ({ send }) => send(503, { code: 'MODEL_UNAVAILABLE' }));
    try {
      const lines: string[] = [];
      let offset = 0;
      const code = await runLiveCheck({
        env: { BLOCKRUN_TEST_PRIVATE_KEY: s.key, BLOCKRUN_TEST_BASE_URL: `${s.stub}/api/v1`, BLOCKRUN_TEST_OPENROUTER_MODELS_URL: `${s.stub}/or/models` },
        argv: ['--yes'],
        out: (l) => lines.push(l),
        publicClient: publicClient as unknown as PublicClient,
        now: () => Date.now() + offset,
        sleep: async (ms) => {
          offset += ms;
        },
      });
      expect(code).toBe(EXIT_FAILED);
      expect(s.paid()).toBe(1);
      expect(await balance(s.wallet)).toBe(FUNDED);
      expect(lines.join('\n')).toContain('The signature expired unused: nothing was charged');
    } finally {
      await s.close();
    }
  }, 180_000);
});
