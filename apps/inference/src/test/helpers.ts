import type { FacilitatorClient } from '@x402/core/server';
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';
import { getAddress, verifyTypedData, type Address, type Hex } from 'viem';
import { vi } from 'vitest';
import { createApp } from '../app.js';
import { DEFAULT_PRICE_TABLE, type PriceTable } from '../pricing.js';
import { createReconciler, type AuthorizationChecker } from '../reconcile.js';
import { MemoryRequestStore } from '../store.js';
import { createOpenRouterClient } from '../upstream.js';
import { createPaymentGate, type PaymentScheme } from '../x402.js';

export const NETWORK: Network = 'eip155:84532';
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const PAY_TO = '0x1111111111111111111111111111111111111111' as Address;
export const TX_HASH = `0x${'ab'.repeat(32)}`;

const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * Mock facilitator. `verify` really checks the EIP-3009 signature for `exact` payloads, so tests
 * prove the payer helper signs what USDC would accept.
 */
export function createMockFacilitator() {
  const settleImpl = vi.fn<(p: PaymentPayload, r: PaymentRequirements) => Promise<SettleResponse>>(
    async (p, r) => ({
      success: true,
      transaction: TX_HASH,
      network: r.network,
      payer: payerOf(p),
    }),
  );
  const verify = vi.fn(
    async (p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> => {
      if (r.scheme !== 'exact') return { isValid: true, payer: payerOf(p) };
      const { authorization, signature } = p.payload as {
        authorization: {
          from: Address;
          to: Address;
          value: string;
          validAfter: string;
          validBefore: string;
          nonce: Hex;
        };
        signature: Hex;
      };
      if (authorization.value !== r.amount)
        return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_value' };
      if (getAddress(authorization.to) !== getAddress(r.payTo))
        return { isValid: false, invalidReason: 'recipient_mismatch' };
      const valid = await verifyTypedData({
        address: authorization.from,
        domain: {
          name: r.extra.name as string,
          version: r.extra.version as string,
          chainId: Number(r.network.split(':')[1]),
          verifyingContract: getAddress(r.asset),
        },
        types: transferWithAuthorizationTypes,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
        signature,
      });
      return valid
        ? { isValid: true, payer: authorization.from }
        : { isValid: false, invalidReason: 'invalid_signature' };
    },
  );
  const getSupported = vi.fn(async (): Promise<SupportedResponse> => ({
    kinds: [
      { x402Version: 2, scheme: 'exact', network: NETWORK },
      {
        x402Version: 2,
        scheme: 'upto',
        network: NETWORK,
        extra: { facilitatorAddress: '0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf' },
      },
    ],
    extensions: [],
    signers: {},
  }));
  const client: FacilitatorClient = {
    verify,
    settle: (p, r) => settleImpl(p, r),
    getSupported,
  };
  return { client, verify, settle: settleImpl, getSupported };
}

function payerOf(p: PaymentPayload): string | undefined {
  return (p.payload as { authorization?: { from?: string } }).authorization?.from;
}

export function completionBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gen-123',
    object: 'chat.completion',
    model: 'openai/gpt-4.1-mini',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.0000096 },
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface TestAppOptions {
  schemes?: PaymentScheme[];
  priceTable?: PriceTable;
  checker?: AuthorizationChecker;
  upstreamFetch?: (req: Request) => Promise<Response>;
}

export function createTestApp(opts: TestAppOptions = {}) {
  const store = new MemoryRequestStore();
  const facilitator = createMockFacilitator();
  const clock = { now: Date.now() };
  const upstreamFetch = vi.fn(opts.upstreamFetch ?? (async () => jsonResponse(completionBody())));
  const upstreamCalls: Request[] = [];
  const gate = createPaymentGate({
    network: NETWORK,
    payTo: PAY_TO,
    schemes: opts.schemes ?? ['exact'],
    facilitator: facilitator.client,
    maxTimeoutSeconds: 300,
  });
  const app = createApp({
    store,
    gate,
    priceTable: opts.priceTable ?? DEFAULT_PRICE_TABLE,
    network: NETWORK,
    payTo: PAY_TO,
    paymentTimeoutSeconds: 300,
    now: () => clock.now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    upstream: createOpenRouterClient({
      apiKey: 'test-openrouter-key',
      baseUrl: 'https://openrouter.test/api/v1',
      timeoutMs: 5_000,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        upstreamCalls.push(req.clone());
        return upstreamFetch(req);
      }) as typeof fetch,
    }),
    reconcile: createReconciler({
      store,
      checker: opts.checker,
      staleAfterMs: 360_000,
      now: () => clock.now,
    }),
  });
  /** fetch-compatible function hitting the app in-process. */
  const appFetch = ((input: string | URL | Request, init?: RequestInit) =>
    app.fetch(new Request(input, init))) as typeof fetch;
  return { app, appFetch, store, facilitator, upstreamFetch, upstreamCalls, clock };
}

export const URL_BASE = 'http://relay.test';

export function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'openai/gpt-4.1-mini',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 256,
    ...overrides,
  };
}
