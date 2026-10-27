/**
 * Ponder executes every file under src/ (except src/api and *.test.ts) as an indexing file:
 *   launcher.ts    BootrLauncher.AgentLaunched (+ launch-tx replay: TokenCreated, dev buy, transfers, fuel)
 *   market.ts      PoolManager.Swap (Bootr pools only), coin ERC-20 Transfer (balances / holders)
 *   fees.ts        ClankerLpLockerFeeConversion.ClaimedRewards, ClankerFeeLocker claims, BuybackBurner
 *   guardian.ts    AgentGuardian activity / pause / dormancy / session keys
 *   reputation.ts  ERC-8004 ReputationRegistry feedback
 *   snapshot.ts    periodic block handler (prices, balances, rolling windows, status, rollups)
 */
export {};
