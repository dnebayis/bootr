# inference

An x402-paid LLM relay for Bootr. Each AI agent pays per request in USDC on Base from its own
smart-account wallet. The relay forwards the request to OpenRouter using the platform's API key.
No LLM provider accepts x402 USDC directly, so the relay is the seller, and it never serves a
completion that has not been paid for.

## How it works

```
agent (Kernel wallet)                    relay                               OpenRouter / facilitator
  POST /v1/chat/completions  ───────────▶ validate body + Idempotency-Key
  Idempotency-Key, X-Max-Quote            known key? -> replay / 409 (no payment)
                                          quote = ceil(in*estIn + out*max_tokens) + margin
                                          quote > X-Max-Quote? -> 402 {quote} (no PAYMENT-REQUIRED)
  ◀─────────── 402 PAYMENT-REQUIRED       x402 requirements: exact, amount = quote, USDC, payTo
  sign EIP-3009 transferWithAuthorization
  POST + PAYMENT-SIGNATURE  ────────────▶ facilitator /verify ─────────────────────────────▶
                                          claim key in Postgres (status in_flight)
                                          forward to OpenRouter ───────────────────────────▶
                                          store completion, mark settlementAttempted
                                          facilitator /settle ─────────────────────────────▶
  ◀─────────── 200 completion             status succeeded
               PAYMENT-RESPONSE, x-bootr-receipt
```

The order is verify, then upstream, then settle (the standard x402 "authorization" flow). The
client is only charged when a completion exists. If settlement fails, the completion is withheld.

### x402 package and API

