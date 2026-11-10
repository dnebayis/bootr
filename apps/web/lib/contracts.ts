import type { Address } from 'viem';
import { chainAddresses } from './chains';
import { env } from './env';

const a = chainAddresses();

export const contracts = {
  usdc: a.usdc as Address,
  weth: a.weth as Address,
  // RwagmiLpLockerV3: locked reward slots (`launchInfo`) and the WETH fee ledger every recipient claims from.
  // `null` on Base Sepolia (no RWAGMI v3 deployment there).
  lpLocker: a.rwagmiLockerV3 as Address | null,
  launcher: env.launcherAddress,
  /** The Clanker v4 launcher (same `launch(LaunchParams)` ABI). Launches use `clankerPath`, not this directly. */
  clankerLauncher: env.clankerLauncherAddress,
  /** The Clanker v5 launcher (same `LaunchParams`, salt mined to a `cccc` token address). Launches use `clankerPath`. */
  clankerLauncherV5: env.clankerV5LauncherAddress,
  guardian: env.guardianAddress,
  // ClankerFeeLocker: where Clanker's LP locker deposits each recipient's converted fees; `claim(feeOwner, WETH)` is
  // callable by anyone and always pays `feeOwner`. Base mainnet only (docs/design/clanker-launch.md, section 1).
  clankerFeeLocker: (env.chainId === 8453 ? '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68' : null) as Address | null,
  // Clanker v5's FeeEscrow: every v5 fee slot's balance, `owed(recipient, 0x0)` in native ETH; `claimFor(recipient,
  // 0x0)` pays `recipient`, whoever sends it (docs/design/clanker-v5-migration.md, section 3). `null` off Base.
  clankerFeeEscrow: (a.clankerV5?.feeEscrow ?? null) as Address | null,
  /** Clanker v5's CREATE2 token deployer and hook, `null` off Base (the swap panel and salt mining read them). */
  clankerV5: a.clankerV5 as { factory: Address; hook: Address; feeEscrow: Address; tokenDeployer: Address; launchBuyAdapter: Address } | null,
};

export type ClankerPath = {
  /** The coin's `source` once indexed. */
  source: 'clanker' | 'clanker-v5';
  version: 4 | 5;
  /** Undefined while the deployment has no such launcher. */
  launcher: Address | undefined;
};

export const CLANKER_PATHS: Record<4 | 5, ClankerPath> = {
  4: { source: 'clanker', version: 4, launcher: env.clankerLauncherAddress },
  5: { source: 'clanker-v5', version: 5, launcher: env.clankerV5LauncherAddress },
};

/**
 * Where a new "Launch through Clanker" goes: the one place the v5 switch is read. The owner's choice (option (a) of
 * docs/design/clanker-v5-migration.md section 8): v4 stays the Clanker path for both presets until the v5 launcher is
 * live; once `NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS` is set, new Clanker launches go through v5 and v4 is not
 * offered. Coins already launched through v4 keep working everywhere (fees, claims, trading) either way.
 */
export const clankerPath: ClankerPath = env.clankerV5LauncherAddress ? CLANKER_PATHS[5] : CLANKER_PATHS[4];

export const USDC_DECIMALS = 6;
