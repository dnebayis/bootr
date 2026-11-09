// Clanker v5 (the tax suite; docs/design/clanker-v5-migration.md section 1). Every item below is copied from the
// Sourcify-verified ABIs of the Base mainnet deployment (exact matches, verified 2026-11-03, read 2026-11-10):
// `TaxLaunchHook` 0x5E320eA6278107968C119942E57d876c5F922AcC, `FeeEscrow` 0x5dd237d1f716C65426CCd2FAe82B95109825FA61,
// `TaxRWAERC20LaunchpadFactory` 0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0; trimmed to what the indexer reads.
// Event topics are pinned by src/lib/clanker.test.ts.

/** `TaxLaunchHook`: per-swap tax credits (one `CreatorTaxCredited` per fee slot, `BurnTaxCredited` in the coin), the launch-time `FeeSlotCreated` / `PoolRegistered` / `Seeded`, and the slot and pool views. */
export const ClankerV5HookAbi = [
  {
    "name": "AntiSnipeFeeCredited",
    "type": "event",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "currency",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "BurnTaxCredited",
    "type": "event",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sink",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "CreatorTaxCredited",
    "type": "event",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "currency",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "FeeSlotCreated",
    "type": "event",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "slotIndex",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "admin",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "weightBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "isCreator",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "name": "PoolRegistered",
    "type": "event",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "originalCreator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "creatorFeeRecipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "name": "ProtocolFeeCredited",
    "type": "event",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "currency",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "Seeded",
    "type": "event",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "tokenAmountSeeded",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "Trade",
    "type": "event",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "executor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "referrer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "quoteCurrency",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "quoteFeeAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "comment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "name": "effectiveFeeRates",
    "type": "function",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "internalType": "PoolId"
      },
      {
        "name": "isBuy",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [
      {
        "name": "rate",
        "type": "tuple",
        "components": [
          {
            "name": "quoteRate",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "burnRate",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "protocolRate",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "creatorRate",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "dividendRate",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "integratorRate",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "surchargeRate",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct TaxFeeMath.Rates"
      },
      {
        "name": "exactOutputRestricted",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "factory",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "feeEscrow",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "poolConfig",
    "type": "function",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "internalType": "PoolId"
      }
    ],
    "outputs": [
      {
        "name": "initialized",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "tokenIsCurrency0",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "quoteToken",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "currentCreator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "creatorFeeRecipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "protocolFeeConfiguration",
        "type": "tuple",
        "components": [
          {
            "name": "protocolTaxShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minimumProtocolFeeRate",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maximumProtocolFeeRate",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "protocolFeeRecipient",
            "type": "address",
            "internalType": "address"
          }
        ],
        "internalType": "struct TaxFeeMath.ProtocolFeeConfiguration"
      },
      {
        "name": "antiSnipeConfiguration",
        "type": "tuple",
        "components": [
          {
            "name": "startTotalFeeRate",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "windowSeconds",
            "type": "uint32",
            "internalType": "uint32"
          }
        ],
        "internalType": "struct TaxFeeMath.AntiSnipeConfiguration"
      },
      {
        "name": "launchTime",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "antiSnipeEnabled",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "integratorFeeRecipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "dividend",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "taxConfiguration",
        "type": "tuple",
        "components": [
          {
            "name": "buyTaxRate",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "sellTaxRate",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "creatorAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "burnAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "dividendAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "integratorAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minimumDividendHolding",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct TaxFeeMath.TaxConfiguration"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "poolFeeSlots",
    "type": "function",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "internalType": "PoolId"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "components": [
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "admin",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "weightBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "isCreator",
            "type": "bool",
            "internalType": "bool"
          }
        ],
        "internalType": "struct TaxLaunchHook.FeeSlot[]"
      }
    ],
    "stateMutability": "view"
  }
] as const;

/** `FeeEscrow`: one balance per (recipient, currency) across every v5 pool; `currency == 0x0` is native ETH; `Claimed` pays the whole balance. */
export const ClankerV5FeeEscrowAbi = [
  {
    "name": "Claimed",
    "type": "event",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "currency",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "destination",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "Credited",
    "type": "event",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "currency",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "claimFor",
    "type": "function",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "currency",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "claimTo",
    "type": "function",
    "inputs": [
      {
        "name": "currency",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "destination",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "hook",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "owed",
    "type": "function",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "currency",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "claimableAmount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  }
] as const;

/** `TaxRWAERC20LaunchpadFactory`: the launch events of the receipt and the policy views. */
export const ClankerV5FactoryAbi = [
  {
    "name": "LaunchBuyExecuted",
    "type": "event",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "originalCreator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "fundingToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amountIn",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "launchBuyAdapter",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "name": "LaunchTaxConfigured",
    "type": "event",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "configVersion",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "admittedPolicy",
        "type": "tuple",
        "indexed": false,
        "components": [
          {
            "name": "taxFeeBounds",
            "type": "tuple",
            "components": [
              {
                "name": "minimumBuyTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "maximumBuyTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "minimumSellTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "maximumSellTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              }
            ],
            "internalType": "struct TaxFeeMath.TaxFeeBounds"
          },
          {
            "name": "protocolFeeConfiguration",
            "type": "tuple",
            "components": [
              {
                "name": "protocolTaxShare",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "minimumProtocolFeeRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "maximumProtocolFeeRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "protocolFeeRecipient",
                "type": "address",
                "internalType": "address"
              }
            ],
            "internalType": "struct TaxFeeMath.ProtocolFeeConfiguration"
          },
          {
            "name": "antiSnipeConfiguration",
            "type": "tuple",
            "components": [
              {
                "name": "startTotalFeeRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "windowSeconds",
                "type": "uint32",
                "internalType": "uint32"
              }
            ],
            "internalType": "struct TaxFeeMath.AntiSnipeConfiguration"
          },
          {
            "name": "minimumDividendHoldingRequirement",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct TaxFeeMath.TaxPolicy"
      },
      {
        "name": "taxConfiguration",
        "type": "tuple",
        "indexed": false,
        "components": [
          {
            "name": "buyTaxRate",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "sellTaxRate",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "creatorAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "burnAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "dividendAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "integratorAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minimumDividendHolding",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct TaxFeeMath.TaxConfiguration"
      },
      {
        "name": "integratorFeeRecipient",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "antiSnipeEnabled",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "name": "Launched",
    "type": "event",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "originalCreator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "quoteToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "launchSupply",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "tickSpacing",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      }
    ],
    "anonymous": false
  },
  {
    "name": "configVersion",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "creatorRights",
    "type": "function",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "rights",
        "type": "tuple",
        "components": [
          {
            "name": "originalCreator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "currentCreator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "pendingCreator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "creatorFeeRecipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "poolId",
            "type": "bytes32",
            "internalType": "PoolId"
          },
          {
            "name": "metadataEditable",
            "type": "bool",
            "internalType": "bool"
          }
        ],
        "internalType": "struct TaxLaunchpadFactoryCore.CreatorRights"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "hook",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract TaxLaunchHook"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "isLaunchToken",
    "type": "function",
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
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "launchBuyAdapter",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "adapter",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "launchCreationEnabled",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "launchSupply",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "launchTokenInitCodeHash",
    "type": "function",
    "inputs": [
      {
        "name": "launchParams",
        "type": "tuple",
        "components": [
          {
            "name": "creator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "feeSlots",
            "type": "tuple[]",
            "components": [
              {
                "name": "recipient",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "admin",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "relativeWeightBps",
                "type": "uint16",
                "internalType": "uint16"
              },
              {
                "name": "isCreator",
                "type": "bool",
                "internalType": "bool"
              }
            ],
            "internalType": "struct TaxLaunchHook.FeeSlotInput[]"
          },
          {
            "name": "tokenName",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "tokenSymbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "tokenContractURI",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "creatorSalt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "quoteToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expectedConfigVersion",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "metadataEditable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "metadataKeys",
            "type": "string[]",
            "internalType": "string[]"
          },
          {
            "name": "metadataValues",
            "type": "string[]",
            "internalType": "string[]"
          },
          {
            "name": "taxConfiguration",
            "type": "tuple",
            "components": [
              {
                "name": "buyTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "sellTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "creatorAllocationShare",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "burnAllocationShare",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "dividendAllocationShare",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "integratorAllocationShare",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "minimumDividendHolding",
                "type": "uint256",
                "internalType": "uint256"
              }
            ],
            "internalType": "struct TaxFeeMath.TaxConfiguration"
          },
          {
            "name": "creatorFeeRecipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "integratorFeeRecipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "antiSnipeEnabled",
            "type": "bool",
            "internalType": "bool"
          }
        ],
        "internalType": "struct TaxLaunchpadFactoryCore.LaunchParams"
      }
    ],
    "outputs": [
      {
        "name": "initCodeHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "previewTaxConfiguration",
    "type": "function",
    "inputs": [
      {
        "name": "configuration",
        "type": "tuple",
        "components": [
          {
            "name": "buyTaxRate",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "sellTaxRate",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "creatorAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "burnAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "dividendAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "integratorAllocationShare",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minimumDividendHolding",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct TaxFeeMath.TaxConfiguration"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "configVersion",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "buyRates",
            "type": "tuple",
            "components": [
              {
                "name": "quoteRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "burnRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "protocolRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "creatorRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "dividendRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "integratorRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "surchargeRate",
                "type": "uint256",
                "internalType": "uint256"
              }
            ],
            "internalType": "struct TaxFeeMath.Rates"
          },
          {
            "name": "sellRates",
            "type": "tuple",
            "components": [
              {
                "name": "quoteRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "burnRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "protocolRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "creatorRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "dividendRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "integratorRate",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "surchargeRate",
                "type": "uint256",
                "internalType": "uint256"
              }
            ],
            "internalType": "struct TaxFeeMath.Rates"
          },
          {
            "name": "dividendsEnabled",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "minimumDividendHoldingRequirement",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct TaxFeeMath.TaxConfigurationPreview"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "quoteConfig",
    "type": "function",
    "inputs": [
      {
        "name": "quoteToken",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "registered",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "quoteDecimals",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "startTickToken0Frame",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "taxPolicy",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "taxFeeBounds",
            "type": "tuple",
            "components": [
              {
                "name": "minimumBuyTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "maximumBuyTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "minimumSellTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "maximumSellTaxRate",
                "type": "uint32",
                "internalType": "uint32"
              }
            ],
            "internalType": "struct TaxFeeMath.TaxFeeBounds"
          },
          {
            "name": "protocolFeeConfiguration",
            "type": "tuple",
            "components": [
              {
                "name": "protocolTaxShare",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "minimumProtocolFeeRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "maximumProtocolFeeRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "protocolFeeRecipient",
                "type": "address",
                "internalType": "address"
              }
            ],
            "internalType": "struct TaxFeeMath.ProtocolFeeConfiguration"
          },
          {
            "name": "antiSnipeConfiguration",
            "type": "tuple",
            "components": [
              {
                "name": "startTotalFeeRate",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "windowSeconds",
                "type": "uint32",
                "internalType": "uint32"
              }
            ],
            "internalType": "struct TaxFeeMath.AntiSnipeConfiguration"
          },
          {
            "name": "minimumDividendHoldingRequirement",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct TaxFeeMath.TaxPolicy"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "tickSpacing",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "tokenDeployer",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract TaxLaunchTokenDeployer"
      }
    ],
    "stateMutability": "view"
  }
] as const;

/**
 * Uniswap v4 `PoolManager.Initialize` and `ModifyLiquidity` (v4-core `IPoolManager`), decoded from a v5 launch receipt
 * for the opening tick and the seeded position; not a Ponder source.
 */
export const PoolManagerLaunchAbi = [
  {
    "type": "event",
    "name": "Initialize",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "currency0",
        "type": "address",
        "indexed": true,
        "internalType": "Currency"
      },
      {
        "name": "currency1",
        "type": "address",
        "indexed": true,
        "internalType": "Currency"
      },
      {
        "name": "fee",
        "type": "uint24",
        "indexed": false,
        "internalType": "uint24"
      },
      {
        "name": "tickSpacing",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      },
      {
        "name": "hooks",
        "type": "address",
        "indexed": false,
        "internalType": "contract IHooks"
      },
      {
        "name": "sqrtPriceX96",
        "type": "uint160",
        "indexed": false,
        "internalType": "uint160"
      },
      {
        "name": "tick",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ModifyLiquidity",
    "inputs": [
      { "name": "id", "type": "bytes32", "indexed": true, "internalType": "PoolId" },
      { "name": "sender", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "tickLower", "type": "int24", "indexed": false, "internalType": "int24" },
      { "name": "tickUpper", "type": "int24", "indexed": false, "internalType": "int24" },
      { "name": "liquidityDelta", "type": "int256", "indexed": false, "internalType": "int256" },
      { "name": "salt", "type": "bytes32", "indexed": false, "internalType": "bytes32" }
    ],
    "anonymous": false
  }
] as const;
