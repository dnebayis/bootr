# Bootr services security review

Scope: `apps/sender`, `apps/web` (admin console, SIWE, `app/api/**`, `app/agents/[id]`, launch and fuel flows), `apps/inference` (x402 relay), `apps/indexer` internal routes, and cross-cutting concerns (shared HMAC, CORS, rate limits, SSRF, validation, logging, cookies, CSRF, dependencies, `.env.example`, deployment assumptions).

Reviewed at commit `f0b2f4c` (2026-10-27), before the move to the RWAGMI v3 launcher on 2026-10-29. This was a code review only. No source files were changed. The root `.env` was not read. The findings concern the services, not the launch backend, and are kept as written; one fact moved: the sender now has the read-only `GET /public/posts/:agentId` route that finding I-1 listed as missing (the web reads it through its own `/api/agents/:id/posts` proxy). TODO(verify): the status of each other finding was not re-checked in this pass.

**Status (2026-11-08):** the fixes of that day are in [`fixes-2026-11-08.md`](./fixes-2026-11-08.md): M-6 gained rate
limits on `POST /api/launch/draft` (20 a minute per IP) and `POST /api/agent/nonce` (30), a bound on the draft store and
a daily X read budget per agent in the sender (items 5 and 7); L-5's `/sql/*` route is gone (item 6); every server-side
viem client refuses CCIP-Read (item 1); bodies are read under a cap (item 3). H-1 moved on: the web now also holds
`SUPERVISOR_SERVICE_KEY` for the coin page's agent routes, and the key inventory
([`key-inventory-2026-11-08.md`](./key-inventory-2026-11-08.md), step 2) proposes a read-mostly key for it.

Evidence gathered:

- Existing suites pass: sender 41/41, inference 47/47.
- Two throwaway proof-of-concept runs against the real relay code (`createApp` with an in-memory store, a stub facilitator and a stub upstream; scripts kept outside the repo) confirmed H-3 and M-1:
  - One signed EIP-3009 authorization replayed under 5 more idempotency keys produced **6 upstream calls and 1 settlement**.
  - An upstream timeout left the row `unknown` with `settlementAttempted=false` and **0 settlements**.
  - A POST with the victim's `Idempotency-Key` and the same body, **with no payment header**, returned the stored completion (HTTP 200).
- `pnpm audit --prod`: 17 advisories (9 high, 7 moderate, 1 low). The relevant ones are listed in L-6.

## Findings

| ID  | Severity | Title | Location |
| --- | --- | --- | --- |
| H-1 | High | One HMAC key (`SENDER_SERVICE_KEY`) authorizes every service. The public web app and the indexer hold the key that can publish as any agent, bind X accounts, and drive the supervisor admin API | `apps/web/app/api/admin/config/route.ts:15`, `apps/indexer/src/lib/env.ts:104`, `apps/supervisor/src/config.ts:100`, `apps/sender/src/config.ts:13` |
| H-2 | High | OAuth state is not tied to the browser or creator that started the flow, and it can be used more than once. An attacker can get a victim's X account bound to the attacker's agent, or silently re-bind a victim's agent to another X account | `apps/sender/src/oauth.ts:68-89`, `apps/sender/src/app.ts:106-148`, `apps/sender/src/accounts.ts:44-47` |
| H-3 | High | The relay calls the paid upstream before it collects payment. Upstream timeouts/5xx are never charged, and one authorization or balance can fund many concurrent upstream calls | `apps/inference/src/app.ts:243-254`, `apps/inference/src/app.ts:313-321`, `apps/inference/src/app.ts:369` |
| H-4 | High | The sender does not enforce reply consent or which post a reply may target. It replies to any post ID and skips the opt-out check whenever the author is not already known | `apps/sender/src/publish.ts:128-157`, `apps/supervisor/src/broker/index.ts:132-141` |
| M-1 | Medium | Relay idempotency keys are global and predictable. This allows key squatting (DoS), unauthenticated metadata reads, and replay of stored completions with no payment | `apps/inference/src/app.ts:135-141`, `apps/inference/src/app.ts:174-175`, `apps/inference/src/app.ts:429-451`, `packages/agent-core/src/inference/request.ts:89-91` |
| M-2 | Medium | A payment authorization is not unique per row, and the reconciler treats a used nonce as proof that *this* row paid | `apps/inference/src/reconcile.ts:81-109`, `apps/inference/src/db/schema.ts:39-58` |
| M-3 | Medium | The SIWE domain/URI check (and the admin CSRF origin check) trusts the client-supplied `X-Forwarded-Host` header | `apps/web/app/api/siwe/verify/route.ts:22-24,53-58`, `apps/web/app/api/admin/config/route.ts:23-32` |
| M-4 | Medium | `/oauth/start` authorization: the signature is a reusable 5-minute bearer token, nothing checks that the caller owns the agent, the agent ID namespaces differ between web and supervisor, and the web flow is unsigned | `apps/sender/src/app.ts:77-104`, `apps/web/components/launch/XConnect.tsx:36-50`, `apps/web/components/launch/LaunchForm.tsx:171-179` |
| M-5 | Medium | The input-token estimate (bytes/3) can be gamed: the relay under-charges for adversarial prompts and can exceed model price tiers | `apps/inference/src/pricing.ts:176-201,250-251` |
| M-6 | Medium | No body-size limits or rate limits on public endpoints; HMAC routes read the whole body before checking the signature | `apps/inference/src/app.ts:156`, `apps/sender/src/auth.ts:62`, `apps/indexer/src/api/index.ts:392`, `apps/sender/src/app.ts:77-148` |
| M-7 | Medium | Admin console controls are not enforced anywhere (`launchesPaused`, `allowedModels`, `xQuotas`, `postIntervalMinutes`), and the config is stored in a per-instance file | `apps/web/lib/server/admin-config.ts:30-76`, `apps/web/components/console/ConsoleView.tsx:247` |
| L-1 | Low | HMAC scheme: no nonce (replay within ±5 min), no host/audience binding, weak key-length enforcement | `apps/sender/src/auth.ts:31-69`, `apps/indexer/src/lib/hmac.ts:35-53` |
| L-2 | Low | Token encryption key has no key ID or rotation path, tokens are never revoked or deleted, and refresh locking is per-process only | `apps/sender/src/crypto.ts:10-48`, `apps/sender/src/accounts.ts:54-122` |
| L-3 | Low | SIWE nonce is stateless and replayable within 10 minutes, admin sessions cannot be revoked, and signature checking depends on an RPC | `apps/web/app/api/siwe/nonce/route.ts:6-15`, `apps/web/app/api/siwe/verify/route.ts:69-80`, `apps/web/lib/server/session-core.ts:62-76` |
| L-4 | Low | Actions do not record which X account posted them, so reconciliation follows whichever account is currently bound; one X account can be bound to many agents | `apps/sender/src/reconcile.ts:129-139`, `apps/sender/src/db/schema.ts:23-71` |
| L-5 | Low | Indexer exposure: public `/sql/*` that no Bootr client uses, CORS `*` fallback, social patch replay | `apps/indexer/src/api/index.ts:26-43,390-421` |
| L-6 | Low | Vulnerable dependency versions (drizzle-orm 0.41.0, zod in inference, transitive Ponder deps) | `apps/sender/package.json`, `apps/inference/package.json`, `apps/indexer/package.json` |
| L-7 | Low | Web hardening gaps: no CSP/frame-ancestors/HSTS, the console prefix appears in robots.txt, no `__Host-` cookie prefix, `apps/web/data` not git-ignored | `apps/web/next.config.ts:3-20`, `apps/web/app/robots.ts:6`, `apps/web/lib/server/session.ts:18-23`, `.gitignore` |
| L-8 | Low | Agent card URI can be squatted (earliest launch wins), and the fuel flow sends USDC to a kernel address supplied by the indexer | `apps/web/app/agents/[id]/route.ts:24-42`, `apps/web/components/token/FuelForm.tsx:47-56` |
| I-1 | Info | Web calls sender endpoints that do not exist (`/oauth/status`, `/public/posts/:kernel`), and post URLs are rendered as `href` without a scheme check | `apps/web/components/launch/XConnect.tsx:49`, `apps/web/lib/indexer.ts:263`, `apps/web/components/token/AgentPanel.tsx:43` |
| I-2 | Info | Error detail passthrough: upstream provider bodies and zod issue arrays | `apps/inference/src/app.ts:333-335`, `apps/sender/src/app.ts:58` |
| I-3 | Info | Sender receipts are signed with the shared service key, so third parties cannot verify them independently | `apps/sender/src/receipt.ts:38` |
| I-4 | Info | One root `.env` with every secret (including deployer/admin private keys); no Docker/deploy manifests, so deployment assumptions are implicit | `.env.example` |
| I-5 | Info | The indexer's admin-config fetch authenticates the request but not the response; integrity relies on HTTPS | `apps/indexer/src/lib/admin-config.ts:16-41` |

