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
  guardian: env.guardianAddress,
};

export const USDC_DECIMALS = 6;
