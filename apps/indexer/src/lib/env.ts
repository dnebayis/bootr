import { getAddresses, type ChainAddresses } from '@bootr/shared/addresses';
import { getAddress, isAddress, type Address } from 'viem';

import { DEFAULT_SNAPSHOT_INTERVAL, snapshotSources } from './blocks';
import { corsPolicy, type CorsPolicy } from './cors';
import type { LaunchSource } from './fees';

/**
 * Indexer environment, shared by ponder.config.ts, the indexing functions and the API.
 * Empty strings count as unset (values copied from .env.example).
 */
const str = (v: string | undefined) => (v ?? '').trim();

function optAddress(name: string, source: NodeJS.ProcessEnv = process.env): Address | null {
  const v = str(source[name]);
  if (!v) return null;
  if (!isAddress(v)) {
    console.warn(`[indexer] ${name}="${v}" is not a valid address; ignoring it`);
    return null;
  }
  return getAddress(v);
}

export const CHAINLINK_ETH_USD: Record<number, Address> = {
  8453: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  // Verified 2026-10-24 with `cast call ... description()` = "ETH / USD", 8 decimals.
  84532: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
};

/**
 * Fallbacks when no RPC is configured. sepolia.base.org prunes history below block 46.5M, which
 * breaks Ponder's finality binary search (it probes from block 0 on Base Sepolia's 200 ms blocks),
 * so the Sepolia fallback is an endpoint that still serves old headers.
 */
const PUBLIC_RPC: Record<number, string> = {
  8453: 'https://mainnet.base.org',
  84532: 'https://base-sepolia.gateway.tenderly.co',
};

/**
 * RWAGMI v3 launch stack per chain (docs/rwagmi-migration.md, @rwagmi/token-launcher-sdk 0.3.0). Base mainnet
 * only: there is no v3 deployment on Base Sepolia. `startBlock` is the launcher creation block (SDK
 * `DEFAULT_LAUNCHER_V3`); RWAGMI sources never start before it.
 */
export type RwagmiStack = { launcher: Address; hook: Address; locker: Address; startBlock: number };
export const RWAGMI_V3: Record<number, RwagmiStack | null> = {
  8453: {
    launcher: '0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20',
    hook: '0xB20B00367E37F826a0652c85a6DF375D784B20Ec',
    locker: '0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20',
    startBlock: 52_861_401,
  },
  84532: null,
};

/**
 * Clanker v4 stack per chain (docs/design/clanker-launch.md section 1, re-verified on Base mainnet 2026-11-04):
 * the factory, the static fee hook V2, the LP locker that converts and deposits rewards, and the fee locker that
 * pays them out. `startBlock` is the earliest block any Clanker source may start at (the factory's creation,
 * 2025-05); Clanker sources start at the Clanker launchers' deploy block, never before this. Base mainnet only.
 */
export type ClankerStack = { factory: Address; hook: Address; locker: Address; feeLocker: Address; startBlock: number };
export const CLANKER_V4: Record<number, ClankerStack | null> = {
  8453: {
    // Clanker v4.0.0 (Basescan "Clanker v4.0.0", Sourcify match): `deprecated() == false` on 2026-11-04.
    factory: '0xE85A59c628F7d27878ACeB4bf3b35733630083a9',
    // ClankerHookStaticFeeV2 (clanker docs, deployed contracts v4.1.0): `PROTOCOL_FEE_NUMERATOR() == 200000`.
    hook: '0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC',
    // ClankerLpLockerFeeConversion: `enabledLockers(locker, hook) == true` on the factory; the address the docs list
    // (0x63D2DfEA…) is not enabled. `feeLocker()` on it returns the fee locker below.
    locker: '0xffA37784D619F228D8B379d287a4D7282e500762',
    // ClankerFeeLocker: `allowedDepositors(locker) == true`.
    feeLocker: '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68',
    startBlock: 30_000_000,
  },
  84532: null,
};

/**
 * Clanker v5 stack per chain (docs/design/clanker-v5-migration.md section 1, verified sources on Sourcify and the live
 * factory read on 2026-11-10): the factory, the one shared `TaxLaunchHook` (every v5 pool's tax credits) and the
 * `FeeEscrow` (every v5 claim). `startBlock` is the factory's creation block (53331374, 2026-11-03); the v5 sources
 * start at the Clanker launchers' deploy block, never before this. Base mainnet only.
 */
