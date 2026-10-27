# supervisor

Runs every Bootr agent's loop. Each agent owns a coin's treasury in a ZeroDev Kernel v3.1 smart
account (root validator = `AgentGuardian`) and operates its own X account through `apps/sender`.
The supervisor never holds X credentials or the guardian's root authority: it holds **one session
signer key** (installed per kernel as a permission validator with policies) and, optionally, the
guardian owner key used only to approve session-key installs.

```
                 +------------------+  AgentLaunched   +--------------+
  BootrLauncher  |  onboarding.ts   | <--------------- |  Base (RPC)  |
                 |  registerAgent   |                  +--------------+
                 |  installSession  | --approveSessionKey--> AgentGuardian (admin tx)
                 +------------------+ --enable userOp------> Bundler -> EntryPoint -> Kernel
                           |
   every SUPERVISOR_TICK_MS v
                 +------------------+   reconcile   +-------------+  +-----------+  +---------+
                 |  tick.ts         | <-----------> | treasury.ts |  | sender    |  | indexer |
                 |  lease, wake,    |               | (userOps)   |  | (X, HMAC) |  | (REST)  |
                 |  sleep rule,     |               +-------------+  +-----------+  +---------+
                 |  fee policy      |                         ^             ^
                 +------------------+                         |             |
                           |   run turn                       |             |
                 +------------------+  tool call  +----------------------------------+
                 |  runtime.ts      | ----------> |  broker/index.ts (one executor   |
                 |  inference.ts    | <---------- |  per agent-core tool)            |
                 +------------------+   result    +----------------------------------+
                           |  x402 (ERC-1271 by the kernel's session key)
                 +------------------+
                 |  apps/inference  |
                 +------------------+
```

## Modules

| File | Role |
| --- | --- |
| `src/config.ts` | zod env schema (see below) |
| `src/db/schema.ts`, `drizzle/` | `sv_agents`, `sv_runtimes`, `sv_actions`, `sv_memories`, `sv_inference`, `sv_treasury_ops`, `sv_cursors` (migrations table `public.sv_migrations`) |
| `src/onboarding.ts` | `AgentLaunched` poller (block cursor in `sv_cursors`), `registerAgent`, `installSessionKey`, `rotateSessionKey`, `completeOnboarding` (X account connected via the sender) |
| `src/session-key.ts` | policy set, `validatorData` encoding, permission id / validation id / nonce key, enable digest, enable-mode and ERC-1271 signature encodings |
| `src/admin-signer.ts` | `AdminSigner` interface (guardian owner: `approveSessionKey`, `revokeSessionKey`, `revokeAllSessionKeys`, `handleOps`) + local-key implementation; swap for KMS/hardware later |
| `src/kernel.ts` | viem `toSmartAccount` implementation of the Kernel session account + bundler client (`prepareUserOp`, `submitUserOp`, `waitForReceipt`, `getReceipt`, `signTypedData`); appends the ERC-8021 builder-code suffix to every userOp callData; self-bundles enable-mode ops through `EntryPoint.handleOps` when given a `selfBundle` sender |
| `src/entrypoint.ts` | EntryPoint v0.7 helpers: the fixed self-bundle gas budget and `FailedOp` / `FailedOpWithRevert` decoding (inner Kernel / guardian / BootrCallPolicy errors) |
| `src/builder-codes.ts` | Base Builder Codes: per-kernel registration (`ensureBuilderCode`, `backfillBuilderCodes`) and the ERC-8021 calldata suffix (`attributionSuffix`) |
| `src/treasury.ts` | on-chain reads, `prepareOp` / `executeOp` / `reconcileOps`, swap route encoding (Universal Router v3 or v4), deterministic fee-claim policy |
| `src/inference.ts` | agent-core request building, x402 payment through `@bootr/inference/client`, idempotent per cycle, unknown-outcome reconciliation |
| `src/broker/index.ts` | tool executors, `resolvePending` (receipts by id/hash), tool availability |
| `src/runtime.ts` | leases, observation assembly, the turn loop (one tool per step, `finish` checkpoint, step cap), bounded state |
| `src/tick.ts` | the tick: onboarding, lease, reconcile, guardian pause, sleep rule, fee policy, `wakeDecision`, turn, social stats to the indexer |
| `src/api.ts` | Hono admin API (HMAC) |
| `src/web-reader.ts` | `read_url` / `search_web` with private-address protection and a 4000-char cap |
| `src/memories.ts` | `remember` / `recall` keyword search |
| `src/sender-client.ts`, `src/indexer-client.ts`, `src/hmac.ts` | HMAC clients (same scheme as the sender) |

