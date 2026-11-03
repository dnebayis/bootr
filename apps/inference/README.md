# inference

An x402-paid LLM relay for Bootr. Each AI agent pays per request in USDC on Base from its own
smart-account wallet. The relay forwards the request to OpenRouter using the platform's API key.
No LLM provider accepts x402 USDC directly, so the relay is the seller, and it never serves a
completion that has not been paid for.

## How it works

```
agent (Kernel wallet)                    relay                               OpenRouter / facilitator
  POST /v1/chat/completions  ───────────▶ validate body (≤ 1 MB) + Idempotency-Key
  Idempotency-Key, X-Max-Quote            PAYMENT-SIGNATURE of a known (payer, key)? -> replay (no payment)
                                          quote = ceil(in*estIn + out*max_tokens) + margin
                                          quote > X-Max-Quote? -> 402 {quote} (no PAYMENT-REQUIRED)
  ◀─────────── 402 PAYMENT-REQUIRED       x402 requirements: exact, amount = quote, USDC, payTo
  sign EIP-3009 transferWithAuthorization
  POST + PAYMENT-SIGNATURE  ────────────▶ facilitator /verify ─────────────────────────────▶
                                          claim (payer, key) + unique (payer, nonce), in_flight
                                          facilitator /settle (quote) ─────────────────────▶
                                          forward to OpenRouter ───────────────────────────▶
                                          ok: store completion, succeeded
                                          timeout/5xx/abort: keep the payment as a credit
  ◀─────────── 200 completion             PAYMENT-RESPONSE, x-bootr-receipt
```

For `exact` the order is **verify, settle, then upstream** (H-3): the relay never spends on
OpenRouter for a request that is not paid. If the upstream call then fails (timeout, network error,
5xx, unparseable body, or a 4xx), the payment is kept as a **credit** for that payer +
Idempotency-Key: a retry with the same key, body and `PAYMENT-SIGNATURE` runs the request again
without a new payment (at most 3 upstream calls per payment; after that the row is `failed` with
`refundDue: true`). For `upto` the charge depends on usage, so the upstream runs first; if its
outcome is unknown, the full quote is settled and kept as a credit (the provider may have billed).

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
| GET    | `/v1/requests/:key`    | Status and receipt by Idempotency-Key, for the payer only (`PAYMENT-SIGNATURE` proof); reconciles first |
| GET    | `/health`              | Liveness                                                                   |

### `POST /v1/chat/completions`

Request headers:

- `Idempotency-Key` (required): one key per logical request. Reuse it on every retry.
- `X-Max-Quote-Micro-USDC` (required): the most the client will pay, in micro-USDC (1 USDC =
  1,000,000).
- `PAYMENT-SIGNATURE`: the x402 payment, sent on the retry after the 402. Sent again on a replay
  of the same key, it is the proof that the caller is the payer (it is never settled twice).

The body accepts `model`, `messages` (roles `system`, `developer`, `user`, `assistant` with
`tool_calls`, and `tool`; content is a string or text parts), `tools` (functions),
`tool_choice`, `max_tokens` (required, because it prices the output), `temperature` and
`modalities` (`["text"]` or `["image", "text"]`, see "Images"). Unknown fields are dropped.
`stream: true` is rejected.

Responses:

| Status  | Meaning                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------- |
| 200     | Upstream body passed through unchanged (incl. `usage`). Headers: `PAYMENT-RESPONSE`, `x-bootr-receipt`  |
| 402     | With `PAYMENT-REQUIRED`: pay `amount` (= quote). Without it: `quote_exceeds_max` or `settlement_failed` |
| 400     | Invalid body or headers, unknown model, `max_tokens` too large, context too long, `image_output_not_supported` (`modalities` asks a text model for an image) |
| 409     | `idempotency_key_conflict` (same key, different body), `request_in_progress`, `request_outcome_unknown`, `payment_authorization_reused` (the authorization already funded another key) |
| 413     | `payload_too_large` (body over 1 MB)                                                                    |
| 422/502 | `upstream_rejected` / `upstream_failed_credited` (paid; kept as a credit, retry the same key), `credit_exhausted` (refund due), `request_outcome_unknown`, `facilitator_unavailable` |

