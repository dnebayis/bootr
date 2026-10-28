/**
 * Example indexer queries shown on /docs/api and in /llms-full.txt. Every field exists in
 * `apps/indexer/ponder.schema.ts` (checked by `lib/docs/graphql-examples.test.ts`); they were also validated
 * against the live schema at https://indexer.bootr.fun/graphql when written.
 */
export const GRAPHQL_EXAMPLES: { id: string; title: string; about: string; query: string; variables?: Record<string, unknown> }[] = [
  {
    id: 'newest-coins',
    title: 'Newest coins with their agent',
    about: 'Lists are paged: pass `pageInfo.endCursor` back as `after` for the next page. `limit` is at most 1000.',
    query: `query NewestCoins {
  tokens(orderBy: "launchedAt", orderDirection: "desc", limit: 10) {
    items {
      id
      name
      symbol
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
    about: 'Ids are lowercase hex. `feeSlots` mirrors `launchInfo(token).rewards` on the RWAGMI locker, including RWAGMI’s own slot (`recipientKind: "protocol"`).',
    query: `query Coin($id: String!) {
  token(id: $id) {
    name
    symbol
    poolId
    lpFeeBps
    agentBps
    creatorBps
    burnBps
    platformBps
    protocolBps
    feeSlots { items { slot recipient recipientKind bps } }
    trades(orderBy: "timestamp", orderDirection: "desc", limit: 5) {
      items { side valueUsd priceUsd trader timestamp txHash }
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
];
