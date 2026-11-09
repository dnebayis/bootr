import { index, onchainTable, relations } from 'ponder';

/**
 * Bootr indexer schema. Shapes follow docs/data-contract.md; columns marked "extra" are
 * additive (not in the contract) and safe for the web to ignore.
 *
 * Conventions: addresses / hashes are lowercase hex; integer amounts are `bigint` (GraphQL
 * `BigInt`, serialized as base-unit strings); `*Usd` are floats rounded to 6 dp; timestamps
 * are unix seconds (int).
 *
 * Coins come through two launch paths (`token.source`, docs/design/clanker-launch.md):
 * - `bootr`: RWAGMI v3 (docs/rwagmi-migration.md): one Uniswap v4 pool per coin, paired with WETH; the
 *   RWAGMI hook takes the swap fee in WETH only, so every fee row's `asset` is WETH. "Fees" on token /
 *   daily / platform rows are the gross swap fee (`PoolFeeTakenV3`); the per-kind splits cover Bootr's
 *   reward slots (90%), the rest is RWAGMI's protocol slot (10%).
 * - `clanker`: Clanker v4: the reward slots share 100% of the LP fee and Clanker charges 20% of it on top
 *   (the trader pays `lpFeeBps × 1.2`); fee rows come from the locker's collections (`ClaimedRewards`,
 *   `asset` WETH for the agent / creator / platform slots, the coin itself for the burn slot, whose
 *   recipient is the dead address) and claims from `ClankerFeeLocker.ClaimTokens`.
 * - `clanker-v5`: Clanker v5 (docs/design/clanker-v5-migration.md): a buy and sell tax (`lpFeeBps`, the trader
 *   pays exactly it); Clanker's share is inside it (`protocolBps`, 3333 at 1.5%) and the four slot kinds share
 *   the rest, so the five bps columns sum to 10000 like the Bootr path. Fee rows come from the hook's per-swap
 *   credits (`CreatorTaxCredited` per paid slot in the quote, native ETH = `0x0`; `BurnTaxCredited` for the
 *   burn in the coin, recipient the dead address) and claims from `FeeEscrow.Claimed`. The pool is paired with
 *   native ETH: `pairedToken` and the fee rows' `asset` are the zero address.
 */

// ------------------------------------------------------------------ token / agent

