# BlockRun vs OpenRouter as the model provider behind `apps/inference`

Decision memo, researched 2026-11-02. No code was changed. Every live observation below (model
catalogue, 402 quotes, health) was taken on 2026-11-02 against `https://blockrun.ai` and is a
snapshot. Anything marked **unverified** was not confirmed from a primary source.


## Update 2026-11-06: the quote changed, and only `upto` saves money

Checked live against unpaid `POST /api/v1/chat/completions` (402 bodies), `GET /api/v1/models`, OpenRouter
`GET /api/v1/models` and the changelog. This section overrides the numbers below where they differ.

- **`exact` now quotes the full `max_tokens`** (changelog 2026-11-03; it was half from 2026-10-30). `exact` and `upto`
  show the same amount in the 402; `exact` settles it, `upto` settles what the call really cost (actual tokens + $0.001).
- **`upto` is offered on the Claude ids only**: no `upto` row for `openai/gpt-5.4-mini`, `openai/gpt-4.1-mini`,
  `openai/gpt-5.4-nano`, `google/gemini-3.5-flash-lite` on 2026-11-06. The 402 also advertises `eip2612GasSponsoring`,
  so a spender with no ETH can sign the Permit2 allowance (not proven until a paid call).
- BlockRun estimates input about like the relay does (about 1 token per 2 bytes), so both quote about twice the real input.
- Settlement is after the model answers. Failed calls are never settled and the authorization is released; rejections
  caused by the caller's input do settle. There is no refund path and no chat replay after a lost response.
- Sonnet 5.5 is $2/$10 on both BlockRun and OpenRouter, a third below Sonnet 4.6.

One thought of the `$BOOTR` agent as it runs today: 61 kB request (the 0.1175 USDC relay quote this size gives matches the
0.1167 median of its on-chain payments), 16.8k real input tokens (o200k count), about 300 output tokens, `max_tokens` 1024.

| USDC per thought | Real cost at OpenRouter | Charged from fuel by the relay | BlockRun `exact` | BlockRun `upto` |
|---|---|---|---|---|
| Sonnet 4.6 | 0.0548 | 0.1175 | 0.1029 | 0.0558 |
| Sonnet 5.5 | 0.0366 | not in the price table | 0.0689 | 0.0376 |
| Haiku 4.5 | 0.0183 | 0.0392 | 0.0350 | 0.0193 |
| GPT-5.4 mini | 0.0139 | 0.0303 | 0.0272 | not offered |
| GPT-4.1 mini | 0.0072 | 0.0153 | 0.0142 | not offered |
| GPT-5.4 nano | 0.0037 | 0.0082 | 0.0081 | not offered |

On a 20 kB prompt `exact` is **dearer** than the relay on the cheap models (nano 0.00421 vs 0.00374, Gemini Flash-Lite
0.00646 vs 0.00626, GPT-4.1 mini 0.00650 vs 0.00636), because the flat $0.001 outweighs the relay's 10% margin. So direct
mode pays with `upto` only by default and leaves everything else on the relay.

