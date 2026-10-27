import { base, baseSepolia } from 'viem/chains';
import { addresses } from '@bootr/shared/addresses';
import { env, type AppChainId } from './env';

export const appChain = env.chainId === 8453 ? base : baseSepolia;
export const isMainnet = env.chainId === 8453;

export function chainLabel(chainId: number = env.chainId): string {
  return chainId === 8453 ? 'Base' : chainId === 84532 ? 'Base Sepolia' : `Chain ${chainId}`;
}

export function chainBadge(chainId: number = env.chainId): string {
  return chainId === 8453 ? 'BASE' : chainId === 84532 ? 'SEPOLIA' : String(chainId);
}

export function explorerBase(chainId: number = env.chainId): string {
  return chainId === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org';
}

export const explorer = {
  address: (a: string, chainId?: number) => `${explorerBase(chainId)}/address/${a}`,
  token: (a: string, chainId?: number) => `${explorerBase(chainId)}/token/${a}`,
  tx: (h: string, chainId?: number) => `${explorerBase(chainId)}/tx/${h}`,
  nft: (contract: string, id: string, chainId?: number) => `${explorerBase(chainId)}/nft/${contract}/${id}`,
};

export function chainAddresses(chainId: AppChainId = env.chainId) {
  return addresses[chainId];
}

/** DexScreener only indexes mainnet; returns null on testnets. */
export function dexscreenerUrl(target: string, opts?: { embed?: boolean; theme?: 'light' | 'dark' }) {
  if (!isMainnet) return null;
  const base = `https://dexscreener.com/base/${target}`;
  if (!opts?.embed) return base;
  return `${base}?embed=1&theme=${opts.theme ?? 'dark'}&trades=0&info=0`;
}

export function swapLink(token: string, override?: string): string {
  const prefix =
    override ||
    env.swapLinkBase ||
    `https://app.uniswap.org/swap?chain=${isMainnet ? 'base' : 'base_sepolia'}&outputCurrency=`;
  return `${prefix}${token}`;
}
