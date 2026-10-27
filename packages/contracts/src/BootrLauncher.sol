// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MinimalClones} from "./lib/MinimalClones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {AgentGuardian} from "./AgentGuardian.sol";
import {BuybackBurner} from "./BuybackBurner.sol";
import {
    IClanker,
    IClankerHookStaticFee,
    IClankerHookV2,
    IClankerLpLockerFeeConversion,
    IClankerUniv4EthDevBuy
} from "./interfaces/IClanker.sol";
import {IERC8004IdentityRegistry} from "./interfaces/IERC8004IdentityRegistry.sol";
import {IKernel, IKernelFactory, KernelLib} from "./interfaces/IKernel.sol";
import {PoolKey, V4Constants} from "./interfaces/IUniswapV4.sol";

/// @title BootrLauncher
/// @notice One-transaction launch of an AI-agent coin on Base:
///         Kernel v3.1 treasury (root = AgentGuardian) -> optional BuybackBurner clone ->
///         Clanker v4 token + Uniswap v4 pool (static-fee hook V2, locked LP in the
///         ClankerLpLockerFeeConversion locker) -> ERC-8004 identity transferred to the kernel ->
///         USDC fuel pulled into the kernel -> guardian registration.
///
///         Immutability of the fee split: every `rewardAdmins[i]` is this contract, and this
///         contract exposes NO function that calls `updateRewardRecipient`, `updateRewardAdmin`
///         or `updateFeePreference` on the locker, so recipients, bps and fee preferences can never
///         change after launch. The same holds for the token: `tokenAdmin` is this contract and no
///         function calls `updateAdmin` / `updateImage` / `updateMetadata` on the token, so the
///         creator (or anyone) cannot rewrite the coin's metadata after launch.
contract BootrLauncher is Ownable2Step, Pausable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct LaunchDefaults {
        uint24 lpFeeBps; // 1e6-based like Clanker (10_000 = 1%)
        uint16 agentBps;
        uint16 creatorBps;
        uint16 burnBps;
        uint16 platformBps;
        address platformRecipient;
        uint256 minFuelUsdc;
        uint32 dormancyPeriod;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string image;
        string metadata;
        string context;
        bytes32 salt;
        bool buybackBurn;
        uint256 fuelUsdc;
        uint256 devBuyWei;
        bytes32 workerHash;
        string model;
        string agentURI;
        address supervisorSessionKey; // informational; installed later via AgentGuardian.approveSessionKey
    }

    struct Deps {
        address clanker;
        address feeLocker;
        address lpLocker; // ClankerLpLockerFeeConversion
        address staticHook; // ClankerHookStaticFeeV2
        address devBuyExtension; // ClankerUniv4EthDevBuy
        address mevModule; // ClankerMevBlockDelay
        address weth;
        address usdc;
        address identityRegistry; // ERC-8004
        address kernelFactory; // ZeroDev KernelFactory (Kernel v3.1)
        address guardian; // AgentGuardian
        address burnerImplementation; // BuybackBurner
        address universalRouter;
        address permit2;
    }

    // ------------------------------------------------------------------
    // Constants: Clanker pool parameters (clanker.world "Standard" preset)
    // ------------------------------------------------------------------

    uint16 public constant BPS = 10_000;
    uint24 public constant MAX_LP_FEE = 100_000; // hook cap, 10%
    uint32 public constant MIN_DORMANCY_PERIOD = 30 days;
    int24 public constant TICK_SPACING = 200;
    /// @dev Starting tick as if the coin is token0: price 1.0001^-230400 ~= 9.9e-11 WETH per token,
    ///      i.e. ~10 ETH fully diluted for the 100B supply (what clanker.world launches at).
    int24 public constant STARTING_TICK = -230_400;
    /// @dev Single position from the starting tick up to -120_000 (~62,000x). Liquidity is 100% coin
    ///      (one-sided) at launch, so no tick below the starting tick is needed.
    int24 public constant POSITION_TICK_UPPER = -120_000;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    IClanker public immutable clanker;
    address public immutable feeLocker;
    address public immutable lpLocker;
    address public immutable staticHook;
    address public immutable devBuyExtension;
    address public immutable mevModule;
    address public immutable weth;
    IERC20 public immutable usdc;
    IERC8004IdentityRegistry public immutable identityRegistry;
    IKernelFactory public immutable kernelFactory;
    AgentGuardian public immutable guardian;
    address public immutable burnerImplementation;
    address public immutable universalRouter;
    address public immutable permit2;
    bytes21 public immutable ROOT_VALIDATION_ID;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    LaunchDefaults public standardDefaults;
    LaunchDefaults public buybackDefaults;
    uint16 public minPlatformBps;

    // ------------------------------------------------------------------
    // Events / errors
    // ------------------------------------------------------------------

    event AgentLaunched(
        address indexed token,
        address indexed kernel,
        address indexed creator,
        address burner,
        uint256 agentId,
        LaunchDefaults defaults,
        bytes32 workerHash,
        string model,
        string agentURI,
        address supervisorSessionKey
    );
    event DefaultsUpdated(bool indexed buyback, LaunchDefaults defaults);
    event MinPlatformBpsUpdated(uint16 minPlatformBps);

    error ZeroAddress();
    error InvalidBpsSum();
    error ZeroBps();
    error BurnBpsMismatch();
    error PlatformBpsBelowMinimum();
    error InvalidLpFee();
    error InvalidDormancyPeriod();
    error InvalidMinPlatformBps();
    error InsufficientValue();
    error InsufficientFuel();
    error EmptyNameOrSymbol();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(
        address owner_,
        Deps memory deps,
        LaunchDefaults memory standard,
        LaunchDefaults memory buyback,
        uint16 minPlatformBps_
    ) Ownable(owner_) {
        if (
            deps.clanker == address(0) || deps.feeLocker == address(0) || deps.lpLocker == address(0)
                || deps.staticHook == address(0) || deps.devBuyExtension == address(0) || deps.mevModule == address(0)
                || deps.weth == address(0) || deps.usdc == address(0) || deps.identityRegistry == address(0)
                || deps.kernelFactory == address(0) || deps.guardian == address(0)
                || deps.burnerImplementation == address(0) || deps.universalRouter == address(0)
                || deps.permit2 == address(0)
        ) revert ZeroAddress();

        clanker = IClanker(deps.clanker);
        feeLocker = deps.feeLocker;
        lpLocker = deps.lpLocker;
        staticHook = deps.staticHook;
        devBuyExtension = deps.devBuyExtension;
        mevModule = deps.mevModule;
        weth = deps.weth;
        usdc = IERC20(deps.usdc);
        identityRegistry = IERC8004IdentityRegistry(deps.identityRegistry);
        kernelFactory = IKernelFactory(deps.kernelFactory);
        guardian = AgentGuardian(deps.guardian);
        burnerImplementation = deps.burnerImplementation;
        universalRouter = deps.universalRouter;
        permit2 = deps.permit2;
        ROOT_VALIDATION_ID = KernelLib.validatorId(deps.guardian);

        if (minPlatformBps_ > BPS) revert InvalidMinPlatformBps();
        minPlatformBps = minPlatformBps_;
        _setDefaults(false, standard);
        _setDefaults(true, buyback);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Update the defaults used by FUTURE launches. Existing launches are unaffected.
    function setDefaults(bool buyback, LaunchDefaults calldata d) external onlyOwner {
        _setDefaults(buyback, d);
    }

    function setMinPlatformBps(uint16 minPlatformBps_) external onlyOwner {
        if (minPlatformBps_ > BPS) revert InvalidMinPlatformBps();
        minPlatformBps = minPlatformBps_;
        emit MinPlatformBpsUpdated(minPlatformBps_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------
    // Launch
    // ------------------------------------------------------------------

    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (address token, address kernel, address burner, uint256 agentId)
    {
        if (msg.value < p.devBuyWei) revert InsufficientValue();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert EmptyNameOrSymbol();
        LaunchDefaults memory d = p.buybackBurn ? buybackDefaults : standardDefaults;
        if (p.fuelUsdc < d.minFuelUsdc) revert InsufficientFuel();

        address creator = msg.sender;
        bytes32 salt = keccak256(abi.encode(creator, p.salt));

        // (a) agent treasury: Kernel v3.1 with root validator + hook = guardian
        kernel = kernelFactory.createAccount(_kernelInitData(), salt);

        // (b) optional buyback burner clone
        if (p.buybackBurn) {
            burner = MinimalClones.cloneDeterministic(burnerImplementation, salt);
        }

        // (c)+(d) Clanker deployment
        token = clanker.deployToken{value: p.devBuyWei}(_buildConfig(p, d, creator, kernel, burner, salt));
        if (burner != address(0)) {
            BuybackBurner(burner).initialize(
                token, weth, feeLocker, poolKeyFor(token), universalRouter, permit2, address(this)
            );
        }

        // (e) ERC-8004 identity: minted to this contract, handed to the kernel
        agentId = identityRegistry.register(p.agentURI);
        identityRegistry.transferFrom(address(this), kernel, agentId);

        // (f) fuel
        if (p.fuelUsdc > 0) {
            usdc.safeTransferFrom(creator, kernel, p.fuelUsdc);
        }

        // (g) guardian registration
        guardian.registerAgent(kernel, token, creator, d.dormancyPeriod);

        // (h)
        emit AgentLaunched(
            token, kernel, creator, burner, agentId, d, p.workerHash, p.model, p.agentURI, p.supervisorSessionKey
        );

        uint256 refund = msg.value - p.devBuyWei;
        if (refund > 0) {
            Address.sendValue(payable(creator), refund);
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function predictKernel(address creator, bytes32 salt) external view returns (address) {
        return kernelFactory.getAddress(_kernelInitData(), keccak256(abi.encode(creator, salt)));
    }

    function predictBurner(address creator, bytes32 salt) external view returns (address) {
        return MinimalClones.predictDeterministicAddress(
            burnerImplementation, keccak256(abi.encode(creator, salt)), address(this)
        );
    }

    function poolKeyFor(address token) public view returns (PoolKey memory key) {
        (address c0, address c1) = token < weth ? (token, weth) : (weth, token);
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: V4Constants.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: staticHook
        });
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _setDefaults(bool buyback, LaunchDefaults memory d) internal {
        if (d.platformRecipient == address(0)) revert ZeroAddress();
        if (uint256(d.agentBps) + d.creatorBps + d.burnBps + d.platformBps != BPS) revert InvalidBpsSum();
        if (d.agentBps == 0 || d.creatorBps == 0 || d.platformBps == 0) revert ZeroBps();
        if (buyback ? d.burnBps == 0 : d.burnBps != 0) revert BurnBpsMismatch();
        if (d.platformBps < minPlatformBps) revert PlatformBpsBelowMinimum();
        if (d.lpFeeBps == 0 || d.lpFeeBps > MAX_LP_FEE) revert InvalidLpFee();
        if (d.dormancyPeriod < MIN_DORMANCY_PERIOD) revert InvalidDormancyPeriod();
        if (buyback) buybackDefaults = d;
        else standardDefaults = d;
        emit DefaultsUpdated(buyback, d);
    }

    function _kernelInitData() internal view returns (bytes memory) {
        // hookData = 0x00: 1 flag byte, Kernel calls guardian.onInstall(hookData[1:]) on first install
        return
            abi.encodeCall(
                IKernel.initialize, (ROOT_VALIDATION_ID, address(guardian), bytes(""), hex"00", new bytes[](0))
            );
    }

    function _buildConfig(
        LaunchParams calldata p,
        LaunchDefaults memory d,
        address creator,
        address kernel,
        address burner,
        bytes32 salt
    ) internal view returns (IClanker.DeploymentConfig memory cfg) {
        cfg.tokenConfig = IClanker.TokenConfig({
            tokenAdmin: address(this),
            name: p.name,
            symbol: p.symbol,
            salt: salt,
            image: p.image,
            metadata: p.metadata,
            context: p.context,
            originatingChainId: block.chainid
        });

        cfg.poolConfig = IClanker.PoolConfig({
            hook: staticHook,
            pairedToken: weth,
            tickIfToken0IsClanker: STARTING_TICK,
            tickSpacing: TICK_SPACING,
            poolData: abi.encode(
                IClankerHookV2.PoolInitializationData({
                    extension: address(0),
                    extensionData: "",
                    feeData: abi.encode(
                        IClankerHookStaticFee.PoolStaticConfigVars({clankerFee: d.lpFeeBps, pairedFee: d.lpFeeBps})
                    )
                })
            )
        });

        uint256 n = burner == address(0) ? 3 : 4;
        address[] memory admins = new address[](n);
        address[] memory recipients = new address[](n);
        uint16[] memory bps = new uint16[](n);
        IClankerLpLockerFeeConversion.FeeIn[] memory prefs = new IClankerLpLockerFeeConversion.FeeIn[](n);
        recipients[0] = kernel;
        bps[0] = d.agentBps;
        recipients[1] = creator;
        bps[1] = d.creatorBps;
        if (burner != address(0)) {
            recipients[2] = burner;
            bps[2] = d.burnBps;
            prefs[2] = IClankerLpLockerFeeConversion.FeeIn.Clanker; // locker converts WETH share -> token
        }
        recipients[n - 1] = d.platformRecipient;
        bps[n - 1] = d.platformBps;
        for (uint256 i; i < n; ++i) {
            admins[i] = address(this);
        }

        int24[] memory tickLower = new int24[](1);
        int24[] memory tickUpper = new int24[](1);
        uint16[] memory positionBps = new uint16[](1);
        tickLower[0] = STARTING_TICK;
        tickUpper[0] = POSITION_TICK_UPPER;
        positionBps[0] = BPS;

        cfg.lockerConfig = IClanker.LockerConfig({
            locker: lpLocker,
            rewardAdmins: admins,
            rewardRecipients: recipients,
            rewardBps: bps,
            tickLower: tickLower,
            tickUpper: tickUpper,
            positionBps: positionBps,
            lockerData: abi.encode(IClankerLpLockerFeeConversion.LpFeeConversionInfo({feePreference: prefs}))
        });

        cfg.mevModuleConfig = IClanker.MevModuleConfig({mevModule: mevModule, mevModuleData: ""});

        if (p.devBuyWei > 0) {
            cfg.extensionConfigs = new IClanker.ExtensionConfig[](1);
            cfg.extensionConfigs[0] = IClanker.ExtensionConfig({
                extension: devBuyExtension,
                msgValue: p.devBuyWei,
                extensionBps: 0,
                extensionData: abi.encode(
                    IClankerUniv4EthDevBuy.Univ4EthDevBuyExtensionData({
                        pairedTokenPoolKey: PoolKey(address(0), address(0), 0, 0, address(0)),
                        pairedTokenAmountOutMinimum: 0,
                        recipient: creator
                    })
                )
            });
        }
    }
}