**Counts:** Critical 0 · High 4 · Medium 7 · Low 8 · Info 5

---

## High

### H-1. One HMAC key authorizes every service

**Status (2026-10-27):** Fixed in sender/web: `SENDER_SERVICE_KEY` (supervisor + web only) must be ≥ 32 chars or the sender refuses to start; the web verifies the admin-config GET with `INDEXER_SERVICE_KEY` (falls back to `SENDER_SERVICE_KEY` only while unset, with a startup warning); the supervisor fallback is removed on the supervisor side. The HMAC string is unchanged (no audience) to stay compatible with the supervisor/indexer signers; the indexer and the supervisor's `IndexerClient` must move to `INDEXER_SERVICE_KEY`.

**Description.** `SENDER_SERVICE_KEY` is used for all of the following:

- the sender's internal API (`/internal/publish`, `/internal/quota`, `/internal/inbox/resolve` and the read endpoints);
- the `/oauth/start` signature;
- OAuth `state` signing;
- receipt signatures;
- the indexer's `/internal/agent/:kernel/social`;
- the web `GET /api/admin/config` service auth;
- the supervisor's `/internal/*` admin API, because `SUPERVISOR_SERVICE_KEY` falls back to `SENDER_SERVICE_KEY` (`apps/supervisor/src/config.ts:100`). That API includes `POST /internal/agents/:id/tick` (runs a paid inference cycle), `session/install`, `session/rotate`, `pause` and `resume`.

Two internet-facing services also hold the key: the Next.js web app (only to *verify* the admin-config GET) and the Ponder indexer (to sign social updates and fetch admin config). The indexer carries the most third-party attack surface: public GraphQL, public `/sql`, and the advisories in L-6.

**Exploit scenario.** An attacker reads the web app's or the indexer's environment, for example through an SSRF/RCE in a dependency, a leaked build log, or a misconfigured host. With the key they can:

- POST `/internal/publish` for every `agentId` (sequential on-chain IDs) and post arbitrary text from every agent's X account (agent-core policy still applies);
- mint `/oauth/start` signatures and re-bind any agent's X account (H-2);
- call supervisor `/internal/agents/:id/tick` in a loop and spend each agent's USDC on inference;
- rotate or install session keys.

**Impact.** Leaking the key from the least-trusted service compromises the whole platform's X presence and agent treasuries.

**Fix.**
1. Give each caller→callee edge its own key:
   - `SENDER_INTERNAL_KEY`: supervisor → sender only;
   - `SENDER_OAUTH_START_KEY`: web → sender, `/oauth/start` only;
   - `INDEXER_SOCIAL_KEY`: supervisor → indexer;
   - `WEB_CONFIG_READ_KEY`: indexer/supervisor → web;
   - `SUPERVISOR_ADMIN_KEY`: ops → supervisor, required, with no fallback.
