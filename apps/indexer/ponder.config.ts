import { createConfig, factory } from 'ponder';
import { getAbiItem } from 'viem';

import { AgentGuardianAbi } from './abis/AgentGuardian';
import { BootrClankerLauncherAbi } from './abis/BootrClankerLauncher';
import { BootrLauncherAbi } from './abis/BootrLauncher';
import { BuybackBurnerAbi } from './abis/BuybackBurner';
import { B20TokenAbi } from './abis/B20Token';
import { ClankerFeeLockerAbi } from './abis/ClankerFeeLocker';
import { ClankerLpLockerFeeConversionAbi } from './abis/ClankerLpLockerFeeConversion';
import { PoolManagerAbi } from './abis/PoolManager';
import { ReputationRegistryAbi } from './abis/ReputationRegistry';
import { RwagmiHookV3Abi } from './abis/RwagmiHookV3';
import { RwagmiLauncherV3Abi } from './abis/RwagmiLauncherV3';
import { RwagmiLpLockerV3Abi } from './abis/RwagmiLpLockerV3';
import { indexerRpc } from './rpc-budget';
import { enabledSources, indexerEnv, snapshotBlockSources } from './src/lib/env';

/**
 * Single-chain config selected by CHAIN_ID (84532 Base Sepolia by default, 8453 Base).
 *
 * Coins come from two launch paths (docs/design/clanker-launch.md):
 *
 * - Bootr path: `BootrLauncher` launches through the RWAGMI v3 launcher (B20 tokens in Uniswap v4 pools, swap fee
 *   taken in WETH by the RWAGMI hook, reward ledger in the RWAGMI LP locker; docs/rwagmi-migration.md). Needs
 *   `BOOTR_LAUNCHERS` (or `BOOTR_LAUNCHER_ADDRESS`) and the RWAGMI v3 stack (Base mainnet only).
 * - Clanker path: `BootrClankerLauncher` launches through Clanker v4 (`BOOTR_CLANKER_LAUNCHERS=addr@block,...`,
 *   empty = off). The wrapper emits the same `AgentLaunched` plus `ClankerLaunched` (pool id, hook, locker, fee);
 *   rewards are collected by `ClankerLpLockerFeeConversion` (`ClaimedRewards`, per slot, after conversion) and
 *   paid out by `ClankerFeeLocker` (`ClaimTokens`). Both lockers are single public contracts: Ponder's log filter
 *   cannot take a dynamic token set, so the handlers drop events of coins that are not ours (as the Bootr path
 *   does for the RWAGMI hook / locker).
 *
 * When neither path is configured every launch-derived source is skipped with a warning and only the periodic
 * snapshot block handler runs (ETH/USD + platform rollups), so `ponder dev` still boots.
 *
 * RWAGMI is a public launcher: `B20LaunchCreatedV3` is filtered on `creator == BootrLauncher` (the launcher is the
 * RWAGMI caller), and the pool / fee / claim handlers drop everything that is not a Bootr pool or fee recipient.
 *
 * Several launcher deployments can be followed at once per path: the launcher sources and the coin factory take
 * the whole address lists, the RWAGMI filter accepts any Bootr launcher as `creator`, and every source starts at
 * the earliest deploy block of its path. Handlers read `event.log.address` for the emitting launcher. The address
 * lists are part of Ponder's build id, so adding a launcher means a new DATABASE_SCHEMA and a backfill (served
 * mostly from Ponder's RPC cache); see README "Adding a launcher".
 */
const env = indexerEnv();
const chain = env.chainName;
const startBlock = env.startBlock;
const rwagmiStartBlock = env.rwagmiStartBlock;
const clankerStartBlock = env.clankerStartBlock;
const anyStartBlock = env.anyStartBlock;

