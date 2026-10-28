# Data contract: indexer ↔ web ↔ supervisor

The Ponder indexer (`apps/indexer`) is the single read source for the web app and the supervisor's `read_market` / `treasury_read` tools. It exposes Ponder's GraphQL at `/graphql` plus a few REST helpers. This document is the agreed shape; the indexer implements it, the web consumes it. Field names are final unless both sides change together.

Chain: Base Sepolia (84532) during development, Base (8453) in production. All amounts are strings of integer base units unless suffixed `Usd` (float, 6 dp) or `Bps`.

## Tables (ponder.schema.ts)

### `token`
| field | type | note |
|---|---|---|
| `id` | hex address | token address (PK) |
| `chainId` | int | |
| `name`, `symbol`, `image` | string | from the launcher event / RWAGMI `B20LaunchCreatedV3` (Clanker `TokenCreated` for coins launched before 2026-10-29) |
| `creator` | hex | |
| `kernel` | hex | agent treasury (ZeroDev Kernel) |
| `burner` | hex \| null | BuybackBurner clone if buyback preset |
| `agentId` | bigint | ERC-8004 id |
| `poolId` | hex (bytes32) | Uniswap v4 pool id |
| `pairedToken` | hex | WETH |
| `lpFeeBps` | int | 1e6-based (10000 = 1%); the static swap fee, charged in WETH |
| `agentBps`, `creatorBps`, `burnBps`, `platformBps` | int | locker slot bps, sum 9000 on RWAGMI coins (the remaining 10% is RWAGMI's slot); of the 80% remainder, sum 10000, on Clanker coins |
| `workerHash` | hex | |
| `model` | string | |
| `agentUri` | string | |
| `xHandle` | string \| null | set by supervisor via REST (see below) |
| `launchedAt` | int (unix s) | |
| `launchBlock` | bigint | |
| `priceUsd`, `marketCapUsd`, `liquidityUsd` | float | derived from last swap + ETH/USD |
| `volume24hUsd`, `volume7dUsd` | float | rolling |
| `change24hPct` | float \| null | price change vs the last trade at or before now−24h; null if none (snapshot handler) |
| `fees24hUsd` | float | LP fee accrued to all recipients in 24h |
| `holders` | int | approx (transfer events) |
| `graduated` | bool | `marketCapUsd >= platformConfig.graduationThresholdUsd` (sticky once true) |
| `graduatedAt` | int \| null | |
| `agentStatus` | enum | denormalized `agent.status`, so `tokens(where: {agentStatus: "awake"})` works (Ponder cannot filter on relations) |

### `agent`
| field | type | note |
|---|---|---|
| `id` | hex | kernel address (PK) |
| `token` | hex | FK token.id |
| `status` | enum | `awake` \| `sleeping` \| `paused` \| `dormant` \| `claimed` |
| `lastActivityAt` | int | from AgentGuardian activity hook |
| `dormancyPeriod` | int (s) | |
| `dormantSince` | int \| null | `lastActivityAt + dormancyPeriod` once passed |
| `treasuryUsdc`, `treasuryWeth`, `treasuryEth`, `treasuryOwnToken` | string | kernel balances, base units, refreshed each block batch |
| `spender` | hex \| null | the agent's x402 spender EOA (pays inference; topped up from the kernel), pushed by the supervisor via REST |
| `spenderUsdc` | string | USDC float held by `spender` (base units), refreshed with the kernel balances; not included in `treasuryUsdc` |
| `treasuryUsd` | float | kernel USDC + `spenderUsdc` + WETH + ETH + own coin, in USD |
| `fuelReceivedUsdc` | string | cumulative inbound USDC |
| `feesClaimedUsd` | float | cumulative claimed from FeeLocker |
| `reputationScore` | float \| null | from ERC-8004 feedback aggregate |
| `reputationCount` | int | |
| `lastPostAt` | int \| null | set by supervisor via REST |
| `postsCount24h` | int | set by supervisor via REST |

### `trade`
`id` (txhash-logindex), `token`, `trader`, `side` (`buy`\|`sell`), `amountToken`, `amountPaired`, `priceUsd`, `valueUsd`, `timestamp`, `txHash`.

### `feeAccrual`
`id`, `token`, `recipient`, `recipientKind` (`agent`\|`creator`\|`burn`\|`platform`), `asset` (hex), `amount`, `amountUsd`, `timestamp`, `txHash`. RWAGMI coins: written from `RwagmiLpLockerV3.PoolFeesSettledV3(poolId, currency, slot, recipient, amount)`; `asset` is always WETH. Clanker coins (launched before 2026-10-29): `ClankerLpLockerFeeConversion.ClaimedRewards(token, amount0, amount1, rewards0[], rewards1[])`, emitted right after the locker's `FeeLocker.storeFees` calls; amounts are post-conversion (the burner's share arrives as the coin).