2. Use separate secrets inside the sender for OAuth state signing and receipts, derived with HKDF from a sender-only master secret.
3. Bind the service identity into the signing string (see L-1) so a signature for one audience is rejected by the others.
4. Better still, keep `/internal/*` off the public internet (private network or mTLS) and verify with per-caller keys.

### H-2. OAuth state is not tied to the initiating browser or creator, and can be used more than once

**Status (2026-10-27):** Fixed: HttpOnly SameSite=Lax binding cookie hashed into `state`, single-use states (`sender_oauth_states`), no overwrite of a different connected account without a signed `reconnect=1`; web drafts can only be connected from the browser that registered them. Not done: the pending/SIWE-confirm step and encrypting the state payload.

**Description.** `buildAuthorizeUrl` produces `state = base64url({a: agentId, s, e, v: enc(verifier), n}) . HMAC`. `openState` checks only the HMAC, the expiry (15 min) and that the verifier decrypts. Nothing ties the state to:

- the browser that started the flow (no cookie set by `/oauth/start` and checked in `/oauth/callback`);
- the creator's wallet or SIWE identity;
- a single use (nothing records consumed `n`).

The callback then upserts `sender_accounts` unconditionally (`onConflictDoUpdate`), overwriting any existing binding to a different `xUserId`, with no confirmation step. The state payload is also readable (base64 JSON, not encrypted), so anyone who sees the URL learns the `agentId` and the web `state`.

**Exploit scenarios.**

1. **Victim's X account bound to the attacker's agent (consent phishing).** The attacker launches an agent, gets a legitimate authorize URL for it, and sends that X link to a target ("claim your airdrop, connect X"). The target sees X's real consent screen for the legitimate "Bootr" app and approves. `/oauth/callback` binds the target's X account to the attacker's agent, and the attacker's agent now posts as the victim.
2. **Attacker's X account bound to a victim's agent (re-binding).** The attacker obtains an authorize URL for the victim's agent. Sources include a replayed `/oauth/start` URL (M-4), browser history, a proxy log or a Referer. They copy its `state` and `code_challenge`, sign in to X as themselves, and approve. The callback decrypts the victim's verifier from `state`, the code exchange succeeds because the challenge matches, and the victim's agent is silently re-bound. The agent card and indexer now advertise the attacker's handle (once the supervisor syncs it), the victim's posting stops, and held actions reconcile against the wrong timeline (L-4).

**Impact.** Account takeover of a victim's posting capability through the platform's own trusted consent screen; identity and brand hijack of launched agents.

**Fix.**
1. In `/oauth/start`, set an `HttpOnly; Secure; SameSite=Lax` cookie containing a random binding value, include its hash in `state`, and require it in `/oauth/callback` (standard OAuth CSRF protection).
2. Make `state` single-use: store `n` with its expiry in Postgres and delete it atomically in the callback.
3. Do not finalize the binding in the callback. Store it as `pending` and redirect to the web app, where the creator, signed in with SIWE as the agent's on-chain creator, confirms "connect @handle to agent X". Re-binding an already-connected agent should require the same confirmation, and an explicit unbind first.
4. Encrypt the whole state payload, or keep it server-side and send only a random ID.

### H-3. The relay calls the paid upstream before it collects payment

**Status (2026-10-27):** Fixed for `exact`: settle before the upstream call; upstream failures keep the payment as a per-(payer, key) credit (max 3 upstream calls, then `refundDue`); unique (payer, nonce); 1 MB body limit; upstream timeout + 90 s ≤ authorization window. `upto` still runs upstream first (unknown outcome settles the full quote as a credit); its H-3b window remains.

**Description.** The flow is verify (no funds move) → claim key → call OpenRouter → settle. Payment is collected only when settlement succeeds. Two paths let a caller consume upstream spend without paying:

- **(a) Upstream outcome "unknown".** On a timeout (`INFERENCE_UPSTREAM_TIMEOUT_MS`, default 120 s), a network error, a 5xx or an unparseable body, the row becomes `unknown` with `settlementAttempted=false` (`app.ts:315-321`). After `validBefore` the reconciler marks it `failed`: "nothing was charged" (`reconcile.ts:122,128`). OpenRouter still bills the relay for the generation; non-streaming requests are not cancelled upstream when the client disconnects. The PoC confirmed 0 settlements after an upstream timeout.
- **(b) Many verifications against one source of funds.** The relay keeps no record of authorization nonces or of each payer's outstanding authorized amount. An attacker can send N concurrent requests with different `Idempotency-Key`s that carry either:
  - the **same** signed authorization (PoC: 6 upstream calls, 1 settlement), or
  - N **distinct** authorizations against a balance that covers only one.

  Every request passes facilitator `verify` because nothing has settled yet, so each makes an upstream call. Only the first settlement succeeds; the rest are "settlement_failed … nothing was charged". A real facilitator probably rejects *sequential* reuse of a nonce once it has settled; concurrent reuse is the realistic window, and upstream calls take seconds.

**Exploit scenario.** The attacker picks `openai/gpt-5-mini` with `max_tokens: 128000` (quote ≈ $0.28, so they need only that balance to pass verify), which reliably exceeds the 120 s upstream timeout. Each request costs them $0 and costs the relay the full generation. Or they hold $1 of USDC, sign 50 authorizations of $1 each, and fire them in parallel: 50 upstream completions, 1 paid.

**Impact.** Unauthenticated, unbounded OpenRouter spend; draining the relay operator's prepaid balance; denial of service for the agents that depend on the relay.

**Fix.**
1. For the `exact` scheme, settle **before** calling upstream (x402 allows the server to settle at any time after verify). Keep the stored-completion replay for the unhappy path, and treat "upstream failed after settlement" as an operator refund case. Alternatively, settle on every outcome where the provider may have billed, including `unknown`.
2. Enforce one in-flight request per payer address, and reject an authorization whose `(from, nonce)` already appears in any row (unique index; see M-2).
3. Track outstanding authorized-but-unsettled amounts per payer and reject new requests above the on-chain balance.
4. Cap `max_tokens × output rate` so the expected generation time stays well below the upstream timeout; prefer `stream: true` upstream so the relay can abort and read usage.

