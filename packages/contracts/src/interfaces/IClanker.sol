// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "./IUniswapV4.sol";

/// @dev Minimal vendored interfaces of Clanker v4 (github.com/clanker-devco/v4-contracts). Restored from commit
///      390468e (Bootr launcher v1 / v1.1) and re-checked on 2026-11-04 against the verified sources of the Base
///      mainnet deployment (Sourcify, chain 8453): `Clanker` v4.0.0 `0xE85A59c628F7d27878ACeB4bf3b35733630083a9`
///      (`src/interfaces/IClanker.sol`, `src/interfaces/IClankerLpLocker.sol`), `ClankerHookStaticFeeV2`
///      `0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC` (`IClankerHookV2`, `IClankerHookStaticFee`),
///      `ClankerUniv4EthDevBuy` `0x1331f0788F9c08C8F38D52c7a1152250A9dE00be`, `ClankerSniperAuctionV2`
///      `0xebB25BB797D82CB78E1bc70406b13233c0854413` (`IClankerMevDescendingFees.FeeConfig`) and the fee locker
///      `0xF3622742b1E446D92e45E22923Ef11C2fcD55D68` (verified as `CornersFeeLocker`, same ABI as
///      `ClankerFeeLocker`). `ClankerLpLockerFeeConversion` `0xffA37784D619F228D8B379d287a4D7282e500762` is not
///      source-verified on Sourcify; its structs come from the repository's `src/lp-lockers/` and are exercised on
///      the fork (`test/fork/ClankerFork.t.sol`). Every struct below is field-for-field the verified one.
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

    error Deprecated();
    error HookNotEnabled();
    error LockerNotEnabled();
    error ExtensionNotEnabled();
    error MevModuleNotEnabled();

    event TokenCreated(
        address msgSender,
        address indexed tokenAddress,
        address indexed tokenAdmin,
        string tokenImage,
        string tokenName,
        string tokenSymbol,
        string tokenMetadata,
        string tokenContext,
        int24 startingTick,
        address poolHook,
        bytes32 poolId,
        address pairedToken,
        address locker,
        address mevModule,
        uint256 extensionsSupply,
        address[] extensions
    );
    event SetHook(address hook, bool enabled);
    event SetExtension(address extension, bool enabled);
    event SetMevModule(address mevModule, bool enabled);
    event SetLocker(address locker, address hook, bool enabled);

    /// @dev Checks, in order: `deprecated`, `originatingChainId == block.chainid`, extensions, `msg.value ==
    ///      sum(extension.msgValue)`, `enabledHooks`, `enabledLockers[locker][hook]`, `enabledExtensions`,
    ///      `enabledMevModules`. No `msg.sender` restriction. Token (CREATE2, salt `keccak(tokenAdmin, salt)`) ->
    ///      pool init -> liquidity into the locker -> extensions -> MEV module init.
    function deployToken(DeploymentConfig memory deploymentConfig) external payable returns (address tokenAddress);
    function tokenDeploymentInfo(address token) external view returns (DeploymentInfo memory);
    function deprecated() external view returns (bool);
    function teamFeeRecipient() external view returns (address);
    /// @dev The only public allowlist; `enabledHooks`, `enabledExtensions` and `enabledMevModules` are private
    ///      mappings (storage slots 5, 7 and 8 of the factory, read with `vm.load` in the fork test).
    function enabledLockers(address locker, address hook) external view returns (bool);
    function TOKEN_SUPPLY() external view returns (uint256);
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

    event ClaimedRewards(
        address indexed token, uint256 amount0, uint256 amount1, uint256[] rewards0, uint256[] rewards1
    );

    function tokenRewards(address token) external view returns (TokenRewardInfo memory);
    /// @dev Permissionless. Skipped (returns without collecting) while the pool's MEV module is operating.
    function collectRewards(address token) external;
    function updateRewardRecipient(address token, uint256 rewardIndex, address newRecipient) external;
    function updateRewardAdmin(address token, uint256 rewardIndex, address newAdmin) external;
}

