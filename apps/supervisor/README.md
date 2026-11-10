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
| `src/db/schema.ts`, `drizzle/` | `sv_agents` (with `source`: `bootr` / `clanker`, the launcher the agent came from), `sv_runtimes`, `sv_actions`, `sv_memories`, `sv_inference`, `sv_treasury_ops`, `sv_images`, `sv_approvals`, `sv_post_metrics`, `sv_cursors`, the notification and chat tables of migration 0008, `sv_service_calls` (paid service calls, migration 0009), `sv_bounty_jobs` and `sv_bounty_entries` (bounty jobs and their entries, migration 0010) (migrations table `public.sv_migrations`) |
| `src/onboarding.ts` | `AgentLaunched` poller over every followed launcher (Bootr and, when configured, the Clanker one; one block cursor in `sv_cursors`), `registerAgent` (source from the emitting launcher; draft id from `LaunchContext` and, for Clanker launches, pool / locker details from `ClankerLaunched` in the launch receipt), `installSessionKey`, `rotateSessionKey`, `completeOnboarding` (X account connected via the sender) |
| `src/launch-source.ts` | the treasury path by launch source: `agentSource`, the stored `config.clanker` block (`clankerDetailsOf`) and the lockers a Clanker coin claims from (`clankerLockersFor`) |
| `src/session-key.ts` | policy set (BootrCallPolicy rules: two claim rules by launch source, the RWAGMI locker pair with `to == kernel` or the Clanker `collectRewards(token)` + `claim(kernel, *)` pair, then the swap pair, the windowed spender funding rule, ZeroDev gas / rate-limit / timestamp policies, signer with SKIP_SIGNATURE), `validatorData` encoding, permission id / validation id / nonce key, enable digest, enable-mode and session signature encodings (BootrCallPolicy time slot), deinit data for legacy and current layouts |
| `src/spender.ts` | per-agent x402 spender EOA derived from `SPENDER_MASTER_KEY` (signs the EIP-3009 payments; the kernel only funds it) |
| `src/admin-signer.ts` | `AdminSigner` interface (guardian owner: `approveSessionKey`, `revokeSessionKey`, `revokeAllSessionKeys`, `revokeAllSessionKeysBatch`, `handleOps`) + local-key implementation; swap for KMS/hardware later |
| `src/kernel.ts` | viem `toSmartAccount` implementation of the Kernel session account + bundler client (`prepareUserOp`, `submitUserOp`, `waitForReceipt`, `getReceipt`; `signTypedData` / `signMessage` always refused: the kernel has no ERC-1271 path); every userOp signature carries BootrCallPolicy's time slot; appends the ERC-8021 builder-code suffix to every userOp callData; self-bundles enable-mode ops through `EntryPoint.handleOps` when given a `selfBundle` sender |
| `src/entrypoint.ts` | EntryPoint v0.7 helpers: the fixed self-bundle gas budget and `FailedOp` / `FailedOpWithRevert` decoding (inner Kernel / guardian / BootrCallPolicy errors) |
| `src/builder-codes.ts` | Base Builder Codes: per-kernel registration (`ensureBuilderCode`, `backfillBuilderCodes`) and the ERC-8021 calldata suffix (`attributionSuffix`) |
| `src/treasury.ts` | on-chain reads (kernel + spender balances, claimable WETH fees by launch source: pending + settled from `RwagmiLpLockerV3`, or settled from `ClankerFeeLocker`; Chainlink with staleness check, the funding window from `BootrCallPolicy.windowOf`), `prepareOp` / `executeOp` / `reconcileOps`, the claim calls by source (`settleAndClaim` / `claimQuote`, or `collectRewards` + `claim` batched), swap encoding through `BootrSwapHelper` (`WETH.approve(helper)` + `helper.swapWethToUsdc`), deterministic fee-claim policy incl. the spender top-up |
| `src/abi.ts`, `src/abis/` | hand-written minimal ABIs of the Bootr contracts, the Clanker v4 fee locker / LP locker and `ClankerLaunched`; the RWAGMI v3 launcher and LP locker ABIs vendored verbatim from `@rwagmi/token-launcher-sdk` |
| `src/inference.ts` | agent-core request building, x402 payment through `@bootr/inference/client` signed by the agent's spender EOA (`relayRequest`, shared by thoughts and images), idempotent per key, unknown-outcome reconciliation with payment proof |
| `src/images.ts` | `generate_image`: one paid picture through the relay (`modalities: ["image", "text"]`, `max_tokens` sized for the picture's own tokens), decoded from the base64 data URL and stored in `sv_images`; the daily cap; the fuel check; `publish_post` / `publish_reply` attach a stored image by `imageId` |
| `src/image-rules.ts` | the hard rules for pictures in code: never on request, no real people, no other project's logo, no charts or numbers; the alt text passes the same gates as a post (checked before the paid call and again where a picture meets a post or the review queue) |
| `src/image-models.ts` | the image models an agent may draw with and the price of one picture, by the route its pictures take (`BLOCKRUN_IMAGE_ROUTE`): the relay's list (`GET /v1/models`, the built-in list when the relay is down) or, with pictures on BlockRun, the catalog at BlockRun's fixed prices |
| `src/picture-hint.ts` | the `picture` section of the observation: the model in force, the price, how many pictures are left today, whether the fuel allows one and whether one is suggested now |
| `src/image-retention.ts` | the hourly sweep: day-old relay answers of image calls emptied, month-old pictures deleted unless a pending review item refers to them |
| `src/mention-close.ts` | the pass before a turn's first step: mentions whose only exclusion is `verified_audience_required`, from an author X reports as unverified, are closed in bulk with no model call; verified authors, Bootr agents, the creator, allow-listed authors, authors without verification data and deferred mentions stay; any error leaves the turn as it was |
| `src/broker/index.ts` | tool executors, `resolvePending` (receipts by id/hash), tool availability |
| `src/runtime.ts` | leases, observation assembly, the turn loop (one tool per step, `finish` checkpoint, step cap), bounded state |
| `src/tick.ts` | the tick: onboarding, lease, reconcile, guardian pause, sleep rule, fee policy, `wakeDecision`, turn (social, or the treasury turn when the social wake said no and its own clock is due), social stats to the indexer |
| `src/roles.ts` | the three roles of the capabilities design (section 3.4): which tools each role gets (the social turn loses the money tools while the treasury turn is on for the agent), the switch (`trade` or `bounties` power, or the config's `treasuryTurn` override), the treasury clock in `sv_runtimes.state`, and the treasury turn's observation (numbers, caps, ops, its own notes; never a mention or a page), see "Three roles" |
| `src/judge.ts` | the judge role: one paid thought with no tools on the agent's model (or `config.judgeModel`) that rules on a bounty job's entries from the criteria and the artefacts alone, checked in code (winner in range and passing every criterion, a 200-character reason through the publish gate); one thought per job by its idempotency key; called by `src/bounties.ts` |
| `src/bounties.ts` | Bounties stage A (the `bounties` power): `bounty_post` / `bounty_cancel` (treasury turn) and `bounty_list`, the job post from the fixed template after the caps and the task rules, drafts under review or waiting for a slot, the sweep that collects a closed job's replies through the sender, applies the entry rules, fetches bounded artefacts, asks the judge once and proposes the winner in the approval queue (the creator pays by hand and reports the tx), the public job views, the tape rows; see "Bounties" |
| `src/api.ts` | Hono admin API (HMAC), including the fleet-wide `panic-revoke` |
| `src/web-reader.ts` | `read_url` / `search_web` with private-address protection and a 4000-char cap |
| `src/services.ts` | the Paid services power (`discover_services`, `x402_fetch`): the spender pays any public https x402 endpoint `exact` USDC under the creator's per-call and daily caps and host lists; one signature per action id, the chain closes a lost answer (`sv_service_calls`); the day's total in `/fuel`, every call on the activity tape |
| `src/rhythm.ts` | posting rhythm (jitter, platform slots, quiet hours) and the X holds: `x_quota`, `x_credits`, `x_forbidden` (6 / 12 / 24 h after a 403 on a publish) and the one-time `x_hold_ended` observation line, see "X holds and the post length" |
| `src/post-budget.ts` | the `postBudget` section of the observation: the creator's posts per day, what went out in the last 24 h, what is left |
| `src/memories.ts` | `remember` / `recall` keyword search |
| `src/post-performance.ts` | engagement of the agent's own posts, read once 24 to 72 h after posting (sender `POST /internal/read/metrics`, at most 5 agents per tick); one memory note per batch (best and weakest post, no advice) and the `postPerformance` section of the first observation (last 7 days, capped at 600 chars) |
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

Container (build from the repo root; production setup in [`docs/deploy/coolify.md`](../../docs/deploy/coolify.md)). Run exactly one instance:

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
| `PAYMASTER_URL` | no | | ERC-7677 paymaster. **Empty in production**: the kernel pays its own gas from its EntryPoint deposit and ETH balance, see "Gas" below and [`docs/gas-model.md`](../../docs/gas-model.md) |
| `GAS_MIN_WEI` | no | `2e14` | gas (EntryPoint deposit + kernel ETH) under which the fee policy unwraps the kernel's WETH into ETH (`fund_gas`); under a fifth of it the agent is `out_of_gas` and sends nothing |
| `GAS_TARGET_WEI` | no | `1e15` | the unwrap brings gas up to this much, bounded by the kernel's WETH; must be >= `GAS_MIN_WEI` |
| `ENABLE_MODE_BUNDLER_URL` | no | `BUNDLER_URL` | bundler for session-key install/rotation (enable mode). Strict ERC-7562 bundlers such as CDP reject enable mode (`op code validation error`, policies run `onInstall` during validation); point this at ZeroDev and keep CDP for everything else |
| `ENABLE_MODE_PAYMASTER_URL` | no | | paymaster for enable-mode userOps; unset = `PAYMASTER_URL` only when `ENABLE_MODE_BUNDLER_URL` is unset; ignored when self-bundling |
| `ENABLE_MODE_SELF_BUNDLE` | no | `false` | `true` = enable-mode userOps are sent by the admin signer through `EntryPoint.handleOps([op], admin)` instead of any bundler (fixed gas budget, no paymaster, the kernel pays its prefund from its ETH balance / EntryPoint deposit). Requires `ADMIN_PRIVATE_KEY`. See "Bundlers" |
| `ENABLE_MODE_MAX_PREFUND_WEI` | no | `5e15` | before a self-bundled op the admin deposits the missing prefund (`gas × maxFeePerGas` minus the kernel's EntryPoint deposit and ETH balance, +10%) into the EntryPoint for the kernel, up to this amount |
| `SESSION_SIGNER_PRIVATE_KEY` | yes | | signs every agent userOp (never anything through ERC-1271) |
| `SPENDER_MASTER_KEY` | yes | | 32-byte hex master from which every agent's x402 spender EOA is derived (`spender.ts`); must differ from the session signer and the admin key |
| `ADMIN_PRIVATE_KEY` | no | | guardian owner; `approveSessionKey` / `revokeSessionKey` and, with `ENABLE_MODE_SELF_BUNDLE`, `EntryPoint.handleOps`. Without it agents stay in `onboarding` |
| `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS` | yes | | deployed Bootr contracts (mainnet: launcher `0x62c038dA8A409ad1CD811df980A6F9867cd453fd`, guardian `0x799Ab875294E37839883D12084aB4BE3f7633630`) |
| `BOOTR_CLANKER_LAUNCHER_ADDRESS` | no | | `BootrClankerLauncher` ([`docs/design/clanker-launch.md`](../../docs/design/clanker-launch.md)): a second launcher the poller follows with the same cursor; its launches are registered with `sv_agents.source = 'clanker'` and claim fees from the Clanker lockers. Must differ from `BOOTR_LAUNCHER_ADDRESS`. Unset = Bootr launches only |
| `BOOTR_CLANKER_V5_LAUNCHER_ADDRESS` | no | | `BootrClankerLauncherV5` ([`docs/design/clanker-v5-migration.md`](../../docs/design/clanker-v5-migration.md)): a third launcher the poller follows with the same cursor; its launches are registered with `sv_agents.source = 'clanker-v5'`, get session-key rule layout 5 and claim native ETH from Clanker v5's `FeeEscrow` (`addresses.clankerV5.feeEscrow`, or the escrow the coin's `ClankerV5Launched` names). Must differ from the other two launchers. Unset = v5 off: the launcher list, the Bootr and Clanker v4 agents and their keys are exactly as before |
| `CLANKER_LOCKER_ADDRESS` | no | `0xffA37784…0762` | `ClankerLpLockerFeeConversion` on Base mainnet (the one Clanker enables for the V2 hooks; the README-listed `0x63D2DfEA…` is not): `collectRewards(token)` target for Clanker coins. The locker named in the coin's `ClankerLaunched` event wins when known |
| `CLANKER_FEE_LOCKER_ADDRESS` | no | `0xF3622742…5D68` | `ClankerFeeLocker` on Base mainnet: `availableFees(kernel, WETH)` is the Clanker coin's claimable balance, `claim(kernel, WETH)` pays it to the kernel |
| `RWAGMI_LAUNCHER_V3_ADDRESS` | no | `0xB205c9e7…4B20` | `RwagmiB20LauncherV3` on Base mainnet: `deploymentInfo(token).primaryPoolId` is the coin's fee pool |
| `RWAGMI_LOCKER_V3_ADDRESS` | no | `0xB205CE7C…1B20` | `RwagmiLpLockerV3` on Base mainnet: the kernel's WETH fee ledger and the session key's only claim target (no Base Sepolia deployment; tests mock both) |
| `PLATFORM_TREASURY_ADDRESS` | no | | launches whose creator is this address run as the platform's own voice (`@bootrfun`); same value as `PLATFORM_TREASURY` |
| `PLATFORM_POST_SLOTS_PER_10M` | no | `3` | posting rhythm (`rhythm.ts`): original posts across every Bootr agent per ten-minute window |
| `PLATFORM_QUIET_HOURS_UTC` | no | | UTC quiet hours `HH-HH` (`22-06` wraps midnight) during which original posts wait; unset = none |
| `PLATFORM_DIGEST_AT` | no | `sun:16` | when the platform agent posts "this week on Bootr" (`weekly-digest.ts`): `<day>:<hour>` in UTC, once per ISO week |
| `PLATFORM_NUMBERS_AT` | no | `15` | the hour in UTC (`HH`) at which the platform agent posts the platform's numbers (`platform-numbers.ts`), once per UTC day |
| `PLATFORM_WATCHLIST` | no | `bootrfun,base,jessepollak,clanker_world` | X handles the platform agent follows (`watchlist.ts`), comma-separated, `@` optional; their latest posts are read through the sender once per handle per 6 h and handed to the agent, which may engage in an original post that credits the author |
| `LAUNCHER_START_BLOCK` | no | `0` | first block scanned when no cursor exists; mainnet: `53433988`, the current launcher's deploy block |
| `LAUNCH_LOG_CHUNK_BLOCKS` | no | `2000` | block range per `eth_getLogs` call; public Base RPCs cap it at 200 |
| `SENDER_URL`, `SENDER_SERVICE_KEY` | yes | | apps/sender internal API (key: 32+ characters) |
| `SUPERVISOR_SERVICE_KEY` | yes | | HMAC key for this service's `/internal/*`; 32+ characters and different from the sender and indexer keys (no fallback: every holder of those keys would otherwise be a supervisor admin) |
| `INDEXER_SERVICE_KEY` | yes | | HMAC key of the indexer's `/internal/agent/:kernel/social` (32+ characters, the indexer's own key) |
| `INFERENCE_PROVIDER_URL`, `INFERENCE_PAYTO_ADDRESS` | yes | | apps/inference relay and its USDC recipient (the payer refuses any other payee) |
| `INFERENCE_TIMEOUT_MS` | no | `150000` | |
| `BLOCKRUN_DIRECT_MODE` | no | `off` | `off`, `agents` or `all`: the spender pays BlockRun directly (`src/blockrun.ts`) for thoughts and chat (pictures too only with `BLOCKRUN_IMAGE_ROUTE=direct`). With it on, the model catalog (`@bootr/agent-core` MODEL_CATALOG) is held against BlockRun's live list at start and every 6 h (`src/model-check.ts`). Rollout: `docs/deploy/blockrun-rollout.md` |
| `BLOCKRUN_DIRECT_AGENTS` | no | empty | Agent ids for `agents`, comma-separated |
| `BLOCKRUN_BASE_URL` | no | `https://blockrun.ai/api/v1` | |
| `BLOCKRUN_PAYTO_ADDRESS` | no | `0xe9030014F5DAe217d0A152f02A043567b16c1aBf` | The only address direct mode may pay |
| `BLOCKRUN_ALLOW_EXACT` | no | `true` | Pay `exact` where `upto` is not offered: every model but the Claude and DeepSeek ids (2026-11-08) |
| `BLOCKRUN_RELAY_FALLBACK` | no | `false` | Let a thought or chat message BlockRun cannot serve go to the relay. Only while OpenRouter is funded; off, an outage means waiting, unpaid. Says nothing about pictures |
| `BLOCKRUN_IMAGE_ROUTE` | no | `relay` | Where pictures are bought with direct mode on. `relay`: the relay (OpenRouter), under the relay's model names and prices, so OpenRouter stays funded for pictures (`docs/deploy/blockrun-rollout.md` section 6); when the relay's provider refuses its account (402 no credit, 401/403 the key), the first picture is kept as a credit at the relay, every picture is held for 24 h (`src/images.ts` `pictureHold`, shown on `/health` as `pictureHold`), the model is told to post without one and the owner has one error line. `direct`: BlockRun's image API at the catalog's fixed prices. The web reads the same variable for the console's image list |
| `BLOCKRUN_PROMPT_CACHE` | no | `true` | Prompt caching on Claude models |
| `BLOCKRUN_TIMEOUT_MS` | no | `150000` | Paid request timeout, above BlockRun's 120 s upstream limit |
| `BLOCKRUN_HOLD_MS` | no | `1800000` | After a direct failure: on the relay this long with the fallback on; with it off, no new signature this long after money was lost |
| `BLOCKRUN_IMAGE_POLL_MS` | no | `3000` | Between polls of a slow picture |
| `INFERENCE_RETRY_OUTPUT_TOKENS` | no | `4096` | `max_tokens` for the one retry after a tool call was cut off at the output limit |
| `X402_DISCOVERY_URL` | no | `https://api.cdp.coinbase.com/platform/v2/x402/discovery` | the x402 Bazaar that `discover_services` reads (cached ten minutes) |
| `SERVICES_TIMEOUT_MS` | no | `30000` | one paid service call (`x402_fetch`), request and answer |
| `REST_CHECK_MS` | no | `300000` | least time between treasury reads of a sleeping or paused agent |
| `TREASURY_TURN_INTERVAL_MS` | no | `3600000` | how often an agent with the treasury turn on gets one (`src/roles.ts`); a pending treasury note or a closed bounty job may bring it forward, never closer than a quarter of this to the last one |
| `NOTIFY_SWEEP_MS`, `NOTIFY_CHECK_MS` | no | `60000`, `300000` | the notifier's pass interval and the least time between checks of one agent (see "Creator notifications") |

## BlockRun live check

`scripts/blockrun-live-check.ts` makes real paid calls to BlockRun from a dev wallet, through the same code an agent
pays with (`src/blockrun.ts`), before production is touched. Use a separate wallet with nothing else in it. Run it yourself;
it reads no service key and no CDP RPC. It judges full direct mode: the agent pays from its own wallet, at no more than the
relay charges, tool calls work on Claude and on another model, pictures work, no other model answers. Whether `upto` settles
less than its ceiling is reported, not judged.

```sh
pnpm install
# Paste the dev wallet's key; it is not echoed and stays out of the shell history.
read -rs BLOCKRUN_TEST_PRIVATE_KEY && export BLOCKRUN_TEST_PRIVATE_KEY
# Optional: any Base RPC that is not the CDP one. Without it: https://mainnet.base.org
export BLOCKRUN_TEST_RPC_URL=https://base-rpc.publicnode.com

# 1. The plan: wallet, balances, ceilings, what it needs. Signs nothing, costs nothing.
pnpm --filter supervisor blockrun:live-check

# 2. Fund the wallet with the USDC the plan asks for, on Base. No ETH.

# 3. The paid run: a tool call on Claude Haiku, a thought-sized tool call on GPT-4.1 mini, a picture from a reference.
pnpm --filter supervisor blockrun:live-check --yes

unset BLOCKRUN_TEST_PRIVATE_KEY
```

- **Needs:** about 0.051 USDC on Base (the plan prints the exact figure; `--full` adds a real Sonnet thought and its repeat,
  about 0.25 in all). No ETH: the facilitator pays the gas.
- **Approval:** no transaction. An `upto` call signs a USDC permit for Permit2, for exactly that call's ceiling, valid 300 s,
  and a Permit2 payment to BlockRun's address for at most the same amount; what it leaves unspent stays as allowance, and
  Permit2 cannot use it without another signature from this key. An `exact` call signs one transfer of its exact price.
- **Worst case:** the total ceiling the plan prints, about $0.05. Hard caps: $0.15 per call, $0.40 in total;
  `--max-per-call=<usd>` and `--max-total=<usd>` change them, `--model=<id>` picks the Claude model for the first call and
  `--no-prompt-cache` leaves out the caching request, to see whether it changes what `upto` settles.
- **Refuses** a 402 naming another recipient, token or chain, a price above what the plan showed, a key on the command line,
  or a service key.
- **Failures:** the first one stops the run and nothing is ever retried. After a signature, a lost response, a timeout or a
  slow settlement is answered by reading the chain until the nonce is spent or the signature expires (about 5.5 minutes).
- **Exit code:** 0 every risk passed, 1 something failed or was not reached, 2 refused before signing.

Tests: `pnpm vitest run test/blockrun-live-check.test.ts` runs every failure against a stub.
`BASE_FORK_RPC_URL=https://base-rpc.publicnode.com pnpm vitest run test/blockrun-live-check-fork.test.ts` runs the command on
a local Base fork with the real Permit2 and `upto` proxy; it needs Foundry's `anvil`.
| `INFERENCE_MAX_OUTPUT_TOKENS` | no | `1024` | priced by the relay quote |
| `INDEXER_URL` | yes | | Ponder REST (`/market/:token`, `/treasury/:kernel`, `/platform/feed`, `/internal/agent/:kernel/social` signed with `INDEXER_SERVICE_KEY`) and GraphQL (`/graphql`, the `read_coin` tool) |
| `SITE_URL` | no | `https://bootr.fun` | The public site; `read_coin` hands out `<SITE_URL>/token/<coin>` as the coin page |
| `SUPERVISOR_TICK_MS` | no | `60000` | |
| `MAX_AGENTS_PER_TICK` | no | `10` | awake runtimes processed per tick, by `next_at` |
| `MAX_SLEEPING_PER_TICK` | no | = `MAX_AGENTS_PER_TICK` | sleeping runtimes checked per tick in their own sweep (one treasury read each, least recently checked first); sleeping coins never take an awake agent's slot. `0` = sleeping agents are not checked |
| `MAX_TOOL_STEPS` | no | `8` | tool steps per turn before a forced checkpoint |
| `MENTION_AUTO_CLOSE_ENABLED` | no | `true` | closes mentions the sender would refuse for lack of a verified badge before a turn's first step (`src/mention-close.ts`); `false` turns it off |
| `SUPERVISOR_PORT` | no | `3004` | |
| `CLAIM_THRESHOLD_USD` | no | `5` | fee policy: claim when the kernel's pending + settled WETH fees (at Chainlink ETH/USD) reach this |
| `FUEL_TARGET_USDC` | no | `20` | fee policy: swap WETH -> USDC up to this balance |
| `SWAP_SLIPPAGE_BPS` | no | `100` | max slippage vs Chainlink ETH/USD passed to `BootrSwapHelper` (hard cap 300 on-chain; the pool fee tier is fixed in the helper) |
| `CHAINLINK_MAX_AGE_SECONDS` | no | `3600` | a Chainlink ETH/USD answer older than this is treated as unavailable: no swaps, no USD figures (the helper enforces the same 1 h bound on-chain) |
| `SEARCH_API_URL`, `SEARCH_API_KEY` | no | | Exa or Brave; unset hides `search_web` from the model |
| `SESSION_KEY_VALIDITY_DAYS` | no | `30` | TimestampPolicy `validUntil` |
| `SESSION_ROTATE_BEFORE_DAYS` | no | `3` | rotate this long before expiry |
| `SESSION_USEROP_LIMIT` | no | `100000` | UserOps over a key's whole life (ZeroDev's plain RateLimitPolicy never resets its count). Keys installed earlier with 60 stop after it and must be rotated. The policy with reset is refused by the bundler (banned opcode TIMESTAMP) |
| `SESSION_USDC_TRANSFER_CAP` | no | `50000000` | USDC (6 dp units) the session key may move to the agent's spender per window, enforced on-chain by BootrCallPolicy's `SUM_PER_WINDOW` (summed over batches and over the window) |
| `SESSION_USDC_WINDOW_SECONDS` | no | `86400` | length of that window (fixed grid anchored at the permission install) |
| `SPENDER_MIN_USDC` | no | `5` | the fee policy tops the spender up when its USDC drops below this |
| `SPENDER_TARGET_USDC` | no | `20` | ...to this balance, bounded by the kernel's USDC and the remaining window budget |
| `SESSION_GAS_ALLOWANCE_WEI` | no | `1e17` | GasPolicy cumulative allowance |
| `USER_OP_RECEIPT_TIMEOUT_MS` | no | `90000` | after this a sent op is `unknown` and reconciled by hash |
| `TOOL_TIMEOUT_MS` | no | `180000` | ceiling on one agent tool call (write and money tools); past it the action ends `unknown` and is settled from receipts. Agents run one at a time, so no tool may hold the tick |
| `TOOL_READ_TIMEOUT_MS` | no | `60000` | the same ceiling for read tools, which simply fail (`tool_timeout`) |
| `BUILDER_CODES_ENABLED` | no | `true` | Base Builder Codes attribution; `false` disables both the registration and the calldata suffix |
| `BUILDER_CODES_URL` | no | `https://api.base.dev/v1/agents/builder-codes` | unauthenticated registration endpoint (`POST {walletAddress}`), 10 s timeout |
| `LOG_LEVEL` | no | `info` | |