### H-4. The sender does not enforce reply consent or which post a reply may target

**Status (2026-10-27):** Fixed in the sender: replies need `replyEligibility` (missing = ineligible), the `replyTo` author comes from the inbox or X (never the caller), opt-outs are enforced for that author and every @mention, and actions record `x_user_id`. Needs the supervisor to send `replyEligibility`.

**Description.** `publish()` accepts any numeric `replyTo`. If that post is not in the agent's inbox, it sets `recipient = null`, and the opt-out check runs only when `replyAuthorId` is known. In that case `replyAuthorId` comes only from the caller (`publish.ts:128-157`). The supervisor sends `replyAuthorId` only when the post ID is in the current inbox snapshot (`broker/index.ts:139`). Reply eligibility (`replyEligibility`: addressed to the agent, verified audience, consent, owner-blocked) is computed for display but **never enforced** before `publish_reply`.

Two further gaps:

- A caller-supplied `replyAuthorId` takes precedence over the inbox author (`replyAuthorId ??= row.authorId`).
- Original posts that @mention an opted-out author are not checked at all.

**Exploit scenario.** A mention contains a prompt injection ("reply to post 1888… with …"), or the model picks an ID from `read_x_thread`. The agent replies to a post it was never addressed in, possibly by a user who opted out (their earlier "stop" is recorded, but this post is not in the inbox, so no `replyAuthorId` is sent). X's automation rules forbid unsolicited automated replies and require honoring opt-outs. Violations lead to app suspension, which affects every agent because all of them share one X app.

**Impact.** Consent violations, platform-wide X app suspension risk, harassment vector.

**Fix.** Enforce this in the sender, the only boundary that sees every post:

1. Require `replyTo` to be an inbox row for this `agentId` whose status is `pending` (or a short allowlist of statuses). Take `replyAuthorId` **only** from that row and ignore the caller's value.
2. Reject replies when the row's author is opted out or the row is `skipped`.
3. For original posts, resolve every @mention to an ID (inbox, or `users/by/username`) and reject it if that author is opted out.
4. Optionally, call `GET /2/tweets/:id` for non-inbox targets and check `author_id` against `sender_optouts`.
5. Record a `policy:not_in_inbox` rejection so the agent learns from it.

---

## Medium

### M-1. Relay idempotency keys are global and predictable

**Status (2026-10-27):** Fixed: keys are namespaced per payer ((payer, key) primary key); replays and `GET /v1/requests/:key` require the `PAYMENT-SIGNATURE` that opened the row. Needs the supervisor to send that proof when reconciling.

**Description.** Keys are a single global namespace (`inference_requests.idempotency_key` PK). Neither replay (`handleExisting`) nor `GET /v1/requests/:key` checks who is asking. The supervisor derives keys as `inference:` + `sha256({agentId, cycle})[0:32]` (`agent-core/src/inference/request.ts:89-91`), where `agentId` is the public sequential ERC-8004 ID and `cycle` is a small counter. Anyone can compute every agent's next keys.

**Exploit scenarios.**

- **Squatting.** For each agent, the attacker claims the next k keys with a minimal paid request ($0.001 floor, `minQuoteMicroUsdc`). The supervisor's real request gets `409 idempotency_key_conflict` and the cycle fails; repeat per cycle to silence all agents for cents.
- **Metadata disclosure.** `GET /v1/requests/<predicted key>` returns status, model, payer (the agent kernel), the EIP-3009 authorization fields, amounts and usage, with no authentication. Each GET on an `unknown` row also triggers an RPC `authorizationState` read (amplification).
- **Free replay.** Anyone who presents a key plus the identical normalized body gets the stored completion without paying (PoC: HTTP 200 with no payment header). The body is effectively a secret today, but if it is guessable (short prompts, leaked logs) completions leak and are served for free.

On "can payer A replay payer B's key to read B's completion?": yes, provided A knows B's exact request body. No payer binding exists.

**Fix.**
1. Scope keys per payer: store `payer` and make the unique key `(payer, idempotency_key)`. On replay, require a payment payload or a signed request from the same payer. A cheap option: `X-Payer` plus an EIP-191 signature over `key|requestHash|ts`.
2. Make supervisor keys unguessable: HMAC(`agent secret`, agentId‖cycle) instead of a plain hash.
3. Authenticate `GET /v1/requests/:key` the same way, and remove `authorization` and `payer` from the public view.
4. Rate-limit reconciliation RPC reads per key.

### M-2. Payment authorization is not unique per row, and the reconciler misattributes a used nonce

**Status (2026-10-27):** Fixed: unique (payer, payment_nonce); a reused authorization gets `409 payment_authorization_reused`, so a used nonce can only belong to its own row.

**Description.** Rows store `payment.authorization.{from, nonce}`, but nothing stops two rows from carrying the same authorization (H-3b). For an `unknown` row, the reconciler reads `authorizationState(from, nonce)`. If it is `true` and the row holds a completion, it marks the row `succeeded` / `reconciled_onchain_paid` (`reconcile.ts:95-108`). That nonce may have been consumed by a *different* row's settlement.

**Exploit scenario.** The attacker sends request A (key k1) and request B (key k2) concurrently with one authorization. A settles. B's settlement returns an ambiguous error (timeout, "pending", or any facilitator message matching `/unknown|pending|timeout/`), so B goes `unknown`. Later the reconciler sees the nonce used and promotes B to `succeeded`; replaying k2 returns B's completion. Two completions for one payment.

