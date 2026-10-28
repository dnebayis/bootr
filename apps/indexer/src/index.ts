/**
 * Ponder executes every file under src/ (except src/api and *.test.ts) as an indexing file:
 *   launcher.ts    RwagmiLauncherV3.B20LaunchCreatedV3 / LaunchPoolCreatedV3 (staged), BootrLauncher.AgentLaunched
 *                  (+ launchInfo slots, launch-tx replay: LiquidityPlacedV3, dev-buy fee + swap, transfers, fuel)
 *   market.ts      PoolManager.Swap (Bootr pools only), coin ERC-20 Transfer (balances / holders)
 *   fees.ts        RwagmiHookV3.PoolFeeTakenV3, RwagmiLpLockerV3.PoolFeesSettledV3 / QuoteRewardsClaimedV3, BuybackBurner
 *   guardian.ts    AgentGuardian activity / pause / dormancy / session keys
 *   reputation.ts  ERC-8004 ReputationRegistry feedback
 *   snapshot.ts    periodic block handler (prices, balances, rolling windows, status, rollups)
 */
export {};
