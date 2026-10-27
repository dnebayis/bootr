// Generated from Sourcify full match, Base Sepolia ReputationRegistry implementation 0x16e0fa7f7c56b9a767e34b192b51f921be31da34 (proxy 0x8004B663056A597Dffe9eCcC1965A193B7388713). Do not edit by hand.
export const ReputationRegistryAbi = [
  {
    "name": "FeedbackRevoked",
    "type": "event",
    "inputs": [
      {
        "name": "agentId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "clientAddress",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "feedbackIndex",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "name": "NewFeedback",
    "type": "event",
    "inputs": [
      {
        "name": "agentId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "clientAddress",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "feedbackIndex",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "value",
        "type": "int128",
        "indexed": false,
        "internalType": "int128"
      },
      {
        "name": "valueDecimals",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "indexedTag1",
        "type": "string",
        "indexed": true,
        "internalType": "string"
      },
      {
        "name": "tag1",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "tag2",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "endpoint",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "feedbackURI",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "feedbackHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "name": "getClients",
    "type": "function",
    "inputs": [
      {
        "name": "agentId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "getSummary",
    "type": "function",
    "inputs": [
      {
        "name": "agentId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "clientAddresses",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "tag1",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "tag2",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "count",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "summaryValue",
        "type": "int128",
        "internalType": "int128"
      },
      {
        "name": "summaryValueDecimals",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "getVersion",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "name": "readFeedback",
    "type": "function",
    "inputs": [
      {
        "name": "agentId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "clientAddress",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "feedbackIndex",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "value",
        "type": "int128",
        "internalType": "int128"
      },
      {
        "name": "valueDecimals",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "tag1",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "tag2",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "isRevoked",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  }
] as const;
