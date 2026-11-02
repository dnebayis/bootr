# indexer (apps/indexer)

Ponder 0.18 indexer for Bootr. It is the single read source for the web app (GraphQL + REST) and
for the supervisor's `read_market` / `treasury_read` tools. Shapes are defined in
[`docs/data-contract.md`](../../docs/data-contract.md).

## Run

```sh
# PGlite (no database needed). Env is read from the process environment. Default CHAIN_ID is 84532 (Base Sepolia),
# which only runs the snapshot handler (no RWAGMI v3 there); set CHAIN_ID=8453 and BASE_RPC_URL to index launches.
pnpm --filter indexer dev            # http://localhost:42069  (/graphql, REST helpers)

pnpm --filter indexer typecheck
pnpm --filter indexer test           # vitest: pure helpers in src/lib/*.test.ts
INDEXER_URL=http://localhost:42069 pnpm --filter indexer smoke   # queries platformStats etc.

# production (Postgres)
INDEXER_DATABASE_URL=postgres://... DATABASE_SCHEMA=bootr_mainnet_v1 pnpm --filter indexer start

# container (build from the repo root); PORT must be the indexer's own, not the sender's from .env
docker build -f apps/indexer/Dockerfile -t bootr-indexer .
docker run --rm --env-file .env -e PORT=42069 -e DATABASE_SCHEMA=bootr_mainnet_v1 -p 42069:42069 bootr-indexer
```

The image runs `scripts/start.sh` (`ponder start --schema $DATABASE_SCHEMA`; without `DATABASE_SCHEMA` it falls
back to `RAILWAY_DEPLOYMENT_ID`, a leftover of the Railway era). Production uses the fixed schema `bootr_v1`.
Ponder refuses to reuse a schema that was built by different indexing code, so the name must be bumped
(`bootr_v2`, ...) whenever the indexer changes, and the new schema backfills from `BOOTR_START_BLOCK` (about an
hour). See [`docs/deploy/coolify.md`](../../docs/deploy/coolify.md) section 2.

