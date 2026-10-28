// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "./IUniswapV4.sol";

/// @dev Subset of the RWAGMI v3 launcher stack (Base mainnet, verified on Basescan) that Bootr calls.
///      Struct layouts mirror `IRwagmiB20LauncherV3` / `IRwagmiB20Launcher` / `IRwagmiLpLockerV3`
///      exactly (ABI compatibility); `PoolId` is `bytes32`.

/// @dev Base B20Factory precompile (`0xB20f0000…0000`).
interface IB20Factory {
    function getB20Address(uint8 variant, address creator, bytes32 salt) external view returns (address);
}

interface IRwagmiB20Launcher {
    enum B20Variant {
        Asset,
        Stablecoin
    }

    enum AdminMode {
        Immutable,
        Admin
    }

    struct B20Config {
        B20Variant variant;
        bytes32 salt;
        bytes params;
        bytes[] initCalls;
        string name;
        string symbol;
        uint8 decimals;
        address initialAdmin;
        uint256 originatingChainId;
    }
}

interface IRwagmiB20LauncherV3 {
    enum FeeMode {
        Static,
        Dynamic
    }

    enum LaunchState {
        Unknown,
        Bootstrapping,
        Complete
    }

    /// @dev `RwagmiDynamicFeeV3.Config`
    struct DynamicFeeConfig {
        uint24 baseFee;
        uint24 maxLpFee;
        uint32 feeControlNumerator;
        uint32 referenceTickFilterPeriod;
        uint32 resetPeriod;
        uint16 decayFilterBps;
    }

    struct HookFeeConfig {
        FeeMode mode;
        uint24 staticFee;
        DynamicFeeConfig dynamicConfig;
    }

    struct PositionConfig {
        int24 tickLower;
        int24 tickUpper;
        uint16 positionBps;
    }

    struct RewardSlotConfig {
        address admin;
        address recipient;
        uint16 bps;
    }

    struct PoolAllocation {
        address pairedToken;
        uint16 allocationBps;
        int24 tickIfToken0IsB20;
        int24 tickSpacing;
        HookFeeConfig fee;
        PositionConfig[] positions;
    }

    struct ExtensionConfigV3 {
        address extension;
        uint8 poolIndex;
        uint256 msgValue;
        bytes data;
    }

    struct LaunchConfigV3 {
        IRwagmiB20Launcher.B20Config b20Config;
        IRwagmiB20Launcher.AdminMode adminMode;
        uint256 liquiditySupply;
        RewardSlotConfig[] creatorRewards;
        PoolAllocation[] pools;
        uint8 primaryPoolIndex;
        ExtensionConfigV3[] extensions;
        uint256 deadline;
    }

    struct DeploymentInfoV3 {
        address token;
        address creator;
        address hook;
        address locker;
        bytes32 primaryPoolId;
        bytes32[] poolIds;
        IRwagmiB20Launcher.AdminMode adminMode;
        LaunchState state;
    }

    event B20LaunchCreatedV3(
        address indexed creator,
        address indexed token,
        address tokenAdmin,
        string name,
        string symbol,
        uint8 decimals,
        IRwagmiB20Launcher.AdminMode adminMode,
        address hook,
        address locker,
        uint256 totalSupply,
        uint256 liquiditySupply,
        uint256 extensionSupply,
        bytes32 primaryPoolId,
        uint8 poolCount,
        bytes32 rewardConfigurationHash,
        uint64 launchTimestamp
    );
    event LaunchPoolCreatedV3(
        address indexed token,
        bytes32 indexed poolId,
        uint8 poolIndex,
        PoolKey key,
        uint16 allocationBps,
        uint256 allocatedSupply,
        uint256 depositedSupply,
        uint256 lockedRemainder,
        int24 startingTick,
        HookFeeConfig fee
    );

    function launchB20(LaunchConfigV3 calldata config)
        external
        payable
        returns (address token, bytes32[] memory poolIds);
    function deploymentInfo(address token) external view returns (DeploymentInfoV3 memory);
    function b20Factory() external view returns (address);
    function hook() external view returns (address);
    function locker() external view returns (address);
    function pairedTokenEnabled(address pair) external view returns (bool);
    function extensionEnabled(address extension) external view returns (bool);
    function deprecated() external view returns (bool);
}

interface IRwagmiLpLockerV3 {
    struct LaunchInfo {
        bytes32[] poolIds;
        IRwagmiB20LauncherV3.RewardSlotConfig[] rewards;
        bool complete;
    }

    event PoolFeesSettledV3(
        bytes32 indexed poolId, address indexed currency, uint256 slot, address indexed recipient, uint256 amount
    );
    event QuoteRewardsClaimedV3(address indexed recipient, address indexed currency, address indexed to, uint256 amount);

    /// @notice Settles `ids` (credits each slot's share of the hook's cumulative fee) and pays the caller's
    ///         whole `currency` balance to `to`. Claims belong to `msg.sender`: a recipient claims for itself.
    function settleAndClaim(bytes32[] calldata ids, address currency, address to) external returns (uint256);
    function claimQuote(address currency, address to) external returns (uint256);
    function settle(bytes32 id) external;
    /// @notice Fees already settled and claimable by `recipient` in `currency`.
    function claimableQuote(address recipient, address currency) external view returns (uint256);
    /// @notice Fees taken by the hook on pool `id` not yet settled into `recipient`'s balance.
    function pendingQuote(bytes32 id, address recipient) external view returns (uint256);
    function launchInfo(address token) external view returns (LaunchInfo memory);
    function launcher() external view returns (address);
    function hook() external view returns (address);
    /// @dev Slot admin only. BootrLauncher is every Bootr slot's admin and never calls these.
    function updateRewardRecipient(address token, uint256 slot, address recipient) external;
    function updateRewardAdmin(address token, uint256 slot, address admin) external;
}

interface IRwagmiHookV3 {
    event PoolFeeTakenV3(bytes32 indexed poolId, address indexed quote, uint256 amount, uint8 swapCase, uint24 rate);

    function cumulativeFees(bytes32 id) external view returns (uint256);
    function currentFee(bytes32 id) external view returns (uint24);
}

/// @dev `RwagmiEthDevBuyV3.execute` data: `abi.encode(address recipient, uint128 minimumOut)`; `minimumOut > 0`.
interface IRwagmiEthDevBuyV3 {
    event DevBuyExecutedV3(
        address indexed token,
        bytes32 indexed poolId,
        address indexed recipient,
        uint256 amountIn,
        uint256 amountOut,
        uint256 refundWeth
    );
}