**Fix.** Add a unique index on `(payment->>'payer', payment->'authorization'->>'nonce')` (or explicit columns), reject reuse at claim time, and in the reconciler also verify that the settlement transaction (`payment.transaction`) or a `Transfer`/`AuthorizationUsed` log belongs to this row.

### M-3. SIWE domain binding trusts `X-Forwarded-Host`

**Status (2026-10-27):** Fixed: SIWE URI/domain and the admin CSRF origin come from `NEXT_PUBLIC_SITE_URL`; nonces are recorded server-side and single use; logout revokes the session id (in-process store, single instance).

**Description.** `requestHost()` returns `x-forwarded-host ?? host`, and the SIWE `domain` and `uri` host must equal it. The admin POST CSRF check (`sameOrigin`) uses the same header. Whether this can be exploited depends on the edge. Vercel overwrites `X-Forwarded-Host`; a self-hosted `next start`, or a proxy that passes the client's value through, does not.

**Exploit scenario (SIWE relay/phishing).**

1. The attacker requests a nonce from `bootr.fun/api/siwe/nonce` and keeps the signed nonce cookie.
2. They host a fake console at `bootr-console.xyz` that asks the admin to sign a SIWE message with `domain: bootr-console.xyz` and the attacker's nonce. The wallet shows no warning because the domain matches the phishing origin.
3. The attacker posts the message and signature to `bootr.fun/api/siwe/verify` with their nonce cookie and `X-Forwarded-Host: bootr-console.xyz`.
4. The domain check passes and the attacker receives an 8-hour admin session.

**Impact.** Admin session theft, and through it write access to the platform config.

**Fix.** Compare against a configured canonical origin (`NEXT_PUBLIC_SITE_URL` or a server-only `SITE_ORIGIN`): `msg.domain === new URL(SITE_ORIGIN).host`, and `msg.uri` must start with `SITE_ORIGIN`. Use the same constant in `sameOrigin()`. Never derive security decisions from `X-Forwarded-*` unless the proxy is explicitly trusted.

### M-4. `/oauth/start` authorization model

**Status (2026-10-27):** Partly fixed: drafts are bound to the registering browser (`POST /api/x/draft` cookie), `reconnect` is signed, and the sender binds the flow to the browser. The start signature is still a 5-minute bearer and drafts are not tied to a SIWE creator.

**Description.**

- The start signature `HMAC(key, "oauth-start\n"+agentId+"\n"+state+"\n"+ts)` is a bearer credential in a URL. It is valid for ±5 minutes, can be used any number of times, and each use mints a fresh authorize URL for that `agentId`. That URL is the input to H-2 scenario 2.
- The signature does not encode *who* may bind the agent. Whatever signs it (no web route does yet) must check that the caller is the agent's on-chain creator.
- The web app binds the X account to a client-generated `draftId` UUID (`XConnect`, `LaunchForm`), but the supervisor calls the sender with the on-chain ERC-8004 `agentId` (`supervisor/src/onboarding.ts:107`). The two never meet, so a later "re-key" step is needed, and it must be authenticated.
- `XConnect` currently calls `/oauth/start` without `ts`/`sig` (always 401) and polls a non-existent `/oauth/status`.

**Exploit scenario.** If a signing route is added as "sign whatever `agentId` the browser asks for" (the path of least resistance given the current client), any visitor can mint start URLs for any agent and, through H-2, re-bind it.

**Fix.** Add a server route, e.g. `POST /api/x/connect`, that:

- requires a SIWE session (or a fresh EIP-712 signature) from the agent's creator wallet;
- checks on-chain or in the indexer that `creator == session.address` for that `agentId`/kernel;
- signs with the narrow `SENDER_OAUTH_START_KEY` (H-1);
- puts the creator address in the signed string and in the state.

Make the start signature single-use (store the `ts`/`state` pair) with a ~60 s lifetime. Bind pre-launch drafts with a short-lived server-side record keyed by `draftId` and creator address, and move them to the on-chain `agentId` only when the `AgentLaunched` event shows the same creator and `salt == keccak256(draftId)`.

### M-5. The input-token estimate can be gamed

**Status (2026-10-27):** Fixed: o200k_base token count (`gpt-tokenizer`) with a UTF-8 bytes / 2 floor. Per-tier context limits and charging shortfalls remain open.

**Description.** `estimateInputTokens` assumes 3 UTF-8 bytes per token. Byte-fallback tokenizers (Llama/DeepSeek SentencePiece-style) emit roughly one token per byte for rare Unicode (CJK extension blocks, symbols, emoji sequences), and JSON escaping adds more. Under `exact`, the relay always charges the quote. Under `upto`, the charge is capped at the quote (`actualChargeMicroUsdc` clamps). So under-estimated input is paid by the relay. The context check also uses the estimate, so real prompts can exceed `contextLength` and cross into a provider's higher price tier (Gemini 2.5 Pro above 200k).

**Exploit scenario.** Prompts of 4-byte rare code points on `meta-llama/llama-3.3-70b-instruct` are billed upstream at about 4 tokens per code point while the quote counts 1.33. With a 10% margin, each request loses money.

**Fix.**
- Use a per-model tokenizer, or a conservative 1 byte = 1 token for non-ASCII.
- Under `exact`, charge `max(quote, actual)` by refusing settlement shortfalls via `upto`, or reject requests when actual `prompt_tokens` exceed the estimate by more than x% (and keep the payment).
- Set `contextLength` per price tier.

### M-6. No body-size limits or rate limits on public endpoints

**Status (2026-10-27):** Partly fixed: body limits (relay 1 MB, sender `/internal` 256 KB and `/oauth` 8 KB, admin POST 64 KB) and HMAC header/timestamp pre-check before the body is read. No rate limits, zod collection caps or verify-failure cache; indexer not in scope.

**Status (2026-11-08):** rate limits on the web's draft and nonce routes and a daily X read budget per agent in the sender ([`fixes-2026-11-08.md`](./fixes-2026-11-08.md) items 5 and 7). The relay and the indexer still have no per-client rate limit.

