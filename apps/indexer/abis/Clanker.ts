// Generated from clanker v4-contracts base_mainnet_abis/Clanker.json. Do not edit by hand.
export const ClankerAbi = [
  {
    "type": "function",
    "name": "tokenDeploymentInfo",
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
        "internalType": "struct IClanker.DeploymentInfo",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "hook",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "locker",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "extensions",
            "type": "address[]",
            "internalType": "address[]"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "TokenCreated",
    "inputs": [
      {
        "name": "msgSender",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "tokenAddress",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenImage",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "tokenName",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "tokenSymbol",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "tokenMetadata",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "tokenContext",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "startingTick",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      },
      {
        "name": "poolHook",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "PoolId"
      },
      {
        "name": "pairedToken",
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
        "name": "extensionsSupply",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "extensions",
        "type": "address[]",
        "indexed": false,
        "internalType": "address[]"
      }
    ],
    "anonymous": false
  }
] as const;