The relay's real cost above excludes OpenRouter's credit purchase fee (reported 5.5%, still unverified from a primary
source) and the CDP facilitator ($0.001 per settlement after 1,000 a month, https://docs.cdp.coinbase.com/x402/support/faq).

## Verdict

BlockRun can be wired in as a **second upstream behind a config switch** with about a day of work,
because its chat endpoint is OpenAI-compatible, its model ids use the same `anthropic/claude-haiku-4.5`
form we already use, and Claude Haiku 4.5, Sonnet 4.5/4.6 and Opus 4.8 are listed at Anthropic list
price (identical to OpenRouter's). It should **not replace OpenRouter as the sole provider today**: 10 of the
27 models in our price table are absent or named differently (2 of the 7 models the admin console allows,
`deepseek/deepseek-v3.2` and `x-ai/grok-4.20`); the company is ten months old, publishes no uptime
figures or SLA, caps liability at 30 days of spend, silently fails over to a different model
(`X-Fallback-Model`), and itself buys some models wholesale from OpenRouter (that path showed a 67.6%
success rate on its own health endpoint when checked). Its pay-per-call x402 door is attractive for the
"no prepaid float" story, but its `exact` quote (estimated input + 50% of `max_tokens` + $0.001) can
exceed what we charge an agent for one thought, and the `upto` scheme needs Permit2 signatures our
payer helper does not produce. Recommendation: run a trial in **API-key mode** (`api.blockrun.ai/v1`,
list price, no per-call fee) as a fallback for the Anthropic and OpenAI models, measure for a week, and
revisit wallet mode only after the open questions below are answered.

## What BlockRun is

- Product: a pay-per-call gateway to 117 models (90 chat) plus data/tool APIs, paid in USDC over x402 on
  Base (`eip155:8453`), Solana, Arc, or with a prepaid/invoiced API key. Marketing now leads with "agent
  money" testing and benchmarks; the gateway is the developer product. https://blockrun.ai/
- Company: BlockRun, Inc., Delaware C-corp incorporated **2026-01-05**, Austin TX (GitHub says San
  Francisco), founder Vicky Fu ("Circle's former Head of Data Science"), "backed by HF0", NVIDIA Inception.
  "A small team. We are hiring." https://blockrun.ai/about, https://github.com/BlockRunAI
- Maturity signals: changelog runs 2026-04-10 to 2026-10-30 with near-daily entries
  (https://blockrun.ai/changelog); Haiku 4.5 "on BlockRun since 2026-02-21"
  (https://blockrun.ai/models/anthropic-claude-haiku-4.5); open-source client-side router ClawRouter has
  ~6.6k GitHub stars, the TS SDK has 3; the gateway server itself is not open source. A third-party scanner
  says the domain was registered "4 months ago" behind privacy (**unverified**, contradicts the Feb 2026 model
  date): https://gridinsoft.com/online-virus-scanner/url/blockrun-ai
- Independent feedback: none found. No Reddit/X complaints, no outage reports, no reviews. The only
  external "evaluation" (double charge after a lost response) was run against the reporter's own test gateway,
  not production, and closed "not planned": https://github.com/BlockRunAI/blockrun-nano-client/issues/15
- Status page: "All gateways operational", "incident history: none recorded on this page yet", no uptime
  percentage. Anthropic 12/12 healthy, Google 10/11 degraded at check time. https://blockrun.ai/status
- Live health JSON (2026-11-02 20:11 UTC, https://blockrun.ai/api/health): per-upstream success rates
  anthropic 1.000 (avg 9.6 s), openai 1.000 (3.6 s), google 1.000 (1.9 s), **openrouter 0.676** (6.9 s),
  nvidia 0.985, zai 0.875. The `openrouter` key confirms the vs-page disclosure that "some catalog models reach
  us through OpenRouter as a wholesale supplier" (https://blockrun.ai/vs-openrouter). Which models is not stated.
- Claude serving path: changelog 2026-09-08 entries talk about AWS Bedrock "global" vs "regional (us., eu.)"
  inference profiles for nine Claude models, and that "the us profiles carry a daily token quota that cannot be
  raised". So at least part of the Claude traffic runs through Bedrock with a daily quota BlockRun cannot lift.
  Per-model path is not published (**unverified** for Haiku 4.5 specifically).

## Comparison

| | OpenRouter (today) | BlockRun |
|---|---|---|
| Claude models | all current Anthropic ids | 12 Anthropic ids incl. `anthropic/claude-haiku-4.5`, `-sonnet-4.5`, `-sonnet-4.6`, `-opus-4.8` (live `GET https://blockrun.ai/api/v1/models`) |
| Our price table (27 ids) | all present | 17 present by exact id; **missing**: `openai/gpt-5-nano`, `google/gemini-3.1-pro-preview` (has `google/gemini-3.1-pro`), `x-ai/grok-4.7` (has `xai/grok-4.7`), `x-ai/grok-4.20` (absent), `deepseek/deepseek-v3.2` (only V4.x / `deepseek-chat`), `moonshotai/kimi-k2.6`, `qwen/qwen3-235b-a22b-2507`, `meta-llama/llama-4-maverick`, `mistralai/mistral-medium-3.1`, `z-ai/glm-4.6` (has `zai/glm-5.x`) |
| Admin allowlist (7 ids, `apps/web/lib/server/admin-config.ts`) | 7/7 | 5/7 (`deepseek/deepseek-v3.2`, `x-ai/grok-4.20` missing) |
| API | OpenAI chat completions, `/models` with prices | OpenAI chat completions at `POST https://blockrun.ai/api/v1/chat/completions` (x402) or `https://api.blockrun.ai/v1/chat/completions` (API key); `GET /v1/models` and `GET /api/pricing` with prices; SSE streaming; tools/`tool_choice`; `response_format`; Anthropic `thinking`; also `/v1/messages` (Anthropic SDK shape). https://blockrun.ai/docs/api-reference/chat-completions |
| Model id format | `vendor/model` | same, except `xai/` not `x-ai/`, `zai/` not `z-ai/` |
| Payment rails | prepaid credits by card or crypto (USDC), API key; no x402 | (a) x402 v2 per call, `exact` (EIP-3009) and `upto` (Permit2) both offered in the 402, USDC on Base, CDP facilitator, payTo observed `0xe9030014F5DAe217d0A152f02A043567b16c1aBf`; (b) API key `brk_live_...`, prepaid card/wire or monthly invoice |
| Fees | token price = provider list price ("passed through without markup", https://openrouter.ai/support); purchase fee widely reported as 5.5% card / 5% crypto, the official FAQ renders placeholders (**unverified from primary**) | token price = provider list price; wallet door: flat $0.001 per call, no margin on chat tokens; API-key door: "no per-call fee and no minimum charge on this host" (https://blockrun.ai/docs/getting-started/enterprise-api); top-up processing fee not stated (**unverified**) |
| Quote semantics (wallet door) | n/a | `exact` amount = est. input + **50% of `max_tokens`** output + $0.001, settled regardless of actual usage; `upto` ceiling = est. input + 100% of `max_tokens` + $0.001, actual usage settled. Observed: haiku, 17-token prompt, `max_tokens` 1024 -> exact 3577 / upto 6137 micro-USDC; 8192 -> 21497 / 41977; 32768 -> 82937 / 164857; floor appears to be 2000 micro (max_tokens 32 -> 2000/2000). Formula inferred from numbers; the docs still say "10% of max_tokens" in one place and "half" in the 2026-10-30 changelog. |
| Input estimate (wallet `exact`) | n/a | a 20,000-character prompt was quoted as 9,616 input tokens (sonnet-4.6, max 1024 -> exact 37528, upto 45208), i.e. roughly 1 token per 2 characters, about 2x a real tokenizer count. Overcharges `exact` callers on input. |
| Failure billing | relay is billed by OpenRouter even when the agent is not charged (H-3a in `docs/security/services-review.md`) | "Failed requests aren't billed": upstream 4xx/5xx, 120 s timeout and empty responses never settle; provider rejections caused by the caller's input do settle; settled payments are final (https://blockrun.ai/faq, https://blockrun.ai/docs/x402/security) |
| Idempotency / replay | none upstream; our relay implements it | nonce single-use (`PAYMENT_REPLAY`); replay-of-lost-response only documented for image jobs, not chat (https://blockrun.ai/docs/x402/payment-flow) |
| Rate limits | per-key limits, documented | "no BlockRun-side per-request limit" for paid calls, only upstream TPM/RPM (429 `RATE_LIMITED` + `Retry-After`); API key: 12,000 req/min safety ceiling; `GET /v1/models` 100/h per IP (https://blockrun.ai/docs/rate-limits). Bedrock regional daily token quota "cannot be raised" (changelog 2026-09-08). |
| Timeouts | our `INFERENCE_UPSTREAM_TIMEOUT_MS` = 120 s | 120 s per upstream call, 500 s stream deadline, 300 s authorization window |
| Silent model fallback | no (caller controls routing) | yes: `X-Fallback-Used: true`, `X-Original-Model`, `X-Fallback-Model`; "Ours to decide; no caller-side provider controls" |
| SLA / liability | commercial terms | "We do not commit to any particular uptime"; liability capped at 30 days of spend; may "suspend or discontinue the service at any time" (https://blockrun.ai/terms, updated 2026-10-21) |
| Reselling | allowed in practice (we do it) | terms only forbid reselling "in a way that misrepresents its origin"; relaying not otherwise addressed |
| Data | provider-dependent | "We do not share, sell, or train on your prompts and completions"; a copy of each call kept in a restricted store for abuse/billing disputes, retention period not stated |
| Testnet | n/a | docs list `testnet.blockrun.ai` (Base Sepolia, `eip155:84532`) but it did not resolve on 2026-11-02 (`curl` HTTP 000) (https://blockrun.ai/docs/x402/endpoints) |
| SDKs | OpenAI SDK | `@blockrun/llm` (TS, MIT, 3 stars), `blockrun-llm` (Python), Go; LiteLLM and LlamaIndex adapters; v1.20.0 (2026-10-12) added opt-in `upto` on Base (https://github.com/BlockRunAI/blockrun-llm/releases/tag/v1.20.0) |

### Price of one thought (4,000 prompt tokens, `max_tokens` 1024, ~300 output tokens actually produced)

List prices are identical on both (verified live: OpenRouter `GET /api/v1/models` and BlockRun
`GET /api/v1/models`, 2026-11-02): Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15, GPT-4.1 mini $0.40/$1.60 per M.
(`google/gemini-3.8-flash` differs: our table 0.825/4.125 from OpenRouter vs 0.75/3.75 on BlockRun.)

| Model | What the relay charges the agent today (`exact`, full `max_tokens`, 10% + 100 micro margin) | Relay's cost via OpenRouter (actual usage, +5.5% purchase fee, fee unverified) | BlockRun API key (actual usage, no per-call fee) | BlockRun wallet `upto` (actual + $0.001) | BlockRun wallet `exact` (if its input estimate = 4,000 tokens; 50% of max_tokens; + $0.001) | BlockRun wallet `exact` if input is over-estimated 2x (as observed) |
|---|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | $0.010132 | $0.0058 | $0.0055 | $0.0065 | $0.00756 | $0.01156 (**above what we charge**) |
| `anthropic/claude-sonnet-4.6` | $0.030500 | $0.0174 | $0.0165 | $0.0175 | $0.02068 | $0.03268 (**above what we charge**) |
| `openai/gpt-4.1-mini` | $0.004062 | $0.0022 | $0.00208 | $0.00308 | $0.00342 | $0.00502 (**above what we charge**) |

Reading: API-key mode is marginally cheaper than OpenRouter (no purchase fee, same list price). Wallet
`upto` costs $0.001 more per call than OpenRouter, which matters at our thought size (15-45% of the token
cost). Wallet `exact` is a loss-maker for us unless our own quote to the agent is raised above BlockRun's
quote, because BlockRun charges 50% of `max_tokens` whether or not the model uses it, and its input
estimate is coarse. The 2-3x margin the relay keeps on a thought (we charge the full `max_tokens`) absorbs
the `upto` fee but not the `exact` over-quote.

## How our code talks to OpenRouter today, and what is OpenRouter-specific

Read: `apps/inference/README.md`, `apps/inference/src/{upstream,pricing,config,main,app,request}.ts`,
`apps/inference/src/client/x402-payer.ts`, `apps/supervisor/src/inference.ts`,
`packages/agent-core/src/inference/request.ts`, `apps/web/lib/models.ts`, `apps/web/app/api/models/route.ts`,
`packages/shared/src/config.ts`.

- `apps/inference/src/upstream.ts`: `createOpenRouterClient` POSTs `${baseUrl}/chat/completions` with
  `authorization: Bearer <OPENROUTER_API_KEY>`, OpenRouter attribution headers `http-referer: https://bootr.fun`
  and `x-title: Bootr`, and the body `{ ...req, stream: false, usage: { include: true } }`. `usage.include` is
  an **OpenRouter-only body field**. Response handling expects `choices[]` and `usage.prompt_tokens` /
  `completion_tokens`; 5xx/408 -> `unknown`, other 4xx -> `rejected`, a 200 without `choices` -> `rejected`
  (an OpenRouter quirk). `OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'`.
- `apps/inference/src/pricing.ts`: `DEFAULT_PRICE_TABLE` hard-codes 27 ids in OpenRouter's `vendor/model`
  form with prices "derived from OpenRouter list prices on 2026-10-27 (https://openrouter.ai/api/v1/models)".
  Nothing fetches `/models` at runtime; `INFERENCE_PRICE_TABLE_JSON` overrides. Quote = ceil(est. input x in-rate
  + `max_tokens` x out-rate) + 10% + 100 micro, floored at 1000 micro (CDP minimum). The o200k_base tokenizer
  with a bytes/2 floor estimates input.
- `apps/inference/src/config.ts`: `OPENROUTER_API_KEY: z.string().min(1)` is required; no upstream selector,
  no upstream base URL variable (tests inject `baseUrl`).
- `apps/inference/src/main.ts`: wires `createOpenRouterClient({ apiKey, timeoutMs })`.
- `apps/inference/src/app.ts`: `GET /v1/models` serves the price table (`owned_by: id.split('/')[0]`); the
  receipt reports `row.model` as requested, so a silent upstream fallback would go unnoticed.
- `pricePerThought`: not in the relay. `apps/web/app/api/models/route.ts` reads the relay's `GET /v1/models`
  and `apps/web/lib/models.ts` turns `input/output_micro_usdc_per_1k_tokens` into `pricePerThoughtUsd` with
  `THOUGHT = { promptTokens: 4000, outputTokens: 1024 }` mirrored through the relay margin (`thoughtPriceUsd`);
  `FALLBACK_PRICES` there repeat the OpenRouter list prices; `PROVIDERS` keys the vendor prefixes `x-ai`, `z-ai`,
  `moonshotai`, `meta-llama`, `mistralai`. `apps/web/e2e/models.spec.ts` asserts haiku at $0.010132.
- `packages/agent-core/src/inference/request.ts`: `MAX_QUOTE_MICRO_USDC` matches bare model prefixes
  (`claude-haiku`, `grok-4.20`, `deepseek`...), vendor-agnostic, so a `xai/` prefix would still match.
- `apps/supervisor/src/inference.ts`: pays the relay with `createX402Payer` (`exact` only),
  `INFERENCE_MAX_OUTPUT_TOKENS` 1024, `INFERENCE_TIMEOUT_MS` 150 s. Unaffected by the upstream choice.
- `packages/shared/src/config.ts`: only `INFERENCE_PROVIDER_URL` and `X402_FACILITATOR_URL` (the relay's own
  env schema lives in `apps/inference/src/config.ts`).
- Deployment: `OPENROUTER_API_KEY` appears in `.env.example`, `.env.mainnet.example` ("with a spend limit"),
  `docker-compose.coolify.yml` (the inference `environment` block and four `env -u` strip lists),
  `docs/deploy/coolify.md`, `docs/deploy/mainnet.md`, `README.md`, `docs/security/services-review.md` (H-3).

## Concrete integration changes

### Option A: API-key mode as a selectable upstream (recommended for a trial)

1. `apps/inference/src/upstream.ts`: generalise `createOpenRouterClient` into an OpenAI-compatible client
   with `{ apiKey, baseUrl, attribution?: boolean, includeUsage?: boolean }`; for BlockRun use
   `https://api.blockrun.ai/v1`, send only `authorization` + `content-type` (drop `http-referer`, `x-title`),
   and **drop `usage: { include: true }`** (BlockRun forwards unknown params to upstreams; Anthropic would
   reject it). Keep `stream: false`. Map BlockRun 503 `MODEL_UNAVAILABLE`/`PROVIDER_CONFIG_ERROR` and 504
   `TIMEOUT` to `unknown` (already true via `>= 500`); treat 429 `RATE_LIMITED` as `unknown`-like retryable
   rather than a definitive `rejected` (today any 4xx becomes a credit after a `rejected`, which is acceptable
   but burns one of the 3 attempts). Read `X-Fallback-Used` / `X-Fallback-Model` and either refuse the
   completion or record the served model in `usage`/receipt.
2. `apps/inference/src/config.ts`: add `INFERENCE_UPSTREAM: z.enum(['openrouter','blockrun']).default('openrouter')`,
   `BLOCKRUN_API_KEY` (required when selected), optional `INFERENCE_UPSTREAM_BASE_URL`; make `OPENROUTER_API_KEY`
   required only when selected. Update `config.test.ts`.
3. `apps/inference/src/main.ts`: pick the client from the config.
4. `apps/inference/src/pricing.ts`: per-upstream default table or a documented `INFERENCE_PRICE_TABLE_JSON`
   for BlockRun: rename `x-ai/` -> `xai/`, `z-ai/` -> `zai/`, `google/gemini-3.1-pro-preview` -> `google/gemini-3.1-pro`,
   drop or remap the 10 missing ids, re-verify `gemini-3.8-flash`; refresh the comment that cites OpenRouter.
5. `apps/web/lib/models.ts` (`PROVIDERS`, `LABELS`, `FALLBACK_PRICES`), `apps/web/lib/server/admin-config.ts`
   (default allowlist), `apps/web/e2e/models.spec.ts`, `packages/agent-core/src/inference/request.ts`
   (`MAX_QUOTE_MICRO_USDC` keys for any renamed models).
6. Tests: `apps/inference/src/upstream.test.ts`, `app.test.ts`, `test/helpers.ts` (fixed OpenRouter URLs and
   the `usage.include` expectation).
7. Ops: `.env.example`, `.env.mainnet.example`, `docker-compose.coolify.yml` (add `BLOCKRUN_API_KEY` to the
   inference block and to every `env -u` list), `docs/deploy/coolify.md`, `docs/deploy/mainnet.md`, `README.md`,
   `apps/inference/README.md`, `docs/security/services-review.md` (H-3a wording: BlockRun does not bill
   failed/timed-out calls, which shrinks that finding's impact).

Estimated effort: about one day including tests; no protocol change for agents.

### Option B: wallet (x402) mode, relay pays BlockRun per call

Everything in A plus:

1. A relay-owned USDC wallet: new secret (e.g. `INFERENCE_UPSTREAM_WALLET_KEY`), funded and monitored;
   `env -u` lists and Coolify docs updated. The `exact` scheme needs no ETH; `upto` needs a one-time Permit2
   approval (and the gateway advertises `eip2612GasSponsoring`, so possibly no ETH either, **unverified**).
2. `apps/inference/src/upstream.ts`: wrap `fetch` with `createX402Payer` from
   `apps/inference/src/client/x402-payer.ts` (signer = relay EOA, `payTo` pinned to BlockRun's address,
   `maxPaymentMicroUsdc` = our own quote so we never pay BlockRun more than the agent paid us). The helper
   already reads the `PAYMENT-REQUIRED` header BlockRun sends and signs `exact`; **it cannot sign `upto`
   (Permit2)**, so `upto` means extending the helper with `@x402/evm`'s upto client scheme.
3. `apps/inference/src/pricing.ts`: add BlockRun's $0.001 per-call fee (raise `marginFixedMicroUsdc` to at least
   1100 or add an explicit upstream fee field), and make the agent-facing quote provably >= BlockRun's `exact`
   quote (its input estimate is coarser than ours; our 10% margin does not cover a 2x input over-estimate).
4. Order of operations: our relay already settles the agent's payment before calling upstream (H-3 fix), so
   paying BlockRun per call fits; but a BlockRun `X-Payment-Settled: false` (served but not settled) and a lost
   response after BlockRun settled both need handling in `reconcile.ts`, and BlockRun offers no chat replay for a
   lost response (a retry is a second charge).
5. Latency: one facilitator verify + settle per call on BlockRun's side on top of our own (both through the
   Coinbase CDP facilitator, a shared single point of failure). Magnitude **unverified**.

## Risks specific to BlockRun

- Ten-month-old company, small team, no public uptime history, no SLA, 30-day-spend liability cap, "may suspend
  or discontinue the service at any time".
- Silent model fallback is the default and cannot be disabled by the caller; our receipt would report the
  requested model.
- Part of the Claude capacity sits behind Bedrock profiles with a daily token quota BlockRun "cannot raise"
  (changelog 2026-09-08). No numbers published.
- BlockRun itself resells OpenRouter for an unnamed subset of models; that path was at 67.6% success at check time.
- Catalogue churn: models were deprovisioned or re-priced repeatedly in the changelog (NVIDIA free models,
  Mistral Large 4, GPT-5.6 Pro SKUs). Our price table is static and would need re-verification per release.
- Quote semantics changed on 2026-10-30 (10% -> 50% of `max_tokens`); the docs are inconsistent about it.
- `testnet.blockrun.ai` is documented but was unreachable, so a Base Sepolia rehearsal of wallet mode is not
  possible right now.

## Open questions only a trial answers

1. Which upstream actually serves `anthropic/claude-haiku-4.5` and `-sonnet-4.6` (Anthropic direct vs Bedrock
   vs OpenRouter), and what the effective daily Claude quota is at our volume.
2. Real p50/p95 latency and error rate for our 4k-token tool-calling prompts versus OpenRouter (the model page
   shows median 2.66 s / p95 8.07 s / 99.69% success for Haiku 4.5 over 7 days, all callers).
3. Whether `tools` + `tool_choice: 'required'` and `developer`-role messages pass through unchanged for Claude
   (BlockRun strips `temperature` on some Claude 5.x ids; behaviour for 4.x not stated).
4. Whether the `usage` object always carries `prompt_tokens`/`completion_tokens` on Claude responses (our
   `readUsage` returns `undefined` otherwise, which disables `upto` actual-charge computation).
5. API-key mode: card/wire top-up fee, minimum top-up, invoice terms, and whether `/v1/usage` reconciles with our
   receipts.
6. Wallet mode: how often `X-Payment-Settled: false` occurs, whether BlockRun ever settles without serving, the
   real input-estimate formula, and the extra latency from BlockRun's own verify/settle.
7. How often `X-Fallback-Used` fires on the Claude ids, and whether support will pin a model on request.
8. Whether BlockRun will state in writing that relaying to third-party agents is within its terms.

## Sources

BlockRun (primary): https://blockrun.ai/ , https://blockrun.ai/about , https://blockrun.ai/pricing ,
https://blockrun.ai/models , https://blockrun.ai/models/anthropic-claude-haiku-4.5 ,
https://blockrun.ai/api/v1/models (live JSON) , https://blockrun.ai/api/pricing (live JSON) ,
https://blockrun.ai/api/health (live JSON) , https://blockrun.ai/.well-known/x402 ,
https://blockrun.ai/api/v1/chat/completions (unpaid POSTs, 402 bodies decoded) ,
https://blockrun.ai/docs/api-reference/chat-completions , https://blockrun.ai/docs/x402/how-it-works ,
https://blockrun.ai/docs/x402/payment-flow , https://blockrun.ai/docs/x402/endpoints ,
https://blockrun.ai/docs/x402/security , https://blockrun.ai/docs/rate-limits ,
https://blockrun.ai/docs/getting-started/enterprise-api , https://blockrun.ai/docs/products/intelligence/pricing ,
https://blockrun.ai/changelog , https://blockrun.ai/faq , https://blockrun.ai/status , https://blockrun.ai/terms ,
https://blockrun.ai/vs-openrouter , https://user.blockrun.ai/ , https://api.blockrun.ai/v1/models (401 without key).

BlockRun GitHub: https://github.com/BlockRunAI , https://github.com/BlockRunAI/blockrun-llm-ts ,
https://github.com/BlockRunAI/blockrun-llm/releases/tag/v1.20.0 ,
https://github.com/BlockRunAI/blockrun-nano-client/issues/15 , https://github.com/BlockRunAI/blockrun-llm-ts/pull/89 .

OpenRouter: https://openrouter.ai/api/v1/models (live JSON) , https://openrouter.ai/support ,
https://openrouter.ai/docs/faq (fee figures render as placeholders).

Third party (unverified): https://gridinsoft.com/online-virus-scanner/url/blockrun-ai ,
https://x.com/x402/status/2069030513722179918 .