export type ClankerV5Stack = { factory: Address; hook: Address; feeEscrow: Address; startBlock: number };
export const CLANKER_V5: Record<number, ClankerV5Stack | null> = {
  8453: {
    // TaxRWAERC20LaunchpadFactory (Sourcify exact match): `launchCreationEnabled() == true`, `hook() == hook` below.
    factory: '0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0',
    // TaxLaunchHook: `feeEscrow() == feeEscrow` below; emits CreatorTaxCredited / BurnTaxCredited per swap.
    hook: '0x5E320eA6278107968C119942E57d876c5F922AcC',
    // FeeEscrow: `hook() == hook`; `Claimed(recipient, currency, destination, amount)` on every payout.
    feeEscrow: '0x5dd237d1f716C65426CCd2FAe82B95109825FA61',
    startBlock: 53_331_374,
  },
  84532: null,
};

/** Deploy blocks of the Bootr launcher per chain (used when BOOTR_START_BLOCK is empty). */
const BOOTR_DEPLOY_BLOCK: Record<number, number | null> = { 8453: null, 84532: 49_367_726 };

/** One BootrLauncher deployment: checksummed address and the block it was created in. */
export type LauncherEntry = { address: Address; startBlock: number };

export type { LaunchSource };

/**
 * Parses `BOOTR_LAUNCHERS` (or `BOOTR_CLANKER_LAUNCHERS`, `name`): comma-separated `address@startBlock` entries,
 * e.g. `0xD3CE…B1F3@53219209,0xNEW…@53500000`. Every entry needs a valid address and a non-negative integer
 * block; a malformed entry throws (a silently dropped launcher would silently drop its coins). Duplicate addresses
 * are merged, keeping the lowest start block. Returns `[]` for an empty value.
 */
export function parseLaunchers(raw: string | undefined, name = 'BOOTR_LAUNCHERS'): LauncherEntry[] {
  const out: LauncherEntry[] = [];
  const entries = str(raw)
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [addr, block, ...rest] = entry.split('@').map((p) => p.trim());
    if (rest.length || !addr || block === undefined || !isAddress(addr) || !/^\d+$/.test(block)) {
      throw new Error(`[indexer] ${name} entry "${entry}" is not <address>@<startBlock>`);
    }
    const address = getAddress(addr);
    const startBlock = Number(block);
    if (!Number.isSafeInteger(startBlock)) throw new Error(`[indexer] ${name} entry "${entry}": block out of range`);
    const dup = out.find((l) => l.address === address);
    if (dup) dup.startBlock = Math.min(dup.startBlock, startBlock);
    else out.push({ address, startBlock });
  }
  return out;
}

/**
 * The launcher list for the chain: `BOOTR_LAUNCHERS` wins; otherwise the single-launcher variables
 * (`BOOTR_LAUNCHER_ADDRESS` or the address book, `BOOTR_START_BLOCK` / `LAUNCHER_START_BLOCK` or the recorded
 * deploy block). The start block of a single launcher is `'latest'` when nothing records it.
 */
export function resolveLaunchers(
  env: NodeJS.ProcessEnv,
  chainId: number,
  bookLauncher: Address | null,
): { launchers: LauncherEntry[]; startBlock: number | 'latest' } {
  const list = parseLaunchers(env.BOOTR_LAUNCHERS);
  if (list.length) {
    // The single variables stay set in production (the supervisor shares them); only warn when they disagree.
    const single = optAddress('BOOTR_LAUNCHER_ADDRESS', env);
    if (single && !list.some((l) => l.address === single)) {
      console.warn(`[indexer] BOOTR_LAUNCHERS is set and does not contain BOOTR_LAUNCHER_ADDRESS=${single}; the list wins`);
    }
    return { launchers: list, startBlock: Math.min(...list.map((l) => l.startBlock)) };
  }
  const launcher = optAddress('BOOTR_LAUNCHER_ADDRESS', env) ?? bookLauncher;
  const sb = str(env.BOOTR_START_BLOCK) || str(env.LAUNCHER_START_BLOCK);
  const startBlock = sb && /^\d+$/.test(sb) ? Number(sb) : (BOOTR_DEPLOY_BLOCK[chainId] ?? 'latest');
  if (!launcher) return { launchers: [], startBlock };
  // 'latest' cannot be stored per launcher; the entry gets 0 and the shared startBlock stays 'latest'.
  return { launchers: [{ address: launcher, startBlock: startBlock === 'latest' ? 0 : startBlock }], startBlock };
}