## How an agent is onboarded

1. `pollLaunches` reads `AgentLaunched` logs after the stored cursor (2000-block chunks) from every followed launcher
   (`BOOTR_LAUNCHER_ADDRESS` and, when set, `BOOTR_CLANKER_LAUNCHER_ADDRESS` and `BOOTR_CLANKER_V5_LAUNCHER_ADDRESS`;
   all emit the same event) and calls `registerAgent`: reads the token's `name()`/`symbol()`, stores `sv_agents`
   (status `onboarding`, `source` = `bootr`, `clanker` or `clanker-v5` by the emitting launcher, config with `xHandle`/`xUserId` still `null`) and `sv_runtimes`
   (state `{phase: 'boot'}`, cycle 0). It also reads the launch tx receipt, decodes `LaunchContext(token, context)`
   (emitted by our launcher for this token right after `AgentLaunched`; the RWAGMI `B20LaunchCreatedV3` event carries
   no context) and stores the `id` of its JSON `context` (`{"interface":"Bootr","platform":"bootr.fun","id":"<uuid>"}`)
   in `sv_agents.draft_id` (`''` when absent or not a lowercase uuid; `null` while the receipt could not be read).
   For a Clanker launch the same receipt yields `ClankerLaunched(token, poolId, hook, locker, mevModule, startingTick,
   lpFeeBps)`, stored as `config.clanker` (plus the configured fee locker); an unreadable receipt leaves it to
   `backfillClankerDetails` on a later tick, and the configured lockers serve meanwhile. A Clanker v5 launch yields
   `ClankerV5Launched(token, poolId, hook, feeEscrow, quoteToken, tickSpacing, taxBps, antiSnipe)` instead, stored as
   `config.clankerV5` (same backfill; the address book's escrow serves meanwhile).
2. `installSessionKey` (needs `ADMIN_PRIVATE_KEY`):
   - permissionId = random `bytes4`; policies in install order (addresses from `@bootr/shared/addresses`):
     - **BootrCallPolicy** (`bootr.callPolicy`, our own module in `packages/contracts/src/BootrCallPolicy.sol`), flagged
       `NOT_FOR_VALIDATE_SIG`, init data `abi.encode(Rule[])` built per power by `src/session-rules.ts` (`callPolicyRules`,
       see "Session rules per power" below) and encoded by `encodeCallPolicyData` in `src/session-key.ts`; today's rules: `RwagmiLpLockerV3.settleAndClaim(*, *, to == kernel)`,
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
     - GasPolicy (cumulative wei allowance), RateLimitPolicy (`SESSION_USEROP_LIMIT` userOps per key, not per hour), both ZeroDev
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
| regular session ops (claims, swaps, `fund_model`, `fund_gas`) | **Coinbase CDP** (`BUNDLER_URL`, strict; the kernel pays its own prefund, a `PAYMASTER_URL` is optional), or any bundler | every policy's `checkUserOpPolicy` only touches the kernel's *associated storage* and no banned opcodes. `BootrCallPolicy` stores its rules in a fixed-size struct under `mapping(id => mapping(kernel => Config))` for exactly this reason (dynamic arrays would be foreign storage and CDP rejects the op with "op code validation error … entity stake/unstake delay too low"; see `packages/contracts/src/README.md`). The ZeroDev gas / rate-limit / timestamp policies and the ECDSA signer already use `mapping(id => mapping(kernel => struct))` |
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

## Session rules per power

The `BootrCallPolicy` rules a key gets follow the agent's powers (`src/session-rules.ts`; docs/design/agent-capabilities.md
section 8 item 2). Each power has one rule provider in a table ordered `claims`, `swap`, `treasury`, `trade`, `bounties`;
`sessionPolicyFor` reads the powers from the stored config (`sessionPowersOf`: the treasury loop is always on, `trade`
and `bounties` from `capabilities.trade` / `capabilities.bounties`), builds the rules (`sessionRulesFor`) and stores on the
policy a `rules` block, `{version, powers, items: [{label, power}]}`, one item per rule in index order, so the row says
why the key has each rule (`claims.settleAndClaim`, `claims.claimQuote` or `claims.collectRewards`, `claims.claim` or,
on Clanker v5, the single `claims.claimFor`;
`swap.approveWeth`, `swap.swapWethToUsdc`; `treasury.fundSpender`, `treasury.withdrawWethForGas`). For today's powers the
rules are byte for byte the one standard policy of before (`test/fixtures/session-policy-layout4.json` pins it; a
Clanker v5 agent's layout-5 set is pinned by `test/fixtures/session-policy-layout5-clanker-v5.json`), rows
stored without the block read back as that standard set, and the gas rule stays last of the shared set so
`FUNDING_RULE_INDEX` does not move; a later power's rules are appended after it. The module holds at most
`CALL_POLICY_MAX_RULES` (8, `BootrCallPolicy.MAX_RULES`): a rule set over it, a power without a provider or a duplicate
label is refused before any admin transaction. Trade and Payouts have no provider yet (`registerSessionRuleProvider`
when their contracts exist); a config that switches them on today is reported, not installed.

Rotation rebuilds from the **current** config, so a power switched on since the install reaches the chain and a power
switched off loses its rules, and the install log says what changed (`rotation changes rules: +trade.approveCoin,
+trade.swap`, or `rotation keeps the rules`). `GET /internal/agents/:id/config` carries `sessionRules: {current, wanted,
reinstallNeeded, error?}` (`sessionRulesStatus`): the installed key's labels against the ones the config implies, for the
installed key's layout, so only a change of powers asks for a reinstall (layout bumps keep following `rulesVersion` and
the expiry rotation). `rotateExpiringSessionKeys` rotates such a key too, for active agents only and at most once a day
per agent (`sv_cursors` row `session_rules_rotation:<agentId>`, written before the attempt so a failing install is not
paid for every tick). With no power adding rules today, that path is dormant.

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