export const token = onchainTable(
  'token',
  (t) => ({
    id: t.hex().primaryKey(),
    chainId: t.integer().notNull(),
    /** Launch path: `bootr` (RWAGMI v3), `clanker` (Clanker v4) or `clanker-v5` (Clanker v5). */
    source: t.text().notNull(),
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    image: t.text().notNull(),
    /** extra: launch metadata (`LaunchParams.metadata`, else the B20 `contractURI()` / Clanker `TokenCreated.tokenMetadata`). */
    metadata: t.text().notNull(),
    creator: t.hex().notNull(),
    kernel: t.hex().notNull(),
    /** BuybackBurner clone (bootr buyback preset) or the dead address `0x…dEaD` (clanker / clanker-v5 buyback: the burn's recipient); null otherwise. */
    burner: t.hex(),
    agentId: t.bigint().notNull(),
    poolId: t.hex().notNull(),
    /** WETH on the bootr and clanker paths; the zero address (native ETH) on clanker-v5. */
    pairedToken: t.hex().notNull(),
    /** extra: true when the coin is currency0 of the v4 pool. */
    coinIsToken0: t.boolean().notNull(),
    /** extra: the locked LP position's range (the `pool` row's, copied at launch), used for `liquidityUsd`. */
    tickLower: t.integer().notNull(),
    tickUpper: t.integer().notNull(),
    /**
     * Swap fee of this coin's pool in hundredths of a bip (1e6 = 100%; 10_000 = 1%), per token: the RWAGMI
     * hook's static fee (bootr), `ClankerLaunched.lpFeeBps` (clanker; Clanker adds 20% of it on top) or the
     * v5 tax `ClankerV5Launched.taxBps` (clanker-v5; the trader pays exactly it).
     */
    lpFeeBps: t.integer().notNull(),
    /**
     * Locked reward split in bps of the fee: bootr `agent + creator + burn + platform = 9000` with
     * `protocolBps` (RWAGMI) = 1000 (`RwagmiLpLockerV3.launchInfo(token).rewards`); clanker the four sum to
     * 10000 and `protocolBps` is 2000 *on top* (`ClankerLpLockerFeeConversion.tokenRewards(token)`); clanker-v5
     * the four sum to `10000 - protocolBps`, Clanker's share of the tax (the hook's slot weights and the burn
     * share, scaled to the tax).
     */
    agentBps: t.integer().notNull(),
    creatorBps: t.integer().notNull(),
    burnBps: t.integer().notNull(),
    platformBps: t.integer().notNull(),
    /** extra: the launch protocol's share: RWAGMI's reward slot (bootr), Clanker's fee on top (clanker) or Clanker's share of the tax (clanker-v5). */
    protocolBps: t.integer().notNull(),
    /** extra: RWAGMI's slot recipient (bootr); null on the Clanker paths (the hook keeps the protocol fee). */
    protocolRecipient: t.hex(),
    /** extra: platform reward-slot recipient. */
    platformRecipient: t.hex().notNull(),
    workerHash: t.hex().notNull(),
    model: t.text().notNull(),
    agentUri: t.text().notNull(),
    /** extra: informational supervisor session key from AgentLaunched. */
    supervisorSessionKey: t.hex().notNull(),
    xHandle: t.text(),
    launchedAt: t.integer().notNull(),
    launchBlock: t.bigint().notNull(),
    /** extra */
    launchTx: t.hex().notNull(),
    /** extra: total supply (base units). */
    totalSupply: t.bigint().notNull(),
    /** extra: last known pool state (from swaps, refreshed by the snapshot handler). */
    sqrtPriceX96: t.bigint().notNull(),
    tick: t.integer().notNull(),
    poolLiquidity: t.bigint().notNull(),
    /** extra: liquidity of the locked launch position (`LiquidityPlacedV3`, constant), used for `liquidityUsd`. */
    positionLiquidity: t.bigint().notNull(),
    /** extra: coin price in WETH. */
    priceWeth: t.doublePrecision().notNull(),
    priceUsd: t.doublePrecision().notNull(),
    marketCapUsd: t.doublePrecision().notNull(),
    liquidityUsd: t.doublePrecision().notNull(),
    volume24hUsd: t.doublePrecision().notNull(),
    volume7dUsd: t.doublePrecision().notNull(),
    fees24hUsd: t.doublePrecision().notNull(),
    /** Price change vs the last trade at or before now-24h; null when there was none. */
    change24hPct: t.doublePrecision(),
    /** extra */
    trades24h: t.integer().notNull(),
    volumeTotalUsd: t.doublePrecision().notNull(),
    feesTotalUsd: t.doublePrecision().notNull(),
    /** extra: coins burned by the BuybackBurner (bootr) or claimed to the dead address by the burn slot (clanker, clanker-v5), base units. */
    burnedTotal: t.bigint().notNull(),
    lastTradeAt: t.integer(),
    holders: t.integer().notNull(),
    graduated: t.boolean().notNull(),
    graduatedAt: t.integer(),
    /** extra: denormalized `agent.status` so `tokens(where: {agentStatus: "awake"})` works. */
    agentStatus: t.text().notNull(),
  }),
  (table) => ({
    creatorIdx: index().on(table.creator),
    kernelIdx: index().on(table.kernel),
    launchedAtIdx: index().on(table.launchedAt),
  }),
);

