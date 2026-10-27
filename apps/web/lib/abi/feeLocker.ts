/**
 * ClankerFeeLocker subset (packages/contracts/src/interfaces/IClanker.sol `IClankerFeeLocker`).
 * Balances are keyed by (feeOwner, fee token): WETH fees from every coin a recipient earns on are
 * pooled in one WETH balance; fees taken in a coin itself are kept under that coin's address.
 * `claim` is permissionless and always pays `feeOwner`.
 */
export const feeLockerAbi = [
  {
    type: 'function',
    name: 'availableFees',
    stateMutability: 'view',
    inputs: [
      { name: 'feeOwner', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'feeOwner', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [],
  },
] as const;