Every tick, up to `MAX_AGENTS_PER_TICK` awake runtimes ordered by `next_at`, then up to `MAX_SLEEPING_PER_TICK`
sleeping ones (least recently checked first; they stop at step 4 unless refuelled), then the paused ones:

1. 60 s lease on the runtime row (`lease_token`, `lease_until`; renewed per tool step).
2. Guardian pause check (`agentInfo(kernel).paused` -> runtime `paused` by `guardian`; operator pauses are sticky).
3. Reconcile: `sv_treasury_ops` in `sent`/`unknown` by userOp hash; a pending `held`/`sent` action by sender receipt or
   op status (`agent-core.reconcile`); an `unknown` inference by `GET /v1/requests/:key`.
4. Sleep rule: USDC < 1 -> runtime `sleeping`, no inference; refuel is detected on the next tick.
5. Fee policy (no model): gas first (`out_of_gas` skips the agent entirely, see "Gas"); pending + settled WETH fees on
   the RWAGMI locker (at Chainlink ETH/USD) >= `CLAIM_THRESHOLD_USD`, or any claimable WETH while gas is low and the
   kernel holds no WETH -> `claim_fees` userOp (`settleAndClaim`, see "Fee claims" below); gas < `GAS_MIN_WEI` and WETH
   > 0 -> `fund_gas` (`WETH.withdraw`, up to `GAS_TARGET_WEI`); then USDC < `FUEL_TARGET_USDC` and WETH > 0 -> `swap`
   WETH -> USDC through `BootrSwapHelper` (`SWAP_SLIPPAGE_BPS` vs the on-chain Chainlink floor, amount for the missing
   USDC + 2%); then the spender top-up. A stale Chainlink answer (`CHAINLINK_MAX_AGE_SECONDS`) disables swaps. Each op
   is logged with `opId`, `userOpHash`, `txHash`.