export const agent = onchainTable(
  'agent',
  (t) => ({
    id: t.hex().primaryKey(),
    token: t.hex().notNull(),
    /** extra */
    agentId: t.bigint().notNull(),
    /** extra */
    creator: t.hex().notNull(),
    status: t.text().notNull(),
    /** extra: last time `status` changed (drives `/stream` agent hints). */
    statusChangedAt: t.integer().notNull(),
    /** extra */
    paused: t.boolean().notNull(),
    /** extra */
    claimed: t.boolean().notNull(),
    lastActivityAt: t.integer().notNull(),
    dormancyPeriod: t.integer().notNull(),
    dormantSince: t.integer(),
    treasuryUsdc: t.bigint().notNull(),
    treasuryWeth: t.bigint().notNull(),
    treasuryEth: t.bigint().notNull(),
    treasuryOwnToken: t.bigint().notNull(),
    /** Kernel balances plus the spender's USDC float (USDC + spenderUsdc + WETH + ETH + own coin, in USD). */
    treasuryUsd: t.doublePrecision().notNull(),
    /** extra: the agent's x402 spender EOA (pushed by the supervisor with the social stats), null until known. */
    spender: t.hex(),
    /** extra: USDC float held by `spender` (base units, 6 dp); not part of `treasuryUsdc` (kernel only). */
    spenderUsdc: t.bigint().notNull(),
    /** extra: block timestamp of the last balance refresh. */
    balancesUpdatedAt: t.integer(),
    fuelReceivedUsdc: t.bigint().notNull(),
    feesClaimedUsd: t.doublePrecision().notNull(),
    reputationScore: t.doublePrecision(),
    reputationCount: t.integer().notNull(),
    /** extra: sum of non-revoked feedback values (score = sum / count). */
    reputationSum: t.doublePrecision().notNull(),
    lastPostAt: t.integer(),
    postsCount24h: t.integer().notNull(),
    /** extra: last status reported by the supervisor via REST. */
    supervisorStatus: t.text(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
    statusIdx: index().on(table.status),
  }),
);

/**
 * extra: Uniswap v4 pools of Bootr coins of both paths, from `RwagmiLauncherV3.LaunchPoolCreatedV3` (bootr) or
 * `BootrClankerLauncher.ClankerLaunched` + the locker's `TokenRewardAdded` (clanker). `PoolManager.Swap` of any
 * other pool is ignored. One pool per coin, paired with WETH.
 */
export const pool = onchainTable(
  'pool',
  (t) => ({
    id: t.hex().primaryKey(),
    token: t.hex().notNull(),
    coinIsToken0: t.boolean().notNull(),
    /** Position range: `LiquidityPlacedV3` / `TokenRewardAdded` once the launch is indexed, the expected launch range before. */
    tickLower: t.integer().notNull(),
    tickUpper: t.integer().notNull(),
    /**
     * v4 PoolKey (`LaunchPoolCreatedV3.key` / `TokenRewardAdded.poolKey`). bootr: native fee 0, the hook charges the
     * swap fee; clanker: the dynamic-fee flag (0x800000), the hook sets the LP fee.
     */
    currency0: t.hex().notNull(),
    currency1: t.hex().notNull(),
    fee: t.integer().notNull(),
    tickSpacing: t.integer().notNull(),
    hooks: t.hex().notNull(),
    pairedToken: t.hex().notNull(),
    poolIndex: t.integer().notNull(),
    /** Hook fee mode (0 static, 1 dynamic) and static fee in hundredths of a bip (the pool's `lpFeeBps`). */
    feeMode: t.integer().notNull(),
    staticFee: t.integer().notNull(),
    startingTick: t.integer().notNull(),
    depositedSupply: t.bigint().notNull(),
    launchTx: t.hex().notNull(),
  }),
  (table) => ({ tokenIdx: index().on(table.token) }),
);

/**
 * extra: Clanker-path launch facts from `BootrClankerLauncher.ClankerLaunched` (v4; plus the factory's
 * `TokenCreated` in the same receipt) or `BootrClankerLauncherV5.ClankerV5Launched` (v5; plus the factory's
 * `Launched` and the PoolManager's `Initialize`): the pool, the modules the coin was launched with, and the fee
 * actually used (per token: the platform's own coin may differ from everyone else's). One row per Clanker coin,
 * keyed by token.
 */
export const clankerPool = onchainTable('clanker_pool', (t) => ({
  id: t.hex().primaryKey(),
  /** Clanker version the coin was launched through: 4 or 5. */
  version: t.integer().notNull(),
  poolId: t.hex().notNull(),
  hook: t.hex().notNull(),
  /** v4: `ClankerLpLockerFeeConversion`; v5: the `FeeEscrow`. */
  locker: t.hex().notNull(),
  /** v4: the MEV module; v5: the zero address (`antiSnipe` says whether Clanker's anti-snipe fee was on). */
  mevModule: t.hex().notNull(),
  /** v5: Clanker's anti-snipe fee (99% falling to the tax over 20 s) was on at launch. Always false on v4. */
  antiSnipe: t.boolean().notNull(),
  /** v4: `tickIfToken0IsClanker` as emitted (not flipped); v5: the pool's opening tick (`Initialize.tick`). */
  startingTick: t.integer().notNull(),
  /** v4: LP fee in hundredths of a bip (10_000 = 1%), the trader pays it plus Clanker's 20%; v5: the tax, paid as is. */
  lpFeeBps: t.integer().notNull(),
  /** `TokenCreated.tokenContext` (`{interface, platform, id}`), empty when the receipt carried none. */
  context: t.text().notNull(),
  /** v4: supply taken by extensions (dev buy etc.); the LP position holds `totalSupply - extensionsSupply`. v5: 0 (the whole supply is seeded). */
  extensionsSupply: t.bigint().notNull(),
  launchTx: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
}));

/**
 * extra: `RwagmiLauncherV3.B20LaunchCreatedV3` of launches made by BootrLauncher. Emitted inside the
 * launch tx before `AgentLaunched`, which turns it (with the pool) into the token row.
 */
export const rwagmiLaunch = onchainTable('rwagmi_launch', (t) => ({
  id: t.hex().primaryKey(),
  name: t.text().notNull(),
  symbol: t.text().notNull(),
  decimals: t.integer().notNull(),
  totalSupply: t.bigint().notNull(),
  liquiditySupply: t.bigint().notNull(),
  extensionSupply: t.bigint().notNull(),
  primaryPoolId: t.hex().notNull(),
  poolCount: t.integer().notNull(),
  hook: t.hex().notNull(),
  locker: t.hex().notNull(),
  rewardConfigurationHash: t.hex().notNull(),
  launchTx: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
}));

/**
 * extra: locked reward slots of a coin (`RwagmiLpLockerV3.launchInfo(token).rewards` on the Bootr path,
 * `ClankerLpLockerFeeConversion.tokenRewards(token)` / `TokenRewardAdded` on the Clanker path, read at launch).
 * `recipientKind`: agent | creator | burn | platform | protocol (RWAGMI's appended slot, bootr only). The
 * Clanker burn slot's recipient is the dead address.
 */
export const feeSlot = onchainTable(
  'fee_slot',
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    slot: t.integer().notNull(),
    recipient: t.hex().notNull(),
    admin: t.hex().notNull(),
    bps: t.integer().notNull(),
    recipientKind: t.text().notNull(),
  }),
  (table) => ({ tokenIdx: index().on(table.token) }),
);