const launcherAddresses = env.launchers.map((l) => l.address);
const clankerLauncherAddresses = env.clankerLaunchers.map((l) => l.address);
const hasLauncher = launcherAddresses.length > 0;
const hasClankerLauncher = clankerLauncherAddresses.length > 0;
const enabled = enabledSources(env);

if (!hasLauncher && !hasClankerLauncher) {
  console.warn(
    '[indexer] no launcher configured (BOOTR_LAUNCHERS / BOOTR_LAUNCHER_ADDRESS / BOOTR_CLANKER_LAUNCHERS empty): skipping every launch-derived source (coins, burners, fees, swaps, reputation).',
  );
}
if (hasLauncher && !env.rwagmi) {
  console.warn(
    `[indexer] no RWAGMI v3 launch stack for chain ${env.chainId} (set RWAGMI_LAUNCHER_V3_ADDRESS, RWAGMI_HOOK_V3_ADDRESS, RWAGMI_LOCKER_V3_ADDRESS): skipping BootrLauncher and the Bootr path.`,
  );
}
if (hasClankerLauncher && !env.clanker) {
  console.warn(
    `[indexer] no Clanker v4 stack for chain ${env.chainId} (set CLANKER_FACTORY_ADDRESS, CLANKER_HOOK_ADDRESS, CLANKER_LOCKER_ADDRESS, CLANKER_FEE_LOCKER_ADDRESS): skipping BootrClankerLauncher and the Clanker path.`,
  );
}
if ((enabled.BootrLauncher || enabled.BootrClankerLauncher) && !env.guardian) {
  console.warn('[indexer] BOOTR_GUARDIAN_ADDRESS is empty: skipping AgentGuardian (activity, pause, dormancy).');
}
if (hasLauncher && startBlock === 'latest') {
  console.warn(
    '[indexer] BOOTR_START_BLOCK is empty: indexing from the latest block; earlier launches will be missing. Set it to the launcher deploy block.',
  );
}

const agentLaunched = getAbiItem({ abi: BootrLauncherAbi, name: 'AgentLaunched' });
const reputation = env.addresses.erc8004.reputationRegistry;
if ((enabled.BootrLauncher || enabled.BootrClankerLauncher) && !reputation) {
  console.warn(`[indexer] no ERC-8004 ReputationRegistry address for chain ${env.chainId}: skipping reputation.`);
}

// Placeholder used only to satisfy the static types of skipped sources; never sent to the RPC.
const ZERO = '0x0000000000000000000000000000000000000000' as const;
/** Every followed Bootr launcher (Ponder takes an address array per source and per factory). */
const launchers: readonly `0x${string}`[] = hasLauncher ? launcherAddresses : [ZERO];
/** Every followed Clanker launcher. */
const clankerLaunchers: readonly `0x${string}`[] = hasClankerLauncher ? clankerLauncherAddresses : [ZERO];
/** Every launcher of either path: they emit the same `AgentLaunched`, which announces the coins. */
const allLaunchers: readonly `0x${string}`[] = [
  ...(enabled.BootrLauncher ? launcherAddresses : []),
  ...(enabled.BootrClankerLauncher ? clankerLauncherAddresses : []),
];