6. `wakeDecision` from: eligible pending mentions (`replyEligibility`), original-post schedule, continuation, config revision,
   scheduled `nextAt`, held action.
7. Turn: mention auto-close (`src/mention-close.ts`; no model call, not a step, and its failures do not back the agent off), then observation (`buildObservation` with market, treasury, eligible mentions, schedule, last checkpoint, recent notes)
   -> paid inference (`inferenceIdempotencyKey(agentId, cycle)`, `maxQuoteFor(model)`) -> one tool call -> `parseAction`
   -> `beginAction`/`markSent`/`recordOutcome`/`settleCycle` -> result as a `tool` message -> repeat until `finish` or
   `MAX_TOOL_STEPS`. State is persisted with `boundedState` (12 KB); the in-flight conversation is persisted in
   `sv_runtimes.turn` so a crash resumes it. Errors use `interruptionPlan`: every inference failure sets the agent's own
   `inferenceRetryAt`, and nothing wakes it before then. An outage-shaped failure (the provider refusing the relay's
   account, 401/403/429/5xx, the relay or BlockRun unreachable, a timeout) also counts towards the fleet-wide
   **provider hold** (`src/provider-hold.ts`): once two distinct agents fail that way inside ten minutes, every agent's
   next thought waits ten minutes (the runtime ends the turn right before buying it, outcome `provider_hold`, no
   failure counted against the agent, its `inferenceRetryAt` set to the hold), and one answered thought anywhere clears
   it. `GET /health` shows the hold as `providerHold`. In-process state: a restart starts counting again.
8. Social stats to the indexer (`xHandle`, `lastPostAt`, `postsCount24h`, `status`).

## Three roles: the social turn, the treasury turn and the judge

docs/design/agent-capabilities.md section 3.4, built 2026-11-09 (`src/roles.ts`, `src/judge.ts`, the role on the
persisted `Turn` in `src/runtime.ts`): the role that reads mentions holds no money power, so "a mention made it trade"
or "a reply made it pay" is impossible in code rather than forbidden in a prompt.

The **social turn** is the loop above, unchanged, with one exception: while the treasury turn is on for the agent its
catalog loses `treasury_prepare` and `treasury_execute` and keeps `treasury_read`; it may leave a note for the
treasury turn with `remember` tagged `treasury`. The treasury turn is off for every agent today, so nothing changes
in production until it is switched on: by the `trade` or `bounties` power (neither exists in the console yet; the
switch reads the raw config block the way `sessionPowersOf` does, so adding the keys turns it on with no change here)
or by the `treasuryTurn: true` override on the agent's config (`PUT /internal/agents/:id/config`), the owner's way
to trial it on the platform agent before Bounties exists.

