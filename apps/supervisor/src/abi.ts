import { parseAbi, toFunctionSelector } from 'viem';

/**
 * Hand-written minimal ABIs (kept in sync with packages/contracts/src), plus the RWAGMI v3 ABIs vendored verbatim
 * from the SDK (`src/abis/`, see docs/rwagmi-migration.md).
 */
export { rwagmiLauncherV3Abi } from './abis/rwagmi-launcher-v3.js';
export { rwagmiLpLockerV3Abi } from './abis/rwagmi-lp-locker-v3.js';

export const guardianAbi = parseAbi([
  'struct AgentInfo { address token; address creator; uint64 lastActivity; uint32 dormancyPeriod; bool paused; }',
  'function approveSessionKey(address kernel, bytes4 permissionId, bytes validatorData) returns (bytes32 digest, uint32 nonce)',
  'function revokeSessionKeyApproval(address kernel, bytes32 digest)',
  'function revokeSessionKey(address kernel, bytes4 permissionId, bytes deinitData)',
  'function revokeAllSessionKeys(address kernel) returns (uint32 nonce)',
  'function revokeAllSessionKeysBatch(address[] kernels) returns (uint32[] nonces)',
  'function approvedDigestOf(address kernel, bytes21 vId) view returns (bytes32)',
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
 * `BootrLauncher.LaunchContext` (BootrLauncher v2): emitted in the launch tx right after `AgentLaunched`; `context`
 * is the Bootr launch form's `{"interface":"Bootr","platform":"bootr.fun","id":"<draft uuid>"}` string (it used to
 * travel in Clanker's `TokenCreated.tokenContext`; the RWAGMI `B20LaunchCreatedV3` event carries no context).
 */
export const launchContextEvent = parseAbi(['event LaunchContext(address indexed token, string context)'])[0];

/**
 * `BootrClankerLauncher.ClankerLaunched` (docs/design/clanker-launch.md section 2): emitted in the launch tx next to
 * the identical `AgentLaunched`, so the pool and locker details need no decoding of Clanker's `TokenCreated`.
 * `poolId` is the Uniswap v4 pool id, `hook` the Clanker static-fee hook, `locker` the `ClankerLpLockerFeeConversion`
 * the positions sit in, `lpFeeBps` the LP fee in bps (same unit as `LaunchDefaults.lpFeeBps`).
 */
export const clankerLaunchedEvent = parseAbi(['event ClankerLaunched(address indexed token, bytes32 poolId, address hook, address locker, address mevModule, int24 startingTick, uint24 lpFeeBps)'])[0];

/**
 * Clanker v4 `ClankerFeeLocker` (`0xF3622742…` on Base, docs/design/clanker-launch.md section 1; restored from the
 * Clanker-era supervisor at commit 390468e). `claim(feeOwner, token)` is callable by anyone and always pays
 * `feeOwner`; `availableFees(feeOwner, token)` is the balance deposited by the LP locker so far.
 */
export const clankerFeeLockerAbi = parseAbi([
  'function claim(address feeOwner, address token)',
  'function availableFees(address feeOwner, address token) view returns (uint256)',
  'function feesToClaim(address feeOwner, address token) view returns (uint256 balance)',
  'event ClaimTokens(address indexed feeOwner, address indexed token, uint256 amountClaimed)',
]);

/**
 * Clanker v5 `FeeEscrow` (`0x5dd237d1…FA61` on Base, docs/design/clanker-v5-migration.md section 1): one balance per
 * recipient and currency across every v5 pool. `owed(recipient, currency)` is that balance; `claimFor(recipient,
 * currency)` is callable by anyone and always pays `recipient` (native ETH when `currency == 0x0`), reverting
 * `NothingToClaim` on zero.
 */
export const clankerV5FeeEscrowAbi = parseAbi([
  'function owed(address recipient, address currency) view returns (uint256)',
  'function claimFor(address recipient, address currency)',
  'event Claimed(address indexed recipient, address indexed currency, address indexed destination, uint256 amount)',
]);

/**
 * `BootrClankerLauncherV5.ClankerV5Launched` (packages/contracts/src/BootrClankerLauncherV5.sol), emitted next to
 * `AgentLaunched`: the v5 pool, hook, escrow, quote and tax of the coin.
 */
export const clankerV5LaunchedEvent = parseAbi(['event ClankerV5Launched(address indexed token, bytes32 poolId, address hook, address feeEscrow, address quoteToken, int24 tickSpacing, uint24 taxBps, bool antiSnipe)'])[0];

/**
 * Clanker v4 `ClankerLpLockerFeeConversion` (`0xffA37784…` on Base). `collectRewards(token)` (permissionless)
 * collects the LP positions' fees, converts each recipient's share per its fee preference and deposits it into the
 * fee locker; `tokenRewards(token)` lists the positions and recipients (the view part is vendored from the Clanker
 * ABI at 390468e:apps/indexer/abis/ClankerLpLockerFeeConversion.ts).
 */
export const clankerLpLockerAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct TokenRewardInfo { address token; PoolKey poolKey; uint256 positionId; uint256 numPositions; uint16[] rewardBps; address[] rewardAdmins; address[] rewardRecipients; }',
  'function collectRewards(address token)',
  'function tokenRewards(address token) view returns (TokenRewardInfo)',
  'event ClaimedRewards(address indexed token, uint256 amount0, uint256 amount1, uint256[] rewards0, uint256[] rewards1)',
]);

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

