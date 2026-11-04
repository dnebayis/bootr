// Generated from clanker v4-contracts base_mainnet_abis/ClankerLpLockerFeeConversion.json (events and views the
// indexer uses). Event signatures re-verified against Base mainnet logs of 0xffA37784D619F228D8B379d287a4D7282e500762
// on 2026-11-04 (topic0 of ClaimedRewards, FeesSwapped, InitialFeePreferences, TokenRewardAdded; indexed counts
// match); `collectRewards`, `collectRewardsWithoutUnlock`, `feeLocker`, `RewardAdminUpdated` and
// `FeePreferenceUpdated` added from src/lp-lockers/interfaces/IClankerLpLockerFeeConversion.sol (v4-contracts main).
export const ClankerLpLockerFeeConversionAbi = [
  {
    "type": "function",
    "name": "feePreferences",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "feePreference",
        "type": "uint8",
        "internalType": "enum IClankerLpLockerFeeConversion.FeeIn"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tokenRewards",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IClankerLpLocker.TokenRewardInfo",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "poolKey",
            "type": "tuple",
            "internalType": "struct PoolKey",
            "components": [
              {
                "name": "currency0",
                "type": "address",
                "internalType": "Currency"
              },
              {
                "name": "currency1",
                "type": "address",
                "internalType": "Currency"
              },
              {
                "name": "fee",
                "type": "uint24",
                "internalType": "uint24"
              },
              {
                "name": "tickSpacing",
                "type": "int24",
                "internalType": "int24"
              },
              {
                "name": "hooks",
                "type": "address",
                "internalType": "contract IHooks"
              }
            ]
          },
          {
            "name": "positionId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "numPositions",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rewardBps",
            "type": "uint16[]",
            "internalType": "uint16[]"
          },
          {
            "name": "rewardAdmins",
            "type": "address[]",
            "internalType": "address[]"
          },
          {
            "name": "rewardRecipients",
            "type": "address[]",
            "internalType": "address[]"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "collectRewards",
    "inputs": [{ "name": "token", "type": "address", "internalType": "address" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "collectRewardsWithoutUnlock",
    "inputs": [{ "name": "token", "type": "address", "internalType": "address" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "feeLocker",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address", "internalType": "contract IClankerFeeLocker" }],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "RewardAdminUpdated",
    "inputs": [
      { "name": "token", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "rewardIndex", "type": "uint256", "indexed": true, "internalType": "uint256" },
      { "name": "oldAdmin", "type": "address", "indexed": false, "internalType": "address" },
      { "name": "newAdmin", "type": "address", "indexed": false, "internalType": "address" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeePreferenceUpdated",
    "inputs": [
      { "name": "token", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "rewardIndex", "type": "uint256", "indexed": true, "internalType": "uint256" },
      { "name": "oldFeePreference", "type": "uint8", "indexed": false, "internalType": "enum IClankerLpLockerFeeConversion.FeeIn" },
      { "name": "newFeePreference", "type": "uint8", "indexed": true, "internalType": "enum IClankerLpLockerFeeConversion.FeeIn" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimedRewards",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount0",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amount1",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "rewards0",
        "type": "uint256[]",
        "indexed": false,
        "internalType": "uint256[]"
      },
      {
        "name": "rewards1",
        "type": "uint256[]",
        "indexed": false,
        "internalType": "uint256[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeesSwapped",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "rewardToken",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amountSwapped",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "swappedToken",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amountOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "InitialFeePreferences",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "feePreference",
        "type": "uint8[]",
        "indexed": false,
        "internalType": "enum IClankerLpLockerFeeConversion.FeeIn[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RewardRecipientUpdated",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "rewardIndex",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "oldRecipient",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "newRecipient",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TokenRewardAdded",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "poolKey",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "currency0",
            "type": "address",
            "internalType": "Currency"
          },
          {
            "name": "currency1",
            "type": "address",
            "internalType": "Currency"
          },
          {
            "name": "fee",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "tickSpacing",
            "type": "int24",
            "internalType": "int24"
          },
          {
            "name": "hooks",
            "type": "address",
            "internalType": "contract IHooks"
          }
        ]
      },
      {
        "name": "poolSupply",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "numPositions",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "rewardBps",
        "type": "uint16[]",
        "indexed": false,
        "internalType": "uint16[]"
      },
      {
        "name": "rewardAdmins",
        "type": "address[]",
        "indexed": false,
        "internalType": "address[]"
      },
      {
        "name": "rewardRecipients",
        "type": "address[]",
        "indexed": false,
        "internalType": "address[]"
      },
      {
        "name": "tickLower",
        "type": "int24[]",
        "indexed": false,
        "internalType": "int24[]"
      },
      {
        "name": "tickUpper",
        "type": "int24[]",
        "indexed": false,
        "internalType": "int24[]"
      },
      {
        "name": "positionBps",
        "type": "uint16[]",
        "indexed": false,
        "internalType": "uint16[]"
      }
    ],
    "anonymous": false
  }
] as const;
