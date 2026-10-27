import type { Address } from 'viem';
import { chainAddresses } from './chains';
import { env } from './env';

const a = chainAddresses();

export const contracts = {
  usdc: a.usdc as Address,
  weth: a.weth as Address,
  // ClankerLpLockerFeeConversion: the locker enabled for the V2 hooks BootrLauncher uses.
  lpLocker: a.clankerLpLockerFeeConversion as Address,
  launcher: env.launcherAddress,
  guardian: env.guardianAddress,
};

export const USDC_DECIMALS = 6;