/** BootrSwapHelper (packages/contracts/src/BootrSwapHelper.sol). */
export const swapHelperAbi = parseAbi([
  'function swapWethToUsdc(uint256 amountIn, uint256 maxSlippageBps) returns (uint256 amountOut)',
  'function minUsdcOut(uint256 amountIn, uint256 maxSlippageBps) view returns (uint256)',
  'function ethUsdPrice() view returns (uint256)',
  'function MAX_SLIPPAGE_BPS() view returns (uint256)',
]);

/** BootrCallPolicy (packages/contracts/src/BootrCallPolicy.sol): window state of a SUM_PER_WINDOW argument. */
export const callPolicyAbi = parseAbi([
  'function windowOf(bytes32 id, address kernel, uint256 ruleIndex, uint256 argIndex) view returns (uint48 windowEnd, uint128 spent, uint32 windowSeconds, uint256 cap)',
  'function installed(bytes32 id, address kernel) view returns (bool)',
]);

export const chainlinkAggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

/** Kernel v3.1 selectors used in call data and policy allow-lists. */
export const KERNEL_EXECUTE_SELECTOR = '0xe9ae5c53' as const;
export const KERNEL_EXECUTE_USER_OP_SELECTOR = '0x8dd7712f' as const;
/** ERC20.approve(address,uint256) */
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3' as const;
/** WETH9.withdraw(uint256 wad): unwraps the kernel's WETH into ETH held by the kernel (its gas; see gas.ts). */
export const WETH_WITHDRAW_SELECTOR = toFunctionSelector('withdraw(uint256)');
/** BootrSwapHelper.swapWethToUsdc(uint256,uint256) */
export const SWAP_HELPER_SWAP_SELECTOR = toFunctionSelector('swapWethToUsdc(uint256,uint256)');
/** RwagmiLpLockerV3.settleAndClaim(bytes32[] ids, address currency, address to): settles the pools' fees and pays `to`. */
export const LOCKER_SETTLE_AND_CLAIM_SELECTOR = toFunctionSelector('settleAndClaim(bytes32[],address,address)');
/** RwagmiLpLockerV3.claimQuote(address currency, address to): pays the caller's already settled balance to `to`. */
export const LOCKER_CLAIM_QUOTE_SELECTOR = toFunctionSelector('claimQuote(address,address)');
/** ClankerLpLockerFeeConversion.collectRewards(address token): collects the positions' fees into the fee locker (anyone may call). */
export const CLANKER_LOCKER_COLLECT_REWARDS_SELECTOR = toFunctionSelector('collectRewards(address)');
/** ClankerFeeLocker.claim(address feeOwner, address token): pays `feeOwner`'s balance of `token` to `feeOwner`, whoever calls. */
export const CLANKER_FEE_LOCKER_CLAIM_SELECTOR = toFunctionSelector('claim(address,address)');
/** Clanker v5 FeeEscrow.claimFor(address recipient, address currency) = `0xb4ba9e11`: pays `recipient`'s whole balance to `recipient`, whoever calls. */
export const CLANKER_V5_ESCROW_CLAIM_FOR_SELECTOR = toFunctionSelector('claimFor(address,address)');
/** BootrSwapHelper.MAX_SLIPPAGE_BPS: the contract refuses a higher requested slippage. */
export const SWAP_MAX_SLIPPAGE_BPS = 300;
