// Multicall3 (0xcA11bde05977b3631167028862bE2a173976CA11) - `getEthBalance` so native balances
// can be batched together with ERC-20 reads.
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const Multicall3Abi = [
  {
    type: 'function',
    name: 'getEthBalance',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;
