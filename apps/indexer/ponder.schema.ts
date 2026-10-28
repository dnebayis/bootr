import { index, onchainTable, relations } from 'ponder';

/**
 * Bootr indexer schema. Shapes follow docs/data-contract.md; columns marked "extra" are
 * additive (not in the contract) and safe for the web to ignore.
 *
 * Conventions: addresses / hashes are lowercase hex; integer amounts are `bigint` (GraphQL
 * `BigInt`, serialized as base-unit strings); `*Usd` are floats rounded to 6 dp; timestamps
 * are unix seconds (int).
 *
 * Coins launch through RWAGMI v3 (docs/rwagmi-migration.md): one Uniswap v4 pool per coin, paired
 * with WETH; the RWAGMI hook takes the swap fee in WETH only, so every fee row's `asset` is WETH.
 * "Fees" on token / daily / platform rows are the gross swap fee (`PoolFeeTakenV3`); the per-kind
 * splits cover Bootr's reward slots (90%), the rest is RWAGMI's protocol slot (10%).
 */

// ------------------------------------------------------------------ token / agent

export const token = onchainTable(
  'token',
  (t) => ({
    id: t.hex().primaryKey(),
    chainId: t.integer().notNull(),
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    image: t.text().notNull(),
    /** extra: launch metadata (`LaunchParams.metadata`, else the B20 `contractURI()`). */
    metadata: t.text().notNull(),
    creator: t.hex().notNull(),
    kernel: t.hex().notNull(),
    burner: t.hex(),
    agentId: t.bigint().notNull(),
    poolId: t.hex().notNull(),
    pairedToken: t.hex().notNull(),
    /** extra: true when the coin is currency0 of the v4 pool. */
    coinIsToken0: t.boolean().notNull(),
    /** Swap fee in hundredths of a bip (1e6 = 100%; 10_000 = 1%): the RWAGMI hook's static fee for the pool. */
    lpFeeBps: t.integer().notNull(),
    /**
     * Locked reward split from `RwagmiLpLockerV3.launchInfo(token).rewards`, in bps of the whole swap fee:
     * agent + creator + burn + platform = 9000, `protocolBps` (RWAGMI) = 1000.
     */
    agentBps: t.integer().notNull(),
    creatorBps: t.integer().notNull(),
    burnBps: t.integer().notNull(),
    platformBps: t.integer().notNull(),
    /** extra: RWAGMI's reward slot (bps of the swap fee) and its recipient. */
    protocolBps: t.integer().notNull(),
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
    /** extra: coins burned by the BuybackBurner (base units). */
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
 * extra: Uniswap v4 pools of Bootr coins, from `RwagmiLauncherV3.LaunchPoolCreatedV3` (Swap and fee
 * events of other pools are ignored). One pool per coin, paired with WETH.
 */
export const pool = onchainTable(
  'pool',
  (t) => ({
    id: t.hex().primaryKey(),
    token: t.hex().notNull(),
    coinIsToken0: t.boolean().notNull(),
    /** Position range: `LiquidityPlacedV3` once the launch is indexed, the expected launch range before. */
    tickLower: t.integer().notNull(),
    tickUpper: t.integer().notNull(),
    /** v4 PoolKey (`LaunchPoolCreatedV3.key`; native fee 0, the hook charges the swap fee). */
    currency0: t.hex().notNull(),
    currency1: t.hex().notNull(),
    fee: t.integer().notNull(),
    tickSpacing: t.integer().notNull(),
    hooks: t.hex().notNull(),
    pairedToken: t.hex().notNull(),
    poolIndex: t.integer().notNull(),
    /** Hook fee mode (0 static, 1 dynamic) and static fee in hundredths of a bip. */
    feeMode: t.integer().notNull(),
    staticFee: t.integer().notNull(),
    startingTick: t.integer().notNull(),
    depositedSupply: t.bigint().notNull(),
    launchTx: t.hex().notNull(),
  }),
  (table) => ({ tokenIdx: index().on(table.token) }),
);

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
 * extra: locked reward slots of a coin (`RwagmiLpLockerV3.launchInfo(token).rewards`, read at launch).
 * `recipientKind`: agent | creator | burn | platform | protocol (RWAGMI's appended slot).
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
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenTsIdx: index().on(table.token, table.timestamp),
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

// ------------------------------------------------------------------ fees / burns / treasury

/**
 * Fee earned per Bootr reward slot, booked when the hook takes the fee (`PoolFeeTakenV3`):
 * gross × slot bps / 10_000, like the locker's per-slot credit. `asset` is WETH.
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
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
    recipientIdx: index().on(table.recipient),
  }),
);

/**
 * extra: per (recipient, asset, coin) accrued/settled/claimed/outstanding. `settled` is what the locker
 * credited (`PoolFeesSettledV3`); a claim (`QuoteRewardsClaimedV3`) pays out a recipient's settled balance
 * across coins and is attributed by `settled - claimed`. `outstanding = accrued - claimed`.
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
 * extra: `RwagmiLpLockerV3.PoolFeesSettledV3` for Bootr reward slots: the exact WETH the locker credited to
 * a recipient when a pool was settled (RWAGMI's protocol slot is skipped).
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
  trades: many(trade),
  feeAccruals: many(feeAccrual),
  feeClaims: many(feeClaim),
  feeCredits: many(feeCredit),
  feeSlots: many(feeSlot),
  burns: many(burn),
  balances: many(balance),
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

export const sessionKeyRelations = relations(sessionKey, ({ one }) => ({
  agentRef: one(agent, { fields: [sessionKey.kernel], references: [agent.id] }),
}));

export const feedbackRelations = relations(feedback, ({ one }) => ({
  agentRef: one(agent, { fields: [feedback.kernel], references: [agent.id] }),
}));

export const fuelRelations = relations(fuel, ({ one }) => ({
  agentRef: one(agent, { fields: [fuel.kernel], references: [agent.id] }),
}));
