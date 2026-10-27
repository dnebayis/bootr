// Generated from packages/contracts/out/BootrLauncher.sol/BootrLauncher.json. Do not edit by hand.
export const BootrLauncherAbi = [
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
        "internalType": "struct BootrLauncher.Deps",
        "components": [
          {
            "name": "clanker",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "feeLocker",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "lpLocker",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "staticHook",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "devBuyExtension",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "mevModule",
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
            "name": "burnerImplementation",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "universalRouter",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "permit2",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "standard",
        "type": "tuple",
        "internalType": "struct BootrLauncher.LaunchDefaults",
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
        "name": "buyback",
        "type": "tuple",
        "internalType": "struct BootrLauncher.LaunchDefaults",
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
    "name": "MAX_LP_FEE",
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
    "name": "POSITION_TICK_UPPER",
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
    "name": "STARTING_TICK",
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
    "type": "function",
    "name": "TICK_SPACING",
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
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "burnerImplementation",
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
    "name": "buybackDefaults",
    "inputs": [],
    "outputs": [
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
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "clanker",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IClanker"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "devBuyExtension",
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
    "name": "feeLocker",
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
        "internalType": "struct BootrLauncher.LaunchParams",
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
    "name": "lpLocker",
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
    "name": "mevModule",
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
    "name": "permit2",
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
    "name": "predictBurner",
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
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setDefaults",
    "inputs": [
      {
        "name": "buyback",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "d",
        "type": "tuple",
        "internalType": "struct BootrLauncher.LaunchDefaults",
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
    "name": "standardDefaults",
    "inputs": [],
    "outputs": [
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
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "staticHook",
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
    "name": "universalRouter",
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
    "name": "unpause",
    "inputs": [],
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
        "internalType": "struct BootrLauncher.LaunchDefaults",
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
    "name": "DefaultsUpdated",
    "inputs": [
      {
        "name": "buyback",
        "type": "bool",
        "indexed": true,
        "internalType": "bool"
      },
      {
        "name": "defaults",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct BootrLauncher.LaunchDefaults",
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
    "name": "BurnBpsMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CloneFailed",
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
    "name": "InvalidBpsSum",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidDormancyPeriod",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidLpFee",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidMinPlatformBps",
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
    "name": "PlatformBpsBelowMinimum",
    "inputs": []
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
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroBps",
    "inputs": []
  }
] as const;