/** extra: ERC-8004 agentId -> kernel. */
export const agentIdentity = onchainTable('agent_identity', (t) => ({
  id: t.bigint().primaryKey(),
  kernel: t.hex().notNull(),
  token: t.hex().notNull(),
}));

// ------------------------------------------------------------------ market

export const trade = onchainTable(
  'trade',
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    trader: t.hex().notNull(),
    /** extra: PoolManager `Swap.sender` (router). */
    sender: t.hex().notNull(),
    side: t.text().notNull(),
    amountToken: t.bigint().notNull(),
    amountPaired: t.bigint().notNull(),
    priceUsd: t.doublePrecision().notNull(),
    valueUsd: t.doublePrecision().notNull(),
    /** extra: swap fee charged by the RWAGMI hook (valueUsd × (Swap.fee + token.lpFeeBps) / 1e6). */
    feeUsd: t.doublePrecision().notNull(),
    timestamp: t.integer().notNull(),
    /** extra */
    blockNumber: t.bigint().notNull(),
    /** extra: with `blockNumber` the order of trades; a timestamp is shared by about five blocks since Denim. */
    logIndex: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenTsIdx: index().on(table.token, table.timestamp),
    tokenBlockIdx: index().on(table.token, table.blockNumber, table.logIndex),
    tsIdx: index().on(table.timestamp),
    traderIdx: index().on(table.trader),
  }),
);