Ponder only auto-loads `apps/indexer/.env.local`; export the variables (or use your usual env
loader) to point it at the root `.env`. When sourcing the root `.env`, override `PORT` (it holds the
sender's port there; Ponder reads `PORT` too): `PORT=42069 pnpm --filter indexer dev`. Without
`SENDER_SERVICE_KEY` the `/internal/agent/:kernel/social` route answers `401 not_configured` and the
web shows agents without an X handle.

`ponder dev` hot-reloads on any change under `apps/indexer`; with PGlite that reload can abort in-flight
queries ("PGlite is closed", exit code 75). Restart it after editing, or run `ponder start` for long
backfills. `INDEXER_MAX_RPS` (default 50) caps the JSON-RPC rate across all configured urls.

Coins launch through the RWAGMI v3 launcher (B20 Asset tokens in Uniswap v4 pools; see
[`docs/rwagmi-migration.md`](../../docs/rwagmi-migration.md)), which exists on **Base mainnet only**.
Without `BOOTR_LAUNCHER_ADDRESS`, or on a chain without the RWAGMI v3 stack (Base Sepolia), the
indexer boots with a warning and only runs the snapshot block handler (ETH/USD, empty platform
rollups). Production runs `CHAIN_ID=8453` with the RWAGMI-backed launcher `0xD3CE024ddC37465510E6c9a1D7942f003338B1F3`
(`BOOTR_LAUNCHER_ADDRESS`, deployed at block 53219209 = `BOOTR_START_BLOCK`) and the guardian
`0x799Ab875294E37839883D12084aB4BE3f7633630` (`BOOTR_GUARDIAN_ADDRESS`; both also default from `@bootr/shared`);
after changing any of them delete `.ponder/` (or bump `DATABASE_SCHEMA`) to reindex. Local dev runs against a
Base mainnet fork (`base-anvil`, see [`docs/deploy/coolify.md`](../../docs/deploy/coolify.md) section 8). Public host:
`https://indexer.bootr.fun` (GraphQL at `/graphql`, REST, SSE `/stream`, `/ready`).

## Environment

| Var | Required | Notes |
| --- | --- | --- |
| `CHAIN_ID` | no | `84532` (default) or `8453`. One chain per process. |
| `BASE_SEPOLIA_RPC_URL` / `BASE_RPC_URL` | recommended | Falls back to public endpoints. The RPC must serve old block headers: Base Sepolia has 200 ms blocks and Ponder's finality search probes from block 0, which pruned nodes (sepolia.base.org) reject. |
| `BOOTR_LAUNCHERS` | for indexing (several launchers) | Comma-separated `address@startBlock` list of every BootrLauncher to follow, e.g. `0xD3CE024ddC37465510E6c9a1D7942f003338B1F3@53219209,0x<new launcher>@<its deploy block>`. Wins over the two single-launcher variables below. A malformed entry aborts the boot (never silently drops a launcher). Every Bootr source starts at the earliest listed block. See "Adding a launcher" below. |
| `BOOTR_LAUNCHER_ADDRESS` | for indexing (single launcher) | Fallback when `BOOTR_LAUNCHERS` is empty: one launcher, overriding the address book (`@bootr/shared`, `[chainId].bootr.launcher`). No launcher on the chain = launch-derived sources skipped. |
| `BOOTR_GUARDIAN_ADDRESS` | for indexing | Overrides the address book. Empty = AgentGuardian skipped (no activity/pause/dormancy). |
| `BOOTR_START_BLOCK` | for indexing (single launcher) | Deploy block of `BOOTR_LAUNCHER_ADDRESS` (mainnet: `53219209`; `LAUNCHER_START_BLOCK`, the supervisor's name, is accepted when this is empty). Ignored with `BOOTR_LAUNCHERS`. Empty = `latest`. RWAGMI sources start at `max(start block, 52861401)` (the RWAGMI v3 launcher's creation block), which is `53219209` with the value above: only coins launched by BootrLauncher matter. |
| `RWAGMI_LAUNCHER_V3_ADDRESS` / `RWAGMI_HOOK_V3_ADDRESS` / `RWAGMI_LOCKER_V3_ADDRESS` | no | Override the RWAGMI v3 stack (defaults: the Base mainnet addresses in `src/lib/env.ts`; none on Base Sepolia). All three are needed. |
| `INDEXER_DATABASE_URL` | prod | Postgres. Empty = PGlite in `.ponder/pglite`. (`DATABASE_URL` is deliberately not used, so other services' DB does not switch the indexer to Postgres.) |
| `DATABASE_SCHEMA` | prod | Required by `ponder start` on Postgres. |
| `INDEXER_SNAPSHOT_INTERVAL` | no | Blocks between snapshots. Default ~60 s (30 on Base, 300 on Base Sepolia). |
| `INDEXER_SERVICE_KEY` | for REST writes | HMAC key for `POST /internal/agent/:kernel/social` and for signing `ADMIN_CONFIG_URL` requests (`SENDER_SERVICE_KEY` still accepted with a deprecation warning). |
| `ADMIN_CONFIG_URL` | no | e.g. `https://bootr.fun/api/admin/config`; supplies `graduationThresholdUsd` (default 50000). |
| `BOOT_TOKEN_ADDRESS` | no | Platform BOOT coin (fallback when admin config has no `bootToken`). |
| `INDEXER_CORS_ORIGIN` | no | Comma-separated CORS origins for browser reads. Empty = `https://bootr.fun`; outside `NODE_ENV=production` any `localhost` / `127.0.0.1` origin is accepted too; `*` = any origin. `NEXT_PUBLIC_WEB_ORIGIN` (older name) is used when this is empty. Ponder answers preflights itself with `*`, so the policy is enforced on the actual response (`src/lib/cors.ts`). |
| `CHAINLINK_ETH_USD_FEED` | no | Override the ETH/USD aggregator. |
| `FUEL_SCAN_MAX_RANGE` | no | eth_getLogs block range for the USDC fuel scan (default 5000). |

PoolManager, USDC, WETH and ERC-8004 addresses come from `@bootr/shared` `getAddresses(chainId)`;
the RWAGMI v3 stack (launcher `0xB205c9e7…4B20`, hook `0xB20B0036…B20Ec`, LP locker
`0xB205CE7C…1B20`, Base mainnet) from `RWAGMI_V3` in `src/lib/env.ts` or the env above.

### Adding a launcher

A BootrLauncher is replaced by deploying a new one and pausing the old one; the old one's coins keep
trading, so the indexer follows **every** launcher ever used, never just the current one. `ponder.config.ts`
registers the `BootrLauncher` source and the `BootrToken` / `BuybackBurner` factories with the whole address
list (Ponder takes an address array per source), filters RWAGMI's `B20LaunchCreatedV3` on `creator` being any
of them, and starts every Bootr source at the earliest deploy block. Handlers use `event.log.address` for the
emitting launcher, so nothing else cares which launcher a coin came from (the schema has no launcher column).

To add one, append it to `BOOTR_LAUNCHERS` (keep the old entries; the first switch moves the current
`BOOTR_LAUNCHER_ADDRESS` + `BOOTR_START_BLOCK` pair into the list):

```sh
BOOTR_LAUNCHERS=0xD3CE024ddC37465510E6c9a1D7942f003338B1F3@53219209,0x<new launcher>@<new launcher deploy block>
DATABASE_SCHEMA=bootr_v2   # bumped: see below
```

**A new launcher needs a new `DATABASE_SCHEMA` and a backfill.** Ponder's build id is a hash of the resolved
config (contract addresses included), the schema and the indexing code (`ponder/dist/esm/build/index.js`), and
`ponder start` refuses a schema whose stored build id differs ("previously used by a different Ponder app"), so
the indexer does **not** pick a new address up on restart: bump `DATABASE_SCHEMA`, let the new schema backfill
from the earliest start block, then `ponder db prune` the old schema. The backfill is much faster than the
first one: Ponder keeps its raw RPC cache (blocks, logs, receipts) in the shared `ponder_sync` schema, which the
new app schema reuses, so only the new launcher's logs (and its coins' transfers / burners) are fetched from the
RPC; the indexing functions still replay every event. Keep the old launcher listed forever: dropping it drops
its coins (OWL `0xb2000000000000000000004481c175669cbc8edb`, launched at block 53406588 by `0xD3CE…B1F3`, is the
first one).

## What is indexed

| Source | Events | Notes |
| --- | --- | --- |
| `RwagmiLauncherV3` | `B20LaunchCreatedV3` (filtered: `creator == BootrLauncher`), `LaunchPoolCreatedV3` | Stage the launch (`rwagmiLaunch`: name, symbol, supply, primary pool) and its pool (`pool`: id, v4 key, hook fee mode / static fee, starting tick). Pools of launches not staged (non-Bootr) are dropped. Both precede `AgentLaunched` in the launch tx. |
| `BootrLauncher` | `AgentLaunched` | Creates token/agent rows from the staged launch + pool. Reads the locked reward split from `RwagmiLpLockerV3.launchInfo(token).rewards` (`feeSlot`, `token.*Bps`). Replays the launch tx receipt for `LiquidityPlacedV3` (exact position range + liquidity), the dev buy (`PoolFeeTakenV3` + `Swap`), initial coin `Transfer`s and the USDC fuel transfer, since they precede `AgentLaunched`. Image / metadata from the `launch()` calldata, else the B20 `contractURI()`. |
| `BootrToken` (factory: `AgentLaunched.token`) | `Transfer` | `balance` table, `token.holders` (non-zero balances, excluding 0x0 and 0x…dEaD). |
| `BuybackBurner` (factory: `AgentLaunched.burner`) | `Swapped`, `Burned` | `burn` rows, `token.burnedTotal`, BOOT burn stats. |
| `PoolManager` | `Swap` | All swaps are delivered; only pool ids in the `pool` table are kept. On Base mainnet this means fetching every v4 swap log (Ponder cannot filter on a dynamic pool-id set). |
| `RwagmiHookV3` | `PoolFeeTakenV3` | Gross swap fee (WETH) per swap: `token.feesTotalUsd`, `dailyStat.feesUsd`, `platformStats.feesTotalUsd`; plus one `feeAccrual` per Bootr reward slot (`gross × bps / 10000`) and its `feeBalance.accrued`. |
| `RwagmiLpLockerV3` | `PoolFeesSettledV3`, `QuoteRewardsClaimedV3` | Settlement credits a slot's recipient (`feeCredit`, `feeBalance.settled`; RWAGMI's slot skipped). A claim pays a recipient's settled balance across all its coins: `feeClaim`, split across coins by `settled - claimed`. |
| `AgentGuardian` | `Activity`, `AgentPaused`, `DormantClaimed`, `SessionKeyApproved`, `SessionKeyApprovalRevoked`, `SessionKeyUninstalled`, `SessionNonceInvalidated` | Agent status inputs, `dormantClaim`, `sessionKey`. |
| ERC-8004 `ReputationRegistry` | `NewFeedback`, `FeedbackRevoked` | `agent.reputationScore` = mean of `value / 10^valueDecimals` over non-revoked feedback. Registry address from `@bootr/shared` (mainnet `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`). |
| `BootrSnapshot` block handler | every `INDEXER_SNAPSHOT_INTERVAL` blocks | See below. |

