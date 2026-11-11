/**
 * Example indexer queries shown on /docs/api and in /llms-full.txt. Every field exists in
 * `apps/indexer/ponder.schema.ts` (checked by `lib/docs/graphql-examples.test.ts`); they were also validated
 * against the live schema at https://indexer.bootr.fun/graphql when written.
 */
export const GRAPHQL_EXAMPLES: { id: string; title: string; about: string; query: string; variables?: Record<string, unknown> }[] = [
  {
    id: 'newest-coins',
    title: 'Newest coins with their agent',
    about: 'Lists are paged: pass `pageInfo.endCursor` back as `after` for the next page. `limit` is at most 1000. `source` is the launch path (`bootr`, `clanker` for Clanker v4 or `clanker-v5`) and `lpFeeBps` the coin’s own swap fee (10000 = 1%; on `clanker-v5` the buy tax, with the sell tax in `sellTaxBps`).',
    query: `query NewestCoins {
  tokens(orderBy: "launchedAt", orderDirection: "desc", limit: 10) {
    items {
      id
      name
      symbol
      source
      lpFeeBps
      priceUsd
      marketCapUsd
      volume24hUsd
      xHandle
      agentStatus
      agent { status treasuryUsd lastActivityAt }
    }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
  {
    id: 'one-coin',
    title: 'One coin: locked fee slots and latest trades',
    about: 'Ids are lowercase hex. `feeSlots` mirrors the locker’s reward slots: on a `bootr` coin `launchInfo(token).rewards` on the RWAGMI locker, including RWAGMI’s own slot (`recipientKind: "protocol"`, the four Bootr slots sum to 9000); on a `clanker` coin `tokenRewards(token)` on the Clanker locker (the four slots sum to 10000, the burn slot’s recipient is `0x…dEaD`, and `protocolBps` is Clanker’s 20% charged on top of `lpFeeBps`); on a `clanker-v5` coin the fee slots of Clanker’s tax hook, the agent’s and the platform’s first, then the creator’s rows (`recipientKind: "creator"` for the first, `"recipient"` for the extra ones), scaled so that they, the burn and the holder dividends (`burnBps`, `dividendBps` on the coin) sum to 10000 less Clanker’s share in `protocolBps`. `clankerPool` is null on `bootr` coins.',
    query: `query Coin($id: String!) {
  token(id: $id) {
    name
    symbol
    source
    poolId
    lpFeeBps
    agentBps
    creatorBps
    burnBps
    platformBps
    protocolBps
    feeSlots { items { slot recipient recipientKind bps } }
    clankerPool { hook locker mevModule startingTick lpFeeBps }
    trades(orderBy: "blockNumber", orderDirection: "desc", limit: 5) {
      items { side valueUsd priceUsd trader timestamp txHash }
    }
  }
}`,
    variables: { id: '0x…coin address, lowercase' },
  },
  {
    id: 'milestones',
    title: 'A coin’s milestones and its agent’s recent activity',
    about: '`milestones` are written once each: `first_swap` (the first trade after the launch transaction), `holders` (the count reached: 25, 100, 500, 1000) and `volume24h` (rolling 24 h volume reached, in USD: 1000, 10000). The agent’s `read_coin` tool reads this shape.',
    query: `query CoinMilestones($id: String!) {
  token(id: $id) {
    name
    symbol
    launchedAt
    xHandle
    holders
    agent { status lastPostAt postsCount24h feesClaimedUsd }
    milestones(orderBy: "timestamp", orderDirection: "desc", limit: 8) {
      items { kind value timestamp txHash }
    }
  }
}`,
    variables: { id: '0x…coin address, lowercase' },
  },
  {
    id: 'platform',
    title: 'Platform totals and the last 7 days',
    about: '`platformStats` is a singleton with id `"global"`; `dailyStats` has one row per UTC day (`id` = `YYYY-MM-DD`).',
    query: `query Platform {
  platformStats(id: "global") {
    tokens
    agentsAwake
    volume24hUsd
    feesTotalUsd
    graduationThresholdUsd
    ethPriceUsd
    updatedAt
  }
  dailyStats(orderBy: "id", orderDirection: "desc", limit: 7) {
    items { id launches volumeUsd feesUsd feesAgentUsd feesCreatorUsd feesBurnUsd feesPlatformUsd }
  }
}`,
  },
  {
    id: 'fees-by-source',
    title: 'Fee totals per launch path',
    about: '`sourceStats` has one row per launch path (`id` = `bootr`, `clanker` or `clanker-v5`): coins, volume, the gross swap fees traders paid (`feesTotalUsd`), what accrued to each slot kind, and what was claimed. The REST helper `/platform/fees` returns the rows and their sum. `feesPlatformClaimedUsd` here counts claims booked under the platform kind; a wallet holding the platform slot and another one of a coin books its claims under the other, and only `/platform/fees` adds its platform share back.',
    query: `query FeesBySource {
  sourceStatss(orderBy: "id", orderDirection: "asc") {
    items {
      id
      tokens
      volumeTotalUsd
      feesTotalUsd
      feesAgentUsd
      feesCreatorUsd
      feesBurnUsd
      feesPlatformUsd
      feesClaimedUsd
      feesPlatformClaimedUsd
      updatedAt
    }
  }
}`,
  },
];