/** Every source with its full type; the ones whose address is unknown are dropped below. */
const allContracts = {
  BootrLauncher: {
    abi: BootrLauncherAbi,
    chain,
    address: launchers,
    startBlock,
  },
  /** `AgentLaunched` (same ABI as BootrLauncher) and `ClankerLaunched` (pool id, hook, locker, MEV module, fee). */
  BootrClankerLauncher: {
    abi: BootrClankerLauncherAbi,
    chain,
    address: clankerLaunchers,
    startBlock: clankerStartBlock,
  },
  /** Coins of both paths (`Transfer` for balances / holders); B20 and Clanker tokens share the ERC-20 surface. */
  BootrToken: {
    abi: B20TokenAbi,
    chain,
    address: factory({ address: allLaunchers.length ? allLaunchers : [ZERO], event: agentLaunched, parameter: 'token' }),
    startBlock: anyStartBlock,
  },
  /** Bootr path only: the Clanker path's burn slot is the dead address, not a BuybackBurner clone. */
  BuybackBurner: {
    abi: BuybackBurnerAbi,
    chain,
    address: factory({ address: launchers, event: agentLaunched, parameter: 'burner' }),
    startBlock,
  },
  /** `B20LaunchCreatedV3` (Bootr launches only, see the filter) and `LaunchPoolCreatedV3` (pool id + key). */
  RwagmiLauncherV3: {
    abi: RwagmiLauncherV3Abi,
    chain,
    address: env.rwagmi?.launcher ?? ZERO,
    startBlock: rwagmiStartBlock,
    filter: { event: 'B20LaunchCreatedV3', args: { creator: launchers } },
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
  /** `ClaimedRewards`: a Clanker coin's collected LP fees per reward slot, after fee-preference conversion. */
  ClankerLpLocker: {
    abi: ClankerLpLockerFeeConversionAbi,
    chain,
    address: env.clanker?.locker ?? ZERO,
    startBlock: clankerStartBlock,
  },
  /** `ClaimTokens` / `ClaimTokensPermissioned`: a fee owner's stored balance of an asset is paid out. */
  ClankerFeeLocker: {
    abi: ClankerFeeLockerAbi,
    chain,
    address: env.clanker?.feeLocker ?? ZERO,
    startBlock: clankerStartBlock,
  },
  /** Every v4 swap; the handler keeps the pool ids of both paths' coins. */
  PoolManager: {
    abi: PoolManagerAbi,
    chain,
    address: env.addresses.uniswap.poolManager,
    startBlock: anyStartBlock,
  },
  AgentGuardian: {
    abi: AgentGuardianAbi,
    chain,
    address: env.guardian ?? ZERO,
    startBlock: anyStartBlock,
  },
  ReputationRegistry: {
    abi: ReputationRegistryAbi,
    chain,
    address: reputation ?? ZERO,
    startBlock: anyStartBlock,
  },
} as const;

const snapshots = snapshotBlockSources(env);

const contracts = Object.fromEntries(
  Object.entries(allContracts).filter(([name]) => enabled[name as keyof typeof enabled]),
) as unknown as typeof allContracts;

export default createConfig({
  database: env.databaseUrl
    ? { kind: 'postgres', connectionString: env.databaseUrl }
    : { kind: 'pglite', directory: '.ponder/pglite' },
  ordering: 'multichain',
  // Only the selected chain is configured at runtime; both names exist for the static types.
  // `chains` is not part of Ponder's build id (build/index.ts hashes `ordering`, `contracts`, `accounts` and `blocks`),
  // so changing the RPC settings needs no new schema (rpc-budget.ts).
  chains: { [chain]: { id: env.chainId, rpc: indexerRpc({ urls: env.rpcUrls, budget: process.env.INDEXER_RPC_BU_PER_SEC, fallbackUrl: process.env.BASE_RPC_FALLBACK_URL, blocksUrl: process.env.INDEXER_BLOCKS_RPC_URL }) } } as unknown as {
    base: { id: 8453; rpc: string };
    baseSepolia: { id: 84532; rpc: string };
  },
  contracts,
  // One snapshot per 60 s of chain time: 30 blocks before Denim, 300 after it (`snapshotSources`, src/lib/blocks.ts).
  blocks: {
    BootrSnapshot: { chain, ...snapshots.main },
    ...(snapshots.preDenim ? { BootrSnapshotPreDenim: { chain, ...snapshots.preDenim } } : {}),
  } as unknown as {
    BootrSnapshot: { chain: typeof chain; startBlock: number | 'latest'; interval: number };
    BootrSnapshotPreDenim: { chain: typeof chain; startBlock: number | 'latest'; endBlock: number; interval: number };
  },
});
