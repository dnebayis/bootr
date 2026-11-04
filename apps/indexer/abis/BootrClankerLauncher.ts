// BootrClankerLauncher (docs/design/clanker-launch.md section 2): the same `launch(LaunchParams)` and
// `AgentLaunched` as BootrLauncher (copied from abis/BootrLauncher.ts), plus the wrapper's own events. Replace with
// the generated ABI from packages/contracts/out once the contract is compiled (task A of the design note).
export const BootrClankerLauncherAbi = [
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
    "name": "ClankerLaunched",
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
        "internalType": "PoolId"
      },
      {
        "name": "hook",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "locker",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "mevModule",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "startingTick",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      },
      {
        "name": "lpFeeBps",
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
  }
] as const;