### Derived vs on-chain

On-chain (exact): launches and their parameters, reward slots, trades (amounts, side, pool price),
balances and holders, gross fees, settlements and claims, burns, dormancy claims, session keys,
feedback, USDC fuel.

### Fees (RWAGMI v3)

All fees are WETH: the hook charges a static swap fee (`token.lpFeeBps`, hundredths of a bip,
10 000 = 1%) in the paired asset only; the pool's native LP fee is 0. Of each fee, Bootr's reward
slots get 9 000 bps (`agentBps + creatorBps + burnBps + platformBps`) and RWAGMI 1 000
(`protocolBps`, `protocolRecipient`). Token / daily / platform "fees" are the gross fee; the per-kind
figures (`/token/:id/fees`, `dailyStat.fees{Agent,Creator,Burn,Platform}Usd`) are Bootr's slots
only, so they sum to 90% of it. A slot's fee is pending in the locker until a pool is settled
(`settle` / `settleAndClaim`), then claimable by its recipient: claimable now =
`pendingQuote(poolId, recipient) + claimableQuote(recipient, WETH)`. `feeAccrual` amounts are
`gross × bps / 10000` per swap, which can differ from the locker's cumulative credit by a few wei.

History (2026-10-29): the Clanker v4 launchers paid fees in WETH or in the coin itself (Clanker's fee
preference). With RWAGMI `feeAccrual` / `feeClaim` / `feeBalance.asset` is always WETH, and `/treasury`'s
`claimable` has one WETH row per recipient instead of a WETH and a coin row. Coins launched by the two
earlier Clanker-backed launchers (`0xD4747d91…84EF`, `0x386CBE5D…e21d`) are not indexed by this version.

