import type { Address } from 'viem';

import { clankerLauncherV5Abi } from './clankerLauncherV5.abi';
import { launcherAbi } from './launcher.abi';

export { clankerLauncherV5Abi, launcherAbi };

/**
 * BootrClankerLauncher: the same `launch(LaunchParams)`, defaults, fee and `predictKernel` as BootrLauncher (one ABI
 * for both paths), plus `ClankerLaunched`. `predictToken` is not available on this path: the token address comes
 * from the receipt's `AgentLaunched` log.
 */
export const clankerLauncherAbi = [
  ...launcherAbi,
  {
    type: 'event',
    name: 'ClankerLaunched',
    inputs: [
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'poolId', type: 'bytes32', indexed: false, internalType: 'bytes32' },
      { name: 'hook', type: 'address', indexed: false, internalType: 'address' },
      { name: 'locker', type: 'address', indexed: false, internalType: 'address' },
      { name: 'mevModule', type: 'address', indexed: false, internalType: 'address' },
      { name: 'startingTick', type: 'int24', indexed: false, internalType: 'int24' },
      { name: 'lpFeeBps', type: 'uint24', indexed: false, internalType: 'uint24' },
    ],
    anonymous: false,
  },
] as const;

/**
 * BootrLauncher.LaunchDefaults (packages/contracts/src/BootrLauncher.sol).
 * Bps fields are out of 10_000; the launcher scales them to RWAGMI reward slots that total 9000 bps of the 1% swap
 * fee (RWAGMI takes the other 10%): agent 500 -> slot 450 -> 0.045% of volume. `lpFeeBps` is not used by the RWAGMI
 * hook, whose swap fee is a static 1%.
 * The launcher keeps two copies: `standardDefaults()` and `buybackDefaults()`.
 */
export type LaunchDefaults = {
  lpFeeBps: number; // 1e6-based (10_000 = 1%)
  agentBps: number;
  creatorBps: number;
  burnBps: number;
  platformBps: number;
  platformRecipient: Address;
  minFuelUsdc: bigint;
  dormancyPeriod: number; // seconds
};

/** Public struct getters return a positional tuple. */
export type LaunchDefaultsTuple = readonly [number, number, number, number, number, Address, bigint, number];

export function defaultsFromTuple(t: LaunchDefaultsTuple): LaunchDefaults {
  return {
    lpFeeBps: t[0],
    agentBps: t[1],
    creatorBps: t[2],
    burnBps: t[3],
    platformBps: t[4],
    platformRecipient: t[5],
    minFuelUsdc: t[6],
    dormancyPeriod: t[7],
  };
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** Used when the launcher is not configured (mock mode). Mirrors the documented presets. */
export const FALLBACK_STANDARD: LaunchDefaults = {
  lpFeeBps: 10_000,
  agentBps: 500,
  creatorBps: 6500,
  burnBps: 0,
  platformBps: 3000,
  platformRecipient: ZERO,
  minFuelUsdc: 10_000_000n,
  dormancyPeriod: 90 * 86400,
};

export const FALLBACK_BUYBACK: LaunchDefaults = { ...FALLBACK_STANDARD, creatorBps: 5000, burnBps: 1500 };

/**
 * The Clanker v5 launcher's presets when they cannot be read: the same splits, with `lpFeeBps` the buy and sell tax
 * (15_000 = 1.5%, `TAX_BPS` of script/DeployClankerLauncherV5.s.sol; the owner's choice of 2026-11-10). The live value is
 * read from `standardDefaults()` / `buybackDefaults()` of the v5 launcher wherever the v4 ones are read.
 */
export const FALLBACK_V5_STANDARD: LaunchDefaults = { ...FALLBACK_STANDARD, lpFeeBps: 15_000 };
export const FALLBACK_V5_BUYBACK: LaunchDefaults = { ...FALLBACK_BUYBACK, lpFeeBps: 15_000 };

/** The fallback presets of a launch path. */
export function fallbackDefaults(source: 'bootr' | 'clanker' | 'clanker-v5', buyback: boolean): LaunchDefaults {
  if (source === 'clanker-v5') return buyback ? FALLBACK_V5_BUYBACK : FALLBACK_V5_STANDARD;
  return buyback ? FALLBACK_BUYBACK : FALLBACK_STANDARD;
}
