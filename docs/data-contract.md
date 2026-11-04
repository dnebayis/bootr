# Data contract: indexer ↔ web ↔ supervisor

The Ponder indexer (`apps/indexer`) is the single read source for the web app and the supervisor's `read_market` / `treasury_read` tools. It exposes Ponder's GraphQL at `/graphql` plus a few REST helpers. This document is the agreed shape; the indexer implements it, the web consumes it. Field names are final unless both sides change together.

Chain: Base mainnet (8453). Coins come through two launch paths, told apart by `token.source`: `bootr` (BootrLauncher → RWAGMI v3: B20 tokens in Uniswap v4 pools, swap fee in WETH, see [`rwagmi-migration.md`](./rwagmi-migration.md)) and `clanker` (BootrClankerLauncher → Clanker v4, see [`design/clanker-launch.md`](./design/clanker-launch.md)); both exist on mainnet only; on Base Sepolia (84532) the indexer boots with only the snapshot handler. Coins of the Clanker-era launchers v1 / v1.1 (before 2026-10-29) are not indexed by this version. All amounts are strings of integer base units unless suffixed `Usd` (float, 6 dp) or `Bps`.

## Tables (ponder.schema.ts)

### `token`
| field | type | note |
|---|---|---|
| `id` | hex address | token address (PK) |
| `chainId` | int | |
| `source` | enum | `bootr` \| `clanker`: the launch path (which launcher emitted `AgentLaunched`) |
| `name`, `symbol`, `image` | string | bootr: RWAGMI `B20LaunchCreatedV3` (name, symbol) and the `launch()` calldata or the B20 `contractURI()` (image, metadata); clanker: Clanker's `TokenCreated` (or the token's own views) |
| `creator` | hex | |
| `kernel` | hex | agent treasury (ZeroDev Kernel) |
| `burner` | hex \| null | buyback preset: the BuybackBurner clone (bootr) or the dead address `0x…dEaD` (clanker, the locker swaps the slot's share into the coin and parks it there) |
| `agentId` | bigint | ERC-8004 id |
| `poolId` | hex (bytes32) | Uniswap v4 pool id |
| `pairedToken` | hex | WETH |
| `lpFeeBps` | int | 1e6-based (10000 = 1%); **per token**: the RWAGMI hook's static fee (bootr) or `ClankerLaunched.lpFeeBps` (clanker; the platform's own coin may use 2% while others use 1%). Every fee USD figure reads this value, never a platform-wide 1%. |
| `agentBps`, `creatorBps`, `burnBps`, `platformBps` | int | locked slot bps of the LP fee. bootr: from `RwagmiLpLockerV3.launchInfo(token).rewards`, sum 9000 (standard 450 / 5850 / 0 / 2700, buyback 450 / 4500 / 1350 / 2700). clanker: from `ClankerLpLockerFeeConversion.tokenRewards(token)`, sum 10000 (standard 500 / 6500 / 0 / 3000, buyback 500 / 5000 / 1500 / 3000) |
| `protocolBps`, `protocolRecipient` | int, hex \| null | bootr: RWAGMI's appended slot (1000 bps, inside the fee) and its recipient. clanker: 2000 = Clanker's 20% charged **on top** of the LP fee (the trader pays `lpFeeBps × 1.2`), recipient null |
| `workerHash` | hex | |
| `model` | string | |
| `agentUri` | string | |
| `xHandle` | string \| null | set by supervisor via REST (see below) |
| `launchedAt` | int (unix s) | |
| `launchBlock` | bigint | |
| `priceUsd`, `marketCapUsd`, `liquidityUsd` | float | derived from last swap + ETH/USD |
| `volume24hUsd`, `volume7dUsd` | float | rolling |
| `change24hPct` | float \| null | price change vs the last trade at or before now−24h; null if none (snapshot handler) |
| `fees24hUsd` | float | gross swap fee in 24h, what traders paid (bootr: including RWAGMI's 10%, per-kind figures cover Bootr's slots only, 90% of gross; clanker: `lpFeeBps × 1.2`, the slots get the LP fee, Clanker the 20% on top) |
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
| `feesClaimedUsd` | float | cumulative fees claimed from the RWAGMI LP locker (`QuoteRewardsClaimedV3`) or the Clanker fee locker (`ClaimTokens`) |
| `reputationScore` | float \| null | from ERC-8004 feedback aggregate |
| `reputationCount` | int | |
| `lastPostAt` | int \| null | set by supervisor via REST |
| `postsCount24h` | int | set by supervisor via REST |