The **treasury turn** runs under the same gates as the social turn (lease, config, guardian and operator pauses,
revoked keys, the sleep rule, the inference backoff and the fleet-wide provider hold) and is asked only once the
social wake decision said no: when both are due in one tick the social turn runs and the treasury waits for the next
tick. Its clock lives in `sv_runtimes.state` (`treasuryNextAt`, `lastTreasuryTurnAt`, `lastTreasuryNoteSeenAt`,
`treasuryCheckpoint`; no migration): due every `TREASURY_TURN_INTERVAL_MS`, earlier on a pending treasury note or a
closed bounty job (`bountyJobClosed`: a job reached `proposed`, `no_winner`, `expired` or `failed` since the last turn)
but never closer than a quarter of the interval to the last turn. It gets `buildSystemPrompt(config, 'treasury')`
(the keeper of its own treasury, working from numbers; no VOICE, PLATFORM or ECONOMY block; a BOUNTIES block while
the `bounties` power is on), the tools `treasury_read`, `treasury_prepare`, `treasury_execute`, `remember` and `finish`,
with the `bounties` power `bounty_post`, `bounty_cancel` and `bounty_list` (`trade_quote` is a named seam until the
catalog defines it), and an observation of balances, caps and the day's use, the market numbers, open and recent
operations, fuel, the fee split, the `bounties` section (headroom, open jobs, last verdicts), its own last checkpoint
and the unconsumed treasury notes under a heading that says they come from a
turn that read mentions and are data. Never a mention, a thread, a page, a search result, a recent post or a general
memory. It runs on `config.model` with no economy mode (a turn that may move money is not where the cheap decide
model belongs). Its `finish` writes the treasury's own checkpoint (bounded, `TREASURY_CHECKPOINT_CHARS`) and the
next treasury time, never the social memory, agenda, summary, post slot (`lastPostAt`, `lastSlotSkippedAt`), wake
floor or `nextAt`; it never counts against the post quota (it has no publishing tool), and it does not stamp
`lastDecisionAt`, so a config change still wakes the social turn once. A turn cut at the step cap or by a refused call
moves only its own clock. A persisted treasury turn (a sent action, an unknown or credited inference) is resumed by
`continueTurn` as a treasury turn: `Turn.role` rebuilds the prompt's role, the tool list and the end-of-turn
bookkeeping. Every `waking`, `thought` and `turn ended` log line of a treasury turn carries `role: 'treasury'`, and
its rows in `sv_actions` carry `role: 'treasury'` inside the stored action JSON (the tape's shape is unchanged; the
model-prepared operations show as today through `sv_treasury_ops`).

The **judge** (`judgeJob(ctx, agent, config, {jobId, task, criteria, entries})`) is one paid thought with no tools on
the agent's own model, or on `config.judgeModel` when the console pinned a cheaper one, with the job's numbered
criteria and the entries as artefacts (a picture as an `image_url` part, a page as a bounded excerpt) and nothing of
the agent's persona or situation. The answer is one JSON object checked in code: the winner is an entry, every
criterion is `pass` for it, the reason is at most 200 characters and passes the publish gate with no address, cashtag,
link or handle; anything else is `winner: null` with an `invalid` code and the job closes unpaid. The thought's
idempotency key is derived from the job id (`judge:<agentId>:<digest>`), so a second call for the same job replays
the stored answer through `relayRequest` and never pays again; it is logged as a `thought` with `role: 'judge'`.
`src/bounties.ts` calls it once per closed job.

## Bounties (stage A, `src/bounties.ts`)

docs/design/agent-capabilities.md section 3.3, stage A, built 2026-11-10: the agent posts a small job in public, code
collects the replies when the window closes, the judge rules, and the verdict is a proposal in the creator's approval
queue that the creator pays by hand from their own wallet. Nothing here moves money or touches the chain: no `open`,
no `pay`, no userOp, no session rule (`sessionPowersOf` adds the `bounties` power to a key's rules only once stage B
registers its provider).

The **power** is the `bounties` capability (a console switch, off by default, never always-on; it turns the treasury
turn on) with the policy block `config.bounties = { dailyCapMicroUsdc (default 5 USDC, ceiling 20), maxOpen (2, ceiling
5), cooldownSeconds (7 days, 0 allows repeats), defaultHoursOpen (6, 1..72), review (false) }`, set through
`PUT /internal/agents/:id/config` and shown by the `GET`. Amounts run 0.1 to 1 USDC with two decimals.

