/**
 * BootrClankerLauncherV5 ABI with creator-set token settings, copied verbatim from
 * packages/contracts/out/BootrClankerLauncherV5.sol/BootrClankerLauncherV5.json (forge build of branch
 * worktree-agent-a13d6a48bc2c37396, 2026-11-10; docs/design/clanker-v5-token-settings.md section 2). The one place the
 * web names the v5 launcher's functions, events and errors: `launch(p, s)`, `tokenInitCodeHash(p, s)`,
 * `predictToken(creator, p, s)`, `previewSlotWeights(s)`, `agentDefaults()`, `allowedQuote(kind, quote)`,
 * `devBuyRoute(quote)`, `updateImage`, `updateMetadata`, `lockMetadata`, `metadataEditable(token)`. Re-copy after
 * contract changes: do not import from out/ at runtime.
 */
// prettier-ignore
export const clankerLauncherV5Abi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "owner_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "deps",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.Deps",
        "components": [
          {
            "name": "factory",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "hook",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "feeEscrow",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "weth",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "usdc",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "identityRegistry",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "kernelFactory",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "guardian",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "gate",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "defaults",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.AgentDefaults",
        "components": [
          {
            "name": "agentShareBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "platformShareBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "platformRecipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "minFuelUsdc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "dormancyPeriod",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "maxTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "maxRewardRows",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      },
      {
        "name": "minPlatformBps_",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "DEAD",
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
    "type": "function",
    "name": "MAX_LOCKED_SHARE_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_REWARD_ROWS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_TAX_CEILING_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint24",
        "internalType": "uint24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_AGENT_SHARE_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_DORMANCY_PERIOD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ROOT_VALIDATION_ID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes21",
        "internalType": "bytes21"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "agentDefaults",
    "inputs": [],
    "outputs": [
      {
        "name": "agentShareBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "platformShareBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "platformRecipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "minFuelUsdc",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "dormancyPeriod",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "minTaxBps",
        "type": "uint24",
        "internalType": "uint24"
      },
      {
        "name": "maxTaxBps",
        "type": "uint24",
        "internalType": "uint24"
      },
      {
        "name": "maxRewardRows",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "allowedQuote",
    "inputs": [
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum BootrClankerLauncherV5.LaunchKind"
      },
      {
        "name": "quote",
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
    "type": "function",
    "name": "coinCreator",
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
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "devBuyRoute",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "pool",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "fee",
        "type": "uint24",
        "internalType": "uint24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "factory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IClankerV5Factory"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeEscrow",
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
    "type": "function",
    "name": "gate",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract BootrLaunchGate"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "guardian",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract AgentGuardian"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hook",
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
    "type": "function",
    "name": "identityRegistry",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC8004IdentityRegistry"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "kernelFactory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IKernelFactory"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "launch",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.LaunchParams",
        "components": [
          {
            "name": "name",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "symbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "image",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "metadata",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "context",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "buybackBurn",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "fuelUsdc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "devBuyWei",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "workerHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "model",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "agentURI",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "supervisorSessionKey",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.TokenSettings",
        "components": [
          {
            "name": "quoteToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buyTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "sellTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "burnBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "dividendBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "minDividendHolding",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rewards",
            "type": "tuple[]",
            "internalType": "struct BootrClankerLauncherV5.RewardInput[]",
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
                "name": "bps",
                "type": "uint16",
                "internalType": "uint16"
              }
            ]
          },
          {
            "name": "antiSnipe",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "metadataEditable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "contractURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "kernel",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "burner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "agentId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "launchFeeWei",
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
    "type": "function",
    "name": "lockMetadata",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "metadataEditable",
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
    "type": "function",
    "name": "minPlatformBps",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "onERC721Received",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "owner",
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
    "type": "function",
    "name": "pause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "paused",
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
    "type": "function",
    "name": "pendingOwner",
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
    "type": "function",
    "name": "poolKeyFor",
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
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "currency0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "currency1",
            "type": "address",
            "internalType": "address"
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
            "internalType": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "poolKeyFor",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tickSpacing",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "outputs": [
      {
        "name": "key",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "currency0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "currency1",
            "type": "address",
            "internalType": "address"
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
            "internalType": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "predictKernel",
    "inputs": [
      {
        "name": "creator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
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
    "type": "function",
    "name": "predictToken",
    "inputs": [
      {
        "name": "creator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.LaunchParams",
        "components": [
          {
            "name": "name",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "symbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "image",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "metadata",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "context",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "buybackBurn",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "fuelUsdc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "devBuyWei",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "workerHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "model",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "agentURI",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "supervisorSessionKey",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.TokenSettings",
        "components": [
          {
            "name": "quoteToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buyTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "sellTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "burnBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "dividendBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "minDividendHolding",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rewards",
            "type": "tuple[]",
            "internalType": "struct BootrClankerLauncherV5.RewardInput[]",
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
                "name": "bps",
                "type": "uint16",
                "internalType": "uint16"
              }
            ]
          },
          {
            "name": "antiSnipe",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "metadataEditable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "contractURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
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
    "type": "function",
    "name": "previewSlotWeights",
    "inputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.TokenSettings",
        "components": [
          {
            "name": "quoteToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buyTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "sellTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "burnBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "dividendBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "minDividendHolding",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rewards",
            "type": "tuple[]",
            "internalType": "struct BootrClankerLauncherV5.RewardInput[]",
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
                "name": "bps",
                "type": "uint16",
                "internalType": "uint16"
              }
            ]
          },
          {
            "name": "antiSnipe",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "metadataEditable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "contractURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint16[]",
        "internalType": "uint16[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteOf",
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
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "scopedSalt",
    "inputs": [
      {
        "name": "creator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setAgentDefaults",
    "inputs": [
      {
        "name": "d",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.AgentDefaults",
        "components": [
          {
            "name": "agentShareBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "platformShareBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "platformRecipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "minFuelUsdc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "dormancyPeriod",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "maxTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "maxRewardRows",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setDevBuyRoute",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "pool",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "fee",
        "type": "uint24",
        "internalType": "uint24"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setLaunchFee",
    "inputs": [
      {
        "name": "launchFeeWei_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMinPlatformBps",
    "inputs": [
      {
        "name": "minPlatformBps_",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setQuoteAllowed",
    "inputs": [
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum BootrClankerLauncherV5.LaunchKind"
      },
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "taxConfigurationFor",
    "inputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.TokenSettings",
        "components": [
          {
            "name": "quoteToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buyTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "sellTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "burnBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "dividendBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "minDividendHolding",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rewards",
            "type": "tuple[]",
            "internalType": "struct BootrClankerLauncherV5.RewardInput[]",
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
                "name": "bps",
                "type": "uint16",
                "internalType": "uint16"
              }
            ]
          },
          {
            "name": "antiSnipe",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "metadataEditable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "contractURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct ClankerV5.TaxConfiguration",
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
        ]
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "tokenInitCodeHash",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.LaunchParams",
        "components": [
          {
            "name": "name",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "symbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "image",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "metadata",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "context",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "buybackBurn",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "fuelUsdc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "devBuyWei",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "workerHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "model",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "agentURI",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "supervisorSessionKey",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct BootrClankerLauncherV5.TokenSettings",
        "components": [
          {
            "name": "quoteToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buyTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "sellTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "burnBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "dividendBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "minDividendHolding",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rewards",
            "type": "tuple[]",
            "internalType": "struct BootrClankerLauncherV5.RewardInput[]",
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
                "name": "bps",
                "type": "uint16",
                "internalType": "uint16"
              }
            ]
          },
          {
            "name": "antiSnipe",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "metadataEditable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "contractURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "unpause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "updateImage",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "image",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "updateMetadata",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "metadata",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "usdc",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "weth",
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
    "type": "event",
    "name": "AgentDefaultsUpdated",
    "inputs": [
      {
        "name": "defaults",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct BootrClankerLauncherV5.AgentDefaults",
        "components": [
          {
            "name": "agentShareBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "platformShareBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "platformRecipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "minFuelUsdc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "dormancyPeriod",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "maxTaxBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "maxRewardRows",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AgentLaunched",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "kernel",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "burner",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "agentId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "defaults",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct BootrClankerLauncherV5.LaunchDefaults",
        "components": [
          {
            "name": "lpFeeBps",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "agentBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "creatorBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "burnBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "platformBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "platformRecipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "minFuelUsdc",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "dormancyPeriod",
            "type": "uint32",
            "internalType": "uint32"
          }
        ]
      },
      {
        "name": "workerHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "model",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "agentURI",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "supervisorSessionKey",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClankerV5Launched",
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
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "hook",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "feeEscrow",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "quoteToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "tickSpacing",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      },
      {
        "name": "buyTaxBps",
        "type": "uint24",
        "indexed": false,
        "internalType": "uint24"
      },
      {
        "name": "sellTaxBps",
        "type": "uint24",
        "indexed": false,
        "internalType": "uint24"
      },
      {
        "name": "burnBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "dividendBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "antiSnipe",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "metadataEditable",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CoinImageUpdated",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "image",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CoinMetadataLocked",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CoinMetadataUpdated",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "metadata",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DevBuyRouteUpdated",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "pool",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "fee",
        "type": "uint24",
        "indexed": false,
        "internalType": "uint24"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "LaunchContext",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "context",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "LaunchFeePaid",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "recipient",
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
    "type": "event",
    "name": "LaunchFeeUpdated",
    "inputs": [
      {
        "name": "launchFeeWei",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MinPlatformBpsUpdated",
    "inputs": [
      {
        "name": "minPlatformBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Paused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "QuoteAllowedUpdated",
    "inputs": [
      {
        "name": "kind",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum BootrClankerLauncherV5.LaunchKind"
      },
      {
        "name": "quote",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Unpaused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "DevBuyRouteMissing",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "DividendHoldingMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EmptyNameOrSymbol",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EnforcedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExpectedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FailedCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientBalance",
    "inputs": [
      {
        "name": "balance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InsufficientFuel",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientValue",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidAgentShare",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidDormancyPeriod",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidMinPlatformBps",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidPlatformShare",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRewardAdmin",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRewardBps",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRewardCount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRewardRecipient",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRewardRowLimit",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidTaxBounds",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MetadataNotEditable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotCoinCreator",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "QuoteNotAllowed",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SharesExceedPool",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TaxOutOfBounds",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroSlotWeight",
    "inputs": []
  }
] as const;