### `feeClaim`
`id`, `token`, `recipient`, `recipientKind`, `asset`, `amount`, `amountUsd`, `timestamp`, `txHash`. RWAGMI coins: `RwagmiLpLockerV3.QuoteRewardsClaimedV3(recipient, currency, to, amount)`. Clanker coins: `ClankerFeeLocker.ClaimTokens` / `ClaimTokensPermissioned`; a claim pays the whole (recipient, asset) balance, so it is split over the per-coin outstanding balances (one row per coin).

### `burn`
`id`, `token`, `amountToken`, `amountWethSpent`, `timestamp`, `txHash` (BuybackBurner events).

### `dormantClaim`
`id`, `token`, `kernel`, `usdc`, `weth`, `eth`, `tokenBurned`, `timestamp`, `txHash`.

### `dailyStat` (platform-wide, one row per UTC day)
`id` (YYYY-MM-DD), `timestamp` (00:00 UTC, unix s), `launches`, `volumeUsd`, `feesUsd`, `feesAgentUsd`, `feesCreatorUsd`, `feesBurnUsd`, `feesPlatformUsd`, `activeAgents`, `awakeAgents`, `bootBurnedToken`, `bootBurnedUsd`.

### `platformStats` (singleton id `"global"`)
`tokens`, `agentsAwake`, `volume24hUsd`, `volumeTotalUsd`, `feesTotalUsd`, `bootToken` (hex \| null), `bootPriceUsd`, `bootMarketCapUsd`, `bootChange24hPct`, `bootBurnedTotal`, `bootFeesToBurnUsd`, `graduationThresholdUsd`, `updatedAt`.

### `platformConfig` (singleton, mirrors admin settings relevant to indexing)
`graduationThresholdUsd` (default 50000), `bootToken`.

## GraphQL queries the web uses (Ponder auto-generates; names must match)
- `tokens(orderBy, orderDirection, where, limit, after)` with filters `graduated`, `agentStatus` (relation filters are not supported by Ponder), text search handled by REST `/search`.
- Relations: `token.agent`, `token.trades`, `token.feeAccruals`, `token.feeClaims`, `token.burns`, `token.balances`; `agent.tokenRef` (the `token` column is the FK), `agent.sessionKeys`, `agent.feedbacks`, `agent.fuelEvents`; `trade.tokenRef`.
- Ids are lowercase hex (Ponder normalizes `hex` columns); query with lowercased addresses.
- `token(id)` with nested `agent`, latest `trades(limit 50)`, `feeAccruals` grouped per kind (REST helper `/token/:id/fees`).
- `agents(where: {status: "awake"})`.
- `dailyStats(orderBy: "id" | "timestamp", orderDirection: "desc", limit: 90)`.
- `platformStats(id: "global")`.

## REST helpers (Hono in `apps/indexer/src/api/index.ts`)
- `GET /search?q=` → tokens by name/symbol/address/xHandle (ILIKE), limit 20.
- `GET /token/:id/fees` → `{byKind: {agent, creator, burn, platform}: {accruedUsd, claimedUsd}}`.
- `GET /stream` → SSE; emits `{type: 'launch'|'trade'|'agent', tokenId}` hints only. Clients re-fetch; never trust payloads.
- `POST /internal/agent/:kernel/social` (HMAC with `INDEXER_SERVICE_KEY`, same scheme as the sender) → `{xHandle?, lastPostAt?, postsCount24h?, status?, spender?}` written by the supervisor (`spender`: 20-byte hex or null, stored lowercase).
- `GET /market/:token` → compact snapshot for the supervisor's `read_market` (price, mcap, liquidity, vol24h, holders, fees24h, last 10 trades).
- `GET /treasury/:kernel` → compact snapshot for `treasury_read` (kernel `balances`, `spender` (hex \| null) and `spenderUsdc` (base units, live with indexed fallback), `treasuryUsd` including the spender float, claimable fees (WETH on RWAGMI coins: `pendingQuote` + `claimableQuote`; per asset from the FeeLocker view on Clanker coins), lastActivityAt).
- `GET /holdings/:owner` → Bootr coins the address currently holds, from the `balance` table: `[{token: {id,name,symbol,image,priceUsd,marketCapUsd}, balance, valueUsd}]`, sorted by `valueUsd` desc.
- `GET /fuel/:from` → USDC transfers from that address into any agent kernel: `[{kernel, token, symbol, amount, amountUsdc, amountUsd, timestamp, txHash}]` (`amountUsdc` = `amount`, base units). The same transfers maintain `agent.fuelReceivedUsdc`.
- Ponder built-ins: `/health`, `/ready`, `/status`, `/metrics` (reserved route names).