/** extra: hourly buckets backing the rolling 24h/7d windows (see src/lib/windows.ts). */
export const tokenWindow = onchainTable('token_window', (t) => ({
  id: t.hex().primaryKey(),
  buckets: t.json().notNull(),
}));

/** extra: ERC-20 balances of Bootr coins (holders count + `/holdings`). */
export const balance = onchainTable(
  'balance',
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    holder: t.hex().notNull(),
    amount: t.bigint().notNull(),
    updatedAt: t.integer().notNull(),
  }),
  (table) => ({
    holderIdx: index().on(table.holder),
    tokenIdx: index().on(table.token),
  }),
);

/**
 * extra: once-only milestones of a coin, for the platform feed (`GET /platform/feed`) and the agents'
 * `read_coin` tool: `first_swap` (the first trade after the launch transaction; `value` 0), `holders`
 * (the holder count reached `value`: 25, 100, 500, 1000) and `volume24h` (rolling 24 h volume reached
 * `value` USD: 1000, 10000). One row per (token, kind, value), written the first time it happens.
 */
export const milestone = onchainTable(
  'milestone',
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    kernel: t.hex().notNull(),
    kind: t.text().notNull(),
    value: t.integer().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
    tsIdx: index().on(table.timestamp),
  }),
);

// ------------------------------------------------------------------ fees / burns / treasury

/**
 * Fee earned per Bootr reward slot. bootr: booked when the hook takes the fee (`PoolFeeTakenV3`), gross × slot
 * bps / 10_000 like the locker's per-slot credit, `asset` WETH. clanker: booked when the locker collects the
 * position's fees (`ClaimedRewards`), the exact post-conversion amount per slot, `asset` WETH (or the coin for
 * the burn slot). clanker-v5: booked per swap from the hook's credits (`CreatorTaxCredited`, `asset` the quote,
 * native ETH = `0x0`; `BurnTaxCredited`, `asset` the coin).
 */
export const feeAccrual = onchainTable(
  'fee_accrual',
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    recipient: t.hex().notNull(),
    recipientKind: t.text().notNull(),
    asset: t.hex().notNull(),
    amount: t.bigint().notNull(),
    amountUsd: t.doublePrecision().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
    recipientIdx: index().on(table.recipient),
  }),
);

export const feeClaim = onchainTable(
  'fee_claim',
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    recipient: t.hex().notNull(),
    recipientKind: t.text().notNull(),
    asset: t.hex().notNull(),
    amount: t.bigint().notNull(),
    amountUsd: t.doublePrecision().notNull(),
    timestamp: t.integer().notNull(),
    /** With `logIndex` the order against `feeCredit`; a timestamp is shared by about five blocks since Denim. */
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
    recipientIdx: index().on(table.recipient),
  }),
);