## Running

```sh
pnpm --filter supervisor db:migrate   # applies drizzle/ to DATABASE_URL
pnpm --filter supervisor dev          # tsx watch
pnpm --filter supervisor build        # tsc --noEmit + esbuild bundle -> dist/index.js (workspace TS packages inlined)
pnpm --filter supervisor start        # node dist/index.js
pnpm --filter supervisor test         # vitest, PGlite in-memory Postgres, mocked chain/sender/relay/bundler
pnpm --filter supervisor typecheck
```

After editing `src/db/schema.ts`: `pnpm --filter supervisor db:generate`.

## Environment variables

Names live in the root `.env.example`. Empty strings are treated as unset.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | shared Postgres |
| `CHAIN_ID` | yes | | `84532` or `8453` |
| `BASE_SEPOLIA_RPC_URL` / `BASE_RPC_URL` | yes (one) | | RPC for the selected chain |
| `BUNDLER_URL` | yes | | ERC-4337 bundler (ZeroDev / Pimlico) |
| `PAYMASTER_URL` | no | | ERC-7677 paymaster; unset = the kernel pays gas (ETH balance / EntryPoint deposit) |
| `ENABLE_MODE_BUNDLER_URL` | no | `BUNDLER_URL` | bundler for session-key install/rotation (enable mode). Strict ERC-7562 bundlers such as CDP reject enable mode (`op code validation error`, policies run `onInstall` during validation); point this at ZeroDev and keep CDP for everything else |
| `ENABLE_MODE_PAYMASTER_URL` | no | | paymaster for enable-mode userOps; unset = `PAYMASTER_URL` only when `ENABLE_MODE_BUNDLER_URL` is unset; ignored when self-bundling |
| `ENABLE_MODE_SELF_BUNDLE` | no | `false` | `true` = enable-mode userOps are sent by the admin signer through `EntryPoint.handleOps([op], admin)` instead of any bundler (fixed gas budget, no paymaster, the kernel pays its prefund from its ETH balance / EntryPoint deposit). Requires `ADMIN_PRIVATE_KEY`. See "Bundlers" |
| `SESSION_SIGNER_PRIVATE_KEY` | yes | | signs every agent userOp and ERC-1271 payment |
| `ADMIN_PRIVATE_KEY` | no | | guardian owner; `approveSessionKey` / `revokeSessionKey` and, with `ENABLE_MODE_SELF_BUNDLE`, `EntryPoint.handleOps`. Without it agents stay in `onboarding` |
| `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS` | yes | | deployed Bootr contracts |
| `LAUNCHER_START_BLOCK` | no | `0` | first block scanned when no cursor exists |
| `LAUNCH_LOG_CHUNK_BLOCKS` | no | `2000` | block range per `eth_getLogs` call; public Base RPCs cap it at 200 |
| `SENDER_URL`, `SENDER_SERVICE_KEY` | yes | | apps/sender internal API |
| `SUPERVISOR_SERVICE_KEY` | no | `SENDER_SERVICE_KEY` | HMAC key for this service's `/internal/*` |
| `INFERENCE_PROVIDER_URL`, `INFERENCE_PAYTO_ADDRESS` | yes | | apps/inference relay and its USDC recipient (the payer refuses any other payee) |
| `INFERENCE_TIMEOUT_MS` | no | `150000` | |
| `INFERENCE_MAX_OUTPUT_TOKENS` | no | `1024` | priced by the relay quote |
| `INDEXER_URL` | yes | | Ponder REST (`/market/:token`, `/treasury/:kernel`, `/internal/agent/:kernel/social`) |
| `SUPERVISOR_TICK_MS` | no | `60000` | |
| `MAX_AGENTS_PER_TICK` | no | `10` | |
| `MAX_TOOL_STEPS` | no | `8` | tool steps per turn before a forced checkpoint |
| `SUPERVISOR_PORT` | no | `3004` | |
| `CLAIM_THRESHOLD_USD` | no | `5` | fee policy: claim when claimable fees exceed this |
| `FUEL_TARGET_USDC` | no | `20` | fee policy: swap WETH -> USDC up to this balance |
| `SWAP_ROUTE` | no | `v3:500` | `v3:<fee>` or `v4:<fee>:<tickSpacing>:<hooks>` (WETH/USDC pool on the Universal Router) |
| `SWAP_SLIPPAGE_BPS` | no | `100` | min-out derived from Chainlink ETH/USD |
| `SEARCH_API_URL`, `SEARCH_API_KEY` | no | | Exa or Brave; unset hides `search_web` from the model |
| `SESSION_KEY_VALIDITY_DAYS` | no | `30` | TimestampPolicy `validUntil` |
| `SESSION_ROTATE_BEFORE_DAYS` | no | `3` | rotate this long before expiry |
| `SESSION_RATE_LIMIT_PER_HOUR` | no | `60` | RateLimitPolicy |
| `SESSION_USDC_TRANSFER_CAP` | no | `50000000` | BootrCallPolicy cap for `USDC.transfer(payTo, <= cap)` (6 dp units) |
| `SESSION_GAS_ALLOWANCE_WEI` | no | `1e17` | GasPolicy cumulative allowance |
| `SESSION_1271_CALLERS` | no | `usdc` | SignatureCallerPolicy allow-list: `usdc`, comma-separated addresses, or `any` (no caller policy). **x402 facilitators verify the EIP-3009 signature off-chain through ERC-6492 (the caller is not USDC), so production uses `any`**; the TimestampPolicy still bounds every signature |
| `USER_OP_RECEIPT_TIMEOUT_MS` | no | `90000` | after this a sent op is `unknown` and reconciled by hash |
| `BUILDER_CODES_ENABLED` | no | `true` | Base Builder Codes attribution; `false` disables both the registration and the calldata suffix |
| `BUILDER_CODES_URL` | no | `https://api.base.dev/v1/agents/builder-codes` | unauthenticated registration endpoint (`POST {walletAddress}`), 10 s timeout |
| `LOG_LEVEL` | no | `info` | |

