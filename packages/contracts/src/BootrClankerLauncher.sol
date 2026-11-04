// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {AgentGuardian} from "./AgentGuardian.sol";
import {BootrLaunchGate} from "./BootrLaunchGate.sol";
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

/// @title BootrClankerLauncher
/// @notice "Launch through Clanker": the same one-transaction agent launch as `BootrLauncher` (same
///         `LaunchParams` / `LaunchDefaults` / events, so the web and the supervisor reuse one ABI), with the
///         coin and its pool created by Clanker v4 (`deployToken`) instead of RWAGMI v3:
///         Kernel v3.1 treasury (root = AgentGuardian) -> Clanker token + Uniswap v4 pool (static-fee hook V2,
///         LP locked for good in ClankerLpLockerFeeConversion) -> ERC-8004 identity transferred to the kernel ->
///         USDC fuel pulled into the kernel -> guardian registration through `BootrLaunchGate`.
///
///         Fee split: the preset's bps go straight into Clanker's reward slots (no 9000 scaling: Clanker takes its
///         20% as a protocol fee ON TOP of the LP fee, so a trader pays `lpFeeBps * 1.2` and the four Bootr slots
///         share 100% of the LP fee). The agent, creator and platform slots take their share in WETH
///         (`FeeIn.Paired`); the buyback slot is the dead address with `FeeIn.Clanker`: the locker swaps that share
///         into the coin on every collection and anyone finalises the burn with `ClankerFeeLocker.claim(0xdEaD,
///         token)`. No `BuybackBurner` is needed on this path (`AgentLaunched.burner` = `0xdEaD` or zero).
///
///         Immutability: every `rewardAdmins[i]` and the token's `tokenAdmin` is this contract, and this contract
///         exposes NO function that calls `updateRewardRecipient` / `updateRewardAdmin` / `updateFeePreference` on
///         the locker or `updateAdmin` / `updateImage` / `updateMetadata` on the token, so recipients, bps, fee
///         preferences and metadata can never change after launch.
///
///         Position layout is Clanker's `Standard` (one position `[-230400, -120000]`, tick spacing 200, ~10 ETH
///         fully diluted), so clanker.world shows no `UNUSUAL_*` tag. Design: docs/design/clanker-launch.md.
contract BootrClankerLauncher is Ownable2Step, Pausable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types (identical to BootrLauncher)
    // ------------------------------------------------------------------

    struct LaunchDefaults {
        uint24 lpFeeBps; // LP fee in hundredths of a bip (10_000 = 1%); Clanker adds 20% of it on top
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
        address clanker; // Clanker v4 factory
        address feeLocker; // ClankerFeeLocker (informational: where every slot's fees land)
        address lpLocker; // ClankerLpLockerFeeConversion
        address staticHook; // ClankerHookStaticFeeV2
        address devBuyExtension; // ClankerUniv4EthDevBuy
        address weth;
        address usdc;
        address identityRegistry; // ERC-8004
        address kernelFactory; // ZeroDev KernelFactory (Kernel v3.1)
        address guardian; // AgentGuardian (kernel root validator + hook)
        address gate; // BootrLaunchGate (guardian.launcher)
    }

    // ------------------------------------------------------------------
    // Constants: Clanker pool parameters (clanker.world "Standard" layout)
    // ------------------------------------------------------------------

    uint16 public constant BPS = 10_000;
    uint24 public constant MAX_LP_FEE = 100_000; // ClankerHookV2.MAX_LP_FEE, 10%
    /// @dev Clanker.TOKEN_SUPPLY, fixed; all of it placed as liquidity (the dev buy has extensionBps 0).
    uint256 public constant TOTAL_SUPPLY = 100_000_000_000e18;
    uint32 public constant MIN_DORMANCY_PERIOD = 30 days;
    int24 public constant TICK_SPACING = 200;
    /// @dev Starting tick as if the coin is token0: price 1.0001^-230400 ~= 9.9e-11 WETH per token,
    ///      i.e. ~10 ETH fully diluted for the 100B supply (what clanker.world's Standard layout opens at).
    int24 public constant STARTING_TICK = -230_400;
    /// @dev Single position from the starting tick up to -120_000 (~62,000x), 100% coin at launch.
    int24 public constant POSITION_TICK_UPPER = -120_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    IClanker public immutable clanker;
    address public immutable feeLocker;
    address public immutable lpLocker;
    address public immutable staticHook;
    address public immutable devBuyExtension;
    address public immutable weth;
    IERC20 public immutable usdc;
    IERC8004IdentityRegistry public immutable identityRegistry;
    IKernelFactory public immutable kernelFactory;
    AgentGuardian public immutable guardian;
    BootrLaunchGate public immutable gate;
    bytes21 public immutable ROOT_VALIDATION_ID;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    LaunchDefaults public standardDefaults;
    LaunchDefaults public buybackDefaults;
    uint16 public minPlatformBps;
    /// @notice Flat ETH fee charged per launch on top of the dev buy, paid to the preset's platformRecipient.
    ///         Owner-settable for future launches; 0 disables it.
    uint256 public launchFeeWei;
    /// @notice LP fee for coins launched by the platform treasury itself (`msg.sender == platformRecipient`,
    ///         e.g. $BOOTR): replaces the preset's `lpFeeBps` for that launch only. 0 = off (preset fee).
    uint24 public platformLpFeeBps;
    /// @notice Clanker MEV module every launch is initialised with (mandatory on Clanker; `ClankerSniperAuctionV2`
    ///         with `abi.encode(FeeConfig)`, or `ClankerMevBlockDelay` with empty data). Owner-settable because
    ///         Clanker's admin can disable modules without notice.
    address public mevModule;
    bytes public mevModuleData;

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
    /// @notice Clanker-side facts of the launch, so the indexer does not have to decode `TokenCreated`.
    ///         `lpFeeBps` is the LP fee the pool was created with (the platform's own coins may differ from the preset).
    event ClankerLaunched(
        address indexed token,
        bytes32 poolId,
        address hook,
        address locker,
        address mevModule,
        int24 startingTick,
        uint24 lpFeeBps
    );
    event DefaultsUpdated(bool indexed buyback, LaunchDefaults defaults);
    event MinPlatformBpsUpdated(uint16 minPlatformBps);
    event LaunchFeeUpdated(uint256 launchFeeWei);
    event LaunchFeePaid(address indexed token, address indexed recipient, uint256 amount);
    event PlatformLpFeeUpdated(uint24 platformLpFeeBps);
    event MevModuleUpdated(address indexed mevModule, bytes mevModuleData);
    /// @notice The launch form's context string (`{"interface":"Bootr","platform":"bootr.fun","id":<draft>}`),
    ///         emitted in the launch tx so the supervisor can bind the draft's X account to the agent.
    event LaunchContext(address indexed token, string context);

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
        IClanker.MevModuleConfig memory mev,
        LaunchDefaults memory standard,
        LaunchDefaults memory buyback,
        uint16 minPlatformBps_
    ) Ownable(owner_) {
        if (
            deps.clanker == address(0) || deps.feeLocker == address(0) || deps.lpLocker == address(0)
                || deps.staticHook == address(0) || deps.devBuyExtension == address(0) || deps.weth == address(0)
                || deps.usdc == address(0) || deps.identityRegistry == address(0) || deps.kernelFactory == address(0)
                || deps.guardian == address(0) || deps.gate == address(0)
        ) revert ZeroAddress();

        clanker = IClanker(deps.clanker);
        feeLocker = deps.feeLocker;
        lpLocker = deps.lpLocker;
        staticHook = deps.staticHook;
        devBuyExtension = deps.devBuyExtension;
        weth = deps.weth;
        usdc = IERC20(deps.usdc);
        identityRegistry = IERC8004IdentityRegistry(deps.identityRegistry);
        kernelFactory = IKernelFactory(deps.kernelFactory);
        guardian = AgentGuardian(deps.guardian);
        gate = BootrLaunchGate(deps.gate);
        ROOT_VALIDATION_ID = KernelLib.validatorId(deps.guardian);

        _setMevModule(mev.mevModule, mev.mevModuleData);
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

    /// @notice Flat ETH launch fee for FUTURE launches (0 disables it). No upper bound is enforced on-chain;
    ///         the console shows the value in ETH before the owner signs.
    function setLaunchFee(uint256 launchFeeWei_) external onlyOwner {
        launchFeeWei = launchFeeWei_;
        emit LaunchFeeUpdated(launchFeeWei_);
    }

    /// @notice LP fee for the platform's own launches (creator == the preset's platformRecipient), FUTURE launches
    ///         only; 0 switches it off. Same bound as the presets (`MAX_LP_FEE`).
    function setPlatformLpFeeBps(uint24 platformLpFeeBps_) external onlyOwner {
        if (platformLpFeeBps_ > MAX_LP_FEE) revert InvalidLpFee();
        platformLpFeeBps = platformLpFeeBps_;
        emit PlatformLpFeeUpdated(platformLpFeeBps_);
    }

    /// @notice MEV module (and its init data) for FUTURE launches.
    function setMevModule(address mevModule_, bytes calldata mevModuleData_) external onlyOwner {
        _setMevModule(mevModule_, mevModuleData_);
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
        uint256 fee = launchFeeWei;
        if (msg.value < p.devBuyWei + fee) revert InsufficientValue();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert EmptyNameOrSymbol();
        LaunchDefaults memory d = p.buybackBurn ? buybackDefaults : standardDefaults;
        if (p.fuelUsdc < d.minFuelUsdc) revert InsufficientFuel();

        address creator = msg.sender;
        // the platform's own coins (launched by the treasury) may carry a different LP fee; the snapshot in
        // AgentLaunched and ClankerLaunched both carry the fee actually used
        uint24 platformFee = platformLpFeeBps;
        if (platformFee != 0 && creator == d.platformRecipient) d.lpFeeBps = platformFee;
        bytes32 salt = keccak256(abi.encode(creator, p.salt));

        // (a) agent treasury: Kernel v3.1 with root validator + hook = guardian
        kernel = kernelFactory.createAccount(_kernelInitData(), salt);

        // (b) buyback: no burner contract; the dead address is the locker's reward recipient (FeeIn.Clanker)
        if (p.buybackBurn) burner = DEAD;

        // (c) Clanker token + pool + locked liquidity (+ dev buy)
        token = clanker.deployToken{value: p.devBuyWei}(_buildConfig(p, d, creator, kernel, salt));

        // (d) ERC-8004 identity: minted to this contract, handed to the kernel
        agentId = identityRegistry.register(p.agentURI);
        identityRegistry.transferFrom(address(this), kernel, agentId);

        // (e) fuel
        if (p.fuelUsdc > 0) {
            usdc.safeTransferFrom(creator, kernel, p.fuelUsdc);
        }

        // (f) guardian registration through the gate
        gate.registerAgent(kernel, token, creator, d.dormancyPeriod);

        // (g)
        emit AgentLaunched(
            token, kernel, creator, burner, agentId, d, p.workerHash, p.model, p.agentURI, p.supervisorSessionKey
        );
        emit LaunchContext(token, p.context);
        emit ClankerLaunched(
            token, V4Constants.poolId(poolKeyFor(token)), staticHook, lpLocker, mevModule, STARTING_TICK, d.lpFeeBps
        );

        // (h) launch fee to the platform, excess back to the creator
        if (fee > 0) {
            Address.sendValue(payable(d.platformRecipient), fee);
            emit LaunchFeePaid(token, d.platformRecipient, fee);
        }
        uint256 refund = msg.value - p.devBuyWei - fee;
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

    /// @notice The v4 pool key Clanker creates for `token`: currencies sorted, dynamic-fee flag, tick spacing
    ///         200, hook = ClankerHookStaticFeeV2. (The token address itself is not predicted: Clanker's CREATE2
    ///         salt mixes the full constructor arguments; the web reads it from the receipt.)
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

    function _setMevModule(address mevModule_, bytes memory mevModuleData_) internal {
        if (mevModule_ == address(0)) revert ZeroAddress();
        mevModule = mevModule_;
        mevModuleData = mevModuleData_;
        emit MevModuleUpdated(mevModule_, mevModuleData_);
    }

    function _kernelInitData() internal view returns (bytes memory) {
        // hookData = 0x00: 1 flag byte, Kernel calls guardian.onInstall(hookData[1:]) on first install
        return
            abi.encodeCall(
                IKernel.initialize, (ROOT_VALIDATION_ID, address(guardian), bytes(""), hex"00", new bytes[](0))
            );
    }

    function _buildConfig(LaunchParams calldata p, LaunchDefaults memory d, address creator, address kernel, bytes32 salt)
        internal
        view
        returns (IClanker.DeploymentConfig memory cfg)
    {
        // (1) token: admin = this contract (no update path exists here), image / metadata / context as given
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

        // (2) one WETH pool on the static-fee V2 hook, Standard starting tick, same fee both directions
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

        // (3) reward slots straight from the preset (sum 10_000), admin = this contract on every slot:
        //     kernel / creator / platform in WETH (Paired), the burn slot = dead address in the coin (Clanker)
        uint256 n = d.burnBps == 0 ? 3 : 4;
        address[] memory admins = new address[](n);
        address[] memory recipients = new address[](n);
        uint16[] memory bps = new uint16[](n);
        IClankerLpLockerFeeConversion.FeeIn[] memory prefs = new IClankerLpLockerFeeConversion.FeeIn[](n);
        recipients[0] = kernel;
        bps[0] = d.agentBps;
        recipients[1] = creator;
        bps[1] = d.creatorBps;
        if (n == 4) {
            recipients[2] = DEAD;
            bps[2] = d.burnBps;
        }
        recipients[n - 1] = d.platformRecipient;
        bps[n - 1] = d.platformBps;
        for (uint256 i; i < n; ++i) {
            admins[i] = address(this);
            prefs[i] = IClankerLpLockerFeeConversion.FeeIn.Paired;
        }
        if (n == 4) prefs[2] = IClankerLpLockerFeeConversion.FeeIn.Clanker;

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

        // (4) MEV module (mandatory on Clanker); the dev buy below runs before the module is initialised
        cfg.mevModuleConfig = IClanker.MevModuleConfig({mevModule: mevModule, mevModuleData: mevModuleData});

        // (5) optional dev buy (coin delivered to the creator). The pool is created in this transaction, so
        //     nothing can front-run it; the extension swaps with amountOutMinimum = 1 itself.
        if (p.devBuyWei > 0) {
            cfg.extensionConfigs = new IClanker.ExtensionConfig[](1);
            cfg.extensionConfigs[0] = IClanker.ExtensionConfig({
                extension: devBuyExtension,
                msgValue: p.devBuyWei,
                extensionBps: 0,
                extensionData: abi.encode(
                    IClankerUniv4EthDevBuy.Univ4EthDevBuyExtensionData({
                        pairedTokenPoolKey: PoolKey(address(0), address(0), 0, 0, address(0)),
                        pairedTokenAmountOutMinimum: 1,
                        recipient: creator
                    })
                )
            });
        }
    }
}
