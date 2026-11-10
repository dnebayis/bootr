import { getAddresses, type ChainAddresses } from '@bootr/shared/addresses';
import { createPublicClient, http, isAddressEqual, type Address, type Chain, type PublicClient, type Transport } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { Config } from './config.js';
import { createRpcCounter, withRateLimitRetry, type RpcCounter } from './rpc-retry.js';

export const CHAINLINK_ETH_USD: Record<number, Address> = {
  8453: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  84532: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
};

/**
 * Where a coin was launched (docs/design/clanker-launch.md): `bootr` = `BootrLauncher` on RWAGMI v3 (fees in
 * `RwagmiLpLockerV3`, claimed with `settleAndClaim`), `clanker` = `BootrClankerLauncher` on Clanker v4 (fees in
 * `ClankerLpLockerFeeConversion` → `ClankerFeeLocker`, claimed with `collectRewards` + `claim`), `clanker-v5` =
 * `BootrClankerLauncherV5` on Clanker v5 (docs/design/clanker-v5-migration.md: a buy and sell tax whose slots are
 * paid in native ETH into `FeeEscrow`, claimed with one `claimFor(kernel, 0x0)`).
 */
export const launchSources = ['bootr', 'clanker', 'clanker-v5'] as const;
export type LaunchSource = (typeof launchSources)[number];

/** One launcher the poller follows and the source its `AgentLaunched` events register agents under. */
export interface LauncherEntry {
  address: Address;
  source: LaunchSource;
}

export interface ChainContext {
  chain: Chain;
  chainId: 8453 | 84532;
  publicClient: PublicClient<Transport, Chain>;
  /** What `publicClient` sent since the last drain (rpc-retry.ts); the tick and notifier lines log it. Absent on a mocked chain. */
  rpc?: RpcCounter;
  addresses: ChainAddresses;
  /** `BootrLauncher` (`BOOTR_LAUNCHER_ADDRESS`): the Bootr-source launcher. */
  launcher: Address;
  /** `BootrClankerLauncher` (`BOOTR_CLANKER_LAUNCHER_ADDRESS`), null when not configured. */
  clankerLauncher: Address | null;
  /** `BootrClankerLauncherV5` (`BOOTR_CLANKER_V5_LAUNCHER_ADDRESS`), null when not configured (v5 off). */
  clankerV5Launcher: Address | null;
  /** Every launcher the poller follows, with its source (the same `AgentLaunched` ABI on all of them). */
  launchers: LauncherEntry[];
  guardian: Address;
  ethUsdFeed: Address;
  /** RWAGMI v3 launcher and LP locker (`RWAGMI_LAUNCHER_V3_ADDRESS`, `RWAGMI_LOCKER_V3_ADDRESS`). */
  rwagmi: { launcher: Address; lpLocker: Address };
  /** Clanker v4 lockers (`CLANKER_LOCKER_ADDRESS` = `ClankerLpLockerFeeConversion`, `CLANKER_FEE_LOCKER_ADDRESS` = `ClankerFeeLocker`). */
  clanker: { lpLocker: Address; feeLocker: Address };
  /**
   * Clanker v5 `FeeEscrow` from the address book (`addresses.clankerV5.feeEscrow`): every v5 slot's balance
   * (`owed(recipient, currency)`) and the `claimFor(recipient, currency)` target. Null on a chain without v5.
   */
  clankerV5: { feeEscrow: Address | null };
}

export function chainFor(chainId: number): Chain {
  return chainId === 8453 ? base : baseSepolia;
}

/** The launcher list from the single-address variables (Bootr first; Clanker v4 and v5 only when configured). */
export function launcherEntries(config: Pick<Config, 'BOOTR_LAUNCHER_ADDRESS' | 'BOOTR_CLANKER_LAUNCHER_ADDRESS'> & Partial<Pick<Config, 'BOOTR_CLANKER_V5_LAUNCHER_ADDRESS'>>): LauncherEntry[] {
  const entries: LauncherEntry[] = [{ address: config.BOOTR_LAUNCHER_ADDRESS as Address, source: 'bootr' }];
  if (config.BOOTR_CLANKER_LAUNCHER_ADDRESS) entries.push({ address: config.BOOTR_CLANKER_LAUNCHER_ADDRESS as Address, source: 'clanker' });
  if (config.BOOTR_CLANKER_V5_LAUNCHER_ADDRESS) entries.push({ address: config.BOOTR_CLANKER_V5_LAUNCHER_ADDRESS as Address, source: 'clanker-v5' });
  return entries;
}

/** The source of a launcher address among the followed ones; null for any other address. */
export function launchSourceOf(launchers: readonly LauncherEntry[], address: Address): LaunchSource | null {
  return launchers.find((l) => isAddressEqual(l.address, address))?.source ?? null;
}

export function createChainContext(
  config: Pick<Config, 'CHAIN_ID' | 'RPC_URL' | 'BOOTR_LAUNCHER_ADDRESS' | 'BOOTR_CLANKER_LAUNCHER_ADDRESS' | 'BOOTR_CLANKER_V5_LAUNCHER_ADDRESS' | 'BOOTR_GUARDIAN_ADDRESS' | 'RWAGMI_LAUNCHER_V3_ADDRESS' | 'RWAGMI_LOCKER_V3_ADDRESS' | 'CLANKER_LOCKER_ADDRESS' | 'CLANKER_FEE_LOCKER_ADDRESS'>,
): ChainContext {
  const chain = chainFor(config.CHAIN_ID);
  // No CCIP-Read (ERC-3668): a contract that reverts with OffchainLookup would otherwise make this process fetch the
  // URLs the contract names, and a hostile one can point them anywhere or loop. Every read here is of a contract an
  // agent or a creator chose, so the lookup is refused and the read fails at once.
  const rpc = createRpcCounter();
  const publicClient = createPublicClient({ chain, transport: withRateLimitRetry(http(config.RPC_URL), { counter: rpc }), ccipRead: false });
  const addresses = getAddresses(config.CHAIN_ID);
  return {
    chain,
    chainId: config.CHAIN_ID as 8453 | 84532,
    publicClient,
    rpc,
    addresses,
    launcher: config.BOOTR_LAUNCHER_ADDRESS as Address,
    clankerLauncher: (config.BOOTR_CLANKER_LAUNCHER_ADDRESS as Address | undefined) ?? null,
    clankerV5Launcher: (config.BOOTR_CLANKER_V5_LAUNCHER_ADDRESS as Address | undefined) ?? null,
    launchers: launcherEntries(config),
    guardian: config.BOOTR_GUARDIAN_ADDRESS as Address,
    ethUsdFeed: CHAINLINK_ETH_USD[config.CHAIN_ID] as Address,
    rwagmi: { launcher: config.RWAGMI_LAUNCHER_V3_ADDRESS as Address, lpLocker: config.RWAGMI_LOCKER_V3_ADDRESS as Address },
    clanker: { lpLocker: config.CLANKER_LOCKER_ADDRESS as Address, feeLocker: config.CLANKER_FEE_LOCKER_ADDRESS as Address },
    clankerV5: { feeEscrow: addresses.clankerV5?.feeEscrow ?? null },
  };
}