/**
 * extra: per (recipient, asset, coin) accrued/settled/claimed/outstanding. `settled` is what the locker
 * credited (`PoolFeesSettledV3`; on the Clanker paths `ClaimedRewards` / the v5 hook's credits, where accrued =
 * settled); a claim (`QuoteRewardsClaimedV3` / `ClaimTokens` / `Claimed`) pays out a recipient's settled balance
 * across the coins of that locker's path and is attributed by `settled - claimed`. `outstanding = accrued -
 * claimed`.
 */
export const feeBalance = onchainTable(
  'fee_balance',
  (t) => ({
    id: t.text().primaryKey(),
    recipient: t.hex().notNull(),
    asset: t.hex().notNull(),
    token: t.hex().notNull(),
    recipientKind: t.text().notNull(),
    accrued: t.bigint().notNull(),
    settled: t.bigint().notNull(),
    claimed: t.bigint().notNull(),
    outstanding: t.bigint().notNull(),
    accruedUsd: t.doublePrecision().notNull(),
    claimedUsd: t.doublePrecision().notNull(),
  }),
  (table) => ({
    ownerAssetIdx: index().on(table.recipient, table.asset),
    tokenIdx: index().on(table.token),
  }),
);

/**
 * extra: the exact amount a locker credited to a reward slot: `RwagmiLpLockerV3.PoolFeesSettledV3` (bootr, WETH;
 * RWAGMI's protocol slot is skipped), `ClankerLpLockerFeeConversion.ClaimedRewards` (clanker, per slot and side
 * after conversion) or the v5 hook's `CreatorTaxCredited` / `BurnTaxCredited` (clanker-v5, per slot and swap).
 */
export const feeCredit = onchainTable(
  'fee_credit',
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    poolId: t.hex().notNull(),
    slot: t.integer().notNull(),
    recipient: t.hex().notNull(),
    recipientKind: t.text().notNull(),
    asset: t.hex().notNull(),
    amount: t.bigint().notNull(),
    amountUsd: t.doublePrecision().notNull(),
    timestamp: t.integer().notNull(),
    /** With `logIndex` the order against `feeClaim`. */
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
    recipientIdx: index().on(table.recipient),
  }),
);

/** extra: every address that receives swap fees of a Bootr coin (cheap filter for locker claims). */
export const feeRecipient = onchainTable('fee_recipient', (t) => ({
  id: t.hex().primaryKey(),
  firstToken: t.hex().notNull(),
}));

export const burn = onchainTable(
  'burn',
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    /** extra */
    burner: t.hex().notNull(),
    amountToken: t.bigint().notNull(),
    amountWethSpent: t.bigint().notNull(),
    /** extra */
    amountUsd: t.doublePrecision().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ tokenIdx: index().on(table.token) }),
);

/** extra: BuybackBurner clone state. */
export const burner = onchainTable('burner', (t) => ({
  id: t.hex().primaryKey(),
  token: t.hex().notNull(),
  lastSwapTx: t.hex(),
  lastSwapWeth: t.bigint().notNull(),
  burnedTotal: t.bigint().notNull(),
}));

export const dormantClaim = onchainTable('dormant_claim', (t) => ({
  id: t.text().primaryKey(),
  token: t.hex().notNull(),
  kernel: t.hex().notNull(),
  usdc: t.bigint().notNull(),
  weth: t.bigint().notNull(),
  eth: t.bigint().notNull(),
  tokenBurned: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
  txHash: t.hex().notNull(),
}));

/** extra: USDC transfers into agent kernels (`/fuel/:from`, `agent.fuelReceivedUsdc`). */
export const fuel = onchainTable(
  'fuel',
  (t) => ({
    id: t.text().primaryKey(),
    from: t.hex().notNull(),
    kernel: t.hex().notNull(),
    token: t.hex().notNull(),
    amount: t.bigint().notNull(),
    amountUsd: t.doublePrecision().notNull(),
    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    fromIdx: index().on(table.from),
    kernelIdx: index().on(table.kernel),
  }),
);

