# indexer (apps/indexer)

Ponder 0.18 indexer for Bootr. It is the single read source for the web app (GraphQL + REST) and
for the supervisor's `read_market` / `treasury_read` tools. Shapes are defined in
[`docs/data-contract.md`](../../docs/data-contract.md).

## Run

```sh
# Base Sepolia, PGlite (no database needed). Env is read from the process environment.
pnpm --filter indexer dev            # http://localhost:42069  (/graphql, REST helpers)

pnpm --filter indexer typecheck
pnpm --filter indexer test           # vitest: pure helpers in src/lib/*.test.ts
INDEXER_URL=http://localhost:42069 pnpm --filter indexer smoke   # queries platformStats etc.

# production (Postgres)
INDEXER_DATABASE_URL=postgres://... DATABASE_SCHEMA=bootr_v1 pnpm --filter indexer start

# container (build from the repo root); PORT must be the indexer's own, not the sender's from .env
docker build -f apps/indexer/Dockerfile -t bootr-indexer .
docker run --rm --env-file .env -e PORT=42069 -e DATABASE_SCHEMA=bootr_v1 -p 42069:42069 bootr-indexer
```

The image runs `scripts/start.sh` (`ponder start --schema $DATABASE_SCHEMA`; on Railway, without
`DATABASE_SCHEMA`, one schema per deployment named after `RAILWAY_DEPLOYMENT_ID`). Ponder refuses to
reuse a schema that was built by different indexing code, so a fixed `DATABASE_SCHEMA` must be bumped
(`bootr_v2`, ...) whenever the indexer changes. See [`docs/deploy/railway.md`](../../docs/deploy/railway.md).