`x-bootr-receipt` is a JSON header containing
`{requestId, quoteMicroUsdc, chargedMicroUsdc, paymentTxOrId, network, usage}`.
`paymentTxOrId` is the settlement transaction hash. If the payment was confirmed through
reconciliation, it is `eip3009:<nonce>` instead.

### Images

An image is a chat completion with `modalities: ["image", "text"]` on an image model
(`google/gemini-2.5-flash-image`, the Bootr default, or `openai/gpt-5-image-mini`): OpenRouter
returns the picture as a base64 data URL in `choices[0].message.images[].image_url.url`, and the
relay passes the body through and stores it like any completion (replays return the image again).
Nothing else differs: same x402 flow, idempotency, credits and reconciliation.

The quote is "one thought plus one picture": the prompt estimate and `max_tokens` at the model's
text rates, plus a fixed allowance for exactly one image at the model's `image_output` rate, plus
the margin. OpenRouter bills a Gemini 2.5 Flash Image picture as 1290 output tokens at $30 / 1M
($0.0387; `GEMINI_IMAGE_OUTPUT_TOKENS`), so a Bootr image request quotes around 0.043 USDC. For
`gpt-5-image-mini` the allowance is the worst case of 4160 tokens at $8 / 1M (a 1024x1024 high-quality
image; medium is 1056, low 272). `GET /v1/models` shows `output_modalities` and the
`image_output_micro_usdc_per_1k_tokens` / `image_output_tokens_per_image` fields for these models.
With `exact` the quote is the charge; with `upto` the image tokens reported in
`usage.completion_tokens_details.image_tokens` are settled at the image rate (every completion token at
the higher rate when the provider does not break them out). Image *input* (vision) is still rejected.

### Idempotency, statuses, reconciliation

Rows live in the Postgres table `inference_requests`, keyed by **(payer, Idempotency-Key)**: keys are
namespaced per paying address (M-1), so nobody can occupy or read another payer's keys. Columns: request
hash, status, quote, charge, payment (including the EIP-3009 authorization), payment nonce, proof hash
(sha256 of the signed payload; the signature itself is never stored), upstream attempts, the stored
response and usage. `(payer, payment_nonce)` is unique: one signed authorization funds one request, so
replaying it under other keys returns `409 payment_authorization_reused` and never reaches the upstream
(H-3b / M-2).

- A request presenting the `PAYMENT-SIGNATURE` that opened `(payer, key)`, with the same body hash:
  the stored result is replayed and **no new payment is taken**. A fresh authorization from the same
  payer for a used key is verified and then treated as a replay; it is never settled.
- Same key and a different body hash (from the payer): `409 idempotency_key_conflict`.
- Without a payment, or with someone else's, a known key is invisible: the request is simply quoted.
- `in_flight`: being processed. Rows stuck for longer than the payment window plus 60s become `credit`
  when the payment had settled, else `unknown` (`relay_interrupted`).
- `succeeded`: paid and delivered. Replays return the completion.
- `credit`: paid, no completion yet (upstream failure, or reconciliation found the payment on-chain).
  A replay runs the request without a new payment (`credit.attemptsLeft`).
- `failed`: terminal for the key. Nothing was charged (settlement refused, authorization expired
  unused, `upto` upstream 4xx; `retrySafe: true`), or a credit was exhausted (`refundDue: true`).
- `unknown`: the settlement outcome is uncertain. The relay holds a signed authorization that someone
  could still settle, so the client **must not pay for a replacement**. Poll `GET /v1/requests/:key`:
  - With `INFERENCE_RPC_URL`: if USDC `authorizationState(from, nonce)` is true, the payment happened
    (the nonce can only belong to this row) and the row becomes `succeeded` (completion held) or
    `credit`. If the nonce is unused after `validBefore`, the row becomes `failed`.
  - Without an RPC, an authorization the relay never submitted becomes `failed` after `validBefore`.
    A submitted but unconfirmed settlement stays `unknown` for an operator.

`GET /v1/requests/:key` needs `PAYMENT-SIGNATURE: <the payload that opened the request>` (401
`payment_proof_required` without it; 404 for any key the proof does not match). It returns
`retrySafe: true` only when a new key can safely be used, `credit` while a credit is open, and
`refundDue` when a paid request ended without a completion.

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