/// @dev ClankerLpLockerFeeConversion: the locker enabled for the V2 hooks. `lockerData` must be
///      `abi.encode(LpFeeConversionInfo)` with exactly one preference per reward recipient. `Paired` swaps the
///      recipient's coin share into the paired token, `Clanker` swaps its paired share into the coin (both with
///      `amountOutMinimum: 0`), `Both` leaves each side as collected. Limits on-chain: `MAX_REWARD_PARTICIPANTS = 7`,
///      `MAX_LP_POSITIONS = 7`, bps sum to 10_000, no zero bps or zero address, `tickLower >= tickIfToken0IsClanker`.
interface IClankerLpLockerFeeConversion is IClankerLpLocker {
    enum FeeIn {
        Both,
        Paired,
        Clanker
    }

    struct LpFeeConversionInfo {
        FeeIn[] feePreference;
    }

    event FeesSwapped(
        address indexed token,
        address indexed rewardToken,
        uint256 amountSwapped,
        address indexed swappedToken,
        uint256 amountOut
    );

    function feePreferences(address token, uint256 index) external view returns (FeeIn);
    function updateFeePreference(address token, uint256 rewardIndex, FeeIn newFeePreference) external;
    function MAX_REWARD_PARTICIPANTS() external view returns (uint256);
    function feeLocker() external view returns (address);
}

/// @dev ClankerFeeLocker: `claim(feeOwner, token)` is callable by anyone and always pays `feeOwner`; reverts
///      `NoFeesToClaim` on a zero balance.
interface IClankerFeeLocker {
    event ClaimTokens(address indexed feeOwner, address indexed token, uint256 amountClaimed);

    function claim(address feeOwner, address token) external;
    function availableFees(address feeOwner, address token) external view returns (uint256);
    function allowedDepositors(address depositor) external view returns (bool);
}

interface IClankerHookStaticFee {
    struct PoolStaticConfigVars {
        uint24 clankerFee;
        uint24 pairedFee;
    }

    function clankerFee(bytes32 poolId) external view returns (uint24);
    function pairedFee(bytes32 poolId) external view returns (uint24);
}

/// @dev ClankerHookV2 (static and dynamic variants). The pool key's `fee` is `LPFeeLibrary.DYNAMIC_FEE_FLAG`; the
///      hook charges `PROTOCOL_FEE_NUMERATOR = 200_000` (20% of the LP fee) on top of it for the factory.
interface IClankerHookV2 {
    struct PoolInitializationData {
        address extension;
        bytes extensionData;
        bytes feeData;
    }

    function mevModuleEnabled(bytes32 poolId) external view returns (bool);
    function mevModule(bytes32 poolId) external view returns (address);
    function poolCreationTimestamp(bytes32 poolId) external view returns (uint256);
    function MAX_LP_FEE() external view returns (uint24);
    function MAX_MEV_LP_FEE() external view returns (uint24);
    function MAX_MEV_MODULE_DELAY() external view returns (uint256);
    function PROTOCOL_FEE_NUMERATOR() external view returns (uint256);
    function locker(bytes32 poolId) external view returns (address);
    function clankerIsToken0(bytes32 poolId) external view returns (bool);
}

/// @dev ClankerUniv4EthDevBuy. With a WETH-paired pool `pairedTokenPoolKey` and `pairedTokenAmountOutMinimum` are
///      unused (the extension wraps ETH and swaps into the coin with `amountOutMinimum = 1`); the pool is created
///      in the same transaction, so nothing can front-run the buy.
interface IClankerUniv4EthDevBuy {
    struct Univ4EthDevBuyExtensionData {
        PoolKey pairedTokenPoolKey;
        uint128 pairedTokenAmountOutMinimum;
        address recipient;
    }
}

/// @dev ClankerSniperAuctionV2 / ClankerMevDescendingFees: `mevModuleData = abi.encode(FeeConfig)`. Checks on
///      initialize: `secondsToDecay > 0`, `startingFee > 0`, `startingFee > endingFee`, `startingFee <= hook
///      MAX_MEV_LP_FEE` (800_000), `secondsToDecay <= hook MAX_MEV_MODULE_DELAY` (120 s). Swaps before the first
///      auction block (2 blocks after the deploy) revert `NotAuctionBlock`; the module expires after the delay.
interface IClankerMevDescendingFees {
    struct FeeConfig {
        uint24 startingFee;
        uint24 endingFee;
        uint256 secondsToDecay;
    }

    function getFee(bytes32 poolId) external view returns (uint24);
}