## Events the indexer consumes (ABIs from `packages/contracts/out`, RWAGMI v3 and Clanker v4)
- `BootrLauncher.AgentLaunched(token, kernel, creator, burner, agentId, defaults..., workerHash, model, agentURI)`
- `RwagmiB20LauncherV3.B20LaunchCreatedV3` and `LaunchPoolCreatedV3` (pool key and id, starting tick) for coins launched from 2026-10-29; `Clanker.TokenCreated` (decoded from the launch tx receipt in the `AgentLaunched` handler; it carries name/symbol/image/metadata/poolId) for earlier coins
- Uniswap v4 `PoolManager.Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)` for our pool ids
- `RwagmiHookV3.PoolFeeTakenV3` (fee taken per swap), `RwagmiLpLockerV3.PoolFeesSettledV3` (accruals) and `QuoteRewardsClaimedV3` (claims); for Clanker coins `ClankerLpLockerFeeConversion.ClaimedRewards` and `ClankerFeeLocker.ClaimTokens` / `ClaimTokensPermissioned`
- `AgentGuardian.Activity(kernel, timestamp)`, `AgentPaused/Unpaused`, `DormantClaimed`
- `BuybackBurner.Burned`
- ERC-8004 `ReputationRegistry` feedback events for our agentIds
- ERC-20 `Transfer` on each launched token (holders)
- ETH/USD: Chainlink `ETH/USD` aggregator on Base (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`; Base Sepolia `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`) read in a block handler every N blocks.

## Implementation notes (indexer v1)

- **Extra columns** (additive, safe to ignore): `token.{metadata, coinIsToken0, platformRecipient, supervisorSessionKey, launchTx, totalSupply, sqrtPriceX96, tick, poolLiquidity, positionLiquidity, priceWeth, trades24h, volumeTotalUsd, feesTotalUsd, burnedTotal, lastTradeAt, agentStatus}`, `agent.{agentId, creator, statusChangedAt, paused, claimed, balancesUpdatedAt, reputationSum, supervisorStatus}`, `trade.{sender, feeUsd, blockNumber}`, `burn.{burner, amountUsd}`, `dailyStat.{timestamp, trades}`, `platformStats.{agentsTotal, fees24hUsd, ethPriceUsd}`, `platformConfig.{source, fuelScannedTo, updatedAt}`.
- **Extra tables**: `pool`, `agentIdentity`, `tokenWindow` (hourly buckets for rolling windows), `balance`, `feeBalance`, `feeRecipient`, `burner`, `fuel`, `sessionKey`, `feedback`, `priceFeed`.
- **Precision**: `*Usd` totals are rounded to 6 dp, but unit prices (`token.priceUsd`, `trade.priceUsd`, `platformStats.bootPriceUsd`) keep 12 significant digits, since a fresh coin trades around 1e-7 USD.
- **Fee economics**: RWAGMI coins pay a static 1% swap fee in WETH; 90% goes to the reward slots (`agentBps…platformBps`, sum 9000) and 10% to RWAGMI, so recipients get `bps / 10000` of the fee and no protocol fee comes on top. Clanker coins: the hook charges a protocol fee of 20% of the LP fee on top (1% LP fee → 1.2% gross) and recipients share 100% of the LP fee by `rewardBps`. `trade.feeUsd` / `fees24hUsd` = `valueUsd × Swap.fee / 1e6`.
- **Social data** (`xHandle`, `lastPostAt`, `postsCount24h`, supervisor `status`, `spender`) is stored off-chain (Postgres schema `bootr_offchain` or `.ponder/agent-social.json` under PGlite) because Ponder tables are read-only from the API. REST responses merge it live; GraphQL `token.xHandle` / `agent.lastPostAt` / `agent.postsCount24h` / `agent.spender` lag by one snapshot (~60 s). The Postgres table gains its `spender` column with `ADD COLUMN IF NOT EXISTS`; file entries without it read as `spender: null`.
- **Spender float**: each agent pays x402 inference from an off-chain-derived spender EOA that the kernel tops up, so part of its USDC lives outside the kernel. The live snapshot adds one USDC `balanceOf(spender)` per agent with a known spender to the same multicall as the kernel balances (skipped during backfill like the other live reads; a failed spender read keeps the last `spenderUsdc`). `treasuryUsdc` stays kernel only; `spenderUsdc` is separate; `treasuryUsd` and the sleep rule include both. A dormancy claim sweeps the kernel only, so a claimed agent's `treasuryUsd` keeps the last spender float.
- **Status**: `claimed` > `dormant` (now − lastActivityAt ≥ dormancyPeriod) > `paused` > `sleeping` (kernel USDC + spender USDC < 1, same rule as the supervisor) > `awake` (activity < 6 h, or supervisor reported `awake`) > `sleeping`.
- **Admin config**: `GET ${ADMIN_CONFIG_URL}` sends both `Authorization: HMAC <ts>:<sig>` (sender scheme) and `x-bootr-timestamp` / `x-bootr-signature` (web scheme). `graduationThresholdUsd` and optional `bootToken` are read; `BOOT_TOKEN_ADDRESS` is the env fallback.