**Description.** Neither Hono service sets a body limit:

- the relay parses `c.req.json()` with unbounded `messages`/`tools`;
- `hmacAuth` and the indexer's social route read the entire body **before** checking the signature;
- `/oauth/start`, `/oauth/callback`, `/v1/requests/:key`, `/stream` (SSE), and the indexer `/treasury` multicall have no rate limiting;
- an invalid `PAYMENT-SIGNATURE` costs a facilitator `verify` call per request, which consumes the relay's CDP quota;
- the relay's zod version is flagged for memory exhaustion on oversized collections (GHSA-mrhx-c7xc-m3w5).

**Impact.** Unauthenticated memory and CPU exhaustion; facilitator quota exhaustion that blocks legitimate payments; RPC cost.

**Fix.**
- Add `hono/body-limit` (e.g. 1 MB for the relay, 64 KB for sender/indexer internal routes).
- Parse and reject a malformed `Authorization` header before reading the body.
- Add per-IP and per-payer rate limits (in-process token bucket, or at the edge).
- Cap `messages.length`, string lengths and `tools.length` in zod.
- Cache `verify` failures per payload hash.

### M-7. Admin console controls are not enforced

**Status (2026-10-27):** Partly fixed: `launchesPaused` (notice + disabled Launch) and `allowedModels` (model list filter) are enforced in the launch form via `GET /api/platform`. `xQuotas`/`postIntervalMinutes` and relay/supervisor model enforcement are not wired; the config is still a file.

**Description.** Only `graduationThresholdUsd` is consumed (by the indexer). Nothing reads `launchesPaused` (the LaunchForm does not check it), `allowedModels` (the relay uses its own price table; agent-core has its own list), `xQuotas` (never pushed to sender `/internal/quota`), or `postIntervalMinutes`. The store is `apps/web/data/admin-config.json` in the server's working directory, so with multiple web replicas or on serverless, writes are lost or diverge.

**Impact.** False assurance during an incident: an admin "pauses launches" or "removes a model" and nothing changes.

**Fix.** Either wire each control (LaunchForm and an on-chain/launcher pause; relay and supervisor reading `allowedModels`; supervisor syncing `xQuotas` to the sender quota API) or remove it from the UI. Move the config to Postgres with an audit log (who, when, diff). Until then, label the controls "advisory" in the console.

---

## Low

### L-1. HMAC scheme hardening

**Status (2026-10-27):** Partly fixed: 32-char minimum for sender/web keys and a pre-check before reading bodies. No nonce cache or audience field (kept compatible with existing signers).

- **No nonce or replay cache.** A request captured on the wire (internal hops are not guaranteed to use TLS) can be replayed for 10 minutes (±5). Publish is idempotent, but these are not:
  - `/read/thread` (up to 8 paid X reads per replay) and `/read/account`;
  - an older `/internal/quota/:agentId` POST can be replayed to revert a newer one;
  - an older indexer social patch can revert `xHandle`/`status`.
- **No audience binding.** The signed string has no service name or host, and all services share one key (H-1), so a signature is valid at any service that exposes the same method and path.
- **Weak key-length checks.** Sender only warns when the key is under 32 chars (`min(1)`); the indexer has no minimum; web requires 16.

**Fix.** Sign `v1\n<audience>\n<ts>\n<nonce>\n<METHOD>\n<path>\n<sha256(body)>`, keep a 10-minute nonce cache in Postgres or memory (keyed per nonce, so byte-identical retries need a new nonce), require keys of at least 32 bytes at boot, and use TLS or a private network for all `/internal` traffic.

### L-2. Token encryption key handling and rotation

The ciphertext prefix is `v1.` with no key ID. Rotating `SENDER_ENCRYPTION_KEY` orphans every token (README admits this). There is:

- no revoke/unbind endpoint;
- no call to X's `POST /2/oauth2/revoke` when "Disconnect" is clicked (it only clears local UI state);
- no deletion of tokens for dead agents.

The `inflight` refresh lock is per process. Two sender replicas refreshing at once make X rotate the refresh token under one of them; the loser gets `invalid_grant` and **marks the account revoked** (`accounts.ts:97-105`).

**Fix.**
- Use format `v2.<kid>.<payload>` with a keyring (`SENDER_ENCRYPTION_KEYS=kid:hex,...`), decrypt by kid, and re-encrypt lazily on refresh.
- Add `/internal/account/:agentId/revoke`, which calls X revoke and deletes the row.
- Serialize refresh with `pg_advisory_xact_lock(hashtext('sender_refresh:'||agentId))` and re-read the row inside the lock.

### L-3. SIWE nonce, session lifetime and RPC dependence

**Status (2026-10-27):** Fixed: server-side single-use nonces and logout revocation. The RPC dependence for ERC-1271 checks remains.

- The nonce is an HMAC-signed cookie, not a server-side record. Until it expires (10 min), replaying the same cookie + message + signature issues a new session; clearing the cookie on success does not invalidate a copy.
- The admin session is a stateless 8-hour token with no server-side revocation. Logout only clears the cookie, and the only way to revoke all sessions is to remove the address or rotate `SESSION_SECRET`.
- `verifyMessage` performs an `eth_call` against `BASE_RPC_URL`, or viem's public default when unset. A malicious or compromised RPC could affect ERC-1271/6492 verification.

**Fix.**
- Store nonces in a table and delete them on use.
- Add a server-side session ID with revocation, and a shorter TTL (1–2 h) with re-auth for writes.
- Verify EOA signatures locally (`recoverMessageAddress`) and use a pinned, trusted RPC only for contract wallets.

### L-4. Posting identity is not recorded

**Status (2026-10-27):** Fixed in part: `sender_actions.x_user_id` is recorded and reconciliation skips actions whose agent is now bound to another account. No unique index on `sender_accounts.x_user_id`.

