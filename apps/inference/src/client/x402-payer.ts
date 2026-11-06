/**
 * x402 payer for the Bootr inference relay (exported as `@bootr/inference/client`).
 *
 * Wraps `fetch`: on an x402 `402` (one carrying a `PAYMENT-REQUIRED` header) it signs an
 * EIP-3009 `transferWithAuthorization` for USDC with the agent's wallet, via the x402 v2 client
 * libraries (`@x402/fetch` re-exports of `x402Client` / `x402HTTPClient` + `@x402/evm`'s
 * `ExactEvmScheme`, or `UptoEvmScheme` when the caller allows it), and retries the request exactly once
 * with the `PAYMENT-SIGNATURE` header.
 *
 * Safety rules, mirroring the supervisor's "never buy a replacement":
 *  - An `Idempotency-Key` header is required. Retries of the same logical request must reuse it;
 *    the relay then replays the stored result without charging again.
 *  - At most one signature per call. No automatic "recovery" re-signing.
 *  - The amount is capped by `maxPaymentMicroUsdc` and the request's `X-Max-Quote-Micro-USDC`.
 *  - A 402 without `PAYMENT-REQUIRED` (e.g. `quote_exceeds_max`) is returned untouched; use
 *    `parseQuoteRejection` to read the quote.
 *  - If a paid call ends in a network error or a `request_outcome_unknown` response, do NOT
 *    pay for a replacement: poll `GET /v1/requests/:key` until the status leaves `unknown`.
 *  - Keys are namespaced per payer at the relay, and a stored request is only revealed or replayed
 *    to whoever presents the signed payment that opened it. This payer remembers the payment it
 *    signed per Idempotency-Key and sends it again on a repeated call (a replay, never a second
 *    charge). Callers that persisted the payload (`onPayment`) send it with
 *    {@link paymentProofHeaders} on `GET /v1/requests/:key` and on replays; a request that already
 *    carries `PAYMENT-SIGNATURE` is passed through unsigned.
 *
 * ## Smart accounts (ZeroDev Kernel)
 *
 * The signer only needs `{ address, signTypedData(typedData) }` ({@link TypedDataSigner}).
 * For a ZeroDev Kernel smart account, `address` is the Kernel account and `signTypedData` must
 * return an ERC-1271 signature that the Kernel's `isValidSignature` accepts (e.g. the Kernel
 * account's own `signTypedData`, or a session-key / permission-validator signer whose policy
 * allows EIP-712 signatures for the USDC domain). USDC on Base (FiatTokenV2_2) verifies
 * `transferWithAuthorization(..., bytes signature)` with `SignatureChecker`, i.e. EIP-1271 for
 * contract `from` addresses, so the Kernel itself is the payer and needs the USDC balance.
 * The Kernel must already be deployed: facilitators reject ERC-6492 (counterfactual) signatures
 * unless the factory is allow-listed.
 */
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { x402Client, x402HTTPClient } from '@x402/fetch';
import { getAddress, type Address, type Hex } from 'viem';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const MAX_QUOTE_HEADER = 'X-Max-Quote-Micro-USDC';
export const RECEIPT_HEADER = 'x-bootr-receipt';
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';

/** Headers proving possession of the payment that opened a relay request (for GET and replays). */
export function paymentProofHeaders(payload: PaymentPayload): Record<string, string> {
  return { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(payload) };
}

/** Payments remembered per Idempotency-Key for replays from the same payer instance. */
const REMEMBERED_PAYMENTS = 256;

export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Anything that can produce an EIP-712 signature for `address` (EOA or ERC-1271 account). */
export interface TypedDataSigner {
  readonly address: Address;
  signTypedData(typedData: TypedDataPayload): Promise<Hex>;
}

/** A viem `Account` (local or smart account) with `signTypedData`. */
export interface ViemLikeAccount {
  readonly address: Address;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTypedData?: (parameters: any) => Promise<Hex>;
}

