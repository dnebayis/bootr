/**
 * `x402_fetch` on a local fork of Base: real USDC (EIP-3009), the real x402 `exact` facilitator code settling from an
 * Anvil test key, and only the paid service's HTTP server stood in for. This proves what a paid service call really
 * moves out of the spender, that the chain read behind `settlement` and the reconcile read the right state, and that
 * an expired signature can no longer move money. No real money moves; the fork is local. Run with a Base RPC:
 * `BASE_FORK_RPC_URL=... pnpm vitest run test/services-fork.test.ts` (the key is read from the environment, never printed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { DEFAULT_SERVICES_POLICY, parseAgentConfig, type AgentConfig } from '@bootr/agent-core';
import { getAddresses } from '@bootr/shared/addresses';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, erc20Abi, http, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { executeAction, type BrokerEnv } from '../src/broker/index.js';
import { serviceCalls } from '../src/db/schema.js';
import { reconcileServiceCall, SERVICES_PAID_NO_ANSWER, SERVICES_UNPAID, servicesReport } from '../src/services.js';
import { spenderAccount } from '../src/spender.js';
import { AGENT_ID, agentConfig, makeWorld, seedAgent, SPENDER_MASTER, type TestWorld } from './helpers.js';

const RPC = process.env.BASE_FORK_RPC_URL;
const PORT = 19_545 + (process.pid % 1000);
const ANVIL = `http://127.0.0.1:${PORT}`;
const USDC = getAddresses(8453).usdc;
/** The paid service's wallet: Anvil's second test account. */
const SERVICE_PAYTO: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** Anvil's public first test key: plays the facilitator's gas wallet on the fork. */
const FACILITATOR_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const facilitatorAccount = privateKeyToAccount(FACILITATOR_KEY);
const SPENDER = spenderAccount(SPENDER_MASTER, AGENT_ID).address;
const PRICE = 7_000n;
const FUNDED = 1_000_000n;
/** FiatToken's `balanceAndBlacklistStates` mapping. */
const USDC_BALANCE_SLOT = 9n;

const pending = (id: string, input: Record<string, unknown>) => ({ id, cycleKey: 'cycle:fork', action: { tool: 'x402_fetch', input }, status: 'sending', createdAt: 0, attempts: 1 }) as unknown as Parameters<typeof executeAction>[3];
const env = (): BrokerEnv => ({ inbox: new Map(), eligibility: new Map() });

function configWith(now: number): AgentConfig {
  return parseAgentConfig(agentConfig(now, { capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false, services: true }, services: { ...DEFAULT_SERVICES_POLICY, perCallMicroUsdc: 10_000, dailyMicroUsdc: 100_000 } }));
}

const required = (): PaymentRequired => ({
  x402Version: 2,
  resource: { url: 'https://data.fork.test/price', description: 'a price', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: PRICE.toString(), payTo: SERVICE_PAYTO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }],
});

