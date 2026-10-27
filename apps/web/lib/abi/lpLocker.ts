/**
 * ClankerLpLockerFeeConversion: `tokenRewards(token)` subset (packages/contracts/src/interfaces/IClanker.sol).
 * rewardBps sum to 10_000 and split the full LP fee. Clanker's 20% protocol fee is charged on top.
 */
export const lpLockerAbi = [
  {
    type: 'function',
    name: 'tokenRewards',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'positionId', type: 'uint256' },
          { name: 'numPositions', type: 'uint256' },
          { name: 'rewardBps', type: 'uint16[]' },
          { name: 'rewardAdmins', type: 'address[]' },
          { name: 'rewardRecipients', type: 'address[]' },
        ],
      },
    ],
  },
] as const;
