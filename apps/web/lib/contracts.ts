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
  /** The Clanker-path launcher (same `launch(LaunchParams)` ABI); undefined hides the choice on the launch form. */
  clankerLauncher: env.clankerLauncherAddress,
  guardian: env.guardianAddress,
  // ClankerFeeLocker: where Clanker's LP locker deposits each recipient's converted fees; `claim(feeOwner, WETH)` is
  // callable by anyone and always pays `feeOwner`. Base mainnet only (docs/design/clanker-launch.md, section 1).
  clankerFeeLocker: (env.chainId === 8453 ? '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68' : null) as Address | null,
};

export const USDC_DECIMALS = 6;
