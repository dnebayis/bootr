import { createConfig, factory } from 'ponder';
import { getAbiItem } from 'viem';

import { AgentGuardianAbi } from './abis/AgentGuardian';
import { BootrLauncherAbi } from './abis/BootrLauncher';
import { BuybackBurnerAbi } from './abis/BuybackBurner';
import { ClankerFeeLockerAbi } from './abis/ClankerFeeLocker';
import { ClankerLpLockerFeeConversionAbi } from './abis/ClankerLpLockerFeeConversion';
import { ClankerTokenAbi } from './abis/ClankerToken';
import { PoolManagerAbi } from './abis/PoolManager';
import { ReputationRegistryAbi } from './abis/ReputationRegistry';
import { enabledSources, indexerEnv } from './src/lib/env';

/**
 * Single-chain config selected by CHAIN_ID (84532 Base Sepolia by default, 8453 Base).
 *
 * Bootr contracts are not deployed yet: when BOOTR_LAUNCHER_ADDRESS is empty every
 * launcher-dependent source (launcher, coins, burners, Clanker locker / FeeLocker, PoolManager,
 * reputation) is skipped with a warning, and only the periodic snapshot block handler runs
 * (ETH/USD + platform rollups), so `ponder dev` still boots.
 */
const env = indexerEnv();
const chain = env.chainName;
const startBlock = env.startBlock;

if (!env.launcher) {
  console.warn(
    '[indexer] BOOTR_LAUNCHER_ADDRESS is empty: skipping BootrLauncher and every launch-derived source (coins, burners, fees, swaps, reputation).',
  );
}
if (env.launcher && !env.guardian) {
  console.warn('[indexer] BOOTR_GUARDIAN_ADDRESS is empty: skipping AgentGuardian (activity, pause, dormancy).');
}
if (env.launcher && startBlock === 'latest') {
  console.warn(
    '[indexer] BOOTR_START_BLOCK is empty: indexing from the latest block; earlier launches will be missing. Set it to the launcher deploy block.',
  );
}

const agentLaunched = getAbiItem({ abi: BootrLauncherAbi, name: 'AgentLaunched' });
const reputation = env.addresses.erc8004.reputationRegistry;
if (env.launcher && !reputation) {
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
    abi: ClankerTokenAbi,
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
  ClankerLpLocker: {
    abi: ClankerLpLockerFeeConversionAbi,
    chain,
    address: env.addresses.clankerLpLockerFeeConversion,
    startBlock,
  },
  ClankerFeeLocker: {
    abi: ClankerFeeLockerAbi,
    chain,
    address: env.addresses.clankerFeeLocker,
    startBlock,
  },
  PoolManager: {
    abi: PoolManagerAbi,
    chain,
    address: env.addresses.uniswap.poolManager,
    startBlock,
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