/** extra: session keys approved by the AgentGuardian admin. */
export const sessionKey = onchainTable(
  'session_key',
  (t) => ({
    id: t.text().primaryKey(),
    kernel: t.hex().notNull(),
    validationId: t.hex().notNull(),
    nonce: t.integer().notNull(),
    digest: t.hex().notNull(),
    status: t.text().notNull(), // approved | revoked | uninstalled | invalidated
    approvedAt: t.integer().notNull(),
    updatedAt: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ kernelIdx: index().on(table.kernel) }),
);

/** extra: ERC-8004 feedback entries for Bootr agents. */
export const feedback = onchainTable(
  'feedback',
  (t) => ({
    id: t.text().primaryKey(),
    agentId: t.bigint().notNull(),
    kernel: t.hex().notNull(),
    client: t.hex().notNull(),
    feedbackIndex: t.bigint().notNull(),
    value: t.doublePrecision().notNull(),
    tag1: t.text().notNull(),
    tag2: t.text().notNull(),
    revoked: t.boolean().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ kernelIdx: index().on(table.kernel) }),
);

// ------------------------------------------------------------------ rollups

export const dailyStat = onchainTable('daily_stat', (t) => ({
  id: t.text().primaryKey(),
  /** extra: 00:00 UTC of the day (unix s). */
  timestamp: t.integer().notNull(),
  launches: t.integer().notNull(),
  volumeUsd: t.doublePrecision().notNull(),
  /** extra */
  trades: t.integer().notNull(),
  feesUsd: t.doublePrecision().notNull(),
  feesAgentUsd: t.doublePrecision().notNull(),
  feesCreatorUsd: t.doublePrecision().notNull(),
  feesBurnUsd: t.doublePrecision().notNull(),
  feesPlatformUsd: t.doublePrecision().notNull(),
  activeAgents: t.integer().notNull(),
  awakeAgents: t.integer().notNull(),
  bootBurnedToken: t.bigint().notNull(),
  bootBurnedUsd: t.doublePrecision().notNull(),
}));

export const platformStats = onchainTable('platform_stats', (t) => ({
  id: t.text().primaryKey(),
  tokens: t.integer().notNull(),
  /** extra */
  agentsTotal: t.integer().notNull(),
  agentsAwake: t.integer().notNull(),
  volume24hUsd: t.doublePrecision().notNull(),
  volumeTotalUsd: t.doublePrecision().notNull(),
  /** extra */
  fees24hUsd: t.doublePrecision().notNull(),
  feesTotalUsd: t.doublePrecision().notNull(),
  bootToken: t.hex(),
  bootPriceUsd: t.doublePrecision().notNull(),
  bootMarketCapUsd: t.doublePrecision().notNull(),
  bootChange24hPct: t.doublePrecision().notNull(),
  bootBurnedTotal: t.bigint().notNull(),
  bootFeesToBurnUsd: t.doublePrecision().notNull(),
  graduationThresholdUsd: t.doublePrecision().notNull(),
  /** extra: ETH/USD (Chainlink) used for valuations. */
  ethPriceUsd: t.doublePrecision().notNull(),
  updatedAt: t.integer().notNull(),
}));

/**
 * extra: platform totals per launch path (`id` = `bootr` | `clanker` | `clanker-v5`), bumped by the handlers: coins, volume, the
 * gross fee traders paid, what accrued to each Bootr slot kind, and what was claimed. `platformStats` keeps the
 * sums; `GET /platform/fees` reads this table.
 */
export const sourceStats = onchainTable('source_stats', (t) => ({
  id: t.text().primaryKey(),
  tokens: t.integer().notNull(),
  volumeTotalUsd: t.doublePrecision().notNull(),
  /** Gross swap fee (bootr: including RWAGMI's 10%; clanker: including Clanker's 20% on top; clanker-v5: the whole tax). */
  feesTotalUsd: t.doublePrecision().notNull(),
  feesAgentUsd: t.doublePrecision().notNull(),
  feesCreatorUsd: t.doublePrecision().notNull(),
  feesBurnUsd: t.doublePrecision().notNull(),
  feesPlatformUsd: t.doublePrecision().notNull(),
  /** Claims of every slot kind. */
  feesClaimedUsd: t.doublePrecision().notNull(),
  /** Claims of the platform slot only. */
  feesPlatformClaimedUsd: t.doublePrecision().notNull(),
  updatedAt: t.integer().notNull(),
}));