- `@x402/hono` / `@x402/core` / `@x402/evm` **2.28.0** (x402 v2 protocol, CAIP-2 networks,
  `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers).
- The relay builds an `x402HTTPResourceServer` with the route `POST /v1/chat/completions`. The
  route's price is dynamic and comes from the per-request quote. It uses the `HonoAdapter` from
  `@x402/hono`, and calls `processHTTPRequest` and `settlePayment` itself instead of mounting the
  stock `paymentMiddleware`, for four reasons:
  1. Idempotent replays must skip payment.
  2. The quote check must run before the 402.
  3. The payment must be persisted before settling.
  4. Settlement errors must be classified as definitive or unknown. The stock middleware
     settles after `next()` and turns every facilitator error into a 402 or 502.
- Scheme `exact` (EIP-3009) is the default and charges exactly the quote; the receipt reports the
  actual usage. `upto` (charge actual usage, capped at the quote) is supported via
  `INFERENCE_X402_SCHEMES=upto,exact`. In x402 v2, `upto` uses **Permit2**, so the payer needs a
  one-time USDC approval to Permit2. The bundled payer helper only signs `exact`.
- Mainnet facilitator: CDP (`https://api.cdp.coinbase.com/platform/v2/x402`), authenticated with
  JWTs from `@coinbase/x402`'s `createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)`.

## Endpoints

| Method | Path                   | Description                                                                |
| ------ | ---------------------- | -------------------------------------------------------------------------- |
| POST   | `/v1/chat/completions` | OpenAI-compatible subset, non-streaming, x402-paid                         |
| GET    | `/v1/models`           | Allowed models, per-1K-token prices (micro-USDC), margin, network, schemes |
| GET    | `/v1/requests/:key`    | Status and receipt of a request by Idempotency-Key (reconciles first)      |
| GET    | `/health`              | Liveness                                                                   |

### `POST /v1/chat/completions`

Request headers:

- `Idempotency-Key` (required): one key per logical request. Reuse it on every retry.
- `X-Max-Quote-Micro-USDC` (required): the most the client will pay, in micro-USDC (1 USDC =
  1,000,000).
- `PAYMENT-SIGNATURE`: the x402 payment, sent on the retry after the 402.

The body accepts `model`, `messages` (roles `system`, `developer`, `user`, `assistant` with
`tool_calls`, and `tool`; content is a string or text parts), `tools` (functions),
`tool_choice`, `max_tokens` (required, because it prices the output), and `temperature`. Unknown
fields are dropped. `stream: true` is rejected.

Responses:

| Status  | Meaning                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------- |
| 200     | Upstream body passed through unchanged (incl. `usage`). Headers: `PAYMENT-RESPONSE`, `x-bootr-receipt`  |
| 402     | With `PAYMENT-REQUIRED`: pay `amount` (= quote). Without it: `quote_exceeds_max` or `settlement_failed` |
| 400     | Invalid body or headers, unknown model, `max_tokens` too large, context too long                        |
| 409     | `idempotency_key_conflict` (same key, different body), `request_in_progress`, `request_outcome_unknown` |
| 422/502 | `upstream_rejected` (nothing charged), `request_outcome_unknown`, `facilitator_unavailable`             |

`x-bootr-receipt` is a JSON header containing
`{requestId, quoteMicroUsdc, chargedMicroUsdc, paymentTxOrId, network, usage}`.
`paymentTxOrId` is the settlement transaction hash. If the payment was confirmed through
reconciliation, it is `eip3009:<nonce>` instead.

### Idempotency, statuses, reconciliation

Rows live in the Postgres table `inference_requests`, keyed by Idempotency-Key, with the columns
request hash, status, quote, charge, payment (including the EIP-3009 authorization), the stored
response and usage.

- Same key and same body hash: the stored result is replayed and **no new payment is taken**.
  Any payment header on a replay is ignored.
- Same key and a different body hash: `409 idempotency_key_conflict`.
- `in_flight`: being processed. Rows stuck for longer than the payment window plus 60s become
  `unknown` (`relay_interrupted`).
- `succeeded`: paid and delivered. Replays return the completion.
- `failed`: nothing was charged (upstream 4xx, settlement refused, or the authorization expired
  unused). The error is replayed for that key. Retry with a **new** key.
- `unknown`: the upstream call, or the settlement, has an uncertain outcome (timeout, network
  error, 5xx, crash). The relay holds a signed authorization that someone could still settle,
  so the client **must not pay for a replacement** (the supervisor's "never buy a replacement"
  rule). Poll `GET /v1/requests/:key`. The relay resolves the row:
  - With `INFERENCE_RPC_URL`: if USDC `authorizationState(from, nonce)` is true, the payment
    happened, and the row becomes `succeeded` when the relay holds the completion. Replay the
    POST with the same key to receive it. If the nonce is unused after `validBefore`, the row
    becomes `failed`.
  - Without an RPC, an authorization the relay never submitted becomes `failed` after
    `validBefore`. A submitted but unconfirmed settlement stays `unknown` for an operator.

  `GET /v1/requests/:key` returns `retrySafe: true` only when a new key can safely be used.

## Payer helper (`@bootr/inference/client`)

```ts
import { createX402Payer, readReceipt, parseQuoteRejection } from '@bootr/inference/client';

const payer = createX402Payer({
  signer: kernelAccount, // viem Account, or { address, signTypedData(typedData) }
  maxPaymentMicroUsdc: 50_000n, // hard cap per request (0.05 USDC); default X-Max-Quote
  networks: ['eip155:8453'],
  payTo: RELAY_PAYTO_ADDRESS, // refuse any other recipient
  onPayment: ({ payload }) => persistNonce(payload), // optional, before the paid retry is sent
});

const res = await payer.fetch(`${RELAY_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'Idempotency-Key': taskStepId },
  body: JSON.stringify({ model: 'anthropic/claude-haiku-4.5', messages, max_tokens: 1024 }),
});
const rejection = await parseQuoteRejection(res); // { quoteMicroUsdc } when the cap was too low
const receipt = readReceipt(res);
```

The helper uses the x402 v2 client libraries: `x402Client` and `x402HTTPClient` from
`@x402/fetch`, plus `ExactEvmScheme` from `@x402/evm`. It signs at most once per call, never
re-signs automatically, and refuses requirements above the cap or addressed to another payee.

**ZeroDev Kernel:** the signer interface is `{ address, signTypedData(typedData): Promise<Hex> }`.
For a Kernel smart account:

- `address` is the Kernel account, which must hold the USDC.
- `signTypedData` must return an **ERC-1271** signature that Kernel's `isValidSignature` accepts.
  This can be the Kernel account's own `signTypedData`, or a session-key / permission-validator
  signer whose policy allows EIP-712 signatures over the USDC domain.
- USDC on Base (FiatTokenV2_2) verifies `transferWithAuthorization(..., bytes signature)` through
  `SignatureChecker`, which supports EIP-1271 for contract `from` addresses.
- Deploy the Kernel before its first payment. Facilitators reject ERC-6492 (counterfactual)
  signatures unless the factory is allow-listed.

## Environment variables

Names are in the root `.env.example`.

| Variable                               | Required | Default                                                                                                                                                                                        |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | yes      |                                                                                                                                                                                                |
| `OPENROUTER_API_KEY`                   | yes      |                                                                                                                                                                                                |
| `INFERENCE_PAYTO_ADDRESS`              | yes      | USDC recipient (platform treasury)                                                                                                                                                             |
| `X402_NETWORK`                         | no       | `eip155:84532` (Base Sepolia); `eip155:8453` for mainnet                                                                                                                                       |
| `X402_FACILITATOR_URL`                 | no       | testnet `https://x402.org/facilitator`; mainnet CDP                                                                                                                                            |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | mainnet  | required when the facilitator is CDP                                                                                                                                                           |
| `INFERENCE_PORT`                       | no       | `3003`                                                                                                                                                                                         |
| `INFERENCE_X402_SCHEMES`               | no       | `exact` (comma list in preference order, e.g. `upto,exact`)                                                                                                                                    |
| `INFERENCE_PRICE_TABLE_JSON`           | no       | built-in table (`src/pricing.ts`); JSON `{marginBps?, marginFixedMicroUsdc?, models: {id: {inputMicroUsdcPerKTokens, outputMicroUsdcPerKTokens, contextLength, maxOutputTokens}}}` replaces it |
| `INFERENCE_RPC_URL`                    | no       | Base RPC used for on-chain reconciliation of `unknown` rows                                                                                                                                    |
| `INFERENCE_UPSTREAM_TIMEOUT_MS`        | no       | `120000`                                                                                                                                                                                       |
| `INFERENCE_PAYMENT_TIMEOUT_SECONDS`    | no       | `300` (x402 `maxTimeoutSeconds`, i.e. authorization lifetime; must exceed the upstream timeout by 30s)                                                                                         |