export interface PaymentEvent {
  requirements: PaymentRequirements;
  payload: PaymentPayload;
  idempotencyKey: string;
}

export interface X402PayerOptions {
  /** viem Account with `signTypedData`, or a custom signer (e.g. Kernel session key). */
  signer: TypedDataSigner | ViemLikeAccount;
  /** Hard cap per request in micro-USDC; also the default `X-Max-Quote-Micro-USDC`. */
  maxPaymentMicroUsdc: bigint;
  /** Networks to pay on. Default: Base mainnet and Base Sepolia. */
  networks?: readonly Network[];
  /** If set, refuse to pay any other recipient. */
  payTo?: Address | readonly Address[];
  /**
   * Schemes this payer may sign, most wanted first. Default `['exact']`. `upto` (Permit2) settles what the call
   * really cost, up to the signed amount; it needs `readContract` for the gas-sponsored allowance.
   */
  schemes?: readonly PayerScheme[];
  /** Chain reads for `upto`: the Permit2 allowance and the USDC permit nonce. */
  readContract?: (args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>;
  /** Refuse a requirement whose signature would stay usable longer than this, so an unknown outcome stays short. */
  maxTimeoutSeconds?: number;
  fetch?: typeof globalThis.fetch;
  /**
   * Called after signing and before sending the payment. Persist `payload` (it contains the
   * EIP-3009 nonce) if you need to reconcile on-chain later. Throwing aborts without sending.
   */
  onPayment?: (event: PaymentEvent) => void | Promise<void>;
}

export type PayerScheme = 'exact' | 'upto';

export class X402PaymentRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402PaymentRefusedError';
  }
}

