// Uniswap v4-core PoolManager: `Swap` event (IPoolManager.sol) and `extsload(bytes32[])`
// (Extsload.sol), used to read pool slot0/liquidity like StateLibrary does.
export const PoolManagerAbi = [
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true, internalType: 'PoolId' },
      { name: 'sender', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount0', type: 'int128', indexed: false, internalType: 'int128' },
      { name: 'amount1', type: 'int128', indexed: false, internalType: 'int128' },
      { name: 'sqrtPriceX96', type: 'uint160', indexed: false, internalType: 'uint160' },
      { name: 'liquidity', type: 'uint128', indexed: false, internalType: 'uint128' },
      { name: 'tick', type: 'int24', indexed: false, internalType: 'int24' },
      { name: 'fee', type: 'uint24', indexed: false, internalType: 'uint24' },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'extsload',
    stateMutability: 'view',
    inputs: [{ name: 'slots', type: 'bytes32[]', internalType: 'bytes32[]' }],
    outputs: [{ name: '', type: 'bytes32[]', internalType: 'bytes32[]' }],
  },
] as const;