/**
 * The Clanker launcher list (`BOOTR_CLANKER_LAUNCHERS=address@startBlock,...`, every BootrClankerLauncher ever
 * used). Empty = the Clanker path is off. A launcher on the list cannot also be a Bootr launcher.
 */
export function resolveClankerLaunchers(
  env: NodeJS.ProcessEnv,
  bootr: readonly LauncherEntry[],
): { clankerLaunchers: LauncherEntry[]; clankerStartBlock: number | 'latest' } {
  const list = parseLaunchers(env.BOOTR_CLANKER_LAUNCHERS, 'BOOTR_CLANKER_LAUNCHERS');
  const both = list.find((c) => bootr.some((b) => b.address === c.address));
  if (both) throw new Error(`[indexer] ${both.address} is listed in both BOOTR_LAUNCHERS and BOOTR_CLANKER_LAUNCHERS`);
  if (!list.length) return { clankerLaunchers: [], clankerStartBlock: 'latest' };
  return { clankerLaunchers: list, clankerStartBlock: Math.min(...list.map((l) => l.startBlock)) };
}

/** True when `address` is one of the followed BootrLaunchers (case-insensitive). */
export function isLauncher(env: Pick<IndexerEnv, 'launchers'>, address: string): boolean {
  const a = address.toLowerCase();
  return env.launchers.some((l) => l.address.toLowerCase() === a);
}

/** True when `address` is one of the followed BootrClankerLaunchers (case-insensitive). */
export function isClankerLauncher(env: Pick<IndexerEnv, 'clankerLaunchers'>, address: string): boolean {
  const a = address.toLowerCase();
  return env.clankerLaunchers.some((l) => l.address.toLowerCase() === a);
}

/**
 * The launch path of the launcher that emitted an event, by its address. A Clanker launcher is `clanker` here
 * whichever Clanker version it launches through: the `AgentLaunched` handler tells v4 from v5 by the launch event
 * the receipt carries (`ClankerLaunched` or `ClankerV5Launched`).
 */
export function launchSourceOf(env: Pick<IndexerEnv, 'launchers' | 'clankerLaunchers'>, launcher: string): LaunchSource | null {
  if (isLauncher(env, launcher)) return 'bootr';
  if (isClankerLauncher(env, launcher)) return 'clanker';
  return null;
}

const minBlock = (a: number | 'latest', b: number | 'latest'): number | 'latest' => {
  if (a === 'latest') return b;
  if (b === 'latest') return a;
  return Math.min(a, b);
};

export type IndexerEnv = {
  chainId: 8453 | 84532;
  chainName: 'base' | 'baseSepolia';
  /** Every configured RPC url: the first is the primary, the second the fallback (`rpc-budget.ts`). */
  rpcUrls: string[];
  addresses: ChainAddresses;
  /**
   * Every BootrLauncher followed, each with its deploy block (`BOOTR_LAUNCHERS`, else the single
   * `BOOTR_LAUNCHER_ADDRESS` + `BOOTR_START_BLOCK`). Empty = no launcher on this chain. A launcher is never
   * removed from the list: its coins (and their swaps, fees, holders) stay indexed after it is paused.
   */
  launchers: LauncherEntry[];
  /**
   * Every BootrClankerLauncher followed (`BOOTR_CLANKER_LAUNCHERS`), the wrapper that launches through Clanker v4
   * (docs/design/clanker-launch.md). Empty = the Clanker path is off; like `launchers`, never shortened.
   */
  clankerLaunchers: LauncherEntry[];
  guardian: Address | null;
  /** RWAGMI v3 launcher / hook / locker (env overrides the per-chain defaults); null when the chain has none. */
  rwagmi: RwagmiStack | null;
  /** Clanker v4 factory / static hook / LP locker / fee locker (env overrides the defaults); null when none. */
  clanker: ClankerStack | null;
  /** Clanker v5 factory / hook / fee escrow (env overrides the defaults); null when the chain has none. */
  clankerV5: ClankerV5Stack | null;
  /** Start block of every Bootr source: the earliest launcher deploy block (`'latest'` when none is known). */
  startBlock: number | 'latest';
  /** Start block of the RWAGMI sources: the Bootr start block, never before the RWAGMI launcher's creation. */
  rwagmiStartBlock: number | 'latest';
  /** Start block of the Clanker v4 sources: the earliest Clanker launcher deploy block (`'latest'` = path off). */
  clankerStartBlock: number | 'latest';
  /** Start block of the Clanker v5 sources: the same, never before the v5 factory's creation. */
  clankerV5StartBlock: number | 'latest';
  /** Start block of the sources shared by both paths (coins, PoolManager, guardian, reputation, snapshot). */
  anyStartBlock: number | 'latest';
  ethUsdFeed: Address;
  /** Blocks between snapshots at today's block time, 300 = 60 s (`INDEXER_SNAPSHOT_INTERVAL`); `snapshotSources` covers the era before Denim. */
  snapshotInterval: number;
  bootToken: Address | null;
  adminConfigUrl: string;
  serviceKey: string;
  /** CORS for the public API: INDEXER_CORS_ORIGIN (default https://bootr.fun), see ./cors.ts. */
  cors: CorsPolicy;
  databaseUrl: string;
  fuelScanMaxRange: number;
};