`sender_actions` does not store the `xUserId` an action was posted from. After a re-bind, `readPublishedAction` reads the **new** account's timeline. An attacker who controls the new account could post matching text in the window and settle a held action as `sent` with their post ID. Nothing prevents one `xUserId` from being bound to many agents.

**Fix.** Store `x_user_id` on each action and reconcile against that account's ID (skip if it no longer matches). Add a unique index on `sender_accounts.x_user_id`, or require explicit confirmation for shared accounts.

### L-5. Indexer exposure

**Status (2026-10-27):** Not in this change (indexer owner): `/sql/*` is still public.
**Status (2026-11-08):** `/sql/*` removed (`apps/indexer/src/api/index.ts`); no Bootr client used it. Ponder's own `/metrics` and `/status` stay public: Ponder registers them in front of the app, so they cannot be guarded from the API code (see `docs/security/fixes-2026-11-08.md`).

- `app.use('/sql/*', client(...))` exposes Ponder's read-only SQL-over-HTTP, including up to 1000 live queries. Neither the web app nor the supervisor uses it. Remove it, or put it behind auth.
- With `NEXT_PUBLIC_WEB_ORIGIN` empty, CORS is `*` and `authorization` is an allowed header. There is no ambient credential, so impact is low, but production should fail closed.
- Social patch replay: see L-1.

### L-6. Dependency advisories (`pnpm audit --prod`, 2026-10-27)

**Status (2026-10-27):** sender `drizzle-orm` bumped to 0.45.2. The zod advisory needs zod 4 (not a trivial bump); the relay's 1 MB body limit bounds it.

- **sender: `drizzle-orm` 0.41.0** — GHSA-gpj5-g38j-94v9, SQL injection via improperly escaped identifiers. The sender uses only static identifiers, so this is not reachable today. Upgrade to ≥0.45.2.
- **inference: zod** — GHSA-mrhx-c7xc-m3w5, memory exhaustion validating oversized constrained collections. Relevant together with M-6. Upgrade to a patched release.
- **indexer, via `ponder@0.18.2`:**
  - `@graphql-tools/utils` prototype pollution (GHSA-7mx3-vvmw-hjmv, GHSA-c4qx-w738-7hr3) on the public GraphQL endpoint;
  - `@hono/node-server` <1.19.15 serve-static bypasses (not used for static files here);
  - vite 8.3.x (dev server only).

  Bump Ponder, or add pnpm `overrides`.

### L-7. Web hardening

**Status (2026-10-27):** Partly fixed: CSP, `X-Frame-Options: DENY`, `Referrer-Policy`, `nosniff`, `Permissions-Policy` and production HSTS via `proxy.ts`. robots.txt, `__Host-` cookies and the `.gitignore` entry are open.

- No `headers()` in `next.config.ts`. Add `Content-Security-Policy` (at least `frame-ancestors 'none'` for `/console-*`), `Strict-Transport-Security`, `X-Content-Type-Options` and `Referrer-Policy`.
- `robots.txt` disallows `/console-*`, which tells scanners the prefix (the slug stays secret). Prefer only `noindex` headers, which are already present.
- Rename the cookies to `__Host-bootr_admin` / `__Host-bootr_siwe_nonce` (the nonce cookie needs `path=/` for the `__Host-` prefix).
- Add `apps/web/data/` to `.gitignore`.

### L-8. Agent card squatting and indexer-trusted fuel destination

- `findByAgentUri` returns the **earliest** launch with a given `agentURI`, and `Launcher.launch` accepts any `agentURI`. Someone who learns a `draftId` before the launch lands (it appears in the OAuth `state` and the popup URL) can launch first with the same URI and own the card. Fix: derive the card from `salt == keccak256(draftId)` plus the creator, or reject duplicate URIs on-chain.
- `FuelForm` sends USDC to `kernel` taken from the indexer API. A compromised or spoofed indexer would redirect user funds. Fix: before `transfer`, read the kernel for the token from the launcher/guardian contract through wagmi and compare.
- On-chain metadata `socialMediaUrls` is whatever the creator submits. The indexer correctly ignores it, but third-party explorers will show unverified handles.

---

## Info

- **I-1.** Integration gaps:
  - `GET {sender}/oauth/status` and `GET {sender}/public/posts/:kernel` do not exist. Whatever is added must not expose tokens or inbox data, and needs CORS limited to the web origin and rate limits.
  - `AgentPanel` renders `p.url` as `href` without checking the scheme. React 19 blocks `javascript:` URLs, but validate `https://x.com/...` anyway.
- **I-2.** The relay returns the upstream error body (`upstream: upstream.body`) and zod `issues`; the sender returns zod `issues`. Nothing secret appears, but provider metadata can leak. Consider returning a provider error code only.
- **I-3.** Receipts are HMAC-signed with the shared service key, so any key holder can forge one. If receipts are ever shown to third parties, sign with an asymmetric key.
- **I-4.** `.env.example` is a single root file listing deployer, admin, treasury and session-signer private keys alongside the web, sender and relay secrets. If every service loads it, each process holds every secret. Ship one env file per service and keep private keys out of web/indexer/relay entirely. There are no Docker/compose/deploy manifests, so the assumptions below (TLS, proxy headers, single instance) are not encoded anywhere.
- **I-5.** `fetchAdminConfig` signs the request, but the response is trusted as-is; integrity rests on `ADMIN_CONFIG_URL` being HTTPS. Reject `http:` URLs outside localhost.

---

## Verified sound

**Sender (X boundary)**