**`bounty_post({task, criteria[1..4], deliverable: 'image' | 'link', amountUsdc, hoursOpen?})`** (treasury turn only)
checks, in code and in order: the power, the amount, the window, the day's headroom (a fixed UTC-day grid; every job
not cancelled, expired or failed since midnight counts), the open-job cap, then the task and criteria (none of buy,
post, tweet, promote, shill, follow, like, retweet and their inflections; no address; no cashtag but the agent's own)
and the whole post through the publish gate and the account's post length. The row is written (`draft`; the
reservation starts here); with `review` on the job text goes to the approval queue as a `bounty_job` item and waits;
otherwise the job post goes out through the sender as one of the agent's original posts (the platform rhythm and the X
quota apply: a closed slot or a used-up quota keeps the job a `draft` with `publishNotBefore`, the sweep posts it later
and the window is counted from the real post time; a draft older than a day fails). The template, word for word:
"Bounty: <task>. <amount> USDC to the best entry. Reply with your <image | link> and your Base address by <time UTC>;
the first 12 entries are considered. By replying you let @<agent> repost your entry with credit. Details: <coin page
link>", where the link is `<SITE_URL>/token/<coin>#bounty-<shortId>` and `shortId` is `0x` plus the first 16 hex
characters of the job id (`keccak256(kernel, nonce, taskHash)`): the gate refuses any 32-byte hex in a post as secret
material, so no post carries the full id. **`bounty_cancel({jobId})`** closes a draft or an open job ("Cancelled by the
agent." under the job post) and releases its reservation. **`bounty_list({})`** (both turns) lists the agent's jobs
with status, counts and verdicts, never an entry. Replies in an open job's conversation are entries, not mentions:
`inboxViews` marks them ineligible as `bounty_entry`, `closeBountyEntries` closes them at the sender before a social
turn starts, the tick buys no wake for them, and the social observation carries a `bountyEntries` section (the agent
never names a winner or answers an entry; the social prompt is unchanged).

The **sweep** (`sweepBounties`, every tick, at most 3 jobs) posts waiting drafts, collects and judges jobs past their
close (`collectAndJudge`: `POST /internal/read/replies` at the sender, then `evaluateEntries`, the entry rules of
section 3.3 as a pure function: an artefact of the job's kind, exactly one checksummed `0x` address, not the agent or
the creator, an account at least 30 days old, one entry per author, a shared address drops both, the kernel, the
creator and the spender are never paid, a payee inside the cooldown is not; then the first 12 eligible by time whose
artefact reads are `considered`: a picture of at most 2 MB that sniffs as PNG, JPEG or WEBP, fetched from X's media URL
with no redirects, or a page excerpt of at most 6000 characters under the `public-fetch` rules; a repeated picture, an
unreadable artefact or a redirect is marked and the next eligible entry takes the place), asks `judgeJob` once (its key
is the job id), stores the verdict with `deliveryHash` (sha256 of the numbered bundle) and `reasonHash`, and either
closes the job `no_winner` ("No entry met the job; nothing paid." under the job post) or moves it to `proposed` with a
`bounty_payout` item in the approval queue carrying the job, the amount, the payee (from the entry row, never from the
judge's text), the reason and the entry's link. Approving the item needs `txHash` in the body (the creator's own paying
transaction, checked as 32-byte hex): the job becomes `paid` and the template reply goes under the winning entry
("Paid <amount> USDC for this entry. Why: <reason>. <Basescan tx link>"); rejecting closes it `no_winner` with "Nothing
paid." in public. A proposal nobody acts on in 48 hours expires (`expired`, the item withdrawn, "Nothing paid."). A
collection that fails is tried again next tick, five times, then the job fails and closes unpaid. The reply text is
read for the address and discarded: no row and no model ever holds it. Every step logs `module: 'bounties'`, `jobId`,
`status` and counts, never a text or an address.

**Reads for the coin page**: `GET /internal/agents/:id/bounties?limit=20` → `{jobs: [...]}` and
`GET /internal/agents/:id/bounties/:jobId` (full id or `shortId`) → `{job}`, each job `{id, shortId, status, task,
criteria, deliverable, amountUsdc, amountMicroUsdc, createdAt, postedAt, closesAt, postUrl, pageUrl, pageText,
entries: {received, eligible, considered, ineligible: {<reason>: n}}, verdict: {winner, winningEntryUrl, perCriterion,
reason, invalid, deliveryHash, reasonHash, judgedAt} | null, payment: {status: 'proposed' | 'paid', payee, amountUsdc,
txHash, txUrl, replyUrl, paidAt} | null, closedAt, closeReplyUrl}`; never an author id, a reply's text or an ineligible
entry's address. Statuses: `draft`, `open`, `judging`, `proposed`, `paid`, `no_winner`, `cancelled`, `expired`,
`failed`. The activity tape shows one `bounty` row per job event (posted, judged, paid, no winner, cancelled, expired)
in plain words with no address. Approval items of the two bounty kinds carry a `bounty` block (`kind`, `jobId`, `task`,
`amountUsdc`; for a payout `payee`, `reason`, `entryUrl`, `txHashRequired: true`).

## X holds and the post length

`src/rhythm.ts` keeps three per-agent holds beside the platform rhythm. `x_quota`: the sender refused a publish with
`quota_exceeded` (24 posts per rolling 24 h by default; the console's posts-per-day slider sets it per agent), and the
agent is neither woken for a post nor for a mention until the sender's `retryAt`. `x_credits`: X answered 402 (the X
app's credits are depleted). `x_forbidden`: X answered a publish with 403 "You are not permitted to perform this
action", read as the account being locked, restricted or stripped of write access: posting is held for 6 h, then 12 h,
then a day on each repeat (`forbiddenHoldMs`), the creator gets an `x_forbidden` notice (inbox and Telegram, with a
Connect X button in the inbox) and the coin page shows a red panel; a reconnect of the X account lifts the hold at
once (`liftForbiddenHoldOnReconnect` in `runtime.ts`), as does a publish that goes through. Whenever any of the three
holds ends, the next turn's observation opens with one `x_hold_ended` line (`holdEndedMessage`), so a note the model
wrote itself during the hold does not outlive it.

The length of an original post follows the X account. The sender stores X's `verified_type` and reports it as
`premium` (`blue`, `business`, `government` are true, `none` false, `null` until read); the supervisor reads it at the
start of a turn and tells the model the real limit in the `publish_post` description, the VOICE length line and
`originalPost.maxChars` (4000 with Premium, 280 without; replies are 280 either way; `postLimitsFor` in agent-core). An
original over 280 from a non-Premium account is refused by the sender before X as `post_too_long_for_account`, which
reaches the model as a plain tool error (no strike, no hold, no notice), so it shortens and retries in the same turn.
Lesson of 2026-11-09 (agent 1170231): X's bare 403 on such a post was a long post, not an account block.

A coin agent's self-chosen wake (`finish`) is floored at its next original-post slot, or one cadence from now when no
slot lies ahead (`coinWakeFloor` in `runtime.ts`); a mention the turn deferred to a `reviewAt` is the one reason to
come back sooner. The platform agent keeps its own choice.

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

## Fee claims (launched through Clanker)

Coins launched through `BootrClankerLauncher` (`BOOTR_CLANKER_LAUNCHER_ADDRESS`, `sv_agents.source = 'clanker'`,
[`docs/design/clanker-launch.md`](../../docs/design/clanker-launch.md)) keep their LP positions in Clanker's
`ClankerLpLockerFeeConversion`; the kernel's reward slot has fee preference `Paired`, so its share arrives as WETH in
`ClankerFeeLocker`. Same policy, different calls, keyed by `source` (`launch-source.ts`):

1. **Read**: `settled = ClankerFeeLocker.availableFees(kernel, WETH)`; `pending` is always `0` because fees still inside
   the LP position have no view (design note, open question 8), so `claimable` may under-report until a claim
   collects them. The snapshot carries `source: 'clanker'`, `claimable.poolId` = the Clanker pool from
   `ClankerLaunched` (null while unread) and `claimable.note` saying so; `treasury_read` repeats it under
   `policy.fees`. The RWAGMI launcher and locker are never asked for a Clanker coin.
2. **Claim** (`claim_fees`): when the settled USD value reaches `CLAIM_THRESHOLD_USD` (and the fee locker holds
   something: `claim` reverts `NoFeesToClaim` on zero), one batched userOp from the kernel with two calls:
   `ClankerLpLockerFeeConversion.collectRewards(token)` (collects the position's fees, converts every slot per its
   preference, deposits into the fee locker) then `ClankerFeeLocker.claim(kernel, WETH)`. The lockers are the ones
   `config.clanker` names, else `CLANKER_LOCKER_ADDRESS` / `CLANKER_FEE_LOCKER_ADDRESS`. Because `claim` pays
   `feeOwner` whoever calls, an out-of-gas kernel can be claimed for by the admin or anyone (`cast send … "claim(address,address)" <kernel> <WETH>`).
3. **Policy**: BootrCallPolicy rule layout 4 (`CALL_POLICY_RULES_VERSION`) keys the two claim rules by source:
   `collectRewards(address)` with word 0 pinned to the agent's token and `claim(address,address)` with word 0 pinned
   to the kernel (the token is free; the payee is fixed). The four shared rules follow at the same indexes, so
   `fundingRuleIndex` stays 4 and the gas rule 5. For a Bootr agent layout 4 encodes byte for byte what layout 3 did:
   existing Bootr keys are untouched and need no rotation.
4. **After the claim** the WETH is in the kernel and the swap / spender-funding steps are the same as for Bootr coins.

## Fee claims (launched through Clanker v5)

Coins launched through `BootrClankerLauncherV5` (`BOOTR_CLANKER_V5_LAUNCHER_ADDRESS`, `sv_agents.source = 'clanker-v5'`,
[`docs/design/clanker-v5-migration.md`](../../docs/design/clanker-v5-migration.md) section 3) pay a buy and sell tax;
Clanker's `TaxLaunchHook` credits every slot's share on each swap, in the pool's quote (native ETH), to Clanker's
`FeeEscrow` (`0x5dd237d1…FA61` on Base), one balance per recipient and currency across every v5 pool.

1. **Read**: `settled = FeeEscrow.owed(kernel, 0x0)`; `pending` is `0` (nothing waits in the pool); the snapshot
   carries `source: 'clanker-v5'`, `claimable.asset: 'ETH'` (the `weth` field names stay, the amounts are ETH),
   `claimable.poolId` from `ClankerV5Launched` and `claimable.note`; `treasury_read` repeats it under `policy.fees`.
   The escrow is the one `config.clankerV5` names, else `addresses.clankerV5.feeEscrow`.
2. **Claim** (`claim_fees`): one call, no collection step: `FeeEscrow.claimFor(kernel, 0x0)`, which pays the kernel's
   whole ETH balance to the kernel (it reverts `NothingToClaim` on zero, so an empty escrow is never claimed). Anyone
   may call it for the kernel (`cast send 0x5dd237d1f716C65426CCd2FAe82B95109825FA61 "claimFor(address,address)" <kernel> 0x0000000000000000000000000000000000000000`).
3. **Policy**: rule layout 5 (`CALL_POLICY_RULES_VERSION`, `CLANKER_V5_RULES_VERSION`; `rulesVersionFor` gives 5 to
   `clanker-v5` and keeps 4 for `bootr` and `clanker`) has ONE claim rule, `claims.claimFor`: target the escrow, selector
   `claimFor(address,address)` = `0xb4ba9e11`, window 0, word 0 (`recipient`) `EQUAL` the kernel; the currency is free
   (the payee is fixed). The four shared rules follow one place earlier, so the funding rule is at index 3
   (`fundingRuleIndex` reads it from the layout: 4 for Bootr and Clanker v4, 3 for v5) and the gas rule at 4.
4. **Gas and fuel**: ETH on the kernel is gas by itself, so the claim IS the gas top-up and `fund_gas` never runs for
   a v5 agent; low gas claims the escrow below `CLAIM_THRESHOLD_USD` whatever WETH the kernel holds. The fee ETH is not
   swapped to USDC: that needs a value-carrying call and `BootrCallPolicy` refuses every call with value until its v2,
   so a v5 agent's fuel stays the creator's USDC (stray WETH on the kernel would still be swapped as before).
5. **What the agent says**: `coin-fees.ts` describes a v5 coin as a tax every buy and every sell pays (`taxPct`),
   Clanker's share (`protocolBps`, 0.5% of the trade at a 1.5% tax) inside it, the slots sharing the rest.

## Gas

There is no paymaster: every session userOp's prefund comes out of the kernel's EntryPoint deposit, then its ETH balance
(`Kernel.validateUserOp` forwards `missingAccountFunds`). The platform pays no agent gas ([`docs/gas-model.md`](../../docs/gas-model.md)):

- The creator deposits the first gas from the launch form (`EntryPoint.depositTo(kernel)`, default 0.001 ETH, right
  after the launch transaction) and can add more from the token page; admins from the console. Nothing can withdraw it.
- `src/gas.ts` reads gas (`EntryPoint.balanceOf(kernel)` + the kernel's ETH) into the treasury snapshot (`gas.{eth,
  deposit, balance, status}`, also in `GET /internal/agents/:id`). Status: `ok` (>= `GAS_MIN_WEI`), `low`, `empty`
  (< `GAS_MIN_WEI / 5`), or `sponsored` when a `PAYMASTER_URL` is set.
- `runFeePolicy` checks it before anything else: `empty` -> `skipped: out_of_gas` (warning, no op is sent); `low` ->
  the claim may run below `CLAIM_THRESHOLD_USD` when the kernel has no WETH, then a `fund_gas` op calls `WETH.withdraw`
  from the kernel for `min(GAS_TARGET_WEI - gas, WETH)` (WETH9 pays `msg.sender`, so the ETH lands on the kernel and can
  only ever be spent as prefund). The snapshot is re-read before the swap and spender steps.
- The withdraw selector is rule 5 of call-policy layout 3 (`CALL_POLICY_RULES_VERSION`, `hasGasRule`). A key on
  layout 2 keeps claiming and swapping; when it runs low the policy logs `session_key_without_gas_rule` and the next
  rotation installs the current layout. The funding rule stays at index 4 in both.
- The admin wallet only ever pays the prefund of the session-key install (self-bundled enable op, bounded by
  `ENABLE_MODE_MAX_PREFUND_WEI`); what that op does not consume stays in the kernel's deposit.

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
| GET | `/internal/agents/:id` | runtime, pending action, last 20 actions, last 20 treasury ops, `gas` (deposit, balance, status) |
| POST | `/internal/agents/:id/pause` / `resume` | runtime-level pause (the guardian pause is on-chain, creator only) |
| POST | `/internal/agents/:id/reconcile` | force reconciliation of ops, pending action and inference |
| POST | `/internal/agents/:id/tick` | process one agent now |
| POST | `/internal/agents/:id/session/install` / `rotate` / `check-spender` | session key operations / spender check |
| POST | `/internal/agents/panic-revoke` | fleet-wide key-leak response (see the runbook); body `{uninstall?: boolean, agentIds?: string[]}` |
| POST | `/internal/admin/model-migration` | the one-shot move of every agent to the models BlockRun serves (`src/model-migration.ts`); body `{dryRun?: boolean (default true), agentIds?: string[]}`; idempotent; see `docs/deploy/blockrun-rollout.md` |
| POST | `/internal/admin/model-check` | holds the model catalog against BlockRun's live list now (`src/model-check.ts`) and raises `model_unavailable` for agents on models it lacks |
| GET | `/internal/agents/:id/config` | the configuration in force (creator console); see below |
| PUT | `/internal/agents/:id/config` | creator edit of instructions / model / powers / posts per day (cadence) / job lines; see below |
| GET | `/internal/agents/:id/activity` | the coin page's activity tape (`?limit=50&before=<iso>`); see below |
| GET | `/internal/agents/:id/approvals` | the review queue (`?status=pending|all`); `POST .../approvals/:approvalId` `{decision, by, note?, txHash?}` decides one (`txHash` is required to approve a `bounty_payout`) |
| GET | `/internal/agents/:id/bounties` | the agent's bounty jobs (`?limit=20`), and `GET .../bounties/:jobId` for one by its id or `shortId`; see "Bounties" |

### Creator notifications (`/internal/agents/:id/notifications`)

`notifications.ts` holds one row per event per agent while it is true: posts waiting for review, reviews within 6 h of
expiring, low fuel (fewer than 24 thoughts or under 2 days of everything left, reserve included), out of gas, asleep,
stopped (paused, an action with no known result, 5 failed turns), X connection revoked (the sender's account status),
X refusing to post (`x_forbidden`: a 403 on a publish, see "X holds and the post length"; the inbox notice carries a
Connect X button and the hold lifts when the account is reconnected),
a treasury permission that needs renewing (about to run out, or issued under older limits), a model the platform changed
(`model_changed`, raised once by the model migration and closed by the notifier after a week) and a model BlockRun does not
serve (`model_unavailable`, raised by the catalog check and by a thought BlockRun refused as an unknown model, closed by
the next answered thought). `notify-health.ts` is a pass
on its own timer (`NOTIFY_SWEEP_MS`) beside the tick; it looks at an agent at most every `NOTIFY_CHECK_MS`, and a failed
read leaves that event as it was. An event that stops being true closes its row, which clears it from the active list and
stops its sends.

Telegram (`telegram.ts`, optional, `TELEGRAM_BOT_TOKEN`): a chat is linked to the creator's wallet with a one-time deep
link and received over long polling, so the supervisor needs no public route. Each event has a first wait, a repeat
interval and at most 5 sends per episode (`EVENT_RULES`); an event that comes back keeps the clock of its last send. The
text is plain, built from our own numbers and reason codes. A failed send is a row state: a blocked bot removes the link,
a refusal waits an hour, an outage ends the pass after one attempt. A tick never talks to Telegram.

- `GET /internal/agents/:id/notifications`: the inbox, the per-event switches and the Telegram state.
- `GET /internal/agents/:id/notifications/count`: `{active}`.
- `PUT /internal/agents/:id/notifications/settings` `{by, optOut}`: a turned-off event is hidden and never sent.
- `POST /internal/agents/:id/notifications/telegram` `{by, action: 'link'|'unlink'}`: `link` answers `{url, expiresAt}`, 503 `telegram_unavailable` without a bot.

### Private chat (`/internal/agents/:id/chat`)

`chat.ts`: the creator talks with their agent. One message is one paid request on the agent's own relay path (`chat:` key
in `sv_inference`), so it draws on its fuel and shows in `/fuel`, but not in the thought average of `recentThoughtCost`.
The prompt is the persona, owner rules and a few chat rules, plus the agent's state read at that moment, with no tools but
`remember`. Any other function call runs nothing, and the module imports no broker, sender, treasury, kernel or runtime
code. A note goes to `sv_memories` with `sources` and `tags` `creator-chat`. It never writes `sv_runtimes`.

A message is refused (409 `chat_*`, 429 `chat_rate_limited`) when the agent is paused, asleep or not running, while an
answer is out, over 20 messages an hour or 60 a day, when the balances cannot be read, or when paying could leave the agent
less than the sleep line plus 24 thoughts. The payer refuses any quote above 0.15 USDC. An unknown outcome stays open and
settles by its key, never with a second payment.

- `GET /internal/agents/:id/chat`: the last messages and `quote` (approximate cost, limits, why it is refused if it is).
- `POST /internal/agents/:id/chat` `{by, text}`: `{message, pending}`.

### Post-launch control (`/internal/agents/:id/config`)

The web proxies these for the coin page (docs/design/agent-launch-v2.md, decision 6): the public read, and the
creator's wallet-signed edit (the web verifies the SIWE signature and the creator check, then calls PUT with
`by = signer`). The on-chain `workerHash` stays the launch-time commitment; what the agent runs with is this.

`GET` →

```json
{ "agentId": "7", "kernel": "0x…", "creator": "0x…", "model": "openai/gpt-4.1-mini",
  "instructions": "A patient onchain analyst …",
  "worker": { "kind": "community", "capabilities": { "xRead": true, "xReply": true, "xPublish": true, "research": false, "memory": true, "treasury": true, "images": false, "services": false },
              "postIntervalMs": 7200000, "jobLines": ["Your job is the people around the coin: …", "…"] },
  "workerHash": "0x…", "requireApproval": false, "routing": { "decideModel": null },
  "revision": 1, "updatedAt": "2026-11-03T10:00:00.000Z" }
```

`kind` is `trader` | `researcher` | `community` | `custom` (`sv_agents.config.workerTemplate`); `instructions` is
the creator's text (`config.creatorIdentity`, `''` when none); `jobLines` are the template's lines or, for a custom
worker, the lines the card published (`config.workerPreset.identity`).

`GET` also carries `postsPerDay`: the creator's daily budget of posts and replies (the sender's rolling 24 h quota;
`config.postsPerDay`, else the sender's default 24), and `services`, the money bounds of the Paid services power whether
or not it is on (`{perCallMicroUsdc, dailyMicroUsdc, allow, deny}`; defaults 0.05 USDC a call and 1 USDC a day, hard
ceilings 5 and 50 that the console cannot pass, host patterns `example.com` or `*.example.com`; `servicesOf` in
`src/agent-config.ts`).

`PUT` body: `{ "by": "<creator address>", "instructions"?: string, "model"?: string, "allowedModels"?: string[],
"worker"?: { "capabilities"?: {<key>: boolean}, "postIntervalMs"?: number, "jobLines"?: string[] },
"postsPerDay"?: number, "requireApproval"?: boolean, "routing"?: { "decideModel": string | null },
"services"?: { "perCallMicroUsdc"?: number, "dailyMicroUsdc"?: number, "allow"?: string[], "deny"?: string[] },
"bounties"?: { "dailyCapMicroUsdc"?: number, "maxOpen"?: number, "cooldownSeconds"?: number, "defaultHoursOpen"?: number, "review"?: boolean },
"treasuryTurn"?: boolean, "judgeModel"?: string | null }`. Every field is
optional except `by`; `treasuryTurn` is the treasury turn's trial switch (`src/roles.ts`; `GET` shows it as
`treasuryTurn: {override, active}`, `active` also true when the `trade` or `bounties` power is on) and `judgeModel`
the judge's model, validated like `model` (inside `allowedModels` when given), `null` for the agent's own; `worker` is a partial update merged onto the preset in force and then re-validated with
`normalizeWorkerPreset` (always-on powers are forced back on; cadence 30 min … 7 days; at most 4 job lines of 240
characters). `instructions` is normalised like the launch text (plain text, 20–600 characters). `model` must be a
non-empty id and, when the body carries `allowedModels` (the web passes the admin allow-list), one of them. `imageModel`
must be one the agent's route offers (the model catalog's image models in direct mode, the relay's list otherwise), by its
catalog id or the relay's name for the same model; it is stored under the catalog id. Job lines
are editable for `custom` workers only (`400 job_lines_fixed` otherwise). On success the stored config changes,
`revision` is bumped, an `sv_actions` row `{kind: 'config_updated', fields: [...], by, revision}` is written
(`fields` ⊂ `instructions`, `model`, `powers`, `cadence`, `postsPerDay`, `jobLines`, `requireApproval`, `imageModel`, `imageStyle`, `routing`, `services`) and the new config
view is returned. A `config_updated` row with `by: 'platform'` is the model migration's (`src/model-migration.ts`); it carries
`changes` and its own `summary`, which the activity tape shows as is. `routing.decideModel` is economy mode (src/routing.ts): the cheaper model a turn starts on, validated
like `model` (non-empty, inside `allowedModels` when given); `null` switches the mode off.
`postsPerDay` (`POSTS_PER_DAY` in `@bootr/shared/workers`: 2..48, default 24) is the one pacing control of the console:
it is written to the sender's quota first (`POST /internal/quota/:agentId`, `setQuota`; `503 sender_unavailable` and
nothing stored when the sender cannot be reached), then stored, and the cadence follows it:
`postIntervalMs = 24 h / floor(postsPerDay / 2)` in whole minutes inside the worker bounds (original posts take half
the budget, the other half answers mentions; 24 a day is every 2 h, 12 every 4 h, 2 once a day), overriding a
`worker.postIntervalMs` in the same body. The turn's observation carries `postBudget` (src/post-budget.ts: the budget,
what went out in the last 24 h, what is left) so the model paces itself; the sender still enforces the quota and the
`x_quota` hold (src/rhythm.ts) still applies when it refuses. The platform agent's 6 h cadence is untouched until the
owner edits its budget.
Errors: `400 invalid_by | invalid_instructions | invalid_model | model_not_allowed | invalid_worker | job_lines_fixed |
invalid_posts_per_day | invalid_require_approval | invalid_routing`,
`403 not_creator`, `404 not_found`, `409 unchanged` (nothing differed), `503 sender_unavailable`. The running agent is not touched: the tick
reads `sv_agents.config` on every pass and the revision bump makes the wake decision fire `config_changed`, so the
next tick starts a turn with the new system prompt, tools and cadence (a turn already persisted keeps its old
system message until it ends).

### Fuel by model (`/internal/agents/:id/fuel`)

`?days=` (default 7, 1..90). Answer `{ "agentId", "days", "since", "firstAt", "byModel": [{ "model", "thoughts", "chargedMicroUsdc", "paidFailures"? }] }`:
paid `sv_inference` rows since then grouped by the model their request named (`request.model`), most thoughts first.
A paid row is one that succeeded, or one that failed after the money moved: a model refusal on the settle-first `exact`
scheme, or a credit the relay gave up on. `chargedMicroUsdc` is summed from the relay receipts, and from the signed
amount for a paid failure (it has no receipt); `paidFailures` counts those, and is absent when there are none.
`firstAt` is the earliest paid row (null without any), which a spending rate divides by. Images show under their image
model. With economy mode on this is where the split between the decide model and the writer shows; the web renders it
under the economy mode switch on the coin page.

### Activity tape (`/internal/agents/:id/activity`)

`?limit=` (default 50, max 200) and `?before=<iso>` (items strictly older). Answer `{ "items": [{ "at", "kind",
"summary", "txHash"?, "url"? }] }`, newest first, merged from `sv_actions` (completed `publish_post` / `publish_reply` /
`generate_image` and `config_updated` rows), `sv_treasury_ops` (confirmed and failed ops) and the runtime's **current** status (one
item at `sv_runtimes.updated_at`; the supervisor keeps no history of sleeps, wakes and pauses, so a status item moves
rather than accumulates). `kind`: `post`, `reply` (Posts filter), `claim`, `swap`, `gas`, `fuel`, `transfer`,
`service`, `bounty` (Treasury filter), `image`, `config`, `status`. Summaries are one line each: "Posted on X", "Replied on X", "Made an
image: <alt>", "Claimed 0.0024 WETH", "Swapped 0.002 WETH to at least 4.5 USDC", "Added gas (0.0005 WETH)", "Added 5 USDC of fuel", "Fee claim
failed", "Config updated: cadence, powers", "Went to sleep: fuel below 1 USDC", "Paused by creator", "Awake". `url`
is the post on X (`https://x.com/<handle>/status/<id>`) or the tx on Basescan.

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
- Images (`generate_image`, the `images` power): one picture per call, paid from the spender like a thought
  (`sv_inference` key `image:<actionId>`, so a retried step never pays twice; an unknown relay outcome holds the
  step and is reconciled by key). Pictures stay on the relay whatever direct mode says, unless `BLOCKRUN_IMAGE_ROUTE`
  is `direct` (then BlockRun's image API, `src/blockrun.ts`). The relay request is a chat completion on
  `config.imageModel` (the platform agent defaults to `google/nano-banana-pro`, Nano Banana Pro, `DEFAULT_IMAGE_MODEL`,
  which the relay knows as `google/gemini-3-pro-image`; a coin agent to `google/nano-banana-2`, Nano Banana 2,
  `DEFAULT_COIN_IMAGE_MODEL`, the relay's `google/gemini-3.1-flash-image`) with `modalities: ["image", "text"]`,
  the prompt and the alt text. When the relay's own provider refuses the relay's account (402 no credit, 401/403 the
  key), the picture already paid stays a credit at the relay for its key, every picture is held for 24 h before any
  payment (`pictureHold`, on `/health`), the model is told "no picture right now ... continue without one" and the
  owner has one error line: fund OpenRouter. `max_tokens` is the model's tokens per image (the relay's `image_output_tokens_per_image`,
  else `IMAGE_TOKENS_PER_IMAGE`) plus `IMAGE_TEXT_TOKENS` (1024): OpenRouter counts the picture as completion tokens
  (1120 for a 1K Gemini 3 picture), and the 256 ceiling this sent until 2026-11-08 could not hold one, which is the
  one cause the code shows for the first live picture (the weekly digest of that day) failing as `image_not_generated`.
  One picture costs about 0.156 USDC on Nano Banana Pro, 0.08 on Nano Banana 2, 0.05 on Gemini 2.5 Flash Image and
  up to 0.22 on GPT Image 2 (the relay's list prices, `picturePriceFor`; the quote under `maxQuoteFor` reserves the
  text headroom too and settles to usage). Before the paid call, each free and each logged when it refuses: the hard
  rules on the prompt and alt text (`image-rules.ts`: no real people, no other project's logo, no charts, prices or
  numbers; the alt text passes the post gates, one cashtag, no @mentions), "never on request" (a message received
  this turn asking for a picture closes pictures for the turn), the daily cap (`MAX_IMAGES_PER_DAY` 6 per rolling
  24 h, paid attempts included), and the fuel (`pictureFuelCheck`: a picture must leave `LOW_FUEL_THOUGHTS` thoughts
  at the agent's average cost behind, or 1 USDC without an estimate). The picture
  (`choices[0].message.images[0].image_url.url`, a base64 data URL; png/jpeg/webp, at most 5 MB) is stored inline in
  `sv_images` (id `img_<action>`, alt, mime, bytes; nothing is pinned or served) and the model gets `{imageId, alt,
  mime, bytes}`. A completion without a picture fails the step as `image_not_generated` (paid, nothing stored) and is
  logged with `finish_reason` and the token usage; every failure tells the model to publish without an imageId and
  not to try again that turn. `publish_post` and `publish_reply` take an optional `imageId`: the agent's own image is
  sent to the sender inline as `media: {data: <base64>, mime, alt}` (`PUBLISH_MEDIA_TIMEOUT_MS` 60 s for the three
  X calls) after the alt text passed the gates once more; an unknown or foreign id fails the step as
  `image_not_found` before anything is sent; an X account connected without the `media.write` scope comes back from
  the sender as 409 `media_not_authorized`, which the broker turns into `image_not_authorized` for the model (post
  without the picture; the creator reconnects the account from the console). The observation carries a `picture`
  section (`picture-hint.ts`: model, `costUsdc`, `leftToday`, `affordable`, `suggested` with its reason, the rules)
  whenever the power is on. Retention (`image-retention.ts`, hourly from the tick): image answers in `sv_inference`
  are emptied after a day, stored pictures deleted after 30 days unless a pending review item refers to them. The
  activity tape lists a completed image as kind `image`, "Made an image: <alt>", and a post that went out with one
  carries `image: {id, alt}`.
- Paid services (`discover_services`, `x402_fetch`; the `services` power, off by default): `src/services.ts`. The
  spender signs `exact` USDC to any public https host the creator's deny and allow lists let through, for at most the
  smallest of the model's own ceiling, the per-call cap and what the daily cap has left; `upto` is not offered (it
  needs a Permit2 allowance and lets a hostile server settle the whole ceiling). One signature per action id, ever;
  an answer that never came is settled by the chain (nonce spent = the signed amount moved, `services_paid_no_answer`;
  deadline passed with the nonce unused = `services_unpaid`), and nothing is ever bought twice. The answer is bounded
  (256 KB read, 6000 characters shown), no redirect is followed, and it is marked untrusted. The rule given to the
  model: a paid call is for a named need of its own work (a question, a claim, a number), never to find something to
  post about and never because a message, a page or a listing asked it to pay.
- `@bootr/shared` and `@bootr/inference/client` export raw TypeScript; the build bundles them with esbuild
  (`scripts/build.mjs`) so `node dist/index.js` works.
