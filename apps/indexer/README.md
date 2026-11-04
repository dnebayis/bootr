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

Coins come through two launch paths, both on **Base mainnet only** (`token.source`):

* **bootr**: `BootrLauncher` launches through the RWAGMI v3 launcher (B20 Asset tokens in Uniswap v4 pools; see
  [`docs/rwagmi-migration.md`](../../docs/rwagmi-migration.md)). Needs `BOOTR_LAUNCHERS` and the RWAGMI stack.
* **clanker**: `BootrClankerLauncher` launches through Clanker v4 (see
  [`docs/design/clanker-launch.md`](../../docs/design/clanker-launch.md)). Needs `BOOTR_CLANKER_LAUNCHERS`; empty =
  the path is off. The wrapper emits the same `AgentLaunched` plus `ClankerLaunched`; fees are collected by Clanker's
  LP locker and paid by its fee locker (addresses in `CLANKER_V4`, `src/lib/env.ts`, verified on chain 2026-11-04).

Without any launcher, or on a chain without the launch stacks (Base Sepolia), the
indexer boots with a warning and only runs the snapshot block handler (ETH/USD, empty platform
rollups). Production runs `CHAIN_ID=8453` with the RWAGMI-backed launcher `0x01f290cC464Ac6D167588b35A08305F58683526f`
(`BOOTR_LAUNCHER_ADDRESS`, deployed at block 53433988 = `BOOTR_START_BLOCK`) and the guardian
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
| `BOOTR_CLANKER_LAUNCHERS` | for the Clanker path | Comma-separated `address@startBlock` list of every `BootrClankerLauncher` ever used (same format and rules as `BOOTR_LAUNCHERS`; an address cannot be on both lists). Empty = the Clanker path is off. Clanker sources start at the earliest listed block. Adding one = new `DATABASE_SCHEMA` + backfill, like a Bootr launcher. |
| `CLANKER_FACTORY_ADDRESS` / `CLANKER_HOOK_ADDRESS` / `CLANKER_LOCKER_ADDRESS` / `CLANKER_FEE_LOCKER_ADDRESS` | no | Override the Clanker v4 stack (defaults in `CLANKER_V4`, `src/lib/env.ts`: factory `0xE85A59c6…83a9`, static fee hook V2 `0xb429d62f…28CC`, LP locker `0xffA37784…0762` (the enabled one, not the `0x63D2…` the docs list), fee locker `0xF3622742…5D68`; none on Base Sepolia). All four are needed. |
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

The Clanker path has its own list, `BOOTR_CLANKER_LAUNCHERS`, with the same rules (keep every wrapper ever used;
the `BootrClankerLauncher` source, the coin factory and the two Clanker locker sources follow it). Turning the path
on, or adding a wrapper, is the same operation as below: the address lists and the schema (`token.source`,
`clankerPool`, `sourceStats`) are part of the build id, so the first deploy with this version needs a new
`DATABASE_SCHEMA` and a backfill even before any Clanker launcher is listed.

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
| `BootrClankerLauncher` | `ClankerLaunched`, `AgentLaunched` | Clanker path. `ClankerLaunched` stages `clankerPool` (pool id, hook, locker, MEV module, starting tick, the LP fee actually used). `AgentLaunched` reads the receipt for Clanker's `TokenCreated` (name, symbol, image, metadata, context, extensions supply) and the locker's `TokenRewardAdded` (pool key, reward slots, position range), falling back to the token's views and `tokenRewards(token)`; writes the `pool` row (dynamic-fee key), token / agent / `feeSlot` rows (`source: 'clanker'`, four slots summing to 10000, the burn slot's recipient `0x…dEaD`, `protocolBps` 2000 = Clanker's 20% on top), and replays the dev-buy swap, coin transfers and the USDC fuel. |
| `BootrToken` (factory: `AgentLaunched.token` of both launcher lists) | `Transfer` | `balance` table, `token.holders` (non-zero balances, excluding 0x0 and 0x…dEaD). |
| `BuybackBurner` (factory: `AgentLaunched.burner`, Bootr launchers only) | `Swapped`, `Burned` | `burn` rows, `token.burnedTotal`, BOOT burn stats. |
| `PoolManager` | `Swap` | All swaps are delivered; only pool ids in the `pool` table are kept (RWAGMI and Clanker pools alike; a Clanker pool's id comes from `ClankerLaunched`). On Base mainnet this means fetching every v4 swap log (Ponder cannot filter on a dynamic pool-id set). `trade.feeUsd` uses the coin's own `lpFeeBps`: bootr `Swap.fee + lpFeeBps`, clanker `lpFee × 1.2`. |
| `ClankerLpLocker` (`ClankerLpLockerFeeConversion`) | `ClaimedRewards` | A coin's collected LP fees per reward slot, after fee-preference conversion (WETH for agent / creator / platform, the coin for the burn slot): `feeAccrual` + `feeCredit`, `feeBalance.accrued = settled`, per-kind daily / per-source rollups. The locker is public: events of coins that are not ours are dropped (a dynamic token filter is not possible, as with the RWAGMI locker). |
| `ClankerFeeLocker` | `ClaimTokens`, `ClaimTokensPermissioned` | A fee owner's whole stored balance of an asset is paid out: `feeClaim` split across its coins by `settled - claimed` (same `recordClaim` as the RWAGMI claims). The burn slot's claim of the coin (owner `0x…dEaD`) is also a `burn` row and `token.burnedTotal`. |
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

### Fees (Clanker path)

The LP fee is per token (`token.lpFeeBps` from `ClankerLaunched.lpFeeBps`; the platform's own coin may use 2%
while everyone else uses 1%), and Clanker's static fee hook V2 charges 20% of it on top for Clanker
(`PROTOCOL_FEE_NUMERATOR = 200000`, verified on chain): a trader pays `lpFeeBps × 1.2`, the four reward slots
share 100% of the LP fee (`agentBps + creatorBps + burnBps + platformBps = 10000`, `protocolBps = 2000` means
"on top", `protocolRecipient` null). No hook event names the gross fee, so the per-trade `feeUsd` is also the
gross figure on token / daily / platform rows. The locker collects a coin's position fees
(`collectRewards(token)`, anyone; the hook also collects on swaps), converts each slot's share (`Paired` →
WETH for agent, creator and platform; `Clanker` → the coin for the burn slot, recipient `0x…dEaD`) and stores it
in the fee locker (`ClaimedRewards`: `feeAccrual`, `feeCredit`, `feeBalance.settled`); `ClankerFeeLocker.claim
(feeOwner, asset)` pays the owner's whole balance (`ClaimTokens`: `feeClaim`, burn rows for the dead address's
coin claim). `/treasury/:kernel` reads `availableFees(recipient, WETH)` (the burn slot: `(0x…dEaD, coin)`) as
`settled`; `pending` is 0 on this path. Per-source totals live in `sourceStats` (`GET /platform/fees`).