Ponder only auto-loads `apps/indexer/.env.local`; export the variables (or use your usual env
loader) to point it at the root `.env`. When sourcing the root `.env`, override `PORT` (it holds the
sender's port there; Ponder reads `PORT` too): `PORT=42069 pnpm --filter indexer dev`. Without
`SENDER_SERVICE_KEY` the `/internal/agent/:kernel/social` route answers `401 not_configured` and the
web shows agents without an X handle.

`ponder dev` hot-reloads on any change under `apps/indexer`; with PGlite that reload can abort in-flight
queries ("PGlite is closed", exit code 75). Restart it after editing, or run `ponder start` for long
backfills. `INDEXER_MAX_RPS` (default 50) caps the JSON-RPC rate across all configured urls.

Until the Bootr contracts are deployed (`BOOTR_LAUNCHER_ADDRESS` empty), the indexer boots with a
warning and only runs the snapshot block handler (ETH/USD, empty platform rollups). Set
`BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS` and `BOOTR_START_BLOCK` (launcher deploy block)
after `forge script script/Deploy.s.sol`, then delete `.ponder/` to reindex.

## Environment

| Var | Required | Notes |
| --- | --- | --- |
| `CHAIN_ID` | no | `84532` (default) or `8453`. One chain per process. |
| `BASE_SEPOLIA_RPC_URL` / `BASE_RPC_URL` | recommended | Falls back to public endpoints. The RPC must serve old block headers: Base Sepolia has 200 ms blocks and Ponder's finality search probes from block 0, which pruned nodes (sepolia.base.org) reject. |
| `BOOTR_LAUNCHER_ADDRESS` | for indexing | Empty = launch-derived sources skipped. |
| `BOOTR_GUARDIAN_ADDRESS` | for indexing | Empty = AgentGuardian skipped (no activity/pause/dormancy). |
| `BOOTR_START_BLOCK` | for indexing | Launcher deploy block. Empty = `latest`. |
| `INDEXER_DATABASE_URL` | prod | Postgres. Empty = PGlite in `.ponder/pglite`. (`DATABASE_URL` is deliberately not used, so other services' DB does not switch the indexer to Postgres.) |
| `DATABASE_SCHEMA` | prod | Required by `ponder start` on Postgres. |
| `INDEXER_SNAPSHOT_INTERVAL` | no | Blocks between snapshots. Default ~60 s (30 on Base, 300 on Base Sepolia). |
| `INDEXER_SERVICE_KEY` | for REST writes | HMAC key for `POST /internal/agent/:kernel/social` and for signing `ADMIN_CONFIG_URL` requests (`SENDER_SERVICE_KEY` still accepted with a deprecation warning). |
| `ADMIN_CONFIG_URL` | no | e.g. `https://bootr.fun/api/admin/config`; supplies `graduationThresholdUsd` (default 50000). |
| `BOOT_TOKEN_ADDRESS` | no | Platform BOOT coin (fallback when admin config has no `bootToken`). |
| `INDEXER_CORS_ORIGIN` | no | Comma-separated CORS origins for browser reads. Empty = `https://bootr.fun`; outside `NODE_ENV=production` any `localhost` / `127.0.0.1` origin is accepted too; `*` = any origin. `NEXT_PUBLIC_WEB_ORIGIN` (older name) is used when this is empty. Ponder answers preflights itself with `*`, so the policy is enforced on the actual response (`src/lib/cors.ts`). |
| `CHAINLINK_ETH_USD_FEED` | no | Override the ETH/USD aggregator. |
| `FUEL_SCAN_MAX_RANGE` | no | eth_getLogs block range for the USDC fuel scan (default 5000). |

Contract addresses (Clanker v4, FeeLocker, `ClankerLpLockerFeeConversion`, PoolManager, USDC,
WETH, ERC-8004) come from `@bootr/shared` `getAddresses(chainId)`.

## What is indexed

| Source | Events | Notes |
| --- | --- | --- |
| `BootrLauncher` | `AgentLaunched` | Creates token/agent/pool rows. The launch tx receipt is replayed for Clanker `TokenCreated` (name, symbol, image, poolId), the dev-buy `Swap`, initial coin `Transfer`s and the USDC fuel transfer, since they precede `AgentLaunched`. |
| `BootrToken` (factory: `AgentLaunched.token`) | `Transfer` | `balance` table, `token.holders` (non-zero balances, excluding 0x0 and 0x…dEaD). |
| `BuybackBurner` (factory: `AgentLaunched.burner`) | `Swapped`, `Burned` | `burn` rows, `token.burnedTotal`, BOOT burn stats. |
| `PoolManager` | `Swap` | All swaps are delivered; only pool ids in the `pool` table are kept. On Base mainnet this means fetching every v4 swap log (Ponder cannot filter on a dynamic pool-id set). |
| `ClankerLpLockerFeeConversion` | `ClaimedRewards` | `feeAccrual` per recipient/asset (post fee-preference conversion), `feeBalance`. |
| `ClankerFeeLocker` | `ClaimTokens`, `ClaimTokensPermissioned` | `feeClaim`, split across coins by outstanding balance. |
| `AgentGuardian` | `Activity`, `AgentPaused`, `DormantClaimed`, `SessionKeyApproved`, `SessionKeyApprovalRevoked`, `SessionKeyUninstalled`, `SessionNonceInvalidated` | Agent status inputs, `dormantClaim`, `sessionKey`. |
| ERC-8004 `ReputationRegistry` | `NewFeedback`, `FeedbackRevoked` | `agent.reputationScore` = mean of `value / 10^valueDecimals` over non-revoked feedback. Base Sepolia only (mainnet address not verified yet). |
| `BootrSnapshot` block handler | every `INDEXER_SNAPSHOT_INTERVAL` blocks | See below. |

### Derived vs on-chain

On-chain (exact): launches and their parameters, trades (amounts, side, pool price), balances and
holders, fee accruals/claims, burns, dormancy claims, session keys, feedback, USDC fuel.

Derived:
* **Prices**: coin/WETH from `sqrtPriceX96`; USD via Chainlink ETH/USD (Base Sepolia feed
  `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`, verified `description() = "ETH / USD"`).
  `marketCapUsd = priceUsd × totalSupply`; `liquidityUsd` from the locked Clanker position liquidity (computed at launch from the one-sided deposit)
  evaluated over the Clanker position range.
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
  kernel balances, `spender` + `spenderUsdc`, `ClankerFeeLocker.availableFees` per recipient and asset), and
  `POST /internal/agent/:kernel/social` signed like the sender
  (`Authorization: HMAC <ts>:<hex(HMAC-SHA256(SENDER_SERVICE_KEY, ts\nPOST\npath\nsha256(body)))>`)
  with `{xHandle?, lastPostAt?, postsCount24h?, status?: 'awake'|'sleeping', spender?: hex|null}`
  (stored in `bootr_offchain.agent_social` / `.ponder/agent-social.json`).

## Layout

```
abis/            ABIs as `const` (Bootr from packages/contracts/out, Clanker v4, v4 PoolManager, Chainlink, ERC-8004)
ponder.config.ts single-chain config, skips undeployed sources
ponder.schema.ts tables + relations
src/*.ts         indexing functions (launcher, market, fees, guardian, reputation, snapshot)
src/lib/         pure helpers (+ tests) and indexing helpers
src/api/         Hono app: GraphQL, REST, SSE
scripts/smoke.ts GraphQL smoke test
```
