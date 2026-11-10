import { concat, encodeFunctionData, formatEther, type Address, type Hex } from 'viem';
import { clankerFeeLockerAbi } from '@/lib/abi/clankerFeeLocker';
import { feeEscrowAbi, NATIVE_ETH } from '@/lib/abi/feeEscrow';
import { rwagmiLpLockerV3Abi } from '@/lib/abi/rwagmiLpLockerV3';

/**
 * The creator's fee claim as unsigned calldata, for programs: the same calls the profile page sends from
 * `components/profile/CreatorFees.tsx` (RWAGMI's locker) and `lib/use-clanker-fees.ts` (Clanker's fee locker and fee
 * escrow). Pure: `app/api/agent/claim/[id]/route.ts` reads the balances, and nothing here signs or sends.
 *
 * - Bootr path: `settleAndClaim(poolIds, WETH, owner)` settles the coins with unsettled fees and pays the owner's whole
 *   balance; with nothing unsettled, `claimQuote(WETH, owner)` takes the settled balance alone. Both pay `msg.sender`'s
 *   balance, so only the owner's own wallet can send them.
 * - Clanker v4 path: `claim(owner, WETH)` on Clanker's fee locker pays the owner, whoever sends it.
 * - Clanker v5 path: `claimFor(owner, 0x0)` on Clanker's fee escrow pays the owner in native ETH, whoever sends it.
 */

export type ClaimPath = 'bootr' | 'clanker' | 'clanker-v5';

export type UnsignedClaim = {
  path: ClaimPath;
  target: Address;
  data: Hex;
  /** Decimal wei; a claim moves no ETH. */
  value: '0';
  /** What the claim pays: WETH, or the zero address for native ETH (Clanker v5). */
  asset: Address;
  /** The asset this claim pays, in wei, as read when the answer was built. */
  amountWei: string;
  /** The wallet that must send it; null when any wallet may. */
  sendFrom: Address | null;
  description: string;
};

export type ClaimInput = {
  owner: Address;
  weth: Address;
  /** RWAGMI's locker; null where it has no deployment. */
  lpLocker: Address | null;
  /** Clanker's fee locker; null where it has no deployment. */
  clankerFeeLocker: Address | null;
  /** Clanker v5's fee escrow; null where it has no deployment. */
  clankerFeeEscrow?: Address | null;
  /** `claimableQuote(owner, WETH)`. */
  settled: bigint;
  /** `pendingQuote(poolId, owner)` of each of the owner's Bootr-path coins. */
  unsettled: { poolId: Hex; amount: bigint }[];
  /** `availableFees(owner, WETH)`. */
  clankerAvailable: bigint;
  /** `owed(owner, 0x0)` on Clanker v5's fee escrow. */
  clankerV5Owed?: bigint;
  /** The ERC-8021 attribution suffix the site's own claims carry, if any. */
  dataSuffix?: Hex;
};

export function buildClaims(input: ClaimInput): UnsignedClaim[] {
  const { owner, weth, lpLocker, clankerFeeLocker, settled, clankerAvailable, dataSuffix } = input;
  const clankerFeeEscrow = input.clankerFeeEscrow ?? null;
  const clankerV5Owed = input.clankerV5Owed ?? 0n;
  const withSuffix = (data: Hex): Hex => (dataSuffix ? concat([data, dataSuffix]) : data);
  const claims: UnsignedClaim[] = [];

  const pools = input.unsettled.filter((u) => u.amount > 0n);
  const bootrAmount = pools.reduce((sum, u) => sum + u.amount, settled);
  if (lpLocker && bootrAmount > 0n) {
    claims.push({
      path: 'bootr',
      target: lpLocker,
      data: withSuffix(
        pools.length > 0
          ? encodeFunctionData({ abi: rwagmiLpLockerV3Abi, functionName: 'settleAndClaim', args: [pools.map((u) => u.poolId), weth, owner] })
          : encodeFunctionData({ abi: rwagmiLpLockerV3Abi, functionName: 'claimQuote', args: [weth, owner] }),
      ),
      value: '0',
      asset: weth,
      amountWei: bootrAmount.toString(),
      sendFrom: owner,
      description: `Pays ${formatEther(bootrAmount)} WETH of creator fees to ${owner} from RWAGMI's locker${pools.length > 0 ? `, settling ${pools.length} coin${pools.length === 1 ? '' : 's'} first` : ''}. Send it from ${owner}: the locker pays the sender's own balance. It costs only network gas.`,
    });
  }

  if (clankerFeeLocker && clankerAvailable > 0n) {
    claims.push({
      path: 'clanker',
      target: clankerFeeLocker,
      data: withSuffix(encodeFunctionData({ abi: clankerFeeLockerAbi, functionName: 'claim', args: [owner, weth] })),
      value: '0',
      asset: weth,
      amountWei: clankerAvailable.toString(),
      sendFrom: null,
      description: `Pays ${formatEther(clankerAvailable)} WETH to ${owner} from Clanker's fee locker: one balance across all their Clanker v4 coins. Any wallet may send it and the WETH still goes to ${owner}. It costs only network gas.`,
    });
  }

  if (clankerFeeEscrow && clankerV5Owed > 0n) {
    claims.push({
      path: 'clanker-v5',
      target: clankerFeeEscrow,
      data: withSuffix(encodeFunctionData({ abi: feeEscrowAbi, functionName: 'claimFor', args: [owner, NATIVE_ETH] })),
      value: '0',
      asset: NATIVE_ETH,
      amountWei: clankerV5Owed.toString(),
      sendFrom: null,
      description: `Pays ${formatEther(clankerV5Owed)} ETH to ${owner} from Clanker's fee escrow: one balance across all their Clanker v5 coins. Any wallet may send it and the ETH still goes to ${owner}. It costs only network gas.`,
    });
  }
  return claims;
}
