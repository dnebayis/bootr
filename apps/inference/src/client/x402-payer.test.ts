import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_USDC, NETWORK, PAY_TO } from '../test/helpers.js';
import {
  createX402Payer,
  parseQuoteRejection,
  X402PaymentRefusedError,
  type TypedDataSigner,
} from './x402-payer.js';

function paymentRequired(amount: string, payTo = PAY_TO): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: 'http://relay.test/v1/chat/completions',
      description: '',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        asset: BASE_SEPOLIA_USDC,
        amount,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  };
}

function relay402(amount: string, payTo?: `0x${string}`) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.headers.get('payment-signature')) return new Response('{}', { status: 200 });
    return new Response('{}', {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired(amount, payTo)) },
    });
  });
}

const init = (key?: string, max?: string): RequestInit => ({
  method: 'POST',
  headers: {
    ...(key ? { 'Idempotency-Key': key } : {}),
    ...(max ? { 'X-Max-Quote-Micro-USDC': max } : {}),
  },
  body: '{}',
});

describe('x402 payer', () => {
  it('requires an Idempotency-Key', async () => {
    const payer = createX402Payer({
      signer: privateKeyToAccount(generatePrivateKey()),
      maxPaymentMicroUsdc: 10n,
      fetch: relay402('1') as typeof fetch,
    });
    await expect(
      payer.fetch('http://relay.test/v1/chat/completions', init()),
    ).rejects.toBeInstanceOf(X402PaymentRefusedError);
  });

  it('signs once with a custom signTypedData signer (Kernel / ERC-1271 plug-in point)', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signTypedData = vi.fn<TypedDataSigner['signTypedData']>((td) =>
      account.signTypedData(td as never),
    );
    const fetchMock = relay402('5000');
    const payer = createX402Payer({
      signer: { address: account.address, signTypedData },
      maxPaymentMicroUsdc: 10_000n,
      fetch: fetchMock as typeof fetch,
    });
    const res = await payer.fetch('http://relay.test/v1/chat/completions', init('k1'));
    expect(res.status).toBe(200);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData.mock.calls[0]![0]).toMatchObject({
      primaryType: 'TransferWithAuthorization',
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: BASE_SEPOLIA_USDC },
      message: { from: account.address, value: 5000n },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]![0] as Request;
    expect(first.headers.get('X-Max-Quote-Micro-USDC')).toBe('10000');
    const second = fetchMock.mock.calls[1]![0] as Request;
    expect(second.headers.get('Idempotency-Key')).toBe('k1');
  });

  it('refuses to sign above the cap or the per-request max', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const fetchMock = relay402('5000');
    const payer = createX402Payer({
      signer,
      maxPaymentMicroUsdc: 4_999n,
      fetch: fetchMock as typeof fetch,
    });
    await expect(payer.fetch('http://relay.test/x', init('k2'))).rejects.toThrow(/refusing to pay/);
    const payer2 = createX402Payer({
      signer,
      maxPaymentMicroUsdc: 1_000_000n,
      fetch: fetchMock as typeof fetch,
    });
    await expect(payer2.fetch('http://relay.test/x', init('k3', '4000'))).rejects.toThrow(
      /refusing to pay/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // only the unpaid probes
  });

  it('refuses an unexpected recipient', async () => {
    const fetchMock = relay402('1', '0x2222222222222222222222222222222222222222');
    const payer = createX402Payer({
      signer: privateKeyToAccount(generatePrivateKey()),
      maxPaymentMicroUsdc: 10n,
      payTo: PAY_TO,
      fetch: fetchMock as typeof fetch,
    });
    await expect(payer.fetch('http://relay.test/x', init('k4'))).rejects.toBeInstanceOf(
      X402PaymentRefusedError,
    );
  });

  it('passes through a quote rejection untouched', async () => {
    const body = {
      error: { code: 'quote_exceeds_max' },
      quoteMicroUsdc: '12345',
      maxQuoteMicroUsdc: '100',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 402 }));
    const payer = createX402Payer({
      signer: privateKeyToAccount(generatePrivateKey()),
      maxPaymentMicroUsdc: 100n,
      fetch: fetchMock as typeof fetch,
    });
    const res = await payer.fetch('http://relay.test/x', init('k5'));
    expect(res.status).toBe(402);
    expect(await parseQuoteRejection(res)).toEqual({
      quoteMicroUsdc: 12_345n,
      maxQuoteMicroUsdc: 100n,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