export interface X402Payer {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

function toSigner(signer: TypedDataSigner | ViemLikeAccount): TypedDataSigner {
  const sign = signer.signTypedData;
  if (typeof sign !== 'function') {
    throw new Error(
      'signer must implement signTypedData (use a local or smart account, or a custom signer)',
    );
  }
  return {
    address: getAddress(signer.address),
    signTypedData: (typedData) => sign.call(signer, typedData),
  };
}

export function createX402Payer(opts: X402PayerOptions): X402Payer {
  const signer = toSigner(opts.signer);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const networks = opts.networks ?? (['eip155:8453', 'eip155:84532'] as Network[]);
  const schemes = opts.schemes ?? (['exact'] as const);
  const allowedPayTo = opts.payTo
    ? new Set(
        (Array.isArray(opts.payTo) ? opts.payTo : [opts.payTo]).map((a) =>
          getAddress(a as Address),
        ),
      )
    : null;

  const signed = new Map<string, PaymentPayload>();
  const remember = (key: string, payload: PaymentPayload) => {
    signed.delete(key);
    signed.set(key, payload);
    if (signed.size > REMEMBERED_PAYMENTS) signed.delete(signed.keys().next().value as string);
  };

  return {
    async fetch(input, init) {
      const request = new Request(input, init);
      const idempotencyKey = request.headers.get(IDEMPOTENCY_HEADER);
      if (!idempotencyKey) {
        throw new X402PaymentRefusedError(
          'Idempotency-Key header is required for paid inference requests',
        );
      }
      // Caller-supplied proof (a persisted payload): pass through, never sign a second payment.
      if (request.headers.has(PAYMENT_SIGNATURE_HEADER)) return doFetch(request);
      // Same key again from this payer: present the payment already signed for it.
      const previous = signed.get(idempotencyKey);
      if (previous) {
        const replay = request.clone();
        for (const [k, v] of Object.entries(paymentProofHeaders(previous)))
          replay.headers.set(k, v);
        return doFetch(replay);
      }
      if (!request.headers.has(MAX_QUOTE_HEADER)) {
        request.headers.set(MAX_QUOTE_HEADER, opts.maxPaymentMicroUsdc.toString());
      }
      const headerMax = BigInt(request.headers.get(MAX_QUOTE_HEADER) ?? '0');
      const cap = headerMax < opts.maxPaymentMicroUsdc ? headerMax : opts.maxPaymentMicroUsdc;

      const first = await doFetch(request.clone());
      if (first.status !== 402 || !first.headers.get('PAYMENT-REQUIRED')) return first;

      // A fresh client per call: the cap differs per request.
      const client = new x402Client();
      for (const network of networks) {
        if (schemes.includes('exact')) client.register(network, new ExactEvmScheme(signer));
        if (schemes.includes('upto')) {
          const uptoSigner = { ...signer, readContract: opts.readContract };
          client.register(network, new UptoEvmScheme(uptoSigner as ConstructorParameters<typeof UptoEvmScheme>[0]));
        }
      }
      // Keep "default assets only" (USDC); the USD cap is replaced by our exact atomic cap.
      client.setSpendControls({ maxAmountPerPayment: false });
      client.registerPolicy((_version, reqs) =>
        reqs
          .filter(
            (r) =>
              schemes.includes(r.scheme as PayerScheme) &&
              BigInt(r.amount) <= cap &&
              (opts.maxTimeoutSeconds === undefined || r.maxTimeoutSeconds <= opts.maxTimeoutSeconds) &&
              (!allowedPayTo || allowedPayTo.has(getAddress(r.payTo as Address))),
          )
          .sort((a, b) => schemes.indexOf(a.scheme as PayerScheme) - schemes.indexOf(b.scheme as PayerScheme)),
      );
      const http = new x402HTTPClient(client);

      let body: unknown;
      try {
        body = await first.clone().json();
      } catch {
        body = undefined;
      }
      const paymentRequired = http.getPaymentRequiredResponse(
        (name) => first.headers.get(name),
        body,
      );

      let payload: PaymentPayload;
      try {
        payload = await http.createPaymentPayload(paymentRequired);
      } catch (err) {
        const offered = paymentRequired.accepts
          .map((r) => `${r.scheme}/${r.network}/${r.amount}`)
          .join(', ');
        throw new X402PaymentRefusedError(
          `refusing to pay: no acceptable requirement within cap ${cap} micro-USDC (offered: ${offered}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      await opts.onPayment?.({ requirements: payload.accepted, payload, idempotencyKey });
      remember(idempotencyKey, payload);

      const paid = request.clone();
      for (const [k, v] of Object.entries(http.encodePaymentSignatureHeader(payload)))
        paid.headers.set(k, v);
      return doFetch(paid);
    },
  };
}

export interface BootrReceipt {
  requestId: string;
  quoteMicroUsdc: string;
  chargedMicroUsdc: string | null;
  paymentTxOrId: string | null;
  network: string;
  usage: Record<string, unknown> | null;
}

/** Parse the relay's `x-bootr-receipt` header. */
export function readReceipt(res: Response): BootrReceipt | null {
  const raw = res.headers.get(RECEIPT_HEADER);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BootrReceipt;
  } catch {
    return null;
  }
}

/** For a `402 quote_exceeds_max` (no PAYMENT-REQUIRED header): the relay's quote. */
export async function parseQuoteRejection(
  res: Response,
): Promise<{ quoteMicroUsdc: bigint; maxQuoteMicroUsdc: bigint } | null> {
  if (res.status !== 402 || res.headers.get('PAYMENT-REQUIRED')) return null;
  try {
    const body = (await res.clone().json()) as {
      error?: { code?: string };
      quoteMicroUsdc?: string;
      maxQuoteMicroUsdc?: string;
    };
    if (body.error?.code !== 'quote_exceeds_max' || !body.quoteMicroUsdc) return null;
    return {
      quoteMicroUsdc: BigInt(body.quoteMicroUsdc),
      maxQuoteMicroUsdc: BigInt(body.maxQuoteMicroUsdc ?? '0'),
    };
  } catch {
    return null;
  }
}
