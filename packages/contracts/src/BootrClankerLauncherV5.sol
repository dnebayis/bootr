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
import {ClankerV5, IClankerV5Factory} from "./interfaces/IClankerV5.sol";
import {IERC8004IdentityRegistry} from "./interfaces/IERC8004IdentityRegistry.sol";
import {IKernel, IKernelFactory, KernelLib} from "./interfaces/IKernel.sol";
import {PoolKey, V4Constants} from "./interfaces/IUniswapV4.sol";

/// @title BootrClankerLauncherV5
/// @notice "Launch through Clanker" on Clanker v5: the same one-transaction agent launch as `BootrLauncher` and
///         `BootrClankerLauncher` (same `LaunchParams` / `LaunchDefaults` / `AgentLaunched` / `LaunchContext` /
///         `LaunchFeePaid`, so the web, the indexer and the supervisor reuse one ABI), with the coin and its pool
///         created by Clanker v5's `createLaunch` (or `createLaunchAndBuy` for a dev buy):
///         Kernel v3.1 treasury (root = AgentGuardian) -> Clanker v5 token + Uniswap v4 pool on the `TaxLaunchHook`
///         (the whole supply seeded single-sided, locked for good) -> ERC-8004 identity transferred to the kernel ->
///         USDC fuel pulled into the kernel -> guardian registration through `BootrLaunchGate`.
///
///         Fees: v5 charges a buy and sell tax (`LaunchDefaults.lpFeeBps`, hundredths of a bip, 15_000 = 1.5%)
///         instead of an LP fee. Clanker keeps `max(10% of the tax, 0.5% of the trade)` capped at 1% of the trade;
///         the rest is split by the preset: three fee slots (kernel, creator, platform) paid in the quote currency on
///         buys and sells alike (`FeeEscrow.owed(recipient, quote)`, claimed with `claimFor(recipient, quote)` by
///         anyone, always to the recipient), and on the buyback preset Clanker's own burn share, taken in the coin
///         by the hook and claimable to the dead address by anyone (`claimFor(0xdEaD, token)`). No burner contract,
///         no conversion swap: every slot receives exactly its weight of the quote-side tax on both trade
///         directions, which fixes the v4 sell-side split (docs/design/clanker-v5-migration.md section 5).
///
///         Buyback weights: the burn is `burnBps` of the slot pool, so the three paid slots are renormalised over
///         `10_000 - burnBps` with the agent's and the platform's weights rounded down and the creator taking the
///         remainder (the platform never gets more than its stated share). Standard preset: the bps as they are.
///
///         Immutability: the creator rights of every coin belong to this contract (`creator = address(0)` in the
///         factory call), every fee slot's `admin` is this contract and no slot is the factory-managed creator
///         slot, `metadataEditable` is false, and this contract exposes NO function that calls the hook's
///         `updateFeeSlotRecipient` / `updateFeeSlotAdmin` or the factory's creator-rights and metadata functions,
///         so recipients, weights, name, symbol, image and metadata can never change after launch.
///
///         Token addresses on v5 end in `0xcccc`: the web mines `LaunchParams.salt` with `tokenInitCodeHash` /
///         `predictToken` before signing (the factory reverts `InvalidTokenAddressSuffix` otherwise). The opening
///         price is Clanker's per-quote start tick, not this contract's choice. Design: docs/design/clanker-v5-migration.md.
contract BootrClankerLauncherV5 is Ownable2Step, Pausable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types (identical to BootrLauncher / BootrClankerLauncher)
    // ------------------------------------------------------------------

    struct LaunchDefaults {
        uint24 lpFeeBps; // on v5: the buy and sell tax, hundredths of a bip (15_000 = 1.5%); the trader pays exactly this
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
        bytes32 salt; // mined by the web so that predictToken(creator, p) ends in 0xcccc
        bool buybackBurn;
        uint256 fuelUsdc;
        uint256 devBuyWei;
        bytes32 workerHash;
        string model;
        string agentURI;
        address supervisorSessionKey; // informational; installed later via AgentGuardian.approveSessionKey
    }

    struct Deps {
        address factory; // Clanker v5 TaxRWAERC20LaunchpadFactory
        address hook; // TaxLaunchHook (the factory's `hook()`)
        address feeEscrow; // FeeEscrow (the hook's `feeEscrow()`; informational: where every slot's fees land)
        address quoteToken; // the pool's quote: address(0) = native ETH (recommended), or a registered ERC-20 (USDC)
        address usdc;
        address identityRegistry; // ERC-8004
        address kernelFactory; // ZeroDev KernelFactory (Kernel v3.1)
        address guardian; // AgentGuardian (kernel root validator + hook)
        address gate; // BootrLaunchGate (guardian.launcher)
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint16 public constant BPS = 10_000;
    /// @dev Tax bounds in hundredths of a bip: Clanker's live floor (1%) and Bootr's own ceiling (3%); Clanker's
    ///      policy bounds (1% to 10% today) are enforced by the factory at launch on top of these.
    uint24 public constant MIN_TAX_BPS = 10_000;
    uint24 public constant MAX_TAX_BPS = 30_000;
    /// @dev hundredths of a bip (1e6 = 100%) -> Clanker's 1e8 rate scale.
    uint32 internal constant TAX_RATE_MULTIPLIER = 100;
    /// @dev bps (1e4 = 100%) -> Clanker's 1e8 share scale.
    uint32 internal constant SHARE_MULTIPLIER = 10_000;
    uint32 public constant MIN_DORMANCY_PERIOD = 30 days;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint8 internal constant SLOT_COUNT = 3;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    IClankerV5Factory public immutable factory;
    address public immutable hook;
    address public immutable feeEscrow;
    address public immutable quoteToken;
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
    /// @notice Tax for coins launched by the platform treasury itself (`msg.sender == platformRecipient`,
    ///         e.g. $BOOTR): replaces the preset's tax for that launch only. 0 = off (preset tax).
    uint24 public platformTaxBps;
    /// @notice Clanker's anti-snipe fee on new pools (a buy surcharge falling from 99% to the tax over 20 s, the
    ///         policy's numbers; exact-output swaps revert meanwhile). On by default, like clanker.world.
    bool public antiSnipe = true;

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
    /// @notice Clanker-side facts of a v5 launch, so the indexer does not have to decode Clanker's `Launched`.
    ///         `taxBps` is the tax the pool was created with (the platform's own coins may differ from the preset);
    ///         the opening tick is in the PoolManager's `Initialize` log of the same receipt.
    event ClankerV5Launched(
        address indexed token,
        bytes32 poolId,
        address hook,
        address feeEscrow,
        address quoteToken,
        int24 tickSpacing,
        uint24 taxBps,
        bool antiSnipe
    );
    event DefaultsUpdated(bool indexed buyback, LaunchDefaults defaults);
    event MinPlatformBpsUpdated(uint16 minPlatformBps);
    event LaunchFeeUpdated(uint256 launchFeeWei);
    event LaunchFeePaid(address indexed token, address indexed recipient, uint256 amount);
    event PlatformTaxUpdated(uint24 platformTaxBps);
    event AntiSnipeUpdated(bool antiSnipe);
    /// @notice The launch form's context string (`{"interface":"Bootr","platform":"bootr.fun","id":<draft>}`),
    ///         emitted in the launch tx so the supervisor can bind the draft's X account to the agent.
    event LaunchContext(address indexed token, string context);

    error ZeroAddress();
    error InvalidBpsSum();
    error ZeroBps();
    error BurnBpsMismatch();
    error PlatformBpsBelowMinimum();
    error InvalidTax();
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
            deps.factory == address(0) || deps.hook == address(0) || deps.feeEscrow == address(0)
                || deps.usdc == address(0) || deps.identityRegistry == address(0) || deps.kernelFactory == address(0)
                || deps.guardian == address(0) || deps.gate == address(0)
        ) revert ZeroAddress();
        // deps.quoteToken may be address(0): native ETH

        factory = IClankerV5Factory(deps.factory);
        hook = deps.hook;
        feeEscrow = deps.feeEscrow;
        quoteToken = deps.quoteToken;
        usdc = IERC20(deps.usdc);
        identityRegistry = IERC8004IdentityRegistry(deps.identityRegistry);
        kernelFactory = IKernelFactory(deps.kernelFactory);
        guardian = AgentGuardian(deps.guardian);
        gate = BootrLaunchGate(deps.gate);
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

    /// @notice Tax for the platform's own launches (creator == the preset's platformRecipient), FUTURE launches
    ///         only; 0 switches it off. Same bounds as the presets.
    function setPlatformTaxBps(uint24 platformTaxBps_) external onlyOwner {
        if (platformTaxBps_ != 0 && (platformTaxBps_ < MIN_TAX_BPS || platformTaxBps_ > MAX_TAX_BPS)) revert InvalidTax();
        platformTaxBps = platformTaxBps_;
        emit PlatformTaxUpdated(platformTaxBps_);
    }

    /// @notice Clanker's anti-snipe fee for FUTURE launches.
    function setAntiSnipe(bool antiSnipe_) external onlyOwner {
        antiSnipe = antiSnipe_;
        emit AntiSnipeUpdated(antiSnipe_);
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
        // Clanker's own native launch fee (0 today) is paid through to the factory.
        uint256 clankerFee = factory.nativeLaunchFee();
        if (msg.value < p.devBuyWei + fee + clankerFee) revert InsufficientValue();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert EmptyNameOrSymbol();
        LaunchDefaults memory d = p.buybackBurn ? buybackDefaults : standardDefaults;
        if (p.fuelUsdc < d.minFuelUsdc) revert InsufficientFuel();

        address creator = msg.sender;
        // the platform's own coins (launched by the treasury) may carry a different tax; AgentLaunched and
        // ClankerV5Launched both carry the tax actually used
        uint24 platformTax = platformTaxBps;
        if (platformTax != 0 && creator == d.platformRecipient) d.lpFeeBps = platformTax;
        bytes32 salt = keccak256(abi.encode(creator, p.salt));

        // (a) agent treasury: Kernel v3.1 with root validator + hook = guardian
        kernel = kernelFactory.createAccount(_kernelInitData(), salt);

        // (b) buyback: Clanker's burn share, credited to the dead address by the hook; no burner contract
        if (p.buybackBurn) burner = DEAD;

        // (c) Clanker v5 token + pool + seeded liquidity (+ dev buy, forwarded to the creator)
        bytes32 poolId;
        (token, poolId) = _createToken(p, d, creator, kernel, salt, clankerFee);

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
        emit ClankerV5Launched(token, poolId, hook, feeEscrow, quoteToken, factory.tickSpacing(), d.lpFeeBps, antiSnipe);

        // (h) launch fee to the platform, excess back to the creator
        if (fee > 0) {
            Address.sendValue(payable(d.platformRecipient), fee);
            emit LaunchFeePaid(token, d.platformRecipient, fee);
        }
        uint256 refund = msg.value - p.devBuyWei - fee - clankerFee;
        if (refund > 0) {
            Address.sendValue(payable(creator), refund);
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function predictKernel(address creator, bytes32 salt) public view returns (address) {
        return kernelFactory.getAddress(_kernelInitData(), keccak256(abi.encode(creator, salt)));
    }

    /// @notice The init code hash of the token `p` would create (`factory.launchTokenInitCodeHash`): depends on
    ///         the name, symbol, metadata and Clanker's supply and hook, not on the salt or the slots. The web mines
    ///         `p.salt` locally against it: `predictToken` must end in `0xcccc`.
    function tokenInitCodeHash(LaunchParams calldata p) external view returns (bytes32) {
        LaunchDefaults memory d = p.buybackBurn ? buybackDefaults : standardDefaults;
        return factory.launchTokenInitCodeHash(_v5Params(p, d, address(0), address(0)));
    }

    /// @notice The scoped CREATE2 salt Clanker uses for a launch by `creator` with `salt`:
    ///         `keccak256(this, keccak256(creator, salt))`.
    function scopedSalt(address creator, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), keccak256(abi.encode(creator, salt))));
    }

    /// @notice The token address `launch(p)` by `creator` creates (CREATE2 from Clanker's token deployer).
    function predictToken(address creator, LaunchParams calldata p) external view returns (address) {
        LaunchDefaults memory d = p.buybackBurn ? buybackDefaults : standardDefaults;
        bytes32 initCodeHash = factory.launchTokenInitCodeHash(_v5Params(p, d, address(0), address(0)));
        return _create2(factory.tokenDeployer(), scopedSalt(creator, p.salt), initCodeHash);
    }

    /// @notice The v4 pool key Clanker creates for `token`: currencies sorted (native ETH is `address(0)` and so
    ///         always currency0), fee 0, the factory's current tick spacing, hook = TaxLaunchHook.
    function poolKeyFor(address token) public view returns (PoolKey memory key) {
        return poolKeyFor(token, factory.tickSpacing());
    }

    function poolKeyFor(address token, int24 tickSpacing) public view returns (PoolKey memory key) {
        (address c0, address c1) = token < quoteToken ? (token, quoteToken) : (quoteToken, token);
        key = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: tickSpacing, hooks: hook});
    }

    /// @notice The three fee-slot weights (agent, creator, platform; sum 10_000) a preset launches with: the
    ///         preset's bps renormalised over the pool left after the burn, agent and platform rounded down, the
    ///         creator taking the remainder.
    function slotWeightsFor(bool buyback) external view returns (uint16[3] memory) {
        return _slotWeights(buyback ? buybackDefaults : standardDefaults);
    }

    /// @notice The Clanker `TaxConfiguration` a preset launches with (buy tax == sell tax; burn share on the
    ///         buyback preset; the rest to the fee slots).
    function taxConfigurationFor(bool buyback) external view returns (ClankerV5.TaxConfiguration memory) {
        return _taxConfiguration(buyback ? buybackDefaults : standardDefaults);
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
        if (d.lpFeeBps < MIN_TAX_BPS || d.lpFeeBps > MAX_TAX_BPS) revert InvalidTax();
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

    /// @dev `createLaunch`, or `createLaunchAndBuy` with the one-hop native route when there is a dev buy. The
    ///      bought coins land on this contract (`originalCreator` of the factory call) and are forwarded whole.
    function _createToken(
        LaunchParams calldata p,
        LaunchDefaults memory d,
        address creator,
        address kernel,
        bytes32 salt,
        uint256 clankerFee
    ) internal returns (address token, bytes32 poolId) {
        ClankerV5.LaunchParams memory params = _v5Params(p, d, creator, kernel);
        params.creatorSalt = salt;
        if (p.devBuyWei == 0) {
            (token, poolId) = factory.createLaunch{value: clankerFee}(params);
            return (token, poolId);
        }
        // the route names the token, so it is predicted first (the factory checks the prediction itself)
        address predicted = _create2(factory.tokenDeployer(), scopedSalt(creator, p.salt), factory.launchTokenInitCodeHash(params));
        ClankerV5.SwapDesc[] memory route = new ClankerV5.SwapDesc[](1);
        route[0] = ClankerV5.SwapDesc({
            swapType: ClankerV5.SWAP_TYPE_LAUNCH_POOL,
            tokenIn: quoteToken,
            tokenOut: predicted,
            poolAddress: address(0),
            fee: 0,
            tickSpacing: factory.tickSpacing(),
            hooks: hook,
            hookData: ""
        });
        uint256 amountOut;
        (token, poolId, amountOut) = factory.createLaunchAndBuy{value: clankerFee + p.devBuyWei}(
            params,
            ClankerV5.LaunchBuyParams({
                fundingToken: address(0), minAmountOut: 1, amountIn: p.devBuyWei, routeData: abi.encode(route)
            })
        );
        IERC20(token).safeTransfer(creator, amountOut);
    }

    /// @dev Clanker's `LaunchParams` for `p` under preset `d`. `creator`/`kernel` only fill the fee slots (the
    ///      views pass zero addresses: the init code hash does not depend on them). `creatorSalt` is set by the
    ///      caller; `creator = address(0)` makes this contract the creator-rights holder.
    function _v5Params(LaunchParams calldata p, LaunchDefaults memory d, address creator, address kernel)
        internal
        view
        returns (ClankerV5.LaunchParams memory params)
    {
        uint16[3] memory w = _slotWeights(d);
        ClankerV5.FeeSlotInput[] memory slots = new ClankerV5.FeeSlotInput[](SLOT_COUNT);
        slots[0] = ClankerV5.FeeSlotInput({recipient: kernel, admin: address(this), relativeWeightBps: w[0], isCreator: false});
        slots[1] = ClankerV5.FeeSlotInput({recipient: creator, admin: address(this), relativeWeightBps: w[1], isCreator: false});
        slots[2] = ClankerV5.FeeSlotInput({
            recipient: d.platformRecipient, admin: address(this), relativeWeightBps: w[2], isCreator: false
        });

        // the keys clanker-sdk writes, so clanker.world shows the image and the context
        string[] memory keys = new string[](3);
        string[] memory values = new string[](3);
        keys[0] = "image";
        values[0] = p.image;
        keys[1] = "metadata";
        values[1] = p.metadata;
        keys[2] = "context";
        values[2] = p.context;

        params = ClankerV5.LaunchParams({
            creator: address(0),
            feeSlots: slots,
            tokenName: p.name,
            tokenSymbol: p.symbol,
            tokenContractURI: p.metadata,
            creatorSalt: bytes32(0),
            quoteToken: quoteToken,
            expectedConfigVersion: factory.configVersion(),
            deadline: uint64(block.timestamp),
            metadataEditable: false,
            metadataKeys: keys,
            metadataValues: values,
            taxConfiguration: _taxConfiguration(d),
            // unused for payouts (no slot is the creator slot); must be a valid recipient
            creatorFeeRecipient: creator == address(0) ? d.platformRecipient : creator,
            integratorFeeRecipient: address(0),
            antiSnipeEnabled: antiSnipe
        });
    }

    function _taxConfiguration(LaunchDefaults memory d) internal pure returns (ClankerV5.TaxConfiguration memory) {
        uint32 burnShare = uint32(d.burnBps) * SHARE_MULTIPLIER;
        return ClankerV5.TaxConfiguration({
            buyTaxRate: uint32(d.lpFeeBps) * TAX_RATE_MULTIPLIER,
            sellTaxRate: uint32(d.lpFeeBps) * TAX_RATE_MULTIPLIER,
            creatorAllocationShare: ClankerV5.PERCENTAGE_SCALE - burnShare,
            burnAllocationShare: burnShare,
            dividendAllocationShare: 0,
            integratorAllocationShare: 0,
            minimumDividendHolding: 0
        });
    }

    function _slotWeights(LaunchDefaults memory d) internal pure returns (uint16[3] memory w) {
        uint256 pool = uint256(BPS) - d.burnBps; // 10_000 on the standard preset
        w[0] = uint16(uint256(d.agentBps) * BPS / pool);
        w[2] = uint16(uint256(d.platformBps) * BPS / pool);
        w[1] = BPS - w[0] - w[2];
    }

    function _create2(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
