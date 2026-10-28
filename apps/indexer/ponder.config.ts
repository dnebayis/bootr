import { createConfig, factory } from 'ponder';
import { getAbiItem } from 'viem';

import { AgentGuardianAbi } from './abis/AgentGuardian';
import { BootrLauncherAbi } from './abis/BootrLauncher';
import { BuybackBurnerAbi } from './abis/BuybackBurner';
import { B20TokenAbi } from './abis/B20Token';
import { PoolManagerAbi } from './abis/PoolManager';
import { ReputationRegistryAbi } from './abis/ReputationRegistry';
import { RwagmiHookV3Abi } from './abis/RwagmiHookV3';
import { RwagmiLauncherV3Abi } from './abis/RwagmiLauncherV3';
import { RwagmiLpLockerV3Abi } from './abis/RwagmiLpLockerV3';
import { enabledSources, indexerEnv } from './src/lib/env';

/**
 * Single-chain config selected by CHAIN_ID (84532 Base Sepolia by default, 8453 Base).
 *
 * Coins launch through the RWAGMI v3 launcher (B20 tokens in Uniswap v4 pools, swap fee taken in WETH by the
 * RWAGMI hook, reward ledger in the RWAGMI LP locker; docs/rwagmi-migration.md). When BOOTR_LAUNCHER_ADDRESS is
 * empty, or the chain has no RWAGMI v3 stack (Base Sepolia), every launcher-dependent source (launcher, coins,
 * burners, RWAGMI launcher / locker / hook, PoolManager, guardian, reputation) is skipped with a warning, and only
 * the periodic snapshot block handler runs (ETH/USD + platform rollups), so `ponder dev` still boots.
 *
 * RWAGMI is a public launcher: `B20LaunchCreatedV3` is filtered on `creator == BootrLauncher` (the launcher is the
 * RWAGMI caller), and the pool / fee / claim handlers drop everything that is not a Bootr pool or fee recipient.
 */
const env = indexerEnv();
const chain = env.chainName;
const startBlock = env.startBlock;
const rwagmiStartBlock = env.rwagmiStartBlock;

if (!env.launcher) {
  console.warn(
    '[indexer] BOOTR_LAUNCHER_ADDRESS is empty: skipping BootrLauncher and every launch-derived source (coins, burners, fees, swaps, reputation).',
  );
} else if (!env.rwagmi) {
  console.warn(
    `[indexer] no RWAGMI v3 launch stack for chain ${env.chainId} (set RWAGMI_LAUNCHER_V3_ADDRESS, RWAGMI_HOOK_V3_ADDRESS, RWAGMI_LOCKER_V3_ADDRESS): skipping BootrLauncher and every launch-derived source.`,
  );
}
if (env.launcher && env.rwagmi && !env.guardian) {
  console.warn('[indexer] BOOTR_GUARDIAN_ADDRESS is empty: skipping AgentGuardian (activity, pause, dormancy).');
}
if (env.launcher && startBlock === 'latest') {
  console.warn(
    '[indexer] BOOTR_START_BLOCK is empty: indexing from the latest block; earlier launches will be missing. Set it to the launcher deploy block.',
  );
}

const agentLaunched = getAbiItem({ abi: BootrLauncherAbi, name: 'AgentLaunched' });
const reputation = env.addresses.erc8004.reputationRegistry;
if (env.launcher && env.rwagmi && !reputation) {
  console.warn(`[indexer] no ERC-8004 ReputationRegistry address for chain ${env.chainId}: skipping reputation.`);
}

// Placeholder used only to satisfy the static types of skipped sources; never sent to the RPC.
const ZERO = '0x0000000000000000000000000000000000000000' as const;

/** Every source with its full type; the ones whose address is unknown are dropped below. */
const allContracts = {
  BootrLauncher: {
    abi: BootrLauncherAbi,
    chain,
    address: env.launcher ?? ZERO,
    startBlock,
  },
  BootrToken: {
    abi: B20TokenAbi,
    chain,
    address: factory({ address: env.launcher ?? ZERO, event: agentLaunched, parameter: 'token' }),
    startBlock,
  },
  BuybackBurner: {
    abi: BuybackBurnerAbi,
    chain,
    address: factory({ address: env.launcher ?? ZERO, event: agentLaunched, parameter: 'burner' }),
    startBlock,
  },
  /** `B20LaunchCreatedV3` (Bootr launches only, see the filter) and `LaunchPoolCreatedV3` (pool id + key). */
  RwagmiLauncherV3: {
    abi: RwagmiLauncherV3Abi,
    chain,
    address: env.rwagmi?.launcher ?? ZERO,
    startBlock: rwagmiStartBlock,
    filter: { event: 'B20LaunchCreatedV3', args: { creator: env.launcher ?? ZERO } },
  },
  /** `PoolFeesSettledV3` (credit per reward slot) and `QuoteRewardsClaimedV3` (claims). */
  RwagmiLpLockerV3: {
    abi: RwagmiLpLockerV3Abi,
    chain,
    address: env.rwagmi?.locker ?? ZERO,
    startBlock: rwagmiStartBlock,
  },
  /** `PoolFeeTakenV3`: the gross swap fee, in WETH. */
  RwagmiHookV3: {
    abi: RwagmiHookV3Abi,
    chain,
    address: env.rwagmi?.hook ?? ZERO,
    startBlock: rwagmiStartBlock,
  },
  PoolManager: {
    abi: PoolManagerAbi,
    chain,
    address: env.addresses.uniswap.poolManager,
    startBlock: rwagmiStartBlock,
  },
  AgentGuardian: {
    abi: AgentGuardianAbi,
    chain,
    address: env.guardian ?? ZERO,
    startBlock,
  },
  ReputationRegistry: {
    abi: ReputationRegistryAbi,
    chain,
    address: reputation ?? ZERO,
    startBlock,
  },
} as const;

const enabled = enabledSources(env);
const contracts = Object.fromEntries(
  Object.entries(allContracts).filter(([name]) => enabled[name as keyof typeof enabled]),
) as unknown as typeof allContracts;

export default createConfig({
  database: env.databaseUrl
    ? { kind: 'postgres', connectionString: env.databaseUrl }
    : { kind: 'pglite', directory: '.ponder/pglite' },
  ordering: 'multichain',
  // Only the selected chain is configured at runtime; both names exist for the static types.
  chains: { [chain]: { id: env.chainId, rpc: env.rpcUrls.length > 1 ? env.rpcUrls : env.rpcUrl, maxRequestsPerSecond: env.maxRps } } as unknown as {
    base: { id: 8453; rpc: string };
    baseSepolia: { id: 84532; rpc: string };
  },
  contracts,
  blocks: {
    BootrSnapshot: {
      chain,
      startBlock,
      interval: env.snapshotInterval,
    },
  },
});