History (2026-10-29): the Clanker-era launchers v1 / v1.1 (`0xD4747d91…84EF`, `0x386CBE5D…e21d`) paid fees in
WETH or in the coin itself; their coins are not indexed by this version. The Clanker path above (2026-11-04) is
the new `BootrClankerLauncher` wrapper, followed next to the Bootr path.

Derived:
* **Prices**: coin/WETH from `sqrtPriceX96`; USD via Chainlink ETH/USD (Base Sepolia feed
  `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`, verified `description() = "ETH / USD"`).
  `marketCapUsd = priceUsd × totalSupply`; `liquidityUsd` from the locked launch position's
  liquidity (`LiquidityPlacedV3`) evaluated over the launch position range.
* **Trade fee**: bootr `trade.feeUsd = valueUsd × (Swap.fee + lpFeeBps) / 1e6` (exact WETH fees come from
  `PoolFeeTakenV3`); clanker `valueUsd × lpFee × 1.2 / 1e6` (`Swap.fee` is the LP fee the hook set, the stored
  `lpFeeBps` when 0). Feeds `fees24hUsd`. `lpFeeBps` is the coin's own value, never a platform-wide 1%.
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

* **Web** (`apps/web/lib/indexer.ts`): GraphQL at `/graphql` (`tokens`, `token { agent clankerPool }`,
  `trades`, `agents { tokenRef }`, `dailyStats`, `platformStats(id: "global")`, `sourceStats(id)`), REST `/search`,
  `/token/:id/fees` (with `source`, `lpFeeBps`, `protocolBps`), `/platform/fees` (totals per launch path),
  `/holdings/:owner`, `/fuel/:from`, and SSE `/stream` hints
  (`{type: 'launch'|'trade'|'agent', tokenId}`; clients re-fetch).
* **Supervisor**: `GET /market/:token` (coin or kernel address; carries `source`, `lpFeeBps`, `protocolBps`),
  `GET /platform/feed?since=<unix>`
  (the platform agent's "Bootr today" digest: launches (each with `source` and `lpFeeBps`), agent status changes,
  posts and agent fee claims since `since`, clamped to 7 days, newest first, 50 rows per list, plus `totals` from
  `platformStats` and the summed 7-day volume), `GET /treasury/:kernel` (`source`, `lpFeeBps`, live
  kernel balances, `spender` + `spenderUsdc`, and `claimable`: one row per recipient (agent,
  creator, burn, platform) with `amount = pending + settled`: bootr WETH from the RWAGMI v3 LP locker
  (`pendingQuote(poolId, recipient)` + `claimableQuote(recipient, WETH)`; `settled` aggregates all
  the recipient's coins); clanker `ClankerFeeLocker.availableFees(recipient, WETH)` (the burn slot in the coin),
  `pending` 0), and
  `POST /internal/agent/:kernel/social` signed like the sender
  (`Authorization: HMAC <ts>:<hex(HMAC-SHA256(SENDER_SERVICE_KEY, ts\nPOST\npath\nsha256(body)))>`)
  with `{xHandle?, lastPostAt?, postsCount24h?, status?: 'awake'|'sleeping', spender?: hex|null}`
  (stored in `bootr_offchain.agent_social` / `.ponder/agent-social.json`).

## Layout

```
abis/            ABIs as `const` (Bootr from packages/contracts/out, RWAGMI v3 launcher / LP locker / hook from
                 @rwagmi/token-launcher-sdk 0.3.0, B20 token, v4 PoolManager, Chainlink, ERC-8004; Clanker v4
                 factory / LP locker / fee locker / token from clanker v4-contracts, event signatures verified
                 against Base mainnet logs 2026-11-04; BootrClankerLauncher = BootrLauncher's launch / AgentLaunched
                 + the wrapper's events until the contract is compiled)
ponder.config.ts single-chain config, skips undeployed sources
ponder.schema.ts tables + relations
src/*.ts         indexing functions (launcher, market, fees, guardian, reputation, snapshot)
src/lib/         pure helpers (+ tests) and indexing helpers
src/api/         Hono app: GraphQL, REST, SSE
scripts/smoke.ts GraphQL smoke test
```
