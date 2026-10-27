import { parseAbi } from 'viem';

/** Hand-written minimal ABIs (kept in sync with packages/contracts/src). */

export const guardianAbi = parseAbi([
  'struct AgentInfo { address token; address creator; uint64 lastActivity; uint32 dormancyPeriod; bool paused; }',
  'function approveSessionKey(address kernel, bytes4 permissionId, bytes validatorData) returns (bytes32 digest, uint32 nonce)',
  'function revokeSessionKeyApproval(address kernel, bytes32 digest)',
  'function revokeSessionKey(address kernel, bytes4 permissionId, bytes deinitData)',
  'function revokeAllSessionKeys(address kernel) returns (uint32 nonce)',
  'function enableDigest(address kernel, bytes4 permissionId, uint32 nonce, bytes validatorData) view returns (bytes32)',
  'function approvedEnableDigests(address kernel, bytes32 digest) view returns (bool)',
  'function agentInfo(address kernel) view returns (AgentInfo)',
  'function isRegistered(address kernel) view returns (bool)',
  'function dormantAt(address kernel) view returns (uint256)',
  'function entryPoint() view returns (address)',
  'event SessionKeyApproved(address indexed kernel, bytes21 indexed validationId, uint32 nonce, bytes32 digest, bytes validatorData)',
  'event AgentPaused(address indexed kernel, bool paused)',
  'event Activity(address indexed kernel, uint64 timestamp)',
]);

export const launcherAbi = parseAbi([
  'struct LaunchDefaults { uint24 lpFeeBps; uint16 agentBps; uint16 creatorBps; uint16 burnBps; uint16 platformBps; address platformRecipient; uint256 minFuelUsdc; uint32 dormancyPeriod; }',
  'event AgentLaunched(address indexed token, address indexed kernel, address indexed creator, address burner, uint256 agentId, LaunchDefaults defaults, bytes32 workerHash, string model, string agentURI, address supervisorSessionKey)',
]);

export const agentLaunchedEvent = launcherAbi[0];

/**
 * Clanker v4 `TokenCreated` (apps/indexer/abis/Clanker.ts, generated from clanker v4-contracts). Emitted by the
 * Clanker factory inside the launch tx; `tokenContext` carries the Bootr launch form's
 * `{"interface":"Bootr","platform":"bootr.fun","id":"<draft uuid>"}`.
 */
export const clankerTokenCreatedEvent = parseAbi([
  'event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)',
])[0];

export const kernelAbi = parseAbi([
  'struct ValidationConfig { uint32 nonce; address hook; }',
  'function currentNonce() view returns (uint32)',
  'function validNonceFrom() view returns (uint32)',
  'function rootValidator() view returns (bytes21)',
  'function validationConfig(bytes21 vId) view returns (ValidationConfig)',
  'function isAllowedSelector(bytes21 vId, bytes4 selector) view returns (bool)',
  'function execute(bytes32 execMode, bytes executionCalldata) payable',
  'function executeUserOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp, bytes32 userOpHash) payable',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);

export const feeLockerAbi = parseAbi([
  'function claim(address feeOwner, address token)',
  'function availableFees(address feeOwner, address token) view returns (uint256)',
]);

export const universalRouterAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);

export const chainlinkAggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

/** Kernel v3.1 selectors used in call data and policy allow-lists. */
export const KERNEL_EXECUTE_SELECTOR = '0xe9ae5c53' as const;
export const KERNEL_EXECUTE_USER_OP_SELECTOR = '0x8dd7712f' as const;
/** UniversalRouter.execute(bytes,bytes[],uint256) */
export const UNIVERSAL_ROUTER_EXECUTE_SELECTOR = '0x3593564c' as const;