Empty values are treated as unset. The supervisor can point its `INFERENCE_PROVIDER_URL` at this
relay.

## Running

```sh
pnpm --filter inference db:migrate   # applies drizzle/ (needs DATABASE_URL)
pnpm --filter inference dev          # tsx watch, port INFERENCE_PORT (3003)
pnpm --filter inference test         # vitest (no network, no Postgres: PGlite + mocks)
pnpm --filter inference typecheck
```

After changing `src/db/schema.ts`, run `pnpm --filter inference db:generate`.

## Base Sepolia test flow

1. Set `X402_NETWORK=eip155:84532` and leave `X402_FACILITATOR_URL` empty to use
   `https://x402.org/facilitator`, which needs no API key and pays the gas. Also set
   `INFERENCE_PAYTO_ADDRESS`, `OPENROUTER_API_KEY` (funded with OpenRouter credits) and
   `DATABASE_URL`. Optionally set `INFERENCE_RPC_URL` to a Base Sepolia RPC.
2. `pnpm --filter inference db:migrate && pnpm --filter inference dev`
3. Create a test payer wallet (a throwaway EOA, or a deployed Kernel account). Fund it with
   Base Sepolia **USDC** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) from the CDP faucet
   (CDP Portal, Faucets, Base Sepolia, USDC) or `faucet.circle.com`. It needs no ETH: the
   facilitator submits `transferWithAuthorization`.
4. Check the price: `curl localhost:3003/v1/models`. Then send an unpaid request to see the 402:
   ```sh
   curl -i localhost:3003/v1/chat/completions -H 'content-type: application/json' \
     -H 'Idempotency-Key: test-1' -H 'X-Max-Quote-Micro-USDC: 100000' \
     -d '{"model":"openai/gpt-4.1-mini","messages":[{"role":"user","content":"ping"}],"max_tokens":32}'
   ```
   `PAYMENT-REQUIRED` is base64 JSON with `amount` equal to the quote in micro-USDC.
5. Pay with the helper (for example in a `tsx` script):
   ```ts
   const payer = createX402Payer({
     signer: privateKeyToAccount(TEST_KEY),
     maxPaymentMicroUsdc: 100_000n,
     networks: ['eip155:84532'],
   });
   const res = await payer.fetch('http://localhost:3003/v1/chat/completions', {
     method: 'POST',
     headers: { 'content-type': 'application/json', 'Idempotency-Key': 'test-2' },
     body,
   });
   console.log(res.status, readReceipt(res), await res.json());
   ```
   Look up `receipt.paymentTxOrId` on `sepolia.basescan.org`. Run the script again with the same
   key: the response is replayed (`x-bootr-idempotent-replay: true`) and nothing is charged.
6. `curl localhost:3003/v1/requests/test-2` shows the stored status and payment.

## Limits

- Non-streaming only. Content is text only (image and audio parts are rejected because they
  are not priced).
- `exact` charges the quote, which is an upper bound: the prompt is estimated at UTF-8 bytes / 3
  and the output at the full `max_tokens`. Actual usage is reported in the receipt. Use `upto`
  (Permit2) to be charged actual usage.
- The prompt estimate is a heuristic with no tokenizer. If a provider bills more prompt tokens
  than estimated, the relay absorbs the difference. The margin covers typical drift.
- If settlement fails after a successful upstream call, the relay absorbs the OpenRouter cost.
  Verification before the upstream call makes this rare.
- `failed` is terminal for its key. Retries use a new key.
- `GET /v1/requests/:key` is unauthenticated and returns metadata only, never the completion.
  Use unguessable keys (UUIDs).
- One network per deployment. There is no rate limiting or per-agent quota. The relay's
  OpenRouter credit balance must be funded separately.
- Default prices in `src/pricing.ts` follow OpenRouter list prices. Re-verify them at
  `openrouter.ai/models` before mainnet. Context limits are clamped to each model's base price
  tier.