describe.skipIf(!RPC)('x402_fetch on a Base fork', () => {
  let anvil: ChildProcess;
  const publicClient = createPublicClient({ chain: base, transport: http(ANVIL) });
  const testClient = createTestClient({ chain: base, mode: 'anvil', transport: http(ANVIL) });
  const walletClient = createWalletClient({ account: facilitatorAccount, chain: base, transport: http(ANVIL) });
  const facilitatorSigner = toFacilitatorEvmSigner({
    address: facilitatorAccount.address,
    readContract: (args) => publicClient.readContract({ ...args, account: facilitatorAccount.address } as never),
    verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
    writeContract: (args) => walletClient.writeContract(args as never),
    sendTransaction: (args) => walletClient.sendTransaction(args as never),
    waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args as never),
    getCode: (args) => publicClient.getCode(args as never),
  });
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

  /** A world on the fork whose `fetch` is the paid service: `paid` decides what it does with a signed request. */
  async function world(paid: (payload: PaymentPayload, requirements: PaymentRequired['accepts'][number]) => Promise<Response>) {
    const w = await makeWorld();
    w.setNow(Date.now());
    w.ctx.chain = { ...w.ctx.chain, chain: base, chainId: 8453, addresses: getAddresses(8453), publicClient: publicClient as never };
    const agent = await seedAgent(w);
    await testClient.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [SPENDER, USDC_BALANCE_SLOT])), value: `0x${FUNDED.toString(16).padStart(64, '0')}` });
    let signatures = 0;
    w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      if (!req.url.startsWith('https://data.fork.test/')) throw new Error(`unexpected host: ${req.url}`);
      const signature = req.headers.get('PAYMENT-SIGNATURE');
      if (!signature) return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required()) } });
      signatures += 1;
      return paid(decodePaymentSignatureHeader(signature), required().accepts[0]!);
    }) as typeof fetch;
    return { w, agent, signatures: () => signatures };
  }

  /** What an honest service does: verify, settle through the facilitator, answer with the settlement header. */
  const settle = async (payload: PaymentPayload, requirements: PaymentRequired['accepts'][number]) => {
    const verified = await exact.verify(payload, requirements);
    expect(verified.invalidReason ?? null, verified.invalidMessage ?? 'verify').toBeNull();
    const settled = await exact.settle(payload, requirements);
    expect(settled.success, settled.errorReason ?? 'settle').toBe(true);
    return settled.transaction as Hex;
  };

  const rowOf = async (w: TestWorld, id: string) => (await w.db.query.serviceCalls.findFirst({ where: eq(serviceCalls.id, id) }))!;

  it('pays the price out of the spender with no ETH, the service receives it, and the chain confirms the settlement', async () => {
    const { w, agent, signatures } = await world(async (payload, requirements) => {
      const tx = await settle(payload, requirements);
      return new Response(JSON.stringify({ price: '2227.57' }), { status: 200, headers: { 'content-type': 'application/json', 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: tx, network: 'eip155:8453', payer: SPENDER })).toString('base64') } });
    });
    try {
      expect(await publicClient.getBalance({ address: SPENDER })).toBe(0n);
      const payToBefore = await balance(SERVICE_PAYTO);
      const out = await executeAction(w.ctx, agent, configWith(w.ctx.now()), pending('fork_paid', { url: 'https://data.fork.test/price', reason: 'ETH price' }), env());
      expect(out.kind).toBe('completed');
      const result = (out as { result: Record<string, unknown> }).result;
      expect(result).toMatchObject({ status: 200, paidUsdc: '0.007', payTo: SERVICE_PAYTO, settlement: 'confirmed on chain', untrusted: true });
      expect(result.text).toContain('2227.57');
      expect(await balance(SPENDER)).toBe(FUNDED - PRICE);
      expect((await balance(SERVICE_PAYTO)) - payToBefore).toBe(PRICE);
      expect(signatures()).toBe(1);
      const row = await rowOf(w, 'fork_paid');
      expect(row).toMatchObject({ status: 'succeeded', chargedMicroUsdc: PRICE.toString(), payTo: SERVICE_PAYTO });
      expect(row.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      const receipt = await publicClient.getTransactionReceipt({ hash: row.txHash as Hex });
      expect(receipt.status).toBe('success');
      expect(await servicesReport(w.ctx, AGENT_ID, new Date(0))).toMatchObject({ calls: 1, chargedMicroUsdc: PRICE.toString() });
    } finally {
      await w.close();
    }
  });

  it('a service that settles and then fails: the money is gone, USDC says so, one payment, no replacement', async () => {
    const { w, agent, signatures } = await world(async (payload, requirements) => {
      await settle(payload, requirements);
      return new Response('internal error', { status: 500 });
    });
    try {
      const out = await executeAction(w.ctx, agent, configWith(w.ctx.now()), pending('fork_lost', { url: 'https://data.fork.test/price', reason: 'ETH price' }), env());
      expect(out).toMatchObject({ kind: 'unknown', error: 'services_http_500' });
      expect(await reconcileServiceCall(w.ctx, await rowOf(w, 'fork_lost'))).toMatchObject({ kind: 'failed', error: expect.stringMatching(new RegExp(`^${SERVICES_PAID_NO_ANSWER}`)) });
      expect(await balance(SPENDER)).toBe(FUNDED - PRICE);
      expect(signatures()).toBe(1);
      expect(await rowOf(w, 'fork_lost')).toMatchObject({ status: 'failed', chargedMicroUsdc: PRICE.toString() });
    } finally {
      await w.close();
    }
  });

  // Last: it moves the fork's clock forward.
  it('a service that never settles: open inside the window, then proven unpaid, and a late settlement can no longer move money', async () => {
    let kept: { payload: PaymentPayload; requirements: PaymentRequired['accepts'][number] } | null = null;
    const { w, agent } = await world(async (payload, requirements) => {
      kept = { payload, requirements };
      return new Response('try later', { status: 503 });
    });
    try {
      const out = await executeAction(w.ctx, agent, configWith(w.ctx.now()), pending('fork_dead', { url: 'https://data.fork.test/price', reason: 'ETH price' }), env());
      expect(out).toMatchObject({ kind: 'unknown', error: 'services_http_503' });
      expect((await reconcileServiceCall(w.ctx, await rowOf(w, 'fork_dead'))).kind).toBe('unknown');
      // past the signature's validity (SERVICE_MAX_TIMEOUT_SECONDS = 900 s, plus the grace)
      w.setNow(Date.now() + 20 * 60_000);
      await testClient.increaseTime({ seconds: 1200 });
      await testClient.mine({ blocks: 1 });
      expect(await reconcileServiceCall(w.ctx, await rowOf(w, 'fork_dead'))).toMatchObject({ kind: 'failed', error: expect.stringMatching(new RegExp(`^${SERVICES_UNPAID}`)) });
      const { payload, requirements } = kept!;
      const late = await exact.settle(payload, requirements).catch((err: unknown) => ({ success: false, errorReason: String(err) }));
      expect(late.success).toBe(false);
      expect(await balance(SPENDER)).toBe(FUNDED);
    } finally {
      await w.close();
    }
  });
});
