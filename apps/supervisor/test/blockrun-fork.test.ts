/**
 * Direct mode on a local fork of Base: real USDC, real Permit2, the real x402 `upto` proxy, and x402's own facilitator
 * code settling from an Anvil test key. Only BlockRun's HTTP server is stood in for, so this proves what a paid call
 * really moves and that the chain reads closing an unknown outcome read the right state. No real money moves; the fork
 * is local. Run with a Base RPC: `BASE_FORK_RPC_URL=https://base-rpc.publicnode.com pnpm vitest run test/blockrun-fork.test.ts`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { UptoEvmScheme } from '@x402/evm/upto/facilitator';
import { getAddresses } from '@bootr/shared/addresses';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, erc20Abi, http, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { DIRECT_PAID_LOST, DIRECT_UNPAID } from '../src/blockrun.js';
import { inference as inferenceTable } from '../src/db/schema.js';
import { fuelReport, reconcileRelay, relayRequest, type RelayCall } from '../src/inference.js';
import { spenderAccount } from '../src/spender.js';
import { AGENT_ID, makeWorld, seedAgent, SPENDER_MASTER, type TestWorld } from './helpers.js';

const RPC = process.env.BASE_FORK_RPC_URL;
const PORT = 18_545 + (process.pid % 1000);
const ANVIL = `http://127.0.0.1:${PORT}`;
const USDC = getAddresses(8453).usdc;
const BLOCKRUN_PAYTO: Address = '0xe9030014F5DAe217d0A152f02A043567b16c1aBf';
/** Anvil's public first test key: plays the facilitator's gas wallet on the fork. */
const FACILITATOR_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const facilitatorAccount = privateKeyToAccount(FACILITATOR_KEY);
const SPENDER = spenderAccount(SPENDER_MASTER, AGENT_ID).address;
const CEILING = 102_904n;
const ACTUAL = 55_800n;
const FUNDED = 5_000_000n;
/** FiatToken's `balanceAndBlacklistStates` mapping. */
const USDC_BALANCE_SLOT = 9n;

const body = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/blockrun/tool-call.json', import.meta.url)), 'utf8')).body as Record<string, unknown>;
const required = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/blockrun/payment-required.json', import.meta.url)), 'utf8')).requirements as PaymentRequired;

const call = (key: string): RelayCall => ({
  key,
  cycle: 0,
  request: { model: 'anthropic/claude-sonnet-4.6', messages: [{ role: 'user', content: 'hello' }], max_tokens: 1024, stream: false, store: false },
  maxQuoteMicroUsdc: 1_500_000n,
});

