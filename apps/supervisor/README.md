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
                           |  x402 (EIP-3009 signed by the agent's spender EOA)
                 +------------------+
                 |  apps/inference  |
                 +------------------+
```

## Modules

| File | Role |
| --- | --- |
| `src/config.ts` | zod env schema (see below) |
| `src/db/schema.ts`, `drizzle/` | `sv_agents`, `sv_runtimes`, `sv_actions`, `sv_memories`, `sv_inference`, `sv_treasury_ops`, `sv_cursors` (migrations table `public.sv_migrations`) |
| `src/onboarding.ts` | `AgentLaunched` poller (block cursor in `sv_cursors`), `registerAgent` (draft id from `BootrLauncher.LaunchContext` in the launch receipt), `installSessionKey`, `rotateSessionKey`, `completeOnboarding` (X account connected via the sender) |
| `src/session-key.ts` | policy set (BootrCallPolicy rules: the two RWAGMI locker claims with `to == kernel`, the swap pair, the windowed spender funding rule, ZeroDev gas / rate-limit / timestamp policies, signer with SKIP_SIGNATURE), `validatorData` encoding, permission id / validation id / nonce key, enable digest, enable-mode and session signature encodings (BootrCallPolicy time slot), deinit data for legacy and current layouts |
| `src/spender.ts` | per-agent x402 spender EOA derived from `SPENDER_MASTER_KEY` (signs the EIP-3009 payments; the kernel only funds it) |
| `src/admin-signer.ts` | `AdminSigner` interface (guardian owner: `approveSessionKey`, `revokeSessionKey`, `revokeAllSessionKeys`, `revokeAllSessionKeysBatch`, `handleOps`) + local-key implementation; swap for KMS/hardware later |
| `src/kernel.ts` | viem `toSmartAccount` implementation of the Kernel session account + bundler client (`prepareUserOp`, `submitUserOp`, `waitForReceipt`, `getReceipt`; `signTypedData` / `signMessage` always refused: the kernel has no ERC-1271 path); every userOp signature carries BootrCallPolicy's time slot; appends the ERC-8021 builder-code suffix to every userOp callData; self-bundles enable-mode ops through `EntryPoint.handleOps` when given a `selfBundle` sender |
| `src/entrypoint.ts` | EntryPoint v0.7 helpers: the fixed self-bundle gas budget and `FailedOp` / `FailedOpWithRevert` decoding (inner Kernel / guardian / BootrCallPolicy errors) |
| `src/builder-codes.ts` | Base Builder Codes: per-kernel registration (`ensureBuilderCode`, `backfillBuilderCodes`) and the ERC-8021 calldata suffix (`attributionSuffix`) |
| `src/treasury.ts` | on-chain reads (kernel + spender balances, pending + settled WETH fees from `RwagmiLpLockerV3`, Chainlink with staleness check, the funding window from `BootrCallPolicy.windowOf`), `prepareOp` / `executeOp` / `reconcileOps`, the claim call (`settleAndClaim` / `claimQuote`), swap encoding through `BootrSwapHelper` (`WETH.approve(helper)` + `helper.swapWethToUsdc`), deterministic fee-claim policy incl. the spender top-up |
| `src/abi.ts`, `src/abis/` | hand-written minimal ABIs of the Bootr contracts; the RWAGMI v3 launcher and LP locker ABIs vendored verbatim from `@rwagmi/token-launcher-sdk` |
| `src/inference.ts` | agent-core request building, x402 payment through `@bootr/inference/client` signed by the agent's spender EOA, idempotent per cycle, unknown-outcome reconciliation with payment proof |
| `src/broker/index.ts` | tool executors, `resolvePending` (receipts by id/hash), tool availability |
| `src/runtime.ts` | leases, observation assembly, the turn loop (one tool per step, `finish` checkpoint, step cap), bounded state |
| `src/tick.ts` | the tick: onboarding, lease, reconcile, guardian pause, sleep rule, fee policy, `wakeDecision`, turn, social stats to the indexer |
| `src/api.ts` | Hono admin API (HMAC), including the fleet-wide `panic-revoke` |
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

Container (build from the repo root; Railway setup in [`docs/deploy/railway.md`](../../docs/deploy/railway.md)). Run exactly one instance:

```sh
docker build -f apps/supervisor/Dockerfile -t bootr-supervisor .
docker run --rm --env-file .env bootr-supervisor node dist/db/migrate.js
docker run --rm --env-file .env -e SUPERVISOR_PORT=3004 -p 3004:3004 bootr-supervisor
```

After editing `src/db/schema.ts`: `pnpm --filter supervisor db:generate`.

## Environment variables

Names live in the root `.env.example`. Empty strings are treated as unset.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | shared Postgres |
| `CHAIN_ID` | yes | | `8453` in production. `84532` is accepted by the schema, but RWAGMI v3 (the launch backend) has no Base Sepolia deployment, so nothing can be launched or claimed there |
| `BASE_SEPOLIA_RPC_URL` / `BASE_RPC_URL` | yes (one) | | RPC for the selected chain |
| `BUNDLER_URL` | yes | | ERC-4337 bundler (ZeroDev / Pimlico) |
| `PAYMASTER_URL` | no | | ERC-7677 paymaster; unset = the kernel pays gas (ETH balance / EntryPoint deposit) |
| `ENABLE_MODE_BUNDLER_URL` | no | `BUNDLER_URL` | bundler for session-key install/rotation (enable mode). Strict ERC-7562 bundlers such as CDP reject enable mode (`op code validation error`, policies run `onInstall` during validation); point this at ZeroDev and keep CDP for everything else |
| `ENABLE_MODE_PAYMASTER_URL` | no | | paymaster for enable-mode userOps; unset = `PAYMASTER_URL` only when `ENABLE_MODE_BUNDLER_URL` is unset; ignored when self-bundling |
| `ENABLE_MODE_SELF_BUNDLE` | no | `false` | `true` = enable-mode userOps are sent by the admin signer through `EntryPoint.handleOps([op], admin)` instead of any bundler (fixed gas budget, no paymaster, the kernel pays its prefund from its ETH balance / EntryPoint deposit). Requires `ADMIN_PRIVATE_KEY`. See "Bundlers" |
| `ENABLE_MODE_MAX_PREFUND_WEI` | no | `5e15` | before a self-bundled op the admin deposits the missing prefund (`gas × maxFeePerGas` minus the kernel's EntryPoint deposit and ETH balance, +10%) into the EntryPoint for the kernel, up to this amount |
| `SESSION_SIGNER_PRIVATE_KEY` | yes | | signs every agent userOp (never anything through ERC-1271) |
| `SPENDER_MASTER_KEY` | yes | | 32-byte hex master from which every agent's x402 spender EOA is derived (`spender.ts`); must differ from the session signer and the admin key |
| `ADMIN_PRIVATE_KEY` | no | | guardian owner; `approveSessionKey` / `revokeSessionKey` and, with `ENABLE_MODE_SELF_BUNDLE`, `EntryPoint.handleOps`. Without it agents stay in `onboarding` |
| `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS` | yes | | deployed Bootr contracts (mainnet: launcher `0xD3CE024ddC37465510E6c9a1D7942f003338B1F3`, guardian `0x799Ab875294E37839883D12084aB4BE3f7633630`) |
| `RWAGMI_LAUNCHER_V3_ADDRESS` | no | `0xB205c9e7…4B20` | `RwagmiB20LauncherV3` on Base mainnet: `deploymentInfo(token).primaryPoolId` is the coin's fee pool |
| `RWAGMI_LOCKER_V3_ADDRESS` | no | `0xB205CE7C…1B20` | `RwagmiLpLockerV3` on Base mainnet: the kernel's WETH fee ledger and the session key's only claim target (no Base Sepolia deployment; tests mock both) |
| `PLATFORM_TREASURY_ADDRESS` | no | | launches whose creator is this address run as the platform's own voice (`@bootrfun`); same value as `PLATFORM_TREASURY` |
| `LAUNCHER_START_BLOCK` | no | `0` | first block scanned when no cursor exists; mainnet: `53219209`, the RWAGMI-backed launcher's deploy block |
| `LAUNCH_LOG_CHUNK_BLOCKS` | no | `2000` | block range per `eth_getLogs` call; public Base RPCs cap it at 200 |
| `SENDER_URL`, `SENDER_SERVICE_KEY` | yes | | apps/sender internal API (key: 32+ characters) |
| `SUPERVISOR_SERVICE_KEY` | yes | | HMAC key for this service's `/internal/*`; 32+ characters and different from the sender and indexer keys (no fallback: every holder of those keys would otherwise be a supervisor admin) |
| `INDEXER_SERVICE_KEY` | yes | | HMAC key of the indexer's `/internal/agent/:kernel/social` (32+ characters, the indexer's own key) |
| `INFERENCE_PROVIDER_URL`, `INFERENCE_PAYTO_ADDRESS` | yes | | apps/inference relay and its USDC recipient (the payer refuses any other payee) |
| `INFERENCE_TIMEOUT_MS` | no | `150000` | |
| `INFERENCE_MAX_OUTPUT_TOKENS` | no | `1024` | priced by the relay quote |
| `INDEXER_URL` | yes | | Ponder REST (`/market/:token`, `/treasury/:kernel`, `/internal/agent/:kernel/social` signed with `INDEXER_SERVICE_KEY`) |
| `SUPERVISOR_TICK_MS` | no | `60000` | |
| `MAX_AGENTS_PER_TICK` | no | `10` | |
| `MAX_TOOL_STEPS` | no | `8` | tool steps per turn before a forced checkpoint |
| `SUPERVISOR_PORT` | no | `3004` | |
| `CLAIM_THRESHOLD_USD` | no | `5` | fee policy: claim when the kernel's pending + settled WETH fees (at Chainlink ETH/USD) reach this |
| `FUEL_TARGET_USDC` | no | `20` | fee policy: swap WETH -> USDC up to this balance |
| `SWAP_SLIPPAGE_BPS` | no | `100` | max slippage vs Chainlink ETH/USD passed to `BootrSwapHelper` (hard cap 300 on-chain; the pool fee tier is fixed in the helper) |
| `CHAINLINK_MAX_AGE_SECONDS` | no | `3600` | a Chainlink ETH/USD answer older than this is treated as unavailable: no swaps, no USD figures (the helper enforces the same 1 h bound on-chain) |
| `SEARCH_API_URL`, `SEARCH_API_KEY` | no | | Exa or Brave; unset hides `search_web` from the model |
| `SESSION_KEY_VALIDITY_DAYS` | no | `30` | TimestampPolicy `validUntil` |
| `SESSION_ROTATE_BEFORE_DAYS` | no | `3` | rotate this long before expiry |
| `SESSION_RATE_LIMIT_PER_HOUR` | no | `60` | RateLimitPolicy |
| `SESSION_USDC_TRANSFER_CAP` | no | `50000000` | USDC (6 dp units) the session key may move to the agent's spender per window, enforced on-chain by BootrCallPolicy's `SUM_PER_WINDOW` (summed over batches and over the window) |
| `SESSION_USDC_WINDOW_SECONDS` | no | `86400` | length of that window (fixed grid anchored at the permission install) |
| `SPENDER_MIN_USDC` | no | `5` | the fee policy tops the spender up when its USDC drops below this |
| `SPENDER_TARGET_USDC` | no | `20` | ...to this balance, bounded by the kernel's USDC and the remaining window budget |
| `SESSION_GAS_ALLOWANCE_WEI` | no | `1e17` | GasPolicy cumulative allowance |
| `USER_OP_RECEIPT_TIMEOUT_MS` | no | `90000` | after this a sent op is `unknown` and reconciled by hash |
| `BUILDER_CODES_ENABLED` | no | `true` | Base Builder Codes attribution; `false` disables both the registration and the calldata suffix |
| `BUILDER_CODES_URL` | no | `https://api.base.dev/v1/agents/builder-codes` | unauthenticated registration endpoint (`POST {walletAddress}`), 10 s timeout |
| `LOG_LEVEL` | no | `info` | |

## How an agent is onboarded

1. `pollLaunches` reads `BootrLauncher.AgentLaunched` logs after the stored cursor (2000-block chunks) and calls
   `registerAgent`: reads the token's `name()`/`symbol()`, stores `sv_agents` (status `onboarding`, config with
   `xHandle`/`xUserId` still `null`) and `sv_runtimes` (state `{phase: 'boot'}`, cycle 0). It also reads the launch
   tx receipt, decodes `BootrLauncher.LaunchContext(token, context)` (emitted by our launcher for this token right
   after `AgentLaunched`; the RWAGMI `B20LaunchCreatedV3` event carries no context) and stores the `id` of its JSON
   `context` (`{"interface":"Bootr","platform":"bootr.fun","id":"<uuid>"}`) in `sv_agents.draft_id`
   (`''` when absent or not a lowercase uuid; `null` while the receipt could not be read).
2. `installSessionKey` (needs `ADMIN_PRIVATE_KEY`):
   - permissionId = random `bytes4`; policies in install order (addresses from `@bootr/shared/addresses`):
     - **BootrCallPolicy** (`bootr.callPolicy`, our own module in `packages/contracts/src/BootrCallPolicy.sol`), flagged
       `NOT_FOR_VALIDATE_SIG`, init data `abi.encode(Rule[])` built by `callPolicyRules` / `encodeCallPolicyData` in
       `src/session-key.ts` with exactly five rules: `RwagmiLpLockerV3.settleAndClaim(*, *, to == kernel)`,
       `RwagmiLpLockerV3.claimQuote(*, to == kernel)`, `WETH.approve(bootr.swapHelper, *)`, `swapHelper.swapWethToUsdc(*, *)`,
       `USDC.transfer(<agent spender>, SUM_PER_WINDOW <= SESSION_USDC_TRANSFER_CAP per SESSION_USDC_WINDOW_SECONDS)`. The
       locker pays `msg.sender`'s (the kernel's) balance to `to`, and `to` is pinned to the kernel, so a claim can only
       move fees into the kernel. The helper pulls WETH from the kernel and pays all USDC back to the kernel at no
       worse than Chainlink minus 3%, so the session key can only turn the kernel's WETH into the kernel's USDC (no
       Universal Router rule any more); the only USDC outflow is to the agent's own spender, cumulatively capped per
       window on-chain. Every call must carry zero ETH value; batches pass only if every call passes and the USDC amounts
       of a batch SUM to at most the remaining window budget; delegatecall is rejected. Every regular userOp signature is
       `[0 ‖ uint64(32) ‖ abi.encode(now)] ‖ 0xff ‖ ecdsa` (the call policy's time slot, so the window can roll without
       reading `block.timestamp`); see the contract README for the semantics. ZeroDev's CallPolicy is **not** used: hooked permissions force `executeUserOp`-wrapped
       callData, which it cannot parse (it reverts in `checkUserOpPolicy`).
     - GasPolicy (cumulative wei allowance), RateLimitPolicy (`SESSION_RATE_LIMIT_PER_HOUR` per 3600 s), both ZeroDev
       modules flagged `NOT_FOR_VALIDATE_SIG` so they do not gate ERC-1271;
     - TimestampPolicy (`validUntil = now + SESSION_KEY_VALIDITY_DAYS`), for userOps and signatures;
     - ECDSASigner with the `SESSION_SIGNER_PRIVATE_KEY` address, flagged **SKIP_SIGNATURE** (`0x0002`): Kernel stores
       the signer entry's flags as the permission's `permissionFlag` and then rejects every `isValidSignature` for it
       (`PermissionNotAlllowedForSignature`). The session key therefore has **no ERC-1271 path**; `src/kernel.ts`
       refuses `signTypedData` / `signMessage` (`KernelSigningRefusedError`). A content policy on that path is not
       possible on Kernel v3.1 (any policy-signature slot reverts `SignerPrefixNotPresent`, see
       `packages/contracts/src/README.md`), which is why payments moved to the spender EOA.
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
3. The creator connects the agent's X account in the launch form, **before** the agent id exists, so the sender
   stores it under the form's draft uuid. `completeOnboarding` first fills a `null` `draft_id` for pending agents
   (agents registered before the column existed; same receipt decode), then asks the sender
   `GET /internal/account/:agentId`. When that is not connected and `draft_id` is set, it checks
   `GET /internal/account/:draftId` and, if connected, calls `POST /internal/account/:draftId/rebind
   {to: agentId, connectedBefore: <launch block time>}` and re-reads the account under the agent id. Guards:
   - only the earliest launch (lowest `launch_block`, then agent id) carrying a draft id may adopt it, since a
     later launch can copy a public `tokenContext`;
   - `connectedBefore` makes the sender refuse an account (re)connected after the launch block, so nobody can bind
     their own X account to a draft id once it is visible on-chain (409, the agent stays in `onboarding`);
   - draft ids must be lowercase uuids, never numeric agent ids.
   Once connected it fills `xHandle`/`xUserId`/`socialStartedAt`, parses the full agent-core `AgentConfig`, sets the
   agent `active` and the runtime `waiting`.

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
it. x402 payments are not session-key userOps: the agent's spender EOA signs them (the session key has no ERC-1271 path). `BUILDER_CODES_ENABLED=false` disables everything; a kernel
client is cached per `(kernel, permissionId, builderCode)` so a code registered later is picked up on the next op.

Admin shortcuts: `POST /internal/agents/:id/session/install` (optionally `{permissionId}` to retry a half-done install) and
`POST /internal/agents/:id/session/check-spender` (the agent's spender address, whether it matches `sv_agents.spender`, its
USDC balance, the remaining funding budget of the current window and a dry EIP-712 signature recovered back to it; nothing
is sent anywhere).

## Rotating session keys

`rotateExpiringSessionKeys` runs every tick and rotates keys that expire within `SESSION_ROTATE_BEFORE_DAYS`;
`POST /internal/agents/:id/session/rotate` does it on demand. Rotation installs a fresh permission (new permissionId,
new validity window) through the same approve + enable-mode path, then calls `guardian.revokeSessionKey(kernel, oldPid,
deinitData)` with `abi.encode(bytes[])` of the old module addresses. If the revoke fails it is logged and must be done
by hand (`revokeSessionKey` or `revokeAllSessionKeys`, which bumps the kernel nonce and kills every non-root validation).
To rotate the **signer EOA** itself, change `SESSION_SIGNER_PRIVATE_KEY` and rotate every agent. Rotation also moves an
agent from a legacy permission layout (Universal Router rules, `USDC.transfer(payTo)`, SignatureCallerPolicy, signer
without SKIP_SIGNATURE) to the current one (swap helper, windowed spender funding, closed signature path); the old
permission's deinit data is rebuilt from its stored `session_policy` (`policyModules`), so legacy permissions revoke
cleanly.

## Money: kernel, spender, windows

```
LP fees (WETH) -> kernel  --swap helper-->  kernel USDC  --USDC.transfer(spender) <= cap / window-->  spender EOA  --x402-->  relay
```

- The **kernel** is the reservoir: WETH from fees, USDC from swaps. Its session key can move USDC to exactly one
  address, the agent's **spender**, and at most `SESSION_USDC_TRANSFER_CAP` per `SESSION_USDC_WINDOW_SECONDS`
  (on-chain, `BootrCallPolicy` `SUM_PER_WINDOW`; the budget is read back with `windowOf` for `treasury_read` and the
  `fund_model` checks). It signs nothing through ERC-1271.
- The **spender** is a plain EOA derived per agent from `SPENDER_MASTER_KEY` (`spender.ts`:
  `k = keccak256(master ‖ agentId) mod (n - 1) + 1`), stored in `sv_agents.spender` at registration (backfilled on later
  ticks). It signs the EIP-3009 payments to the relay (settled by the facilitator, so it needs no ETH). The fee policy
  keeps it between `SPENDER_MIN_USDC` and `SPENDER_TARGET_USDC` (`fund_model` ops of origin `policy`); the model's
  `treasury_prepare {operation: "transfer"}` may top it up too (the only allowed recipient).
- Exposure: a leaked session key moves at most `cap` per window into an account it does not control (plus the swap
  slippage bound); a leaked master key exposes every spender's float (`SPENDER_TARGET_USDC` each). Rotate the master by
  changing it, funding the new spenders and letting the old ones drain.
- Sleep rule: the agent sleeps when kernel USDC + spender USDC < 1.

## Runbook: session signer leak

`SESSION_SIGNER_PRIVATE_KEY` is one EOA installed on every kernel. If it may have leaked (host compromise, `.env` in a
log, backup, CI), the goal is minutes, not ticks:

1. **Revoke fleet-wide, then stop the supervisor**: `POST /internal/agents/panic-revoke` (HMAC with
   `SUPERVISOR_SERVICE_KEY`, needs `ADMIN_PRIVATE_KEY`; the process must be up for the API). It does, in order:
   - one guardian transaction per 40 kernels: `revokeAllSessionKeysBatch(kernels)` bumps every kernel's valid nonce.
     This kills the userOp path of every permission at once; production permissions have no ERC-1271 path, so for
     them this is complete;
   - unless the body says `{"uninstall": false}`, `revokeSessionKey` per agent (uninstall, best effort, reported per
     agent). This is the only thing that closes the ERC-1271 path of **legacy** permissions whose signer was installed
     without SKIP_SIGNATURE (Kernel's `isValidSignature` ignores the nonce bump), and it also withdraws their
     enable-digest approvals. Retry failed ones by hand with
     `guardian.revokeSessionKey(kernel, pid, abi.encode(bytes[](policies + 1)))`;
   - every runtime is paused by the operator.
   Response: `{nonceRevoked: [{kernels, txHash}], uninstalled: [{agentId, kernel, permissionId, txHash | null, error}],
   paused: [agentId], errors: []}` (HTTP 207 when a batch failed). `{"agentIds": [...]}` limits the scope.
2. Verify on-chain: `kernel.validNonceFrom()` moved; a session userOp now fails validation. The spenders are not
   affected by a session-key leak (different key); if `SPENDER_MASTER_KEY` leaked too, move their floats and rotate
   the master.
3. Replace the key: new `SESSION_SIGNER_PRIVATE_KEY`, restart, then `POST /internal/agents/:id/session/install` (or let
   `completeOnboarding` do it: agents whose permission was uninstalled need a fresh install; the approval is bound to the
   new nonce) and `POST /internal/agents/:id/resume`.
4. Review: `SessionKeyApproved` events for approvals you did not make, USDC `AuthorizationUsed` events of every kernel
   between the leak and the revoke, the x402 relay's `refundDue` rows, and rotate `ADMIN_PRIVATE_KEY` if it shared the
   host (it can still approve anything: C-03 is out of scope of this fix).

## The loop

Every tick, up to `MAX_AGENTS_PER_TICK` runtimes ordered by `next_at`:

1. 60 s lease on the runtime row (`lease_token`, `lease_until`; renewed per tool step).
2. Guardian pause check (`agentInfo(kernel).paused` -> runtime `paused` by `guardian`; operator pauses are sticky).
3. Reconcile: `sv_treasury_ops` in `sent`/`unknown` by userOp hash; a pending `held`/`sent` action by sender receipt or
   op status (`agent-core.reconcile`); an `unknown` inference by `GET /v1/requests/:key`.
4. Sleep rule: USDC < 1 -> runtime `sleeping`, no inference; refuel is detected on the next tick.
5. Fee policy (no model): pending + settled WETH fees on the RWAGMI locker (at Chainlink ETH/USD) >= `CLAIM_THRESHOLD_USD`
   -> `claim_fees` userOp (`settleAndClaim`, see "Fee claims" below); then USDC < `FUEL_TARGET_USDC` and WETH > 0 -> `swap` WETH -> USDC through `BootrSwapHelper`
   (`SWAP_SLIPPAGE_BPS` vs the on-chain Chainlink floor, amount for the missing USDC + 2%). A stale Chainlink answer
   (`CHAINLINK_MAX_AGE_SECONDS`) disables swaps. Each op is logged with `opId`, `userOpHash`, `txHash`.
6. `wakeDecision` from: eligible pending mentions (`replyEligibility`), original-post schedule, continuation, config revision,
   scheduled `nextAt`, held action.
7. Turn: observation (`buildObservation` with market, treasury, eligible mentions, schedule, last checkpoint, recent notes)
   -> paid inference (`inferenceIdempotencyKey(agentId, cycle)`, `maxQuoteFor(model)`) -> one tool call -> `parseAction`
   -> `beginAction`/`markSent`/`recordOutcome`/`settleCycle` -> result as a `tool` message -> repeat until `finish` or
   `MAX_TOOL_STEPS`. State is persisted with `boundedState` (12 KB); the in-flight conversation is persisted in
   `sv_runtimes.turn` so a crash resumes it. Errors use `interruptionPlan`.
8. Social stats to the indexer (`xHandle`, `lastPostAt`, `postsCount24h`, `status`).

## Fee claims (RWAGMI v3)

Coins launch through `RwagmiB20LauncherV3` into a Uniswap v4 pool paired with WETH (`docs/rwagmi-migration.md`). The
RWAGMI hook takes the 1% swap fee in WETH only and credits it to the pool; `RwagmiLpLockerV3` settles a pool's credits
into per-recipient, per-currency balances and pays them out. The kernel is the agent's reward recipient, so the
kernel itself claims, with the supervisor's session key:

1. **Read** (`readTreasuryOnChain`): `poolId = RwagmiB20LauncherV3.deploymentInfo(token).primaryPoolId` (the indexer's
   `/market/:token` `poolId` only when that read fails; `null` when the coin was not launched through the RWAGMI
   launcher, e.g. a coin of the Clanker-era launchers before 2026-10-29). Claimable WETH = `pendingQuote(poolId, kernel)` (credited to the pool, not
   settled yet) + `claimableQuote(kernel, WETH)` (settled). The snapshot exposes `claimable.{weth, pending, settled,
   poolId}`; there is no claimable token amount any more. USD value at Chainlink ETH/USD.
2. **Claim** (`runFeePolicy`, kind `claim_fees`): when the USD value reaches `CLAIM_THRESHOLD_USD`, one call from the
   kernel to `RWAGMI_LOCKER_V3_ADDRESS`: `settleAndClaim([poolId], WETH, kernel)`, which settles the pool and pays the
   kernel's whole WETH balance to the kernel in one go. Without a pool id only the settled balance can move:
   `claimQuote(WETH, kernel)` (nothing is sent when there is nothing settled). Both calls are simulated as the kernel,
   persisted as `prepared`, then sent like every treasury op (`executeOp`, hash stored before the send, `unknown` on
   timeout, reconciled by hash).
3. **Policy**: BootrCallPolicy allows exactly those two selectors on the locker, with the `to` argument pinned to the
   kernel (`settleAndClaim` word 2, `claimQuote` word 1); currency and pools are free. The locker pays
   `msg.sender`'s balance, so the session key can only ever move the kernel's own fees into the kernel.
4. **After the claim** the WETH sits in the kernel and the unchanged swap / spender-funding steps take over (WETH ->
   USDC via `BootrSwapHelper`, USDC -> spender within the window cap).

Session keys installed before 2026-10-29 (Clanker-era rules, `rulesVersion` unset in `sv_agents.session_policy`) keep
working for swaps and funding; their claim rule points at the Clanker fee locker, which the supervisor no longer calls,
and their funding rule stays at index 3 for `windowOf` until the key is rotated (`rotateSessionKey` installs the new
five-rule layout). Clanker-era coins report `poolId: null` and no pending fees; their old Clanker fees are not
claimed by the supervisor any more.

## Runbook: `held` states

A runtime is `held` when a money or non-idempotent action has an unknown outcome. Nothing is ever resent; the runtime
does not wake until the original effect is settled.

| Symptom | Where to look | Resolution |
| --- | --- | --- |
| `sv_runtimes.status = held`, pending tool `treasury_execute` | `sv_treasury_ops` row with `status = unknown` and `user_op_hash` | the tick polls `eth_getUserOperationReceipt` every minute; `POST /internal/agents/:id/reconcile` forces it. If the bundler dropped the op (no receipt after the nonce moved on), set the op `failed` manually; the pending action then settles as failed on the next reconcile |
| held, pending tool `publish_post` / `publish_reply` | sender `GET /internal/receipt/:actionId` | the sender's own reconciler reads the agent's timeline; once it reports `sent` or `rejected` the runtime unblocks |
| `sv_inference.status = unknown`, `state.inferenceKey` set | `GET <INFERENCE_PROVIDER_URL>/v1/requests/:key` with the persisted payment as `PAYMENT-SIGNATURE` (the relay scopes keys per payer and only answers the payer) | the relay reconciles on-chain (`authorizationState`); `succeeded` and `credit` (paid, completion still owed) replay the POST with the same key, body and proof at no new charge; `failed`/`retrySafe` releases the key, `failed` + `refundDue` is logged at error level (the operator owes a refund). A row without a stored payment was never paid and is failed without asking the relay. Never pay with a new key while it is unknown |
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
| POST | `/internal/agents/:id/session/install` / `rotate` / `check-spender` | session key operations / spender check |
| POST | `/internal/agents/panic-revoke` | fleet-wide key-leak response (see the runbook); body `{uninstall?: boolean, agentIds?: string[]}` |

## Notes and known gaps

- `@zerodev/sdk`'s `createKernelAccount` is not used for signing: its enable-mode wrapper (`getEncodedPluginsData`) encodes
  `selectorData` as `selector || action.address || hook || abi.encode(initData)`, while the guardian fixes `selectorData` to the
  bare 4-byte `execute` selector. The account in `src/kernel.ts` is built on viem's `toSmartAccount` with the exact encodings.
  The SDK is still used for the ZeroDev policy/signer init data (`toGasPolicy`, `toRateLimitPolicy`, `toTimestampPolicy`,
  `toECDSASigner`) and those entries are cross-checked against `toPermissionValidator(...).getEnableData`;
  the call allow-list and authorization-policy entries are Bootr's and are encoded locally.
- Logging: every `err` / `error` field goes through `serializeError` (`src/log.ts`), which reduces every URL in the error
  (viem's `url`, `details`, `metaMessages`, the composed message, nested `cause`s) to its origin, because RPC / bundler /
  paymaster URLs embed API keys.
- Replies: `publish_reply` always sends the agent-core `replyEligibility` decision recorded when the mention was observed
  (`read_mentions` or the turn's observation; persisted in the turn); the sender rejects replies without it and replies to
  opted-out users, and answers `consent_lookup_failed` (429/503) when X cannot be reached, which the broker turns into a
  retryable failure (`retryAt`), never a final one.
  `serializePermissionAccount` needs an SDK account object, so the policy parameters are stored in `sv_agents.session_policy`
  instead and `validatorData` is stored verbatim.
- `recall_conversation` is served from the supervisor's own action log and notes; the sender has no inbox-history endpoint.
- `generate_image` is hidden from the model (no image service yet).
- `@bootr/shared` and `@bootr/inference/client` export raw TypeScript; the build bundles them with esbuild
  (`scripts/build.mjs`) so `node dist/index.js` works.