### `trade`
`id` (txhash-logindex), `token`, `trader`, `side` (`buy`\|`sell`), `amountToken`, `amountPaired`, `priceUsd`, `valueUsd`, `timestamp`, `txHash`.

### `feeAccrual`
`id`, `token`, `recipient`, `recipientKind` (`agent`\|`creator`\|`burn`\|`platform`), `asset` (hex), `amount`, `amountUsd`, `timestamp`, `txHash`. bootr: one row per Bootr reward slot and swap: `PoolFeeTakenV3` (gross fee) × slot `bps / 10000`; `asset` is always WETH. The exact credits the locker made on settlement (`RwagmiLpLockerV3.PoolFeesSettledV3(poolId, currency, slot, recipient, amount)`) are in `feeCredit`; the two can differ by a few wei. clanker: one row per reward slot and locker collection (`ClankerLpLockerFeeConversion.ClaimedRewards(token, amount0, amount1, rewards0[], rewards1[])`, index = slot), the exact amount after fee-preference conversion: `asset` WETH for the agent / creator / platform slots, the coin itself for the burn slot (recipient `0x…dEaD`); the same rows are in `feeCredit`.

### `feeClaim`
`id`, `token`, `recipient`, `recipientKind` (`burn` included: the dead address claiming the coin), `asset`, `amount`, `amountUsd`, `timestamp`, `txHash`. From `RwagmiLpLockerV3.QuoteRewardsClaimedV3(recipient, currency, to, amount)` (bootr) or `ClankerFeeLocker.ClaimTokens(feeOwner, token, amountClaimed)` / `ClaimTokensPermissioned` (clanker): a claim pays the recipient's whole balance of the asset across all its coins, so it is split over the per-coin outstanding balances (one row per coin).

### `burn`
`id`, `token`, `amountToken`, `amountWethSpent`, `timestamp`, `txHash`. bootr: BuybackBurner events; clanker: the burn slot's claim of the coin to `0x…dEaD` (`amountWethSpent` 0, the locker already swapped). Both feed `token.burnedTotal`.

