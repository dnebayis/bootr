// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "./IUniswapV4.sol";

/// @dev Minimal vendored interfaces of Clanker v4 (github.com/clanker-devco/v4-contracts).
interface IClanker {
    struct TokenConfig {
        address tokenAdmin;
        string name;
        string symbol;
        bytes32 salt;
        string image;
        string metadata;
        string context;
        uint256 originatingChainId;
    }

    struct PoolConfig {
        address hook;
        address pairedToken;
        int24 tickIfToken0IsClanker;
        int24 tickSpacing;
        bytes poolData;
    }

    struct LockerConfig {
        address locker;
        address[] rewardAdmins;
        address[] rewardRecipients;
        uint16[] rewardBps;
        int24[] tickLower;
        int24[] tickUpper;
        uint16[] positionBps;
        bytes lockerData;
    }

    struct ExtensionConfig {
        address extension;
        uint256 msgValue;
        uint16 extensionBps;
        bytes extensionData;
    }

    struct MevModuleConfig {
        address mevModule;
        bytes mevModuleData;
    }

    struct DeploymentConfig {
        TokenConfig tokenConfig;
        PoolConfig poolConfig;
        LockerConfig lockerConfig;
        MevModuleConfig mevModuleConfig;
        ExtensionConfig[] extensionConfigs;
    }

    struct DeploymentInfo {
        address token;
        address hook;
        address locker;
        address[] extensions;
    }

    function deployToken(DeploymentConfig memory deploymentConfig) external payable returns (address tokenAddress);
    function tokenDeploymentInfo(address token) external view returns (DeploymentInfo memory);
    function deprecated() external view returns (bool);
    function enabledLockers(address locker, address hook) external view returns (bool);
}

interface IClankerToken {
    function admin() external view returns (address);
    function originalAdmin() external view returns (address);
    function imageUrl() external view returns (string memory);
    function metadata() external view returns (string memory);
    function context() external view returns (string memory);
}

interface IClankerLpLocker {
    struct TokenRewardInfo {
        address token;
        PoolKey poolKey;
        uint256 positionId;
        uint256 numPositions;
        uint16[] rewardBps;
        address[] rewardAdmins;
        address[] rewardRecipients;
    }

    function tokenRewards(address token) external view returns (TokenRewardInfo memory);
    function collectRewards(address token) external;
    function updateRewardRecipient(address token, uint256 rewardIndex, address newRecipient) external;
    function updateRewardAdmin(address token, uint256 rewardIndex, address newAdmin) external;
}

/// @dev ClankerLpLockerFeeConversion: the locker enabled for the V2 hooks. `lockerData` must be
/// `abi.encode(LpFeeConversionInfo)` with exactly one preference per reward recipient.
interface IClankerLpLockerFeeConversion is IClankerLpLocker {
    enum FeeIn {
        Both,
        Paired,
        Clanker
    }

    struct LpFeeConversionInfo {
        FeeIn[] feePreference;
    }

    function feePreferences(address token, uint256 index) external view returns (FeeIn);
    function updateFeePreference(address token, uint256 rewardIndex, FeeIn newFeePreference) external;
}

interface IClankerFeeLocker {
    function claim(address feeOwner, address token) external;
    function availableFees(address feeOwner, address token) external view returns (uint256);
}

interface IClankerHookStaticFee {
    struct PoolStaticConfigVars {
        uint24 clankerFee;
        uint24 pairedFee;
    }

    function clankerFee(bytes32 poolId) external view returns (uint24);
    function pairedFee(bytes32 poolId) external view returns (uint24);
}

interface IClankerHookV2 {
    struct PoolInitializationData {
        address extension;
        bytes extensionData;
        bytes feeData;
    }

    function mevModuleEnabled(bytes32 poolId) external view returns (bool);
    function poolCreationTimestamp(bytes32 poolId) external view returns (uint256);
    function MAX_LP_FEE() external view returns (uint24);
    function MAX_MEV_MODULE_DELAY() external view returns (uint256);
    function locker(bytes32 poolId) external view returns (address);
}

interface IClankerUniv4EthDevBuy {
    struct Univ4EthDevBuyExtensionData {
        PoolKey pairedTokenPoolKey;
        uint128 pairedTokenAmountOutMinimum;
        address recipient;
    }
}