/**
 * HMAC key for the indexer's own internal route and for signing the admin-config GET. Per-service keys:
 * INDEXER_SERVICE_KEY is the only supported key; SENDER_SERVICE_KEY is accepted temporarily with a warning.
 */
function indexerServiceKey(): string {
  const own = str(process.env.INDEXER_SERVICE_KEY);
  if (own) return own;
  const legacy = str(process.env.SENDER_SERVICE_KEY);
  if (legacy) console.warn('[indexer] INDEXER_SERVICE_KEY is unset; falling back to SENDER_SERVICE_KEY (deprecated, set a dedicated key)');
  return legacy;
}

let cached: IndexerEnv | undefined;

export function indexerEnv(): IndexerEnv {
  if (cached) return cached;
  const rawChain = Number(str(process.env.CHAIN_ID) || 84532);
  const chainId = rawChain === 8453 ? 8453 : 84532;
  if (rawChain !== chainId) console.warn(`[indexer] unsupported CHAIN_ID=${rawChain}; using 84532`);
  // BASE_(SEPOLIA_)RPC_URL may hold several urls separated by commas; Ponder round-robins across them.
  const configured = str(chainId === 8453 ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL)
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const rpcUrls = configured.length ? configured : [PUBLIC_RPC[chainId]!];

  if (!configured.length) {
    console.warn(`[indexer] no RPC url configured for chain ${chainId}; falling back to the public endpoint ${rpcUrls[0]}`);
  }
  const addresses = getAddresses(chainId);
  const rwagmi = rwagmiStack(chainId);
  // Env wins; otherwise the deployment recorded in @bootr/shared (null until deployed).
  const { launchers, startBlock } = resolveLaunchers(process.env, chainId, addresses.bootr.launcher);
  const { clankerLaunchers, clankerStartBlock } = resolveClankerLaunchers(process.env, launchers);
  const clanker = clankerStack(chainId);
  const clankerV5 = clankerV5Stack(chainId);
  const interval = Number(str(process.env.INDEXER_SNAPSHOT_INTERVAL) || DEFAULT_SNAPSHOT_INTERVAL);
  cached = {
    chainId,
    chainName: chainId === 8453 ? 'base' : 'baseSepolia',
    rpcUrls,
    addresses,
    launchers,
    clankerLaunchers,
    guardian: optAddress('BOOTR_GUARDIAN_ADDRESS') ?? addresses.bootr.guardian,
    rwagmi,
    clanker,
    clankerV5,
    startBlock,
    rwagmiStartBlock: typeof startBlock === 'number' && rwagmi ? Math.max(startBlock, rwagmi.startBlock) : startBlock,
    clankerStartBlock: typeof clankerStartBlock === 'number' && clanker ? Math.max(clankerStartBlock, clanker.startBlock) : clankerStartBlock,
    clankerV5StartBlock: typeof clankerStartBlock === 'number' && clankerV5 ? Math.max(clankerStartBlock, clankerV5.startBlock) : clankerStartBlock,
    anyStartBlock: minBlock(launchers.length && rwagmi ? startBlock : 'latest', clankerLaunchers.length && (clanker || clankerV5) ? clankerStartBlock : 'latest'),
    ethUsdFeed: optAddress('CHAINLINK_ETH_USD_FEED') ?? CHAINLINK_ETH_USD[chainId]!,
    snapshotInterval: Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : DEFAULT_SNAPSHOT_INTERVAL,
    bootToken: optAddress('BOOT_TOKEN_ADDRESS'),
    adminConfigUrl: str(process.env.ADMIN_CONFIG_URL),
    serviceKey: indexerServiceKey(),
    cors: corsPolicy(process.env),
    databaseUrl: str(process.env.INDEXER_DATABASE_URL),
    fuelScanMaxRange: Number(str(process.env.FUEL_SCAN_MAX_RANGE) || 5000) || 5000,
  };
  return cached;
}