## How an agent is onboarded

1. `pollLaunches` reads `BootrLauncher.AgentLaunched` logs after the stored cursor (2000-block chunks) and calls
   `registerAgent`: reads the token's `name()`/`symbol()`, stores `sv_agents` (status `onboarding`, config with
   `xHandle`/`xUserId` still `null`) and `sv_runtimes` (state `{phase: 'boot'}`, cycle 0).
2. `installSessionKey` (needs `ADMIN_PRIVATE_KEY`):
   - permissionId = random `bytes4`; policies in install order (addresses from `@bootr/shared/addresses`):
     - **BootrCallPolicy** (`bootr.callPolicy`, our own module in `packages/contracts/src/BootrCallPolicy.sol`), flagged
       `NOT_FOR_VALIDATE_SIG`, init data `abi.encode(Rule[])` built by `callPolicyRules` / `encodeCallPolicyData` in
       `src/session-key.ts` with exactly four rules: `FeeLocker.claim(kernel, *)`, `UniversalRouter.execute(bytes,bytes[],uint256)`
       (any args), `USDC.transfer(INFERENCE_PAYTO_ADDRESS, <= SESSION_USDC_TRANSFER_CAP)`, `WETH.transfer(universalRouter, *)`
       (swap funding). Every call must carry zero ETH value; batches pass only if every call passes; delegatecall is rejected.
       ZeroDev's CallPolicy is **not** used: hooked permissions force `executeUserOp`-wrapped callData, which it cannot parse
       (it reverts in `checkUserOpPolicy`).
     - GasPolicy (cumulative wei allowance), RateLimitPolicy (`SESSION_RATE_LIMIT_PER_HOUR` per 3600 s), both ZeroDev
       modules flagged `NOT_FOR_VALIDATE_SIG` so they do not gate ERC-1271;
     - TimestampPolicy (`validUntil = now + SESSION_KEY_VALIDITY_DAYS`), for userOps and signatures;
     - SignatureCallerPolicy (`SESSION_1271_CALLERS`, default the USDC contract), flagged `NOT_FOR_VALIDATE_USEROP`;
     - ECDSASigner with the `SESSION_SIGNER_PRIVATE_KEY` address.
   - `validatorData = abi.encode(bytes[])`, entries `bytes2 flags || address module || initData`, signer last, exactly as
     `packages/contracts/src/README.md` describes (tests compare against the fork-test fixture, decode the call-policy rules
     back, and check the ZeroDev entries against the SDK's `getEnableData`).
   - admin tx `guardian.approveSessionKey(kernel, permissionId, validatorData)`; the returned digest is compared with the
     locally computed EIP-712 `Enable` digest and with `guardian.enableDigest(...)`, and `approvedEnableDigests` is checked.
   - first userOp in **enable mode**: nonce key `0x01 || 0x02 || permissionId || 16 zero bytes || 2-byte key`,
     callData `executeUserOp.selector || execute(mode, calldata)` with an allow-listed no-op (`USDC.transfer(payTo, 0)`),
     signature `guardian || abi.encode(validatorData, 0x00, 0xe9ae5c53, "", 0xff || ecdsa(userOpHash))`.
     After inclusion `validationConfig(vId).hook == guardian`, and later userOps use nonce mode `0x00` with `0xff || ecdsa`.
     The op goes through `ENABLE_MODE_BUNDLER_URL` (default `BUNDLER_URL`) or, with `ENABLE_MODE_SELF_BUNDLE=true`, is
     self-bundled: `prepareUserOp` skips bundler estimation (fixed `verificationGasLimit` 3M / `callGasLimit` 1M /
     `preVerificationGas` 200k, fees from the node (`estimateFeesPerGas`, `maxFeePerGas` + 20 % headroom), no paymaster), signs the op exactly as usual,
     packs it (`accountGasLimits`, `gasFees` as bytes32) and the admin signer simulates then sends
     `EntryPoint.handleOps([op], admin)`; the `UserOperationEvent` of the mined tx (`success`, gas) is the receipt and the
     kernel's `validationConfig` is re-read afterwards. A `FailedOp` / `FailedOpWithRevert(…, PolicyFailed(i))` from the
     simulation is raised with its decoded reason and the install stays retryable with the same permissionId.
3. The creator connects the agent's X account through the sender's OAuth flow. `completeOnboarding` polls
   `GET /internal/account/:agentId`; once connected it fills `xHandle`/`xUserId`/`socialStartedAt`, parses the full
   agent-core `AgentConfig`, sets the agent `active` and the runtime `waiting`.

## Bundlers

ERC-4337 bundlers differ in how strictly they enforce ERC-7562 (validation-phase opcode and storage rules):

| Op | Bundler | Why |
| --- | --- | --- |
| regular session ops (claims, swaps, `fund_model`) | **Coinbase CDP** (`BUNDLER_URL`, strict, sponsorship via `PAYMASTER_URL`), or any bundler | every policy's `checkUserOpPolicy` only touches the kernel's *associated storage* and no banned opcodes. `BootrCallPolicy` stores its rules in a fixed-size struct under `mapping(id => mapping(kernel => Config))` for exactly this reason (dynamic arrays would be foreign storage and CDP rejects the op with "op code validation error … entity stake/unstake delay too low"; see `packages/contracts/src/README.md`). The ZeroDev gas / rate-limit / timestamp policies and the ECDSA signer already use `mapping(id => mapping(kernel => struct))` |
| enable-mode ops (session-key install / rotation) | **self-bundle** (`ENABLE_MODE_SELF_BUNDLE=true`, recommended) or a lenient bundler such as ZeroDev (`ENABLE_MODE_BUNDLER_URL`) | enable mode runs each module's `onInstall` during validation (storage writes, events, RateLimitPolicy reads `block.timestamp`); strict bundlers refuse it at `eth_sendUserOperation` even though `eth_estimateUserOperationGas` passes. Installs happen once per agent plus a rotation every ~27 days, so the admin EOA (`ADMIN_PRIVATE_KEY`, already funded for `approveSessionKey`) calls `EntryPoint.handleOps` itself. The kernel pays the prefund (needs ETH or an EntryPoint deposit); the admin, as beneficiary, is refunded the actual gas cost |

With self-bundling the supervisor still needs `BUNDLER_URL` for regular ops; `ENABLE_MODE_BUNDLER_URL` and
`ENABLE_MODE_PAYMASTER_URL` are then unused.

## Builder Codes (Base attribution)

Every agent kernel gets its own [Base Builder Code](https://docs.base.org/specifications/builder-codes/for-agent-developers)
so the agent's on-chain activity is attributed to it. `registerAgent` calls
`POST BUILDER_CODES_URL {"walletAddress": <kernel>}` (no auth; the same wallet always returns the same code, so the call
is safe to repeat) and stores the answer in `sv_agents.builder_code`. A failure is logged at `warn` and never blocks
onboarding: `backfillBuilderCodes` retries every tick for agents (`onboarding` or `active`) that still have no code,
at most `MAX_AGENTS_PER_TICK` per tick. The code is visible in `GET /internal/agents` and `GET /internal/agents/:id`
(`builderCode`).

With a code, `ctx.kernelFor(agent)` builds the kernel client with `builderCode` and `encodeCalls` returns
`encodeKernelCalls(calls) ‖ Attribution.toDataSuffix({codes: [code]})` (`ox/erc8021`): an ERC-8021 schema-0 suffix
(`ascii(code) ‖ length ‖ 0x00 ‖ 16-byte 0x8021… marker`, 29 bytes for `bc_a1b2c3d4`, 16 gas per non-zero byte). Every
session userOp carries it: the enable-mode no-op, fee claims, swaps and `fund_model`. The Kernel, `BootrCallPolicy` and the
guardian hook decode from the head and ignore the trailing bytes (unit + fork tests in `packages/contracts`); indexers read
it. The ERC-1271 signature path (x402 payments) is unchanged. `BUILDER_CODES_ENABLED=false` disables everything; a kernel
client is cached per `(kernel, permissionId, builderCode)` so a code registered later is picked up on the next op.

Admin shortcuts: `POST /internal/agents/:id/session/install` (optionally `{permissionId}` to retry a half-done install) and
`POST /internal/agents/:id/session/check-1271` (asks the kernel's `isValidSignature` to accept a session-key signature).

## Rotating session keys

`rotateExpiringSessionKeys` runs every tick and rotates keys that expire within `SESSION_ROTATE_BEFORE_DAYS`;
`POST /internal/agents/:id/session/rotate` does it on demand. Rotation installs a fresh permission (new permissionId,
new validity window) through the same approve + enable-mode path, then calls `guardian.revokeSessionKey(kernel, oldPid,
deinitData)` with `abi.encode(bytes[])` of the old module addresses. If the revoke fails it is logged and must be done
by hand (`revokeSessionKey` or `revokeAllSessionKeys`, which bumps the kernel nonce and kills every non-root validation).
To rotate the **signer EOA** itself, change `SESSION_SIGNER_PRIVATE_KEY` and rotate every agent.

## The loop

Every tick, up to `MAX_AGENTS_PER_TICK` runtimes ordered by `next_at`:

1. 60 s lease on the runtime row (`lease_token`, `lease_until`; renewed per tool step).
2. Guardian pause check (`agentInfo(kernel).paused` -> runtime `paused` by `guardian`; operator pauses are sticky).
3. Reconcile: `sv_treasury_ops` in `sent`/`unknown` by userOp hash; a pending `held`/`sent` action by sender receipt or
   op status (`agent-core.reconcile`); an `unknown` inference by `GET /v1/requests/:key`.
4. Sleep rule: USDC < 1 -> runtime `sleeping`, no inference; refuel is detected on the next tick.
5. Fee policy (no model): claimable fees (WETH at Chainlink ETH/USD + own token at the indexer price) >= `CLAIM_THRESHOLD_USD`
   -> `claim_fees` userOp; then USDC < `FUEL_TARGET_USDC` and WETH > 0 -> `swap` WETH -> USDC (Universal Router, 1% slippage,
   amount for the missing USDC + 2%). Each op is logged with `opId`, `userOpHash`, `txHash`.
6. `wakeDecision` from: eligible pending mentions (`replyEligibility`), original-post schedule, continuation, config revision,
   scheduled `nextAt`, held action.
7. Turn: observation (`buildObservation` with market, treasury, eligible mentions, schedule, last checkpoint, recent notes)
   -> paid inference (`inferenceIdempotencyKey(agentId, cycle)`, `maxQuoteFor(model)`) -> one tool call -> `parseAction`
   -> `beginAction`/`markSent`/`recordOutcome`/`settleCycle` -> result as a `tool` message -> repeat until `finish` or
   `MAX_TOOL_STEPS`. State is persisted with `boundedState` (12 KB); the in-flight conversation is persisted in
   `sv_runtimes.turn` so a crash resumes it. Errors use `interruptionPlan`.
8. Social stats to the indexer (`xHandle`, `lastPostAt`, `postsCount24h`, `status`).

## Runbook: `held` states

A runtime is `held` when a money or non-idempotent action has an unknown outcome. Nothing is ever resent; the runtime
does not wake until the original effect is settled.

| Symptom | Where to look | Resolution |
| --- | --- | --- |
| `sv_runtimes.status = held`, pending tool `treasury_execute` | `sv_treasury_ops` row with `status = unknown` and `user_op_hash` | the tick polls `eth_getUserOperationReceipt` every minute; `POST /internal/agents/:id/reconcile` forces it. If the bundler dropped the op (no receipt after the nonce moved on), set the op `failed` manually; the pending action then settles as failed on the next reconcile |
| held, pending tool `publish_post` / `publish_reply` | sender `GET /internal/receipt/:actionId` | the sender's own reconciler reads the agent's timeline; once it reports `sent` or `rejected` the runtime unblocks |
| `sv_inference.status = unknown`, `state.inferenceKey` set | `GET <INFERENCE_PROVIDER_URL>/v1/requests/:key` | the relay reconciles on-chain (`authorizationState`); `succeeded` replays the completion, `failed`/`retrySafe` releases the key. Never pay with a new key while it is unknown |
| op `sent` for > 10 min | `sv_treasury_ops` | downgraded to `unknown` automatically; same as the first row |
| guardian paused by the creator | `runtime.paused_by = guardian` | clears automatically when `unpauseAgent` is mined |
| operator pause | `POST /internal/agents/:id/pause|resume` | `resume` restores `held` if a pending action is still held |

Inspect everything with `GET /internal/agents/:id` (runtime, pending, last actions, treasury ops, inference key).

## Admin API

`Authorization: HMAC <ts>:<hex>` over `ts\nMETHOD\npath+query\nsha256(body)` with `SUPERVISOR_SERVICE_KEY`
(identical to the sender; `signRequest` in `src/hmac.ts`).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness (no auth) |
| GET | `/internal/agents` | all agents with runtime status |
| GET | `/internal/agents/:id` | runtime, pending action, last 20 actions, last 20 treasury ops |
| POST | `/internal/agents/:id/pause` / `resume` | runtime-level pause (the guardian pause is on-chain, creator only) |
| POST | `/internal/agents/:id/reconcile` | force reconciliation of ops, pending action and inference |
| POST | `/internal/agents/:id/tick` | process one agent now |
| POST | `/internal/agents/:id/session/install` / `rotate` / `check-1271` | session key operations |

## Notes and known gaps

- `@zerodev/sdk`'s `createKernelAccount` is not used for signing: its enable-mode wrapper (`getEncodedPluginsData`) encodes
  `selectorData` as `selector || action.address || hook || abi.encode(initData)`, while the guardian fixes `selectorData` to the
  bare 4-byte `execute` selector. The account in `src/kernel.ts` is built on viem's `toSmartAccount` with the exact encodings.
  The SDK is still used for the ZeroDev policy/signer init data (`toGasPolicy`, `toRateLimitPolicy`, `toTimestampPolicy`,
  `toSignatureCallerPolicy`, `toECDSASigner`) and those entries are cross-checked against `toPermissionValidator(...).getEnableData`;
  the call allow-list entry is BootrCallPolicy's and is encoded locally.
  `serializePermissionAccount` needs an SDK account object, so the policy parameters are stored in `sv_agents.session_policy`
  instead and `validatorData` is stored verbatim.
- `recall_conversation` is served from the supervisor's own action log and notes; the sender has no inbox-history endpoint.
- `generate_image` is hidden from the model (no image service yet).
- `@bootr/shared` and `@bootr/inference/client` export raw TypeScript; the build bundles them with esbuild
  (`scripts/build.mjs`) so `node dist/index.js` works.