describe.skipIf(!RPC)('direct mode on a Base fork', () => {
  let anvil: ChildProcess;
  const publicClient = createPublicClient({ chain: base, transport: http(ANVIL) });
  const testClient = createTestClient({ chain: base, mode: 'anvil', transport: http(ANVIL) });
  const walletClient = createWalletClient({ account: facilitatorAccount, chain: base, transport: http(ANVIL) });
  const facilitatorSigner = toFacilitatorEvmSigner({
    address: facilitatorAccount.address,
    // Simulations run as the facilitator: the proxy only lets the witness's facilitator settle.
    readContract: (args) => publicClient.readContract({ ...args, account: facilitatorAccount.address } as never),
    verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
    writeContract: (args) => walletClient.writeContract(args as never),
    sendTransaction: (args) => walletClient.sendTransaction(args as never),
    waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args as never),
    getCode: (args) => publicClient.getCode(args as never),
  });
  const upto = new UptoEvmScheme(facilitatorSigner);
  const exact = new ExactEvmScheme(facilitatorSigner);
  const balance = (holder: Address) => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });

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

  /** A world on the fork: `paid` decides what the BlockRun stand-in does with a signed request. */
  async function world(paid: (payload: PaymentPayload, requirements: PaymentRequired['accepts'][number]) => Promise<Response>, opts: { offerUpto?: boolean; config?: Record<string, string> } = {}) {
    const w = await makeWorld({ config: { BLOCKRUN_DIRECT_MODE: 'all', BLOCKRUN_BASE_URL: 'https://blockrun.test/api/v1', ...opts.config } });
    w.setNow(Date.now());
    w.ctx.chain = { ...w.ctx.chain, chain: base, chainId: 8453, addresses: getAddresses(8453), publicClient: publicClient as never };
    const agent = await seedAgent(w);
    await testClient.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [SPENDER, USDC_BALANCE_SLOT])), value: `0x${FUNDED.toString(16).padStart(64, '0')}` });
    const accepts = required.accepts
      .filter((a) => opts.offerUpto !== false || a.scheme !== 'upto')
      .map((a) => ({ ...a, amount: CEILING.toString(), extra: a.scheme === 'upto' ? { ...a.extra, facilitatorAddress: facilitatorAccount.address } : a.extra }));
    let signatures = 0;
    w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      if (!req.url.startsWith('https://blockrun.test')) throw new Error(`the relay must not be called: ${req.url}`);
      const signature = req.headers.get('PAYMENT-SIGNATURE');
      if (!signature) return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ ...required, accepts }) } });
      signatures += 1;
      const payload = decodePaymentSignatureHeader(signature);
      const requirements = accepts.find((a) => a.scheme === payload.accepted.scheme)!;
      return paid(payload, requirements);
    }) as typeof fetch;
    return { w, agent, signatures: () => signatures };
  }

  /** What BlockRun does on success: verify, serve, settle `amount`, return the receipt headers. */
  const serve = (amount: bigint) => async (payload: PaymentPayload, requirements: PaymentRequired['accepts'][number]) => {
    const scheme = requirements.scheme === 'upto' ? upto : exact;
    const verified = await scheme.verify(payload, requirements);
    expect(verified.invalidReason ?? null, verified.invalidMessage ?? 'verify').toBeNull();
    const settled = await scheme.settle(payload, { ...requirements, amount: amount.toString() });
    expect(settled.success, settled.errorReason ?? 'settle').toBe(true);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: settled.transaction, network: requirements.network, payer: SPENDER })).toString('base64'), 'x-payment-receipt': settled.transaction } });
  };

  const rowOf = async (w: TestWorld, key: string) => (await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, key) }))!;

  it('upto, from a spender with no ETH: only the real cost moves, twice in a row, and the charge is read from the chain', async () => {
    const { w, agent, signatures } = await world(serve(ACTUAL));
    try {
      expect(await publicClient.getBalance({ address: SPENDER })).toBe(0n);
      const payToBefore = await balance(BLOCKRUN_PAYTO);
      expect((await relayRequest(w.ctx, agent, call('inference:a'))).kind).toBe('ok');
      expect(await balance(SPENDER)).toBe(FUNDED - ACTUAL);
      expect((await balance(BLOCKRUN_PAYTO)) - payToBefore).toBe(ACTUAL);
      expect((await rowOf(w, 'inference:a')).receipt).toMatchObject({ relay: { quoteMicroUsdc: CEILING.toString(), chargedMicroUsdc: ACTUAL.toString() } });

      // the first settlement left less allowance than the next ceiling, so this one needs a fresh sponsored permit
      expect((await relayRequest(w.ctx, agent, call('inference:b'))).kind).toBe('ok');
      expect(await balance(SPENDER)).toBe(FUNDED - 2n * ACTUAL);
      expect(signatures()).toBe(2);
      expect((await fuelReport(w.ctx, AGENT_ID, new Date(0))).byModel[0]).toMatchObject({ thoughts: 2, chargedMicroUsdc: (2n * ACTUAL).toString() });
    } finally {
      await w.close();
    }
  });

  it('upto, settled and the answer lost: Permit2 says the money moved, one payment, no replacement', async () => {
    const { w, agent, signatures } = await world(async (payload, requirements) => {
      await serve(ACTUAL)(payload, requirements);
      throw new TypeError('connection reset');
    });
    try {
      expect((await relayRequest(w.ctx, agent, call('inference:lost'))).kind).toBe('unknown');
      expect(await reconcileRelay(w.ctx, 'inference:lost')).toMatchObject({ kind: 'failed', error: DIRECT_PAID_LOST });
      expect(await balance(SPENDER)).toBe(FUNDED - ACTUAL);
      expect(signatures()).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('exact, when allowed: the whole quote moves and a lost answer is read from USDC', async () => {
    const { w, agent } = await world(
      async (payload, requirements) => {
        await serve(CEILING)(payload, requirements);
        throw new TypeError('connection reset');
      },
      { offerUpto: false, config: { BLOCKRUN_ALLOW_EXACT: 'true' } },
    );
    try {
      expect((await relayRequest(w.ctx, agent, call('inference:exact'))).kind).toBe('unknown');
      expect(await reconcileRelay(w.ctx, 'inference:exact')).toMatchObject({ kind: 'failed', error: DIRECT_PAID_LOST });
      expect(await balance(SPENDER)).toBe(FUNDED - CEILING);
    } finally {
      await w.close();
    }
  });

  // Last: it moves the fork's clock forward.
  it('upto, nothing settled: open inside the window, then proven dead, and a late settlement can no longer move money', async () => {
    let kept: { payload: PaymentPayload; requirements: PaymentRequired['accepts'][number] } | null = null;
    const { w, agent } = await world(async (payload, requirements) => {
      kept = { payload, requirements };
      return new Response(JSON.stringify({ code: 'MODEL_UNAVAILABLE' }), { status: 503 });
    });
    try {
      expect((await relayRequest(w.ctx, agent, call('inference:dead'))).kind).toBe('unknown');
      expect((await reconcileRelay(w.ctx, 'inference:dead')).kind).toBe('unknown');
      w.setNow(Date.now() + 6 * 60_000);
      await testClient.increaseTime({ seconds: 360 });
      await testClient.mine({ blocks: 1 });
      expect(await reconcileRelay(w.ctx, 'inference:dead')).toMatchObject({ kind: 'failed', error: DIRECT_UNPAID });
      const { payload, requirements } = kept!;
      const late = await upto.settle(payload, { ...requirements, amount: ACTUAL.toString() }).catch((err: unknown) => ({ success: false, errorReason: String(err) }));
      expect(late.success).toBe(false);
      expect(await balance(SPENDER)).toBe(FUNDED);
    } finally {
      await w.close();
    }
  });
});