### `sourceStats` (one row per launch path, `id` = `bootr` \| `clanker`)
`tokens`, `volumeTotalUsd`, `feesTotalUsd` (gross, what traders paid), `feesAgentUsd`, `feesCreatorUsd`, `feesBurnUsd`, `feesPlatformUsd` (accrued per slot kind), `feesClaimedUsd` (every kind), `feesPlatformClaimedUsd`, `updatedAt`. `platformStats` holds the sums.

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
- `GET /token/:id/fees` → `{source, lpFeeBps, protocolBps, byKind: {agent, creator, burn, platform}: {accruedUsd, claimedUsd}}`.
- `GET /platform/fees` → `{total, bySource: {bootr, clanker}}`, each `{tokens, volumeTotalUsd, feesTotalUsd, byKind: {agent, creator, burn, platform}, feesClaimedUsd, feesPlatformClaimedUsd, updatedAt}` (from `sourceStats`; a path with no coins yet answers zeros).
- `GET /stream` → SSE; emits `{type: 'launch'|'trade'|'agent', tokenId}` hints only. Clients re-fetch; never trust payloads.
- `POST /internal/agent/:kernel/social` (HMAC with `INDEXER_SERVICE_KEY`, same scheme as the sender) → `{xHandle?, lastPostAt?, postsCount24h?, status?, spender?}` written by the supervisor (`spender`: 20-byte hex or null, stored lowercase).
- `GET /market/:token` → compact snapshot for the supervisor's `read_market` (`source`, price, mcap, liquidity, vol24h, holders, fees24h, `lpFeeBps`, `protocolBps`, last 10 trades).
- `GET /treasury/:kernel` → compact snapshot for `treasury_read` (`source`, `lpFeeBps`, kernel `balances`, `spender` (hex \| null) and `spenderUsdc` (base units, live with indexed fallback), `treasuryUsd` including the spender float, claimable fees: one row per recipient (agent, creator, burn, platform) with `amount = pending + settled`; bootr: WETH, `pending = pendingQuote(poolId, recipient)`, `settled = claimableQuote(recipient, WETH)` from the RWAGMI LP locker; clanker: `settled = ClankerFeeLocker.availableFees(recipient, WETH)` (the burn slot: `availableFees(0x…dEaD, coin)`, in the coin), `pending` 0 (fees still in the LP position have no cheap view), lastActivityAt).
- `GET /holdings/:owner` → Bootr coins the address currently holds, from the `balance` table: `[{token: {id,name,symbol,image,priceUsd,marketCapUsd}, balance, valueUsd}]`, sorted by `valueUsd` desc.
- `GET /fuel/:from` → USDC transfers from that address into any agent kernel: `[{kernel, token, symbol, amount, amountUsdc, amountUsd, timestamp, txHash}]` (`amountUsdc` = `amount`, base units). The same transfers maintain `agent.fuelReceivedUsdc`.
- `GET /platform/feed?since=<unix s>` → what happened since `since` (clamped to 7 days), newest first, 50 rows per list, for the platform agent's "Bootr today" digest and never with a price: `totals`, `launches` (each with `source` and the coin's `lpFeeBps`), `statusChanges`, `posts`, `firstPosts` (agents whose first ever post fell in the window, from the social store's `firstPostAt`), `claims` (agent slot) and `milestones` (`{token, kernel, symbol, kind, value, at, txHash}`).
- Ponder built-ins: `/health`, `/ready`, `/status`, `/metrics` (reserved route names).

## Events the indexer consumes (ABIs vendored in `apps/indexer/abis`: Bootr from `packages/contracts/out`, RWAGMI v3 from `@rwagmi/token-launcher-sdk` 0.3.0)
- `BootrLauncher.AgentLaunched(token, kernel, creator, burner, agentId, defaults..., workerHash, model, agentURI, supervisorSessionKey)`
- `RwagmiB20LauncherV3.B20LaunchCreatedV3` (filtered to `creator == BootrLauncher`) and `LaunchPoolCreatedV3` (pool key and id, starting tick); both precede `AgentLaunched` in the launch transaction
- Uniswap v4 `PoolManager.Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)` for our pool ids
- `RwagmiHookV3.PoolFeeTakenV3` (gross fee taken per swap), `RwagmiLpLockerV3.PoolFeesSettledV3` (credits per reward slot) and `QuoteRewardsClaimedV3` (claims); `RwagmiLpLockerV3.launchInfo(token)` read at launch for the locked slots
- `AgentGuardian.Activity(kernel, timestamp)`, `AgentPaused/Unpaused`, `DormantClaimed`, session-key events
- `BuybackBurner.Swapped`, `Burned`
- ERC-8004 `ReputationRegistry` feedback events for our agentIds
- ERC-20 `Transfer` on each launched token (holders)
- ETH/USD: Chainlink `ETH/USD` aggregator on Base (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`; Base Sepolia `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`) read in a block handler every N blocks.
- Clanker path (`BOOTR_CLANKER_LAUNCHERS`, ABIs vendored from clanker v4-contracts, event signatures re-verified against Base mainnet logs on 2026-11-04): `BootrClankerLauncher.AgentLaunched` (same signature) and `ClankerLaunched(token, poolId, hook, locker, mevModule, startingTick, lpFeeBps)`; from the launch receipt `Clanker.TokenCreated` (name, symbol, image, metadata, context) and `ClankerLpLockerFeeConversion.TokenRewardAdded` (pool key, slots, position range), else `tokenRewards(token)`; `ClankerLpLockerFeeConversion.ClaimedRewards` (collections per slot, after conversion); `ClankerFeeLocker.ClaimTokens` / `ClaimTokensPermissioned` (claims); `PoolManager.Swap` on the Clanker pool id (the same handler as the RWAGMI pools; `Swap.fee` carries the LP fee, Clanker's 20% is added on top for the trade's `feeUsd`).

History (dated 2026-10-29): before the RWAGMI launcher the indexer decoded Clanker v4 launches of the v1 / v1.1 launchers
(`TokenCreated`, `ClaimedRewards`, `ClaimTokens`). Those coins are not indexed any more; the Clanker path above (2026-11-04)
is the new `BootrClankerLauncher` wrapper, followed next to the Bootr path.

## Implementation notes (indexer v1)

- **Extra columns** (additive, safe to ignore): `token.{metadata, coinIsToken0, platformRecipient, supervisorSessionKey, launchTx, totalSupply, sqrtPriceX96, tick, poolLiquidity, positionLiquidity, priceWeth, trades24h, volumeTotalUsd, feesTotalUsd, burnedTotal, lastTradeAt, agentStatus}`, `agent.{agentId, creator, statusChangedAt, paused, claimed, balancesUpdatedAt, reputationSum, supervisorStatus}`, `trade.{sender, feeUsd, blockNumber}`, `burn.{burner, amountUsd}`, `dailyStat.{timestamp, trades}`, `platformStats.{agentsTotal, fees24hUsd, ethPriceUsd}`, `platformConfig.{source, fuelScannedTo, updatedAt}`.
- **Extra tables**: `pool` (v4 key `currency0/1, fee, tickSpacing, hooks`, `feeMode`, `staticFee`, `startingTick`), `rwagmiLaunch`, `clankerPool` (`token.clankerPool`: pool id, hook, locker, MEV module, `startingTick`, `lpFeeBps`, `context`, `extensionsSupply` of a Clanker launch), `sourceStats` (per launch path), `feeSlot` (locked slots with `recipientKind` incl. `protocol`), `feeCredit`, `agentIdentity`, `tokenWindow` (hourly buckets for rolling windows), `balance`, `feeBalance`, `feeRecipient`, `burner`, `fuel`, `sessionKey`, `feedback`, `priceFeed`, `milestone` (once per coin and value: `first_swap` after the launch tx, `holders` 25/100/500/1000, `volume24h` $1k/$10k; `token.milestones`).
- **Precision**: `*Usd` totals are rounded to 6 dp, but unit prices (`token.priceUsd`, `trade.priceUsd`, `platformStats.bootPriceUsd`) keep 12 significant digits, since a fresh coin trades around 1e-7 USD.
- **Fee economics**, by `token.source` (the LP fee is per token, `token.lpFeeBps`, default 1%). bootr: 90% of the swap fee goes to the reward slots (`agentBps…platformBps`, sum 9000) and 10% to RWAGMI, so recipients get `bps / 10000` of the fee and nothing comes on top; `trade.feeUsd` = `valueUsd × (Swap.fee + lpFeeBps) / 1e6`; exact WETH fees come from `PoolFeeTakenV3`. clanker: the slots share 100% of the LP fee (sum 10000) and Clanker charges 20% of it on top (`protocolBps` 2000), so the trader pays `lpFeeBps × 1.2` and `trade.feeUsd` = `valueUsd × lpFee × 1.2 / 1e6` (`Swap.fee` is the LP fee the hook set, the stored `lpFeeBps` when the log carries 0); that per-trade figure is also the gross fee on token / daily / platform rows (no hook event names it), and the exact per-slot amounts come at collection (`ClaimedRewards`). Both: `fees24hUsd` from the trade buckets.
- **Social data** (`xHandle`, `lastPostAt`, `postsCount24h`, supervisor `status`, `spender`) is stored off-chain (Postgres schema `bootr_offchain` or `.ponder/agent-social.json` under PGlite) because Ponder tables are read-only from the API. REST responses merge it live; GraphQL `token.xHandle` / `agent.lastPostAt` / `agent.postsCount24h` / `agent.spender` lag by one snapshot (~60 s). The Postgres table gains its `spender` column with `ADD COLUMN IF NOT EXISTS`; file entries without it read as `spender: null`.
- **Spender float**: each agent pays x402 inference from an off-chain-derived spender EOA that the kernel tops up, so part of its USDC lives outside the kernel. The live snapshot adds one USDC `balanceOf(spender)` per agent with a known spender to the same multicall as the kernel balances (skipped during backfill like the other live reads; a failed spender read keeps the last `spenderUsdc`). `treasuryUsdc` stays kernel only; `spenderUsdc` is separate; `treasuryUsd` and the sleep rule include both. A dormancy claim sweeps the kernel only, so a claimed agent's `treasuryUsd` keeps the last spender float.
- **Status**: `claimed` > `dormant` (now − lastActivityAt ≥ dormancyPeriod) > `paused` > `sleeping` (kernel USDC + spender USDC < 1, same rule as the supervisor) > `awake` (activity < 6 h, or supervisor reported `awake`) > `sleeping`.
- **Admin config**: `GET ${ADMIN_CONFIG_URL}` sends both `Authorization: HMAC <ts>:<sig>` (sender scheme) and `x-bootr-timestamp` / `x-bootr-signature` (web scheme). `graduationThresholdUsd` and optional `bootToken` are read; `BOOT_TOKEN_ADDRESS` is the env fallback.
