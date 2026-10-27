import { index, onchainTable, relations } from 'ponder';

/**
 * Bootr indexer schema. Shapes follow docs/data-contract.md; columns marked "extra" are
 * additive (not in the contract) and safe for the web to ignore.
 *
 * Conventions: addresses / hashes are lowercase hex; integer amounts are `bigint` (GraphQL
 * `BigInt`, serialized as base-unit strings); `*Usd` are floats rounded to 6 dp; timestamps
 * are unix seconds (int).
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
    /** extra: Clanker token metadata JSON string. */
    metadata: t.text().notNull(),
    creator: t.hex().notNull(),
    kernel: t.hex().notNull(),
    burner: t.hex(),
    agentId: t.bigint().notNull(),
    poolId: t.hex().notNull(),
    pairedToken: t.hex().notNull(),
    /** extra: true when the coin is currency0 of the v4 pool. */
    coinIsToken0: t.boolean().notNull(),
    lpFeeBps: t.integer().notNull(),
    agentBps: t.integer().notNull(),
    creatorBps: t.integer().notNull(),
    burnBps: t.integer().notNull(),
    platformBps: t.integer().notNull(),
    /** extra: platform LP-fee recipient from the AgentLaunched defaults snapshot. */
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
    /** extra: liquidity of the locked Clanker position (constant), used for `liquidityUsd`. */
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

/** extra: Uniswap v4 pools of Bootr coins (Swap events of other pools are ignored). */
export const pool = onchainTable('pool', (t) => ({
  id: t.hex().primaryKey(),
  token: t.hex().notNull(),
  coinIsToken0: t.boolean().notNull(),
  tickLower: t.integer().notNull(),
  tickUpper: t.integer().notNull(),
}));

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
    /** extra: LP fee paid to recipients (valueUsd * lpFee). */
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

/** extra: per (recipient, asset, coin) accrued/claimed/outstanding, used to attribute claims. */
export const feeBalance = onchainTable(
  'fee_balance',
  (t) => ({
    id: t.text().primaryKey(),
    recipient: t.hex().notNull(),
    asset: t.hex().notNull(),
    token: t.hex().notNull(),
    recipientKind: t.text().notNull(),
    accrued: t.bigint().notNull(),
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

/** extra: every address that receives LP fees of a Bootr coin (cheap filter for FeeLocker claims). */
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