/** RWAGMI_{LAUNCHER,HOOK,LOCKER}_V3_ADDRESS override the chain defaults; all three are needed. */
function rwagmiStack(chainId: number): RwagmiStack | null {
  const d = RWAGMI_V3[chainId] ?? null;
  const launcher = optAddress('RWAGMI_LAUNCHER_V3_ADDRESS') ?? d?.launcher ?? null;
  const hook = optAddress('RWAGMI_HOOK_V3_ADDRESS') ?? d?.hook ?? null;
  const locker = optAddress('RWAGMI_LOCKER_V3_ADDRESS') ?? d?.locker ?? null;
  if (!launcher || !hook || !locker) return null;
  return { launcher, hook, locker, startBlock: d?.startBlock ?? 0 };
}

/** CLANKER_V5_{FACTORY,HOOK,FEE_ESCROW}_ADDRESS override the chain defaults; all three are needed. */
function clankerV5Stack(chainId: number): ClankerV5Stack | null {
  const d = CLANKER_V5[chainId] ?? null;
  const factory = optAddress('CLANKER_V5_FACTORY_ADDRESS') ?? d?.factory ?? null;
  const hook = optAddress('CLANKER_V5_HOOK_ADDRESS') ?? d?.hook ?? null;
  const feeEscrow = optAddress('CLANKER_V5_FEE_ESCROW_ADDRESS') ?? d?.feeEscrow ?? null;
  if (!factory || !hook || !feeEscrow) return null;
  return { factory, hook, feeEscrow, startBlock: d?.startBlock ?? 0 };
}

/** CLANKER_{FACTORY,HOOK,LOCKER,FEE_LOCKER}_ADDRESS override the chain defaults; all four are needed. */
function clankerStack(chainId: number): ClankerStack | null {
  const d = CLANKER_V4[chainId] ?? null;
  const factory = optAddress('CLANKER_FACTORY_ADDRESS') ?? d?.factory ?? null;
  const hook = optAddress('CLANKER_HOOK_ADDRESS') ?? d?.hook ?? null;
  const locker = optAddress('CLANKER_LOCKER_ADDRESS') ?? d?.locker ?? null;
  const feeLocker = optAddress('CLANKER_FEE_LOCKER_ADDRESS') ?? d?.feeLocker ?? null;
  if (!factory || !hook || !locker || !feeLocker) return null;
  return { factory, hook, locker, feeLocker, startBlock: d?.startBlock ?? 0 };
}

/**
 * The snapshot handler's block sources: from the earliest known launcher block of either path (a known Bootr block even
 * when its path is off), one source per block-time era (`snapshotSources`).
 */
export function snapshotBlockSources(env: IndexerEnv = indexerEnv()) {
  const start = minBlock(env.startBlock, env.clankerStartBlock);
  return snapshotSources(env.chainId, start, env.snapshotInterval);
}

/**
 * Which Ponder sources are registered (handlers check the same flags). The Bootr path needs a Bootr launcher and
 * the RWAGMI v3 stack it launches through; the Clanker path a Clanker launcher and the Clanker v4 stack (the v5
 * hook and escrow sources join it when the chain has the v5 stack: one launcher list serves both versions). The
 * sources both paths share (coins, PoolManager, guardian, reputation) run when either path is on.
 */
export function enabledSources(env: IndexerEnv = indexerEnv()) {
  const launcher = env.launchers.length > 0 && !!env.rwagmi;
  const clanker = env.clankerLaunchers.length > 0 && !!env.clanker;
  const clankerV5 = env.clankerLaunchers.length > 0 && !!env.clankerV5;
  const any = launcher || clanker || clankerV5;
  return {
    BootrLauncher: launcher,
    BuybackBurner: launcher,
    RwagmiLauncherV3: launcher,
    RwagmiLpLockerV3: launcher,
    RwagmiHookV3: launcher,
    BootrClankerLauncher: clanker || clankerV5,
    ClankerLpLocker: clanker,
    ClankerFeeLocker: clanker,
    ClankerV5Hook: clankerV5,
    ClankerV5FeeEscrow: clankerV5,
    BootrToken: any,
    PoolManager: any,
    AgentGuardian: any && !!env.guardian,
    ReputationRegistry: any && !!env.addresses.erc8004.reputationRegistry,
  };
}
