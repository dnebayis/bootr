/**
 * Ponder executes every file under src/ (except src/api and *.test.ts) as an indexing file:
 *   launcher.ts    Bootr path: RwagmiLauncherV3.B20LaunchCreatedV3 / LaunchPoolCreatedV3 (staged),
 *                  BootrLauncher.AgentLaunched (+ launchInfo slots, launch-tx replay: LiquidityPlacedV3, dev-buy
 *                  fee + swap, transfers, fuel). Clanker path: BootrClankerLauncher.ClankerLaunched (staged),
 *                  BootrClankerLauncher.AgentLaunched (+ TokenCreated / TokenRewardAdded from the receipt or
 *                  tokenRewards(token), launch-tx replay: dev-buy swap, transfers, fuel)
 *   market.ts      PoolManager.Swap (pools of both paths), coin ERC-20 Transfer (balances / holders)
 *   fees.ts        Bootr: RwagmiHookV3.PoolFeeTakenV3, RwagmiLpLockerV3.PoolFeesSettledV3 / QuoteRewardsClaimedV3,
 *                  BuybackBurner. Clanker: ClankerLpLockerFeeConversion.ClaimedRewards, ClankerFeeLocker.ClaimTokens
 *   guardian.ts    AgentGuardian activity / pause / dormancy / session keys
 *   reputation.ts  ERC-8004 ReputationRegistry feedback
 *   snapshot.ts    periodic block handler (prices, balances, rolling windows, status, rollups)
 */
export {};
