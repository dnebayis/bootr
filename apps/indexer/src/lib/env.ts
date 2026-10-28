import { getAddresses, type ChainAddresses } from '@bootr/shared/addresses';
import { getAddress, isAddress, type Address } from 'viem';

import { corsPolicy, type CorsPolicy } from './cors';

/**
 * Indexer environment, shared by ponder.config.ts, the indexing functions and the API.
 * Empty strings count as unset (values copied from .env.example).
 */
const str = (v: string | undefined) => (v ?? '').trim();

function optAddress(name: string): Address | null {
  const v = str(process.env[name]);
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

/** Deploy blocks of the Bootr launcher per chain (used when BOOTR_START_BLOCK is empty). */
const BOOTR_DEPLOY_BLOCK: Record<number, number | null> = { 8453: null, 84532: 49_367_726 };

/** Seconds per block: Base mainnet 2 s, Base Sepolia 200 ms (measured 2026-10-24). */
export const BLOCK_TIME_SEC: Record<number, number> = { 8453: 2, 84532: 0.2 };

export type IndexerEnv = {
  chainId: 8453 | 84532;
  chainName: 'base' | 'baseSepolia';
  /** First RPC url (used for ad-hoc viem reads). */
  rpcUrl: string;
  /** Every configured RPC url; Ponder load-balances across them when there is more than one. */
  rpcUrls: string[];
  /** Ponder `maxRequestsPerSecond` for the chain (all rpc urls together). Keeps a shared CDP key under its quota. */
  maxRps: number;
  addresses: ChainAddresses;
  launcher: Address | null;
  guardian: Address | null;
  /** RWAGMI v3 launcher / hook / locker (env overrides the per-chain defaults); null when the chain has none. */
  rwagmi: RwagmiStack | null;
  /** BootrLauncher (and every Bootr source) start block: BOOTR_START_BLOCK, else the recorded deploy block. */
  startBlock: number | 'latest';
  /** Start block of the RWAGMI sources: the Bootr start block, never before the RWAGMI launcher's creation. */
  rwagmiStartBlock: number | 'latest';
  ethUsdFeed: Address;
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
  const rpcUrl = rpcUrls[0]!;
  const maxRps = Number(str(process.env.INDEXER_MAX_RPS) || 50);
  if (!configured.length) {
    console.warn(`[indexer] no RPC url configured for chain ${chainId}; falling back to the public endpoint ${rpcUrl}`);
  }
  const sb = str(process.env.BOOTR_START_BLOCK);
  const startBlock = sb && /^\d+$/.test(sb) ? Number(sb) : (BOOTR_DEPLOY_BLOCK[chainId] ?? 'latest');
  // Default: one snapshot per ~60 s of chain time.
  const defaultInterval = Math.round(60 / BLOCK_TIME_SEC[chainId]!);
  const addresses = getAddresses(chainId);
  const rwagmi = rwagmiStack(chainId);
  const interval = Number(str(process.env.INDEXER_SNAPSHOT_INTERVAL) || defaultInterval);
  cached = {
    chainId,
    chainName: chainId === 8453 ? 'base' : 'baseSepolia',
    rpcUrl,
    rpcUrls,
    maxRps,
    addresses,
    // Env wins; otherwise the deployment recorded in @bootr/shared (null until deployed).
    launcher: optAddress('BOOTR_LAUNCHER_ADDRESS') ?? addresses.bootr.launcher,
    guardian: optAddress('BOOTR_GUARDIAN_ADDRESS') ?? addresses.bootr.guardian,
    rwagmi,
    startBlock,
    rwagmiStartBlock: typeof startBlock === 'number' && rwagmi ? Math.max(startBlock, rwagmi.startBlock) : startBlock,
    ethUsdFeed: optAddress('CHAINLINK_ETH_USD_FEED') ?? CHAINLINK_ETH_USD[chainId]!,
    snapshotInterval: Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : defaultInterval,
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

/**
 * Which Ponder sources are registered (handlers check the same flags). Every launch-derived source needs both
 * the Bootr launcher and the RWAGMI v3 stack it launches through.
 */
export function enabledSources(env: IndexerEnv = indexerEnv()) {
  const launcher = !!env.launcher && !!env.rwagmi;
  return {
    BootrLauncher: launcher,
    BootrToken: launcher,
    BuybackBurner: launcher,
    RwagmiLauncherV3: launcher,
    RwagmiLpLockerV3: launcher,
    RwagmiHookV3: launcher,
    PoolManager: launcher,
    AgentGuardian: launcher && !!env.guardian,
    ReputationRegistry: launcher && !!env.addresses.erc8004.reputationRegistry,
  };
}
