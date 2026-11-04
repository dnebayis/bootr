/**
 * ClankerFeeLocker, the two calls the fee panels need (docs/design/clanker-launch.md, section 1). Clanker's LP locker
 * deposits each recipient's converted fees here; `claim(feeOwner, token)` is callable by anyone and always pays
 * `feeOwner`, `availableFees(feeOwner, token)` is the balance waiting for a claim.
 */
export const clankerFeeLockerAbi = [
  {
    type: 'function',
    name: 'availableFees',
    inputs: [
      { name: 'feeOwner', type: 'address', internalType: 'address' },
      { name: 'token', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claim',
    inputs: [
      { name: 'feeOwner', type: 'address', internalType: 'address' },
      { name: 'token', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;