The helper remembers the payment it signed per Idempotency-Key and presents it again when the same key
is fetched twice (a replay, never a second signature). Callers that persist the payload (`onPayment`)
pass `paymentProofHeaders(payload)` on `GET /v1/requests/:key` and on replays; a request that already
carries `PAYMENT-SIGNATURE` is sent as is.

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
| `INFERENCE_UPSTREAM_TIMEOUT_MS`        | no       | `120000`; must be shorter than the authorization window minus the facilitator timeout (60s) and 30s of margin                                                                                  |
| `INFERENCE_PAYMENT_TIMEOUT_SECONDS`    | no       | `300` (x402 `maxTimeoutSeconds`, i.e. authorization lifetime; must be ≥ upstream timeout + 90s)                                                                                                |

Empty values are treated as unset. The supervisor can point its `INFERENCE_PROVIDER_URL` at this
relay.

## Running

```sh
pnpm --filter inference db:migrate   # applies drizzle/ (needs DATABASE_URL)
pnpm --filter inference dev          # tsx watch, port INFERENCE_PORT (3003)
pnpm --filter inference test         # vitest (no network, no Postgres: PGlite + mocks)
pnpm --filter inference typecheck
```

Container (build from the repo root; production setup in [`docs/deploy/coolify.md`](../../docs/deploy/coolify.md)):

```sh
docker build -f apps/inference/Dockerfile -t bootr-inference .
docker run --rm --env-file .env -e INFERENCE_PORT=3003 -p 3003:3003 bootr-inference
docker run --rm --env-file .env bootr-inference node scripts/migrate.mjs   # same journal as db:migrate
```

After changing `src/db/schema.ts`, run `pnpm --filter inference db:generate`.

## Base Sepolia test flow

Production runs on Base mainnet (`X402_NETWORK=eip155:8453`, CDP facilitator) as a private compose service with
no public host (`http://inference:3003`, called by the supervisor and, for the model list, by the web app). The flow below exercises the
relay on its own with testnet USDC; it does not involve a launcher (RWAGMI v3 has no Base Sepolia deployment, so no
coin can be launched there).

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

- Non-streaming only. Input content is text only (image and audio parts are rejected because they
  are not priced); image output is priced for exactly one picture per request (see "Images").
- `exact` charges the quote, which is an upper bound: the prompt is estimated with the o200k_base
  tokenizer (`gpt-tokenizer`), floored at UTF-8 bytes / 2 for other tokenizer families (M-5), and
  the output at the full `max_tokens`. Actual usage is reported in the receipt. Use `upto` (Permit2)
  to be charged actual usage.
- A payment whose upstream call fails is kept as a credit for its key, not refunded on-chain. After 3
  failed upstream calls (or a deterministic upstream 4xx that will repeat), the operator owes a
  refund (`refundDue`).
- `upto` still calls the upstream before settling; concurrent requests with distinct Permit2
  authorizations against one balance can each reach the upstream (only one settles). Keep `exact`
  unless the payers are trusted.
- `failed` is terminal for its key. Retries use a new key.
- `GET /v1/requests/:key` returns metadata only, never the completion, and only to the payer.
  After settlement the EIP-3009 signature is public on-chain, so the proof then only protects rows
  from callers who do not know the payer, the key and (for replays) the exact request body.
- Request bodies are limited to 1 MB (413).
- One network per deployment. There is no rate limiting or per-agent quota.
- Migration `0001_payer_scoped_keys` backfills `payer` and `payment_nonce` from stored payments;
  rows created before it have proof hash `legacy` and can no longer be read or replayed through the API. The relay's
  OpenRouter credit balance must be funded separately.
- Default prices in `src/pricing.ts` follow OpenRouter list prices (text models read on 2026-10-27,
  image models on 2026-11-03: Gemini 2.5 Flash Image $0.30 / $2.50 / $30 per 1M prompt / completion
  / image-output tokens; GPT-5 Image Mini $2.50 / $2 / $8). Re-verify them at `openrouter.ai/models`
  before mainnet. Context limits are clamped to each model's base price tier.
