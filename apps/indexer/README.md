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
back to `RAILWAY_DEPLOYMENT_ID`, a leftover of the Railway era; `DATABASE_SCHEMA=auto`, a name derived from the
image's commit, is implemented there but production does not use it). Production runs a fixed name, `bootr_v8` since
2026-11-08 (the next is `bootr_v9`). Ponder refuses to reuse a schema that was built by different indexing code
("previously used by a different Ponder app"; the container crash-loops until the name changes), and the build id
hashes `src/**` except `src/api`, `ponder.schema.ts` and the config's contracts, accounts, blocks and ordering. Before
every deploy run
`git diff <live commit>..HEAD --name-only -- apps/indexer/src apps/indexer/ponder.schema.ts apps/indexer/ponder.config.ts | grep -v src/api`
yourself: any line means a new `DATABASE_SCHEMA` in Coolify and a backfill from the earliest listed launcher block
(about 13 minutes on 2026-11-08 with Ponder's RPC cache warm; the site shows stale or partial data meanwhile).
`rpc-budget.ts`, the RPC urls and the `INDEXER_*` budget settings live outside the build id. See
[`docs/deploy/coolify.md`](../../docs/deploy/coolify.md) section 2.

Ponder only auto-loads `apps/indexer/.env.local`; export the variables (or use your usual env
loader) to point it at the root `.env`. When sourcing the root `.env`, override `PORT` (it holds the
sender's port there; Ponder reads `PORT` too): `PORT=42069 pnpm --filter indexer dev`. Without
`SENDER_SERVICE_KEY` the `/internal/agent/:kernel/social` route answers `401 not_configured` and the
web shows agents without an X handle.

`ponder dev` hot-reloads on any change under `apps/indexer`; with PGlite that reload can abort in-flight
queries ("PGlite is closed", exit code 75). Restart it after editing, or run `ponder start` for long
backfills.

RPC rate: CDP limits billing units, not requests (7,500 BU per 5 s per project, 100 BU for `eth_getLogs` and
`eth_getBlockByNumber`). Since the Denim fork Base has 5 blocks a second, and Ponder's realtime sync costs one
`eth_getBlockByNumber` plus one `eth_getLogs` for every one of them: measured on 2026-11-08 over 60 s of production
(`ponder_rpc_request_duration_count` at `:42069/metrics`), 300 blocks took 304 `eth_getBlockByNumber` and 301
`eth_getLogs`, about 1,000 BU/s. The bloom check never skips a block because `BootrToken` is a factory source (Ponder
matches a factory's children on the `Transfer` topic alone, which every block has) and `PoolManager:Swap` is in nearly every
block too; `pollingInterval` changes nothing, since every block between two polls is fetched one by one; a `ws` newHeads url
would save the header only, and the body is fetched again as soon as the bloom matches. `INDEXER_RPC_BU_PER_SEC` is what
Ponder may spend: empty = 1300 on a CDP url and no budget elsewhere, 0 = no budget. `BASE_RPC_FALLBACK_URL` is an optional
second RPC for what the budget cannot cover and for what the first one answers 429 to. `INDEXER_BLOCKS_RPC_URL` is an
optional url for the block reads alone (`eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_blockNumber`), which spend
nothing from the budget: the public `https://mainnet.base.org` served 12 full blocks a second for a minute without a
refusal in a probe from one IP, and refused every `eth_getLogs` (429), which is why only the block reads go there; a
failed block read goes to the primary and the url is left alone for 10 s. With it the keyed url carries about 500 BU/s
for the tail instead of 1,000. The public endpoint publishes no rate limit ("not suitable for production apps"), so
watch the indexer lag line for a while after turning it on. All three live in `chains` and `rpc-budget.ts`, outside Ponder's
build id, so changing them needs no new `DATABASE_SCHEMA`. The USDC fuel scan and the REST API's live reads (`src/lib/rpc.ts`)
spend from the same budget and wait out a 429 for about 8 s.

Keys in logs: viem names the full url in its errors and Ponder logs an error whole, so a url string in Ponder's chain config
would print the key on any failed request. `rpc-budget.ts` therefore gives Ponder a transport that scrubs every error for any
url with a path, query or credentials, budget or not, and keeps plain strings for urls with nothing to hide. Keep RPC urls out
of anything else that logs. With the transport, Ponder's own lines name `hostname: custom_transport` and no url.

The indexer's own viem client (`src/lib/rpc.ts`) is the one server-side chain client without `ccipRead: false`
(`docs/security/fixes-2026-11-08.md` item 1): it is indexing code and so part of the build id, it reads only Bootr's own
contracts, and it gets the flag with the next schema bump.

Coins come through three launch paths, all on **Base mainnet only** (`token.source`):

* **bootr**: `BootrLauncher` launches through the RWAGMI v3 launcher (B20 Asset tokens in Uniswap v4 pools; see
  [`docs/rwagmi-migration.md`](../../docs/rwagmi-migration.md)). Needs `BOOTR_LAUNCHERS` and the RWAGMI stack.
* **clanker**: `BootrClankerLauncher` launches through Clanker v4 (see
  [`docs/design/clanker-launch.md`](../../docs/design/clanker-launch.md)). Needs `BOOTR_CLANKER_LAUNCHERS`; empty =
  the path is off. The wrapper emits the same `AgentLaunched` plus `ClankerLaunched`; fees are collected by Clanker's
  LP locker and paid by its fee locker (addresses in `CLANKER_V4`, `src/lib/env.ts`, verified on chain 2026-11-04).
* **clanker-v5**: `BootrClankerLauncherV5` launches through Clanker v5 (see
  [`docs/design/clanker-v5-migration.md`](../../docs/design/clanker-v5-migration.md)). Same list,
  `BOOTR_CLANKER_LAUNCHERS`: the `AgentLaunched` handler tells a v5 wrapper by the `ClankerV5Launched` its receipt
  carries. Fees are a buy and sell tax credited per swap by Clanker's `TaxLaunchHook` and paid by its `FeeEscrow`
  (addresses in `CLANKER_V5`, `src/lib/env.ts`, from the verified sources, read on chain 2026-11-10). The first
  deploy of this version needs `DATABASE_SCHEMA=bootr_v9` and a backfill (new tables' columns, new sources, new
  indexing code), whether or not a v5 launcher is listed yet. **The token settings** (the launcher's
  `launch(LaunchParams, TokenSettings)`,
  [`docs/design/clanker-v5-token-settings.md`](../../docs/design/clanker-v5-token-settings.md): buy and sell tax,
  burn, holder dividends, the creator's row and up to four extra reward rows, ETH or USDC as the paired asset, the
  sniper tax switch, editable metadata) are in the same `bootr_v9` bump: new token columns, the `fee_slot_update` and
  `dividend_credit` tables, four more hook events and three launcher events. No other schema name is needed as long
  as `bootr_v9` has not gone live before this lands; if it has, the next is `bootr_v10`.

Without any launcher, or on a chain without the launch stacks (Base Sepolia), the
indexer boots with a warning and only runs the snapshot block handler (ETH/USD, empty platform
rollups). Production runs `CHAIN_ID=8453` with `BOOTR_LAUNCHERS` naming every RWAGMI-backed `BootrLauncher` ever used
(the current one is v3.1 `0x62c038dA8A409ad1CD811df980A6F9867cd453fd`, deployed at block 53503025; the list is in
`.env.mainnet.example`), `BOOTR_CLANKER_LAUNCHERS` with the `BootrClankerLauncher`
`0x387f1B0aC128D534E822c344D829645336BDAbbB@53503025`, and the guardian `0x799Ab875294E37839883D12084aB4BE3f7633630`
(`BOOTR_GUARDIAN_ADDRESS`; the single-launcher fallback and the guardian also default from `@bootr/shared`); after
changing any of them delete `.ponder/` (or bump `DATABASE_SCHEMA`) to reindex. Local dev runs against a
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
| `CLANKER_V5_FACTORY_ADDRESS` / `CLANKER_V5_HOOK_ADDRESS` / `CLANKER_V5_FEE_ESCROW_ADDRESS` | no | Override the Clanker v5 stack (defaults in `CLANKER_V5`, `src/lib/env.ts`: factory `0x572e88D3…09A0`, `TaxLaunchHook` `0x5E320eA6…2AcC`, `FeeEscrow` `0x5dd237d1…FA61`, created at block 53331374; none on Base Sepolia). All three are needed; without them the v5 hook and escrow sources stay off. |
| `INDEXER_DATABASE_URL` | prod | Postgres. Empty = PGlite in `.ponder/pglite`. (`DATABASE_URL` is deliberately not used, so other services' DB does not switch the indexer to Postgres.) |
| `DATABASE_SCHEMA` | prod | Required by `ponder start` on Postgres. |
| `INDEXER_SNAPSHOT_INTERVAL` | no | Blocks between snapshots at today's 200 ms block time. Default 300, one snapshot per 60 s. Leave it empty unless you mean to change the time: the 2 s blocks before Denim keep the same time on their own grid (30 blocks), see "Snapshots across Denim". Part of Ponder's build id. |
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
DATABASE_SCHEMA=bootr_v9   # the next fixed name: see below
```

The Clanker path has its own list, `BOOTR_CLANKER_LAUNCHERS`, with the same rules (keep every wrapper ever used;
the `BootrClankerLauncher` source, the coin factory, the two Clanker v4 locker sources and the v5 hook and escrow
sources follow it; v4 and v5 wrappers share the list, e.g.
`0x387f1B0aC128D534E822c344D829645336BDAbbB@53503025,0x<v5 launcher>@<its deploy block>`). Turning the path
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
| `BootrClankerLauncher` (every Clanker wrapper, v4 and v5; v4 ABI plus `ClankerV5Launched` and the v5 metadata events) | `ClankerLaunched`, `AgentLaunched`, `ImageUpdated`, `MetadataUpdated`, `MetadataLocked` | Clanker path. `ClankerLaunched` stages `clankerPool` (pool id, hook, locker, MEV module, starting tick, the LP fee actually used). `AgentLaunched` reads the receipt for Clanker's `TokenCreated` (name, symbol, image, metadata, context, extensions supply) and the locker's `TokenRewardAdded` (pool key, reward slots, position range), falling back to the token's views and `tokenRewards(token)`; writes the `pool` row (dynamic-fee key), token / agent / `feeSlot` rows (`source: 'clanker'`, four slots summing to 10000, the burn slot's recipient `0x…dEaD`, `protocolBps` 2000 = Clanker's 20% on top), and replays the dev-buy swap, coin transfers and the USDC fuel. **Clanker v5**: when the receipt carries the wrapper's `ClankerV5Launched` (pool id, hook, escrow, quote, tick spacing, tax, anti-snipe), the handler reads the hook's `FeeSlotCreated` (else `poolFeeSlots(poolId)`, else the preset's weights), the factory's `LaunchTaxConfigured` (the admitted protocol policy and the burn share) and `Launched` (supply, 1 B), the PoolManager's `Initialize` (opening tick) and `ModifyLiquidity` (the seeded band); writes `clankerPool` (`version 5`, `locker` = the escrow, `antiSnipe`), the `pool` row (native ETH `0x0` is currency0, fee 0) and token / agent / `feeSlot` rows (`source: 'clanker-v5'`, `lpFeeBps` = the tax, `protocolBps` = Clanker's share of it, 3333 at 1.5%, the three paid slots plus a synthetic burn slot `0x…dEaD` on the buyback preset summing to `10000 - protocolBps`), and replays the dev buy's swap and tax credits, transfers and fuel. **Token settings** (section "Clanker v5 token settings" below): the settings shape of `ClankerV5Launched` adds each side's tax, burn, dividends and the editable switch; the slots are classified by recipient and admin, the token row carries the settings, the paired asset may be USDC, and the image and metadata come from the coin's genesis `ExtraMetadataUpdated`. `ImageUpdated` / `MetadataUpdated` / `MetadataLocked` (the coin's creator, through the launcher) update `token.image` / `token.metadata` / `metadataLocked` and `metadataUpdatedAt`. |
| `BootrToken` (factory: `AgentLaunched.token` of both launcher lists) | `Transfer` | `balance` table, `token.holders` (non-zero balances, excluding 0x0 and 0x…dEaD). |
| `BuybackBurner` (factory: `AgentLaunched.burner`, Bootr launchers only) | `Swapped`, `Burned` | `burn` rows, `token.burnedTotal`, BOOT burn stats. |
| `PoolManager` | `Swap` | All swaps are delivered; only pool ids in the `pool` table are kept (RWAGMI and Clanker pools alike; a Clanker pool's id comes from `ClankerLaunched`). On Base mainnet this means fetching every v4 swap log (Ponder cannot filter on a dynamic pool-id set). `trade.feeUsd` uses the coin's own `lpFeeBps`: bootr `Swap.fee + lpFeeBps`, clanker `lpFee × 1.2`, clanker-v5 the tax of the trade's side (`buyTaxBps` / `sellTaxBps`). The paired side is valued in its own decimals (USDC at $1, `lib/quote.ts`). |
| `ClankerLpLocker` (`ClankerLpLockerFeeConversion`) | `ClaimedRewards` | A coin's collected LP fees per reward slot, after fee-preference conversion (WETH for agent / creator / platform, the coin for the burn slot): `feeAccrual` + `feeCredit`, `feeBalance.accrued = settled`, per-kind daily / per-source rollups. The locker is public: events of coins that are not ours are dropped (a dynamic token filter is not possible, as with the RWAGMI locker). |
| `ClankerFeeLocker` | `ClaimTokens`, `ClaimTokensPermissioned` | A fee owner's whole stored balance of an asset is paid out: `feeClaim` split across its coins by `settled - claimed` (same `recordClaim` as the RWAGMI claims). The burn slot's claim of the coin (owner `0x…dEaD`) is also a `burn` row and `token.burnedTotal`. |
| `ClankerV5Hook` (`TaxLaunchHook`) | `CreatorTaxCredited`, `BurnTaxCredited`, `DividendTaxCredited`, `DividendTaxRedirected`, `FeeSlotRecipientUpdated`, `FeeSlotAdminUpdated` | Clanker v5, per swap: a paid slot's exact share of the tax in the quote (native ETH, asset `0x0`), and the burn share in the coin for `0x…dEaD`: `feeAccrual` + `feeCredit` (with `feeCredit.slot`), `feeBalance.accrued = settled`, per-kind rollups. The event names the recipient, not the slot: a wallet holding two slots of one coin takes them in turn (`pickV5Slot`). The hook is shared by every v5 pool: events of pools that are not ours are dropped. The gross fee is booked per trade from `Swap`. The dividend share of a trade is a `dividendCredit` row (to the coin's tracker, or `redirected` to Clanker while no holder qualifies) and `token.dividendsTotalUsd` / `dividendsRedirectedUsd`. A slot admin's recipient or admin change moves the `feeSlot` row (logged in `feeSlotUpdate`), so later credits follow the new recipient. The four credits share one decoder (`decodeV5HookCredit`) with the launch replay. |
| `ClankerV5FeeEscrow` (`FeeEscrow`) | `Claimed` | A recipient's whole escrow balance of a currency is paid out (`claimFor`, anyone, or `claimTo`): `feeClaim` split over its v5 coins by `settled - claimed`. The dead address claiming a coin is that coin's burn (`burn` row, `token.burnedTotal`). |
| `RwagmiHookV3` | `PoolFeeTakenV3` | Gross swap fee (WETH) per swap: `token.feesTotalUsd`, `dailyStat.feesUsd`, `platformStats.feesTotalUsd`; plus one `feeAccrual` per Bootr reward slot (`gross × bps / 10000`) and its `feeBalance.accrued`. |
| `RwagmiLpLockerV3` | `PoolFeesSettledV3`, `QuoteRewardsClaimedV3` | Settlement credits a slot's recipient (`feeCredit`, `feeBalance.settled`; RWAGMI's slot skipped). A claim pays a recipient's settled balance across all its coins: `feeClaim`, split across coins by `settled - claimed`. |
| `AgentGuardian` | `Activity`, `AgentPaused`, `DormantClaimed`, `SessionKeyApproved`, `SessionKeyApprovalRevoked`, `SessionKeyUninstalled`, `SessionNonceInvalidated` | Agent status inputs, `dormantClaim`, `sessionKey`. |
| ERC-8004 `ReputationRegistry` | `NewFeedback`, `FeedbackRevoked` | `agent.reputationScore` = mean of `value / 10^valueDecimals` over non-revoked feedback. Registry address from `@bootr/shared` (mainnet `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`). |
| `BootrSnapshot` and `BootrSnapshotPreDenim` block handlers | every 60 s of chain time | See below. |

### Snapshots across Denim

Ponder's block `interval` counts blocks over a source's whole range, and Base has two block times: 2 s up to block
53556126 and 200 ms from block 53556127 (18:00:01 UTC on 2026-11-05). So the snapshot has two sources, one handler:

| Source | Range | Interval | Live cost |
| --- | --- | --- | --- |
| `BootrSnapshotPreDenim` | first launcher block to 53556126 | 30 blocks = 60 s | never live |
| `BootrSnapshot` | 53556127 onward | 300 blocks = 60 s | one snapshot a minute |

Far behind the tip only the first snapshot of each UTC hour does the work (`historicalSnapshotDue`, given the spacing of
its era by `snapshotSpacingSec`). A fixed 300 would have made history a 10 minute grid and a fixed 30 a 6 second one
forever. The pre-Denim source keeps the 30-block grid so that Ponder's sync cache, kept per (interval, offset), serves it
without a single RPC call as long as the first launcher block is unchanged, and its hourly snapshots land on the same
blocks as before. The new grid is fetched once, one `eth_getBlockByNumber` (100 BU) per minute of history since the fork,
and is cached after that. Base Sepolia, and a range starting after the fork, has the `BootrSnapshot` source alone.

Everything else that counted blocks as time counts seconds now: the ETH/USD freshness of event handlers is 10 minutes in
both eras (`secondsBetweenBlocks`).

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

Every claim (`QuoteRewardsClaimedV3`, `ClaimTokens(Permissioned)`, `Claimed`) is split only over the recipient's
balances of coins from the claiming locker's own path (`claimParts` in `src/lib/fees.ts`, fixed 2026-11-10 with
`bootr_v9`): `feeBalance` is keyed by (recipient, asset, coin) across every path, and before the fix a Clanker v4
WETH claim was pro-rated over the same wallet's unclaimed RWAGMI WETH too (the $BOOTR claim at block 54656132 came
out 0.000393 WETH short), and the reverse.

### Fees (Clanker v5 path)

Clanker v5 charges a buy and sell tax instead of an LP fee (`token.lpFeeBps` = the tax, 15000 = 1.5%; the pool's own
fee is 0); the trader pays exactly the tax (the 20 s anti-snipe surcharge after launch is not counted). Clanker's share
is inside it: `max(10% of the tax, 0.5% of the trade)` capped at 1% (`protocolBps` = that share in bps of the tax,
from the policy in the launch receipt), and the four slot kinds share the rest, so the five bps columns sum to 10000
like the Bootr path. The hook credits each slot per swap (`CreatorTaxCredited`, native ETH for agent, creator and
platform on buys and sells alike) and the burn share in the coin (`BurnTaxCredited` to `0x…dEaD`), so `feeAccrual`
amounts are exact and need no collection step; `FeeEscrow.claimFor(recipient, currency)` pays a recipient's whole
balance across every v5 pool (`Claimed`). `/treasury/:kernel` reads `FeeEscrow.owed(recipient, quote)` (the burn slot:
`owed(0x…dEaD, coin)`) as `settled`, in the pool's paired asset, `pending` 0. `assetUsd` values native ETH (`0x0`) at
ETH/USD and USDC at $1.

### Clanker v5 token settings

The token-settings launcher (`launch(LaunchParams, TokenSettings)`, design note
[`clanker-v5-token-settings.md`](../../docs/design/clanker-v5-token-settings.md)) lets the creator set the coin the way
Clanker's deploy form does. What the indexer does with it (pure helpers in `src/lib/clanker.ts`, `src/lib/fees.ts` and
`src/lib/quote.ts`, tested in `src/lib/clanker-v5-settings.test.ts`):

* **Settings on the token row**, decided once by `clankerV5Settings`: the launcher's `ClankerV5Launched` first
  (`decodeClankerV5Launched`, the compiled contract's shape `(token, poolId, hook, feeEscrow, quoteToken, tickSpacing, buyTaxBps,
  sellTaxBps, burnBps, dividendBps, antiSnipe, metadataEditable)`; the fixed launcher's 8-field shape still decodes),
  then Clanker's verified `LaunchTaxConfigured` / `Launched` of the same receipt, then `AgentLaunched.defaults`.
  Columns: `buyTaxBps`, `sellTaxBps` (`lpFeeBps` = the buy tax), `dividendBps`, `rewardsBps`, `minDividendHolding`,
  `dividendContract` (the coin's `DividendInitialized`), `antiSnipe`, `metadataEditable`, `metadataLocked`,
  `metadataUpdatedAt`, `pairedSymbol`, `pairedDecimals`, `priceQuote`, `dividendsTotalUsd`, `dividendsRedirectedUsd`.
  The kinds' bps are of the buy tax: `agent + creator + rewards + burn + dividend + platform + protocol = 10000`; the
  rounding gap goes to the last creator row, where Clanker puts its wei remainder (never the platform).
* **USDC-quoted pools**: `lib/quote.ts` prices the coin in its paired asset (`coinPriceInQuote`: the raw pool price
  times 10^(18 − 6) for USDC), USDC at $1, ETH and WETH at ETH/USD; `priceUsd`, market cap, liquidity, trade value and
  fees follow. `priceWeth` stays the price in ETH for every coin (`priceUsd / ethUsd` on a USDC pool). A trade's fee
  is its side's tax (`v5SideTaxPips`).
* **Fee slots by recipient and admin** (`classifyV5Slots`): the launcher-admin slot paying the kernel is `agent`, the
  one paying the platform recipient `platform`, the first slot with another admin is the creator's row (`creator`,
  whoever it pays), later ones are extra rows (`recipient`, a new kind: `byKind.recipient` on `/token/:id/fees`; no
  daily or per-source rollup column). Slot credits are in the paired asset; the escrow's claims are per (recipient,
  currency) as before. `FeeSlotRecipientUpdated` / `FeeSlotAdminUpdated` move the row.
* **Burn and dividends**: the burn is credited per trade on both sides (`BurnTaxCredited`, in the coin); the
  dividend share per trade is a `dividendCredit`; the tracker is on the token row. No per-holder accounting.
* **Metadata edits**: the launcher's `CoinImageUpdated(token, image)`, `CoinMetadataUpdated(token, metadata)`,
  `CoinMetadataLocked(token)` (no caller field: only the coin's creator may call them; `decodeLauncherMetadataEdit`)
  update the token row, so the API serves the current image and metadata.
* **Paired-asset allow-list**: the owner's `QuoteAllowedUpdated(kind, quote, allowed)` is kept per (launcher, kind,
  quote) in `quote_allowed` (`kind` `agent` / `plain`).
* **`AgentLaunched.defaults` on this launcher**: `lpFeeBps` = the buy tax, `agentBps` / `platformBps` the locked shares
  of the post-Clanker pool, `burnBps` the burn, `creatorBps` = 10000 − agent − platform − burn (creator funds plus
  dividends); `burner` is `0x…dEaD` exactly when the burn is above 0. The dev buy pays the buy tax, so the launch
  receipt already carries slot, burn and dividend credits, which the launch handler replays.

The launcher's events are taken from its compiled ABI (abis/BootrClankerLauncherV5.ts, regenerated from
`packages/contracts/out`: `ClankerV5LaunchedEvent`, `ClankerV5MetadataEvents`, `QuoteAllowedUpdatedEvent`); when the
contract changes, regenerate it and adjust the one decoder per event in `src/lib/clanker.ts`. The Clanker events (`DividendTaxCredited`, `DividendTaxRedirected`,
`FeeSlotRecipientUpdated`, `FeeSlotAdminUpdated`, the token's `ExtraMetadataUpdated` and `DividendInitialized`) are
copied from the verified sources.

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
  `lpFeeBps` when 0); clanker-v5 `valueUsd × tax / 1e6`. Feeds `fees24hUsd`. `lpFeeBps` is the coin's own value, never a platform-wide 1%.
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
  skipped and the handler does its work once per UTC hour instead of once per snapshot, since it
  took about 84% of a backfill at the full rate. `treasuryUsdc` is the kernel only; `treasuryUsd` and the sleep rule count the spender too.

## Consumers

* **Web** (`apps/web/lib/indexer.ts`): GraphQL at `/graphql` (`tokens`, `token { agent clankerPool }`,
  `trades`, `agents { tokenRef }`, `dailyStats`, `platformStats(id: "global")`, `sourceStats(id)`), REST `/search`,
  `/token/:id/fees` (with `source`, `lpFeeBps`, `protocolBps`; v5 settings add `pairedToken`, `pairedSymbol`,
  `buyTaxBps`, `sellTaxBps`, `rewardsBps`, `dividendBps`, `byKind.recipient` and `dividends`), `/platform/fees` (totals per launch path),
  `/holdings/:owner`, `/fuel/:from`, `/tokens/list`, `/tokens/trending`, `/leaderboards/:board`, `/creator/:address`, and SSE `/stream` hints
  (`{type: 'launch'|'trade'|'agent', tokenId}`; clients re-fetch).
* **Supervisor**: `GET /market/:token` (coin or kernel address; carries `source`, `lpFeeBps`, `protocolBps`, and
  `pairedToken`, `pairedSymbol`, `pairedDecimals`, `priceQuote`, `buyTaxBps`, `sellTaxBps`, `rewardsBps`,
  `dividendBps`, `antiSnipe`),
  `GET /platform/feed?since=<unix>`
  (the platform agent's "Bootr today" digest: launches (each with `source` and `lpFeeBps`), agent status changes,
  posts and agent fee claims since `since`, clamped to 7 days, newest first, 50 rows per list, plus `totals` from
  `platformStats` and the summed 7-day volume), `GET /treasury/:kernel` (`source`, `lpFeeBps`, live
  kernel balances, `spender` + `spenderUsdc`, and `claimable`: one row per recipient (agent,
  creator, burn, platform) with `amount = pending + settled`: bootr WETH from the RWAGMI v3 LP locker
  (`pendingQuote(poolId, recipient)` + `claimableQuote(recipient, WETH)`; `settled` aggregates all
  the recipient's coins); clanker `ClankerFeeLocker.availableFees(recipient, WETH)` (the burn slot in the coin),
  `pending` 0; clanker-v5 one row per fee slot as it stands now, extra rows included, `FeeEscrow.owed(recipient,
  quote)` in the paired asset, ETH or USDC (the burn slot in the coin), `pending` 0; top-level `pairedToken` /
  `pairedSymbol`), and
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
                 + the wrapper's events until the contract is compiled; Clanker v5 hook / escrow / factory from the
                 Sourcify-verified Base deployment, topics checked against Base logs 2026-11-10;
                 BootrClankerLauncherV5 from packages/contracts/out, the token-settings launcher)
ponder.config.ts single-chain config, skips undeployed sources
ponder.schema.ts tables + relations
src/*.ts         indexing functions (launcher, market, fees, guardian, reputation, snapshot)
src/lib/         pure helpers (+ tests) and indexing helpers
src/api/         Hono app: GraphQL, REST, SSE
scripts/smoke.ts GraphQL smoke test
```