Derived:
* **Prices**: coin/WETH from `sqrtPriceX96`; USD via Chainlink ETH/USD (Base Sepolia feed
  `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`, verified `description() = "ETH / USD"`).
  `marketCapUsd = priceUsd × totalSupply`; `liquidityUsd` from the locked launch position's
  liquidity (`LiquidityPlacedV3`) evaluated over the launch position range.
* **Trade fee**: `trade.feeUsd = valueUsd × (Swap.fee + lpFeeBps) / 1e6` (feeds `fees24hUsd`); exact
  WETH fees come from `PoolFeeTakenV3`.
* **Rolling windows**: hourly buckets (`tokenWindow`) → `volume24hUsd`, `volume7dUsd`,
  `fees24hUsd`, `change24hPct`.
* **Status** (`src/lib/status.ts`): claimed > dormant > paused > sleeping (kernel + spender USDC < 1) > awake
  (activity < 6 h) > sleeping.
* **Graduation**: sticky once `marketCapUsd >= platformConfig.graduationThresholdUsd`.
* **Rollups**: `dailyStat`, `platformStats`.
* **Snapshot handler**: near the tip it refreshes ETH/USD, pool state (`PoolManager.extsload`),
  kernel balances (USDC, WETH, ETH via Multicall3 `getEthBalance`, own coin) plus the USDC float of
  each agent's x402 spender EOA (`agent.spenderUsdc`; address from the supervisor's social push) in
  one multicall, the admin config, the supervisor social data, and scans USDC `Transfer` logs into
  kernels (eth_getLogs with an OR-list of kernel topics). During backfill the RPC/HTTP reads are
  skipped. `treasuryUsdc` is the kernel only; `treasuryUsd` and the sleep rule count the spender too.

## Consumers

* **Web** (`apps/web/lib/indexer.ts`): GraphQL at `/graphql` (`tokens`, `token { agent }`,
  `trades`, `agents { tokenRef }`, `dailyStats`, `platformStats(id: "global")`), REST `/search`,
  `/token/:id/fees`, `/holdings/:owner`, `/fuel/:from`, and SSE `/stream` hints
  (`{type: 'launch'|'trade'|'agent', tokenId}`; clients re-fetch).
* **Supervisor**: `GET /market/:token` (coin or kernel address), `GET /treasury/:kernel` (live
  kernel balances, `spender` + `spenderUsdc`, and `claimable`: one WETH row per recipient (agent,
  creator, burn, platform) with `amount = pending + settled` from the RWAGMI v3 LP locker
  (`pendingQuote(poolId, recipient)` + `claimableQuote(recipient, WETH)`; `settled` aggregates all
  the recipient's coins)), and
  `POST /internal/agent/:kernel/social` signed like the sender
  (`Authorization: HMAC <ts>:<hex(HMAC-SHA256(SENDER_SERVICE_KEY, ts\nPOST\npath\nsha256(body)))>`)
  with `{xHandle?, lastPostAt?, postsCount24h?, status?: 'awake'|'sleeping', spender?: hex|null}`
  (stored in `bootr_offchain.agent_social` / `.ponder/agent-social.json`).

## Layout

```
abis/            ABIs as `const` (Bootr from packages/contracts/out, RWAGMI v3 launcher / LP locker / hook from
                 @rwagmi/token-launcher-sdk 0.3.0, B20 token, v4 PoolManager, Chainlink, ERC-8004)
ponder.config.ts single-chain config, skips undeployed sources
ponder.schema.ts tables + relations
src/*.ts         indexing functions (launcher, market, fees, guardian, reputation, snapshot)
src/lib/         pure helpers (+ tests) and indexing helpers
src/api/         Hono app: GraphQL, REST, SSE
scripts/smoke.ts GraphQL smoke test
```
