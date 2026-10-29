/**
 * Agent gas: the ETH an agent's Kernel can spend on its own transactions. There is no paymaster; the
 * EntryPoint takes the prefund of every userOp from the kernel's EntryPoint deposit, topped up from the
 * kernel's own ETH balance. "Gas" on the site is the sum of the two.
 *
 * The thresholds mirror the supervisor's defaults (apps/supervisor): below `GAS_LOW_WEI` the supervisor
 * unwraps the kernel's WETH fees into ETH; below `GAS_EMPTY_WEI` the agent cannot send anything.
 */
import { formatEther, parseEther, type Address } from 'viem';
import { chainAddresses } from './chains';

export type GasStatus = 'ok' | 'low' | 'empty';

/** Gas at or above this is `ok`. */
export const GAS_OK_WEI = parseEther('0.0002');
/** Gas at or below this is `empty`; between the two it is `low`. */
export const GAS_EMPTY_WEI = parseEther('0.00004');
/** Default amount of the "Add gas" form, in ETH. */
export const GAS_TOPUP_DEFAULT_ETH = '0.001';
/** Smallest top-up the form accepts, in ETH. */
export const GAS_TOPUP_MIN_ETH = '0.0001';

export const GAS_STATUS_LABEL: Record<GasStatus, string> = { ok: 'ok', low: 'low', empty: 'out of gas' };

/** ERC-4337 EntryPoint v0.7, the same address on Base and Base Sepolia. */
export const entryPoint: Address = chainAddresses().entryPointV07;

/** The two EntryPoint functions the site uses: read a kernel's deposit, and add to it (anyone can). */
export const entryPointAbi = [
  { type: 'function', name: 'depositTo', stateMutability: 'payable', inputs: [{ name: 'account', type: 'address' }], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface KernelGas {
  /** EntryPoint deposit (wei). */
  deposit: bigint;
  /** Kernel ETH balance (wei). */
  balance: bigint;
}

export function gasTotal(g: KernelGas): bigint {
  return g.deposit + g.balance;
}

export function gasStatus(totalWei: bigint): GasStatus {
  if (totalWei >= GAS_OK_WEI) return 'ok';
  if (totalWei > GAS_EMPTY_WEI) return 'low';
  return 'empty';
}

/** ETH figure with at most 5 significant decimals: 0.0012, 0.00004, 1.5, 0 */
export function formatGas(wei: bigint | null | undefined): string {
  if (wei == null) return '—';
  const n = Number(formatEther(wei));
  if (n === 0) return '0';
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumSignificantDigits: 5, maximumFractionDigits: 18 });
}

/** A top-up amount typed by a person: a decimal ETH string of at least `GAS_TOPUP_MIN_ETH`. */
export function validTopUp(amount: string): boolean {
  if (!/^\d+(\.\d{0,18})?$/.test(amount)) return false;
  try {
    return parseEther(amount) >= parseEther(GAS_TOPUP_MIN_ETH);
  } catch {
    return false;
  }
}