export const platformConfig = onchainTable('platform_config', (t) => ({
  id: t.text().primaryKey(),
  graduationThresholdUsd: t.doublePrecision().notNull(),
  bootToken: t.hex(),
  /** extra: `default` | `env` | `admin` */
  source: t.text().notNull(),
  /** extra: last block whose USDC transfers into kernels were scanned. */
  fuelScannedTo: t.bigint().notNull(),
  updatedAt: t.integer().notNull(),
}));

/** extra: cached oracle prices (`ETH/USD`). */
export const priceFeed = onchainTable('price_feed', (t) => ({
  id: t.text().primaryKey(),
  priceUsd: t.doublePrecision().notNull(),
  /** Oracle `updatedAt`. */
  oracleUpdatedAt: t.integer().notNull(),
  blockNumber: t.bigint().notNull(),
}));

// ------------------------------------------------------------------ relations (GraphQL nesting)

export const tokenRelations = relations(token, ({ one, many }) => ({
  agent: one(agent, { fields: [token.kernel], references: [agent.id] }),
  clankerPool: one(clankerPool, { fields: [token.id], references: [clankerPool.id] }),
  trades: many(trade),
  feeAccruals: many(feeAccrual),
  feeClaims: many(feeClaim),
  feeCredits: many(feeCredit),
  feeSlots: many(feeSlot),
  burns: many(burn),
  balances: many(balance),
  milestones: many(milestone),
}));

export const agentRelations = relations(agent, ({ one, many }) => ({
  tokenRef: one(token, { fields: [agent.token], references: [token.id] }),
  sessionKeys: many(sessionKey),
  feedbacks: many(feedback),
  fuelEvents: many(fuel),
}));

export const tradeRelations = relations(trade, ({ one }) => ({
  tokenRef: one(token, { fields: [trade.token], references: [token.id] }),
}));

export const feeAccrualRelations = relations(feeAccrual, ({ one }) => ({
  tokenRef: one(token, { fields: [feeAccrual.token], references: [token.id] }),
}));

export const feeClaimRelations = relations(feeClaim, ({ one }) => ({
  tokenRef: one(token, { fields: [feeClaim.token], references: [token.id] }),
}));

export const feeCreditRelations = relations(feeCredit, ({ one }) => ({
  tokenRef: one(token, { fields: [feeCredit.token], references: [token.id] }),
}));

export const feeSlotRelations = relations(feeSlot, ({ one }) => ({
  tokenRef: one(token, { fields: [feeSlot.token], references: [token.id] }),
}));

export const burnRelations = relations(burn, ({ one }) => ({
  tokenRef: one(token, { fields: [burn.token], references: [token.id] }),
}));

export const balanceRelations = relations(balance, ({ one }) => ({
  tokenRef: one(token, { fields: [balance.token], references: [token.id] }),
}));

export const milestoneRelations = relations(milestone, ({ one }) => ({
  tokenRef: one(token, { fields: [milestone.token], references: [token.id] }),
}));

export const sessionKeyRelations = relations(sessionKey, ({ one }) => ({
  agentRef: one(agent, { fields: [sessionKey.kernel], references: [agent.id] }),
}));

export const feedbackRelations = relations(feedback, ({ one }) => ({
  agentRef: one(agent, { fields: [feedback.kernel], references: [agent.id] }),
}));

export const fuelRelations = relations(fuel, ({ one }) => ({
  agentRef: one(agent, { fields: [fuel.kernel], references: [agent.id] }),
}));