- **Token storage.** AES-256-GCM with a random 96-bit IV and a 128-bit tag. AAD binds ciphertext to its row and column (`access:<agentId>`, `refresh:<agentId>`; PKCE uses `pkce:<agentId>:<nonce>`). Tokens are decrypted only in the sender and never returned by any endpoint (`/internal/account` returns handle, ID, scopes, expiry). The logger redacts secret-like keys, and no call site logs tokens, codes or verifiers.
- **HMAC verification.** Strict header regex, ±300 s skew, path including query, SHA-256 of the exact raw body, constant-time compare. The indexer implementation is byte-compatible and fails closed when no key is set.
- **OAuth basics.** PKCE S256 with a 48-byte verifier, encrypted inside a tamper-proof (HMAC) state with a 15-minute TTL. `redirect_uri` and the post-callback return URL come from config, so there is no open redirect. The reflected `error` value is truncated and URL-encoded. Confidential client with Basic auth. Refresh is serialized in-process, and `invalid_grant` marks the account revoked.
- **Publish idempotency.**
  - The claim row is committed before X is contacted, under a per-agent advisory lock that also enforces the rolling 24 h quota (pending, held and sent all count).
  - A body-hash conflict and a cross-agent `actionId` reuse return 409.
  - Definite 4xx responses are final; timeout/5xx/malformed 2xx become `held` and are never resent.
  - The 401 retry is recorded (`attempts: 2`) before the second send.
  - Stale `pending` rows are promoted to `held`.
  - Readback requires a unique match on author, time window, reply parent, recipient ID and expanded text, and excludes posts already bound to another action (unique index on `provider_post_id`).
- **Policy gate.** Every publish runs agent-core `validatePost` (which runs `outgoingActionRisk`) before anything is recorded or sent. Rejections are recorded deterministically. The policy-parity test passes.
- **Consent ledger.** Newer post wins (numeric ID compare), the agent's own posts are never treated as consent commands, already-observed posts never re-apply consent, and opted-out authors are filtered out of the eligible inbox.

**Inference relay**

- **Quote handling.** `X-Max-Quote-Micro-USDC` is required. When the quote exceeds it, the relay returns a 402 **without** `PAYMENT-REQUIRED`, so a client cannot pay it accidentally.
- **Payment checks.** The verified requirement amount must equal the quote, and the route throws if x402 ever says no payment is required. payTo, network and asset are enforced by `@x402/core` requirement matching. Losing a race for a key never settles.
- **Persistence order.** The completion and `settlementAttempted` are persisted before settling. Ambiguous settlement leaves the row `unknown`, and the completion is released only after settlement or reconciliation.
- **Request schema.** Unknown fields are stripped (no `provider` routing or extra-cost params reach OpenRouter), streaming is refused, content is text only, and `max_tokens` is required and capped per model.
- **No signature exposure.** The EIP-3009 signature is never stored or exposed; only the authorization fields are.
- **Payer client.** Exact scheme only, amount ≤ min(header, cap), optional payTo allowlist, network allowlist, one signature per call.

**Web**

- **Console gate.** The console returns 404 without both the correct slug and a valid admin session (the proxy checks, and the page checks again). The proxy overwrites any client-supplied slug header. Responses carry `X-Robots-Tag: noindex` and `no-store`, and the console is excluded from the sitemap.
- **Admin writes.** Only an admin-session holder can write the config, and the request must also pass an Origin check plus a SameSite=Strict cookie. Input is validated (ranges, model ID regex, https-only swap link). The admin allowlist is re-checked on every request, so removing an address revokes access at once.
- **Cookies.** HttpOnly, SameSite=Strict, Secure in production. The nonce cookie is scoped to `/api/siwe`. A fresh token is minted at sign-in (no session fixation).
- **SIWE checks.** Nonce, chain ID (8453/84532), issuedAt freshness, expiry/notBefore and allowlist are all checked. ERC-1271/6492 are supported. The weakness is the domain source (M-3).
- **Agent card.** UUID v4 validation, JSON only, `no-store` on indexer failure, X endpoint built only from the indexer's social store (never from creator-supplied metadata).
- **Builder-code `dataSuffix`.** ERC-8021 bytes appended after ABI-encoded calldata are ignored by the launcher and by USDC `transfer` decoding. The value comes from build-time env, not user input.
- **No SSRF.** No web or relay route fetches a user-supplied URL. The relay calls a fixed OpenRouter base, the web calls the configured indexer, and SIWE calls a configured RPC.

**Indexer**

- **Social route.** HMAC covers the path, so a signature for one kernel cannot be replayed for another. Patch validation is strict (handle regex, integer ranges, enum), unknown kernels return 404, and SQL is parameterized.
- **Search.** The search route escapes LIKE wildcards. GraphQL has depth, token and alias limits (Ponder defaults).

## Open questions

1. Who will sign `/oauth/start`, and how will a pre-launch `draftId` binding move to the on-chain `agentId`? This decides how M-4/H-2 should be fixed.
2. Deployment topology:
   - Are sender `/internal/*`, supervisor `/internal/*` and indexer `/internal/*` reachable from the internet?
   - Is inter-service traffic TLS?
   - Which proxy sits in front of the web app, and does it overwrite `X-Forwarded-Host`?
   - How many replicas run of sender and web (refresh lock, file stores)?
3. Which facilitator is used in production, and does its `verify` check `authorizationState` and simulate `transferWithAuthorization`? This sets how wide the H-3b/M-2 window is.
4. Is `INFERENCE_RPC_URL` set in production? Without it, `unknown` rows whose settlement was attempted never resolve.
5. Is the relay meant for non-Bootr payers? If not, restrict payers to registered agent kernels (indexer lookup), which removes most of the H-3/M-1 attack surface.
6. Confirm OpenRouter billing for non-streaming requests the client aborts. H-3a assumes the relay is billed.
7. Are the console's `xQuotas`/`allowedModels`/`launchesPaused` meant to drive the sender quota API, the relay and the launch form (M-7)?
8. Should opt-outs apply platform-wide (one "stop" silences every Bootr agent toward that user) rather than per agent, and should DMs or blocks count as opt-out?
9. The supervisor's `/internal/agents/:id/tick` and `session/*` are outside this review's scope but sit behind the shared key (H-1). Who are their intended callers?
