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
import {IB20Factory, IRwagmiB20Launcher, IRwagmiB20LauncherV3, IRwagmiLpLockerV3} from "./interfaces/IRwagmi.sol";
import {IERC8004IdentityRegistry} from "./interfaces/IERC8004IdentityRegistry.sol";
import {IKernel, IKernelFactory, KernelLib} from "./interfaces/IKernel.sol";
import {PoolKey, V4Constants} from "./interfaces/IUniswapV4.sol";

/// @title BootrLauncher
/// @notice One-transaction launch of an AI-agent coin on Base:
///         Kernel v3.1 treasury (root = AgentGuardian) -> optional BuybackBurner clone ->
///         Base B20 Asset token + Uniswap v4 pool through the RWAGMI v3 launcher (1% swap fee taken by
///         the RWAGMI hook in WETH, LP locked for good in RwagmiLpLockerV3) -> ERC-8004 identity
///         transferred to the kernel -> USDC fuel pulled into the kernel -> guardian registration.
///
///         Immutability of the fee split: every reward slot's `admin` is this contract, and this
///         contract exposes NO function that calls `updateRewardRecipient` / `updateRewardAdmin` on the
///         locker, so recipients and bps can never change after launch. The token is launched in
///         RWAGMI's immutable mode (`initialAdmin = 0`): nobody holds admin, mint or metadata powers.
///         RWAGMI appends its own 10% slot to every launch; Bootr's presets are expressed over the
///         remaining 9000 bps (see `_slotBps`).
contract BootrLauncher is Ownable2Step, Pausable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct LaunchDefaults {
        uint24 lpFeeBps; // hook swap fee in hundredths of a bip (10_000 = 1%)
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
        address rwagmiLauncher; // RwagmiB20LauncherV3
        address rwagmiLocker; // RwagmiLpLockerV3
        address rwagmiHook; // RwagmiHookV3
        address rwagmiDevBuy; // RwagmiEthDevBuyV3
        address b20Factory; // Base B20Factory precompile
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
    // Constants: pool parameters (one WETH pool, 1% static hook fee, one-sided position)
    // ------------------------------------------------------------------

    uint16 public constant BPS = 10_000;
    uint24 public constant MAX_LP_FEE = 100_000; // RWAGMI hook cap, 10% (hundredths of a bip)
    /// @dev Fixed supply, all of it placed as liquidity (RWAGMI mints exactly `liquiditySupply`).
    uint256 public constant TOTAL_SUPPLY = 100_000_000_000e18;
    /// @dev Bootr presets sum to 10_000; RWAGMI reserves 1_000 for itself, so slots are scaled to 9_000.
    uint16 public constant CREATOR_SLOT_BPS = 9_000;
    uint8 public constant TOKEN_DECIMALS = 18;
    uint8 public constant B20_PARAMS_VERSION = 1;
    uint32 public constant MIN_DORMANCY_PERIOD = 30 days;
    int24 public constant TICK_SPACING = 200;
    /// @dev Starting tick as if the coin is token0: price 1.0001^-230400 ~= 9.9e-11 WETH per token,
    ///      i.e. ~10 ETH fully diluted for the 100B supply.
    int24 public constant STARTING_TICK = -230_400;
    /// @dev Single position from the starting tick up to -120_000 (~62,000x). Liquidity is 100% coin
    ///      (one-sided) at launch, so no tick below the starting tick is needed.
    int24 public constant POSITION_TICK_UPPER = -120_000;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    IRwagmiB20LauncherV3 public immutable rwagmiLauncher;
    IRwagmiLpLockerV3 public immutable rwagmiLocker;
    address public immutable rwagmiHook;
    address public immutable rwagmiDevBuy;
    IB20Factory public immutable b20Factory;
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
    /// @notice Flat ETH fee charged per launch on top of the dev buy, paid to the preset's platformRecipient.
    ///         Owner-settable for future launches; 0 disables it.
    uint256 public launchFeeWei;

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
    event LaunchFeeUpdated(uint256 launchFeeWei);
    event LaunchFeePaid(address indexed token, address indexed recipient, uint256 amount);
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
        LaunchDefaults memory standard,
        LaunchDefaults memory buyback,
        uint16 minPlatformBps_
    ) Ownable(owner_) {
        if (
            deps.rwagmiLauncher == address(0) || deps.rwagmiLocker == address(0) || deps.rwagmiHook == address(0)
                || deps.rwagmiDevBuy == address(0) || deps.b20Factory == address(0) || deps.weth == address(0) || deps.usdc == address(0) || deps.identityRegistry == address(0)
                || deps.kernelFactory == address(0) || deps.guardian == address(0)
                || deps.burnerImplementation == address(0) || deps.universalRouter == address(0)
                || deps.permit2 == address(0)
        ) revert ZeroAddress();

        rwagmiLauncher = IRwagmiB20LauncherV3(deps.rwagmiLauncher);
        rwagmiLocker = IRwagmiLpLockerV3(deps.rwagmiLocker);
        rwagmiHook = deps.rwagmiHook;
        rwagmiDevBuy = deps.rwagmiDevBuy;
        b20Factory = IB20Factory(deps.b20Factory);
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

    /// @notice Flat ETH launch fee for FUTURE launches (0 disables it). No upper bound is enforced on-chain;
    ///         the console shows the value in ETH before the owner signs.
    function setLaunchFee(uint256 launchFeeWei_) external onlyOwner {
        launchFeeWei = launchFeeWei_;
        emit LaunchFeeUpdated(launchFeeWei_);
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
        bytes32 salt = keccak256(abi.encode(creator, p.salt));

        // (a) agent treasury: Kernel v3.1 with root validator + hook = guardian
        kernel = kernelFactory.createAccount(_kernelInitData(), salt);

        // (b) optional buyback burner clone
        if (p.buybackBurn) {
            burner = MinimalClones.cloneDeterministic(burnerImplementation, salt);
        }

        // (c)+(d) B20 token + v4 pool through the RWAGMI v3 launcher
        (token,) = rwagmiLauncher.launchB20{value: p.devBuyWei}(_buildConfig(p, d, creator, kernel, burner, salt));
        if (burner != address(0)) {
            BuybackBurner(burner).initialize(
                token, weth, address(rwagmiLocker), poolKeyFor(token), universalRouter, permit2, address(this)
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
        emit LaunchContext(token, p.context);

        // (i) launch fee to the platform, excess back to the creator
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

    function predictBurner(address creator, bytes32 salt) external view returns (address) {
        return MinimalClones.predictDeterministicAddress(
            burnerImplementation, keccak256(abi.encode(creator, salt)), address(this)
        );
    }

    /// @notice The v4 pool key RWAGMI creates for `token`: currencies sorted, LP fee 0 (the hook charges the
    ///         swap fee itself), tick spacing 200, hook = RwagmiHookV3.
    function poolKeyFor(address token) public view returns (PoolKey memory key) {
        (address c0, address c1) = token < weth ? (token, weth) : (weth, token);
        key = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: rwagmiHook});
    }

    /// @notice The B20 address a launch by `creator` with `salt` creates (deterministic per RWAGMI launcher).
    function predictToken(address creator, bytes32 salt) public view returns (address) {
        return b20Factory.getB20Address(
            uint8(IRwagmiB20Launcher.B20Variant.Asset), address(rwagmiLauncher), keccak256(abi.encode(creator, salt))
        );
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

    /// @dev Bootr preset bps (sum 10_000) -> RWAGMI slot bps (sum 9_000). The platform slot takes the
    ///      rounding remainder so the slots always sum to exactly 9_000.
    function _slotBps(uint16 bps) internal pure returns (uint16) {
        return uint16((uint256(bps) * CREATOR_SLOT_BPS) / BPS);
    }

    function _buildConfig(
        LaunchParams calldata p,
        LaunchDefaults memory d,
        address creator,
        address kernel,
        address burner,
        bytes32 salt
    ) internal view returns (IRwagmiB20LauncherV3.LaunchConfigV3 memory cfg) {
        // (1) B20 Asset token, immutable mode: no admin, metadata set once at creation (ERC-7572 contract URI)
        bytes[] memory initCalls;
        if (bytes(p.metadata).length > 0) {
            initCalls = new bytes[](1);
            initCalls[0] = abi.encodeWithSignature("updateContractURI(string)", p.metadata);
        } else {
            initCalls = new bytes[](0);
        }
        cfg.b20Config = IRwagmiB20Launcher.B20Config({
            variant: IRwagmiB20Launcher.B20Variant.Asset,
            salt: salt,
            params: abi.encode(
                B20AssetParams({
                    version: B20_PARAMS_VERSION,
                    name: p.name,
                    symbol: p.symbol,
                    initialAdmin: address(0),
                    decimals: TOKEN_DECIMALS
                })
            ),
            initCalls: initCalls,
            name: p.name,
            symbol: p.symbol,
            decimals: TOKEN_DECIMALS,
            initialAdmin: address(0),
            originatingChainId: block.chainid
        });
        cfg.adminMode = IRwagmiB20Launcher.AdminMode.Immutable;
        cfg.liquiditySupply = TOTAL_SUPPLY;

        // (2) reward slots, admin = this contract (no rotation path exists here): locked for good
        uint256 n = burner == address(0) ? 3 : 4;
        cfg.creatorRewards = new IRwagmiB20LauncherV3.RewardSlotConfig[](n);
        cfg.creatorRewards[0] = IRwagmiB20LauncherV3.RewardSlotConfig(address(this), kernel, _slotBps(d.agentBps));
        cfg.creatorRewards[1] = IRwagmiB20LauncherV3.RewardSlotConfig(address(this), creator, _slotBps(d.creatorBps));
        uint16 used = cfg.creatorRewards[0].bps + cfg.creatorRewards[1].bps;
        if (burner != address(0)) {
            cfg.creatorRewards[2] = IRwagmiB20LauncherV3.RewardSlotConfig(address(this), burner, _slotBps(d.burnBps));
            used += cfg.creatorRewards[2].bps;
        }
        cfg.creatorRewards[n - 1] =
            IRwagmiB20LauncherV3.RewardSlotConfig(address(this), d.platformRecipient, CREATOR_SLOT_BPS - used);

        // (3) one WETH pool, static hook fee, one one-sided position. Positions are given in the pool's real
        //     orientation: mirrored when the coin sorts as currency1 (the launcher validates them that way).
        bool is0 = predictToken(creator, p.salt) < weth;
        IRwagmiB20LauncherV3.PositionConfig[] memory positions = new IRwagmiB20LauncherV3.PositionConfig[](1);
        positions[0] = is0
            ? IRwagmiB20LauncherV3.PositionConfig(STARTING_TICK, POSITION_TICK_UPPER, BPS)
            : IRwagmiB20LauncherV3.PositionConfig(-POSITION_TICK_UPPER, -STARTING_TICK, BPS);
        cfg.pools = new IRwagmiB20LauncherV3.PoolAllocation[](1);
        cfg.pools[0] = IRwagmiB20LauncherV3.PoolAllocation({
            pairedToken: weth,
            allocationBps: BPS,
            tickIfToken0IsB20: STARTING_TICK,
            tickSpacing: TICK_SPACING,
            fee: IRwagmiB20LauncherV3.HookFeeConfig({
                mode: IRwagmiB20LauncherV3.FeeMode.Static,
                staticFee: d.lpFeeBps,
                dynamicConfig: IRwagmiB20LauncherV3.DynamicFeeConfig(0, 0, 0, 0, 0, 0)
            }),
            positions: positions
        });
        cfg.primaryPoolIndex = 0;

        // (4) optional dev buy through RWAGMI's ETH extension (coin delivered to the creator). The launch
        //     transaction creates the pool, so nothing can front-run it: minimumOut = 1 is safe here.
        if (p.devBuyWei > 0) {
            cfg.extensions = new IRwagmiB20LauncherV3.ExtensionConfigV3[](1);
            cfg.extensions[0] = IRwagmiB20LauncherV3.ExtensionConfigV3({
                extension: rwagmiDevBuy,
                poolIndex: 0,
                msgValue: p.devBuyWei,
                data: abi.encode(creator, uint128(1))
            });
        } else {
            cfg.extensions = new IRwagmiB20LauncherV3.ExtensionConfigV3[](0);
        }
        cfg.deadline = block.timestamp + 1 hours;
    }

    /// @dev B20 Asset `createB20` params (`RwagmiB20BootstrapV3.AssetParams`), ABI-encoded as one tuple.
    struct B20AssetParams {
        uint8 version;
        string name;
        string symbol;
        address initialAdmin;
        uint8 decimals;
    }
}
