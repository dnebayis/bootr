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
import {IUniswapV3Factory} from "./interfaces/IUniswapV3.sol";
import {PoolKey} from "./interfaces/IUniswapV4.sol";

/// @title BootrClankerLauncherV5
/// @notice "Launch through Clanker" on Clanker v5 with creator-set token settings: the same one-transaction agent
///         launch as `BootrLauncher` and `BootrClankerLauncher` (same `LaunchParams` / `LaunchDefaults` /
///         `AgentLaunched` / `LaunchContext` / `LaunchFeePaid`), with the coin and its pool created by Clanker v5's
///         `createLaunch` (or `createLaunchAndBuy` for a dev buy) and the token set by the creator the way Clanker's
///         own deploy form does (`TokenSettings`):
///         Kernel v3.1 treasury (root = AgentGuardian) -> Clanker v5 token + Uniswap v4 pool on the `TaxLaunchHook`
///         (the whole supply seeded single-sided, locked for good) -> ERC-8004 identity transferred to the kernel ->
///         USDC fuel pulled into the kernel -> guardian registration through `BootrLaunchGate`.
///
///         Settings (docs/design/clanker-v5-token-settings.md section 2): a paired asset from the owner's allow-list
///         for agent coins (native ETH and USDC at deploy), a buy and a sell tax inside the owner's bounds (1% to 5%
///         at deploy), burn and holder-dividend shares of the post-Clanker pool, Clanker's sniper tax on or off, and
///         the creator funds' recipients: the creator's own row and up to four extra rows, each with its own admin.
///         Two slots come first and are locked: the agent (the kernel) and the platform, each at the launcher's
///         share of the post-Clanker pool (5% and 30% at deploy), the agent's weight rounded up and the platform's
///         down, both with this contract as admin. Nobody can change them: this contract exposes no function that
///         calls the hook's `updateFeeSlotRecipient` / `updateFeeSlotAdmin`.
///
///         Creator rights: this contract holds Clanker's creator rights of every coin (`creator = address(0)` in the
///         factory call) and never hands them over. When the creator launched with editable metadata, only the coin's
///         creator wallet (`coinCreator[token]`, fixed at launch, no handover) may change the `image` and `metadata`
///         keys through `updateImage` / `updateMetadata`, and may lock them for good with `lockMetadata`. Name,
///         symbol and the contract URI stay as launched: nothing here forwards `updateTokenName`,
///         `updateTokenSymbol` or `updateTokenContractURI`.
///
///         What the creator signs is what runs (the pins in `TokenSettings`): the launch reverts when Clanker's
///         config version is not the one the creator read (`expectedConfigVersion`, Clanker's own `StaleConfig`
///         guard), when the locked shares are not the ones previewed (`expectedAgentShareBps` /
///         `expectedPlatformShareBps`), when the launch fee is above `maxLaunchFeeWei`, and when a dev buy would
///         deliver fewer coins than `minDevBuyOut`.
///
///         Token addresses on v5 end in `0xcccc`: the web mines `LaunchParams.salt` with `tokenInitCodeHash(p, s)` /
///         `predictToken` before signing (the factory reverts `InvalidTokenAddressSuffix` otherwise). The opening
///         price is Clanker's per-quote start tick, not this contract's choice. Not upgradeable.
contract BootrClankerLauncherV5 is Ownable2Step, Pausable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice The numbers of one launch as `AgentLaunched` reports them (the struct `BootrLauncher` and
    ///         `BootrClankerLauncher` emit, so one decoder reads every path). On this launcher: `lpFeeBps` = the
    ///         buy tax (hundredths of a bip), `agentBps` / `platformBps` = the locked shares, `burnBps` = the
    ///         creator's burn share, `creatorBps` = everything else (creator funds and holder dividends), all of the
    ///         post-Clanker pool; they sum to 10_000.
    struct LaunchDefaults {
        uint24 lpFeeBps;
        uint16 agentBps;
        uint16 creatorBps;
        uint16 burnBps;
        uint16 platformBps;
        address platformRecipient;
        uint256 minFuelUsdc;
        uint32 dormancyPeriod;
    }

    /// @notice Unchanged from the other launchers. `metadata` is Clanker's metadata JSON (the `metadata` key
    ///         clanker.world reads); `buybackBurn` is ignored here (the burn is `TokenSettings.burnBps`).
    struct LaunchParams {
        string name;
        string symbol;
        string image;
        string metadata;
        string context;
        bytes32 salt; // mined by the web so that predictToken(creator, p, s) ends in 0xcccc
        bool buybackBurn;
        uint256 fuelUsdc;
        uint256 devBuyWei;
        bytes32 workerHash;
        string model;
        string agentURI;
        address supervisorSessionKey; // informational; installed later via AgentGuardian.approveSessionKey
    }

    /// @notice One creator-funds recipient: a fee slot on Clanker's hook with its own admin, who may change the
    ///         slot's recipient and admin there (`updateFeeSlotRecipient` / `updateFeeSlotAdmin`).
    struct RewardInput {
        address recipient; // non-zero, not this launcher
        address admin; // non-zero, not this launcher (launcher-admin slots are the agent's and the platform's)
        uint16 bps; // share of the creator funds; the rows sum to 10_000
    }

    /// @notice The creator's token settings. Shares are bps of the tax pool after Clanker's cut (10_000 = all).
    struct TokenSettings {
        address quoteToken; // address(0) = native ETH; must be on the allow-list for LaunchKind.Agent
        uint24 buyTaxBps; // hundredths of a bip like LaunchDefaults.lpFeeBps: 15_000 = 1.5%
        uint24 sellTaxBps;
        uint16 burnBps; // of the post-Clanker pool, taken in the coin and credited to 0xdEaD
        uint16 dividendBps; // of the post-Clanker pool, paid in the quote to holders through Clanker's tracker
        uint256 minDividendHolding; // raw token units (18 decimals); 0 iff dividendBps == 0
        RewardInput[] rewards; // the creator funds' recipients; row 0 is the creator's own row
        bool antiSnipe; // Clanker's 20 s sniper tax (to Clanker), frozen per pool
        bool metadataEditable; // the creator may later change image and metadata (and lock them)
        string contractURI; // the token's contractURI(): Bootr's hosted document
        // --- pins: what the creator read before signing; the launch reverts when the live value differs ---
        uint256 minDevBuyOut; // least coins (raw units) the dev buy must deliver; required (> 0) when devBuyWei > 0
        uint64 expectedConfigVersion; // Clanker's `factory.configVersion()` (tax policy, tick spacing, native fee)
        uint256 maxLaunchFeeWei; // the most this launcher may charge as its flat launch fee
        uint16 expectedAgentShareBps; // `agentDefaults.agentShareBps`
        uint16 expectedPlatformShareBps; // `agentDefaults.platformShareBps`
    }

    /// @notice The launcher's own numbers for future agent launches (owner-settable within fixed bounds).
    struct AgentDefaults {
        uint16 agentShareBps; // the agent's slot, of the post-Clanker pool (>= 500, rounded up)
        uint16 platformShareBps; // the platform's slot (>= minPlatformBps, rounded down); agent + platform <= 5000
        address platformRecipient;
        uint256 minFuelUsdc;
        uint32 dormancyPeriod;
        uint24 minTaxBps; // each side's tax, hundredths of a bip (Clanker's policy is enforced on top)
        uint24 maxTaxBps;
        uint8 maxRewardRows; // creator rows: the creator's own row plus extras, 1..5 (7 slots - agent - platform)
    }

    /// @notice Launch kinds with their own paired-asset allow-list. `Plain` (a coin without an agent) is a
    ///         reserved slot of the allow-list only: this contract has no launch path for it.
    enum LaunchKind {
        Agent,
        Plain
    }

    /// @notice The first hop of a dev buy into an ERC-20-quoted pool: Uniswap v3 WETH -> quote (the second hop is
    ///         the launch pool), funded in native ETH (Clanker's adapter wraps it). Always the Uniswap v3 factory's
    ///         own pool for WETH / quote at `fee` (`setDevBuyRoute`).
    struct DevBuyRoute {
        address pool;
        uint24 fee;
    }

    struct Deps {
        address factory; // Clanker v5 TaxRWAERC20LaunchpadFactory
        address hook; // TaxLaunchHook (the factory's `hook()`)
        address feeEscrow; // FeeEscrow (the hook's `feeEscrow()`; informational: where every slot's fees land)
        address weth; // the launch-buy adapter's wrapped native (first token of a two-hop dev buy)
        address uniswapV3Factory; // the Uniswap v3 factory every dev-buy first hop must be a pool of
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
    /// @notice The agent's share never goes below 5% of the post-Clanker pool.
    uint16 public constant MIN_AGENT_SHARE_BPS = 500;
    /// @notice Agent + platform never take more than half of the post-Clanker pool.
    uint16 public constant MAX_LOCKED_SHARE_BPS = 5000;
    /// @notice Creator rows: Clanker's seven slots minus the agent's and the platform's.
    uint8 public constant MAX_REWARD_ROWS = ClankerV5.MAX_FEE_SLOTS - 2;
    /// @notice No side's tax bound may exceed Clanker's live ceiling (10%).
    uint24 public constant MAX_TAX_CEILING_BPS = 100_000;
    /// @dev hundredths of a bip (1e6 = 100%) -> Clanker's 1e8 rate scale.
    uint32 internal constant TAX_RATE_MULTIPLIER = 100;
    /// @dev bps (1e4 = 100%) -> Clanker's 1e8 share scale.
    uint32 internal constant SHARE_MULTIPLIER = 10_000;
    uint32 public constant MIN_DORMANCY_PERIOD = 30 days;
    /// @notice The flat launch fee can never be set above this (the creator's own bound is
    ///         `TokenSettings.maxLaunchFeeWei`).
    uint256 public constant MAX_LAUNCH_FEE_WEI = 0.05 ether;
    /// @notice The highest Uniswap v3 fee tier a dev-buy first hop may use (0.3%, hundredths of a bip).
    uint24 public constant MAX_DEV_BUY_ROUTE_FEE = 3000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    IClankerV5Factory public immutable factory;
    address public immutable hook;
    address public immutable feeEscrow;
    address public immutable weth;
    IUniswapV3Factory public immutable uniswapV3Factory;
    IERC20 public immutable usdc;
    IERC8004IdentityRegistry public immutable identityRegistry;
    IKernelFactory public immutable kernelFactory;
    AgentGuardian public immutable guardian;
    BootrLaunchGate public immutable gate;
    bytes21 public immutable ROOT_VALIDATION_ID;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    AgentDefaults public agentDefaults;
    uint16 public minPlatformBps;
    /// @notice Flat ETH fee charged per launch on top of the dev buy, paid to the platformRecipient.
    ///         Owner-settable for future launches; 0 disables it.
    uint256 public launchFeeWei;
    /// @notice Paired assets admitted per launch kind (Clanker's own registration is checked by the factory).
    mapping(LaunchKind kind => mapping(address quote => bool)) public allowedQuote;
    /// @notice The v3 first hop of a dev buy per ERC-20 quote (native ETH needs none).
    mapping(address quote => DevBuyRoute) public devBuyRoute;

    /// @notice The pool's paired asset of each coin launched here.
    mapping(address token => address) public quoteOf;
    /// @notice The tick spacing of each coin's pool, fixed at launch (Clanker may change its own for later coins).
    mapping(address token => int24) public tickSpacingOf;
    /// @notice The wallet that launched each coin: the only one that may edit its image and metadata.
    mapping(address token => address) public coinCreator;
    /// @notice Whether the creator may still edit the coin's image and metadata (launched editable, not locked).
    mapping(address token => bool) public metadataEditable;

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
    /// @notice Clanker-side facts and the creator's settings of a v5 launch. The fee slots (agent, platform, then
    ///         the creator rows, in that order) are the hook's `FeeSlotCreated` logs and the full split with the
    ///         dividend minimum is the factory's `LaunchTaxConfigured`, both in the same receipt.
    event ClankerV5Launched(
        address indexed token,
        bytes32 poolId,
        address hook,
        address feeEscrow,
        address quoteToken,
        int24 tickSpacing,
        uint24 buyTaxBps,
        uint24 sellTaxBps,
        uint16 burnBps,
        uint16 dividendBps,
        bool antiSnipe,
        bool metadataEditable
    );
    /// @notice The launch form's context string (`{"interface":"Bootr","platform":"bootr.fun","id":<draft>}`),
    ///         emitted in the launch tx so the supervisor can bind the draft's X account to the agent.
    event LaunchContext(address indexed token, string context);
    event LaunchFeePaid(address indexed token, address indexed recipient, uint256 amount);
    event AgentDefaultsUpdated(AgentDefaults defaults);
    event MinPlatformBpsUpdated(uint16 minPlatformBps);
    event LaunchFeeUpdated(uint256 launchFeeWei);
    event QuoteAllowedUpdated(LaunchKind indexed kind, address indexed quote, bool allowed);
    event DevBuyRouteUpdated(address indexed quote, address pool, uint24 fee);
    /// @notice The creator changed the coin's `image` key (the token also emits Clanker's `ExtraMetadataUpdated`).
    event CoinImageUpdated(address indexed token, string image);
    /// @notice The creator changed the coin's `metadata` key (Clanker's metadata JSON).
    event CoinMetadataUpdated(address indexed token, string metadata);
    /// @notice The creator locked the coin's image and metadata for good.
    event CoinMetadataLocked(address indexed token);
    /// @notice The owner sent out an asset that had landed on this contract (`token == address(0)`: native ETH).
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error InvalidAgentShare();
    error InvalidPlatformShare();
    error InvalidTaxBounds();
    error InvalidRewardRowLimit();
    error InvalidDormancyPeriod();
    error InvalidMinPlatformBps();
    error QuoteNotAllowed(address quote);
    error TaxOutOfBounds();
    error SharesExceedPool();
    error DividendHoldingMismatch();
    error InvalidRewardCount();
    error InvalidRewardBps();
    error InvalidRewardRecipient();
    error InvalidRewardAdmin();
    error ZeroSlotWeight();
    error DevBuyRouteMissing(address quote);
    error InsufficientValue();
    error InsufficientFuel();
    error EmptyNameOrSymbol();
    error NotCoinCreator();
    error MetadataNotEditable();
    /// @notice A dev buy needs the creator's minimum output (`TokenSettings.minDevBuyOut > 0`).
    error MinDevBuyOutRequired();
    /// @notice The locked shares are not the ones the creator signed for (the live values are returned).
    error LockedSharesChanged(uint16 agentShareBps, uint16 platformShareBps);
    /// @notice The launch fee is above the creator's `maxLaunchFeeWei`.
    error LaunchFeeAboveMax(uint256 launchFeeWei, uint256 maxLaunchFeeWei);
    /// @notice `setLaunchFee` above `MAX_LAUNCH_FEE_WEI`.
    error LaunchFeeTooHigh();
    /// @notice A dev-buy route's fee is 0 or above `MAX_DEV_BUY_ROUTE_FEE`.
    error DevBuyRouteFeeOutOfBounds();
    /// @notice A dev-buy route's pool is not the Uniswap v3 factory's pool for WETH / quote at that fee.
    error DevBuyRouteNotFactoryPool();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(address owner_, Deps memory deps, AgentDefaults memory defaults, uint16 minPlatformBps_)
        Ownable(owner_)
    {
        if (
            deps.factory == address(0) || deps.hook == address(0) || deps.feeEscrow == address(0)
                || deps.weth == address(0) || deps.uniswapV3Factory == address(0) || deps.usdc == address(0)
                || deps.identityRegistry == address(0)
                || deps.kernelFactory == address(0) || deps.guardian == address(0) || deps.gate == address(0)
        ) revert ZeroAddress();

        factory = IClankerV5Factory(deps.factory);
        hook = deps.hook;
        feeEscrow = deps.feeEscrow;
        weth = deps.weth;
        uniswapV3Factory = IUniswapV3Factory(deps.uniswapV3Factory);
        usdc = IERC20(deps.usdc);
        identityRegistry = IERC8004IdentityRegistry(deps.identityRegistry);
        kernelFactory = IKernelFactory(deps.kernelFactory);
        guardian = AgentGuardian(deps.guardian);
        gate = BootrLaunchGate(deps.gate);
        ROOT_VALIDATION_ID = KernelLib.validatorId(deps.guardian);

        if (minPlatformBps_ > MAX_LOCKED_SHARE_BPS) revert InvalidMinPlatformBps();
        minPlatformBps = minPlatformBps_;
        emit MinPlatformBpsUpdated(minPlatformBps_);
        _setAgentDefaults(defaults);
    }

    // ------------------------------------------------------------------
    // Admin (future launches only; nothing here reaches an existing coin)
    // ------------------------------------------------------------------

    function setAgentDefaults(AgentDefaults calldata d) external onlyOwner {
        _setAgentDefaults(d);
    }

    function setMinPlatformBps(uint16 minPlatformBps_) external onlyOwner {
        if (minPlatformBps_ > MAX_LOCKED_SHARE_BPS) revert InvalidMinPlatformBps();
        minPlatformBps = minPlatformBps_;
        emit MinPlatformBpsUpdated(minPlatformBps_);
    }

    /// @notice Flat ETH launch fee for FUTURE launches (0 disables it), at most `MAX_LAUNCH_FEE_WEI`. A launch
    ///         signed under a lower fee reverts instead of paying more (`TokenSettings.maxLaunchFeeWei`).
    function setLaunchFee(uint256 launchFeeWei_) external onlyOwner {
        if (launchFeeWei_ > MAX_LAUNCH_FEE_WEI) revert LaunchFeeTooHigh();
        launchFeeWei = launchFeeWei_;
        emit LaunchFeeUpdated(launchFeeWei_);
    }

    /// @notice Admit or remove a paired asset for a launch kind (`address(0)` = native ETH).
    function setQuoteAllowed(LaunchKind kind, address quote, bool allowed) external onlyOwner {
        allowedQuote[kind][quote] = allowed;
        emit QuoteAllowedUpdated(kind, quote, allowed);
    }

    /// @notice The Uniswap v3 WETH -> `quote` pool a dev buy into a `quote` pool goes through first
    ///         (`pool = address(0)` clears it: dev buys into that quote then revert). The pool must be the
    ///         Uniswap v3 factory's own pool for WETH / `quote` at `fee`, and `fee` at most
    ///         `MAX_DEV_BUY_ROUTE_FEE`, so a mistyped address or tier is refused here. The contract cannot judge a
    ///         pool's depth: the creator's `minDevBuyOut` is what protects a dev buy from a thin route.
    function setDevBuyRoute(address quote, address pool, uint24 fee) external onlyOwner {
        if (quote == address(0)) revert ZeroAddress();
        if (pool == address(0)) {
            fee = 0;
        } else {
            if (fee == 0 || fee > MAX_DEV_BUY_ROUTE_FEE) revert DevBuyRouteFeeOutOfBounds();
            if (uniswapV3Factory.getPool(weth, quote, fee) != pool) revert DevBuyRouteNotFactoryPool();
        }
        devBuyRoute[quote] = DevBuyRoute({pool: pool, fee: fee});
        emit DevBuyRouteUpdated(quote, pool, fee);
    }

    /// @notice Send out an asset that landed on this contract by mistake (`token == address(0)`: native ETH,
    ///         which can only arrive by force: there is no `receive`). The launcher holds nothing between
    ///         transactions: a launch pulls the fuel straight from the creator to the kernel, forwards the dev
    ///         buy's coins whole and refunds the unspent ETH before it returns, and fees accrue in Clanker's
    ///         escrow to the slot recipients, never here. So anything `rescue` can reach is a stray transfer, not
    ///         a coin's or a creator's money; it cannot run inside a launch (`nonReentrant`).
    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            Address.sendValue(payable(to), amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit Rescued(token, to, amount);
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

    function launch(LaunchParams calldata p, TokenSettings calldata s)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (address token, address kernel, address burner, uint256 agentId)
    {
        AgentDefaults memory d = agentDefaults;
        // every per-launch rule, before any external call
        uint16[] memory weights = _slotWeights(s, d);
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert EmptyNameOrSymbol();
        if (p.fuelUsdc < d.minFuelUsdc) revert InsufficientFuel();
        if (p.devBuyWei > 0) {
            if (s.minDevBuyOut == 0) revert MinDevBuyOutRequired();
            if (s.quoteToken != address(0) && devBuyRoute[s.quoteToken].pool == address(0)) {
                revert DevBuyRouteMissing(s.quoteToken);
            }
        }
        // the creator's pins on this launcher's own terms (Clanker's are pinned by `expectedConfigVersion`)
        if (s.expectedAgentShareBps != d.agentShareBps || s.expectedPlatformShareBps != d.platformShareBps) {
            revert LockedSharesChanged(d.agentShareBps, d.platformShareBps);
        }
        uint256 fee = launchFeeWei;
        if (fee > s.maxLaunchFeeWei) revert LaunchFeeAboveMax(fee, s.maxLaunchFeeWei);

        // Clanker's own native launch fee (0 today) is paid through to the factory; changing it bumps Clanker's
        // config version, so a launch signed under another fee reverts `StaleConfig`.
        uint256 clankerFee = factory.nativeLaunchFee();
        if (msg.value < p.devBuyWei + fee + clankerFee) revert InsufficientValue();

        address creator = msg.sender;
        bytes32 salt = keccak256(abi.encode(creator, p.salt));

        // (a) agent treasury: Kernel v3.1 with root validator + hook = guardian
        kernel = kernelFactory.createAccount(_kernelInitData(), salt);

        // (b) burn: Clanker's burn share, credited to the dead address by the hook; no burner contract
        if (s.burnBps > 0) burner = DEAD;

        // (c) Clanker v5 token + pool + seeded liquidity (+ dev buy, forwarded to the creator)
        bytes32 poolId;
        int24 spacing = factory.tickSpacing();
        (token, poolId) =
            _createToken(p, s, _feeSlots(s, weights, kernel, d.platformRecipient), creator, salt, clankerFee, spacing);
        quoteOf[token] = s.quoteToken;
        tickSpacingOf[token] = spacing;
        coinCreator[token] = creator;
        if (s.metadataEditable) metadataEditable[token] = true;

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
            token,
            kernel,
            creator,
            burner,
            agentId,
            _launchDefaults(s, d),
            p.workerHash,
            p.model,
            p.agentURI,
            p.supervisorSessionKey
        );
        emit LaunchContext(token, p.context);
        _emitClankerV5Launched(token, poolId, spacing, s);

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
    // The creator's image and metadata
    // ------------------------------------------------------------------

    /// @notice Change the coin's image (Clanker's `image` key). Only the coin's creator wallet, while editable.
    function updateImage(address token, string calldata image) external nonReentrant {
        _requireEditor(token);
        factory.updateTokenExtraMetadata(token, "image", image);
        emit CoinImageUpdated(token, image);
    }

    /// @notice Change the coin's metadata JSON (Clanker's `metadata` key: description, social links, audit URLs).
    ///         Only the coin's creator wallet, while editable.
    function updateMetadata(address token, string calldata metadata) external nonReentrant {
        _requireEditor(token);
        factory.updateTokenExtraMetadata(token, "metadata", metadata);
        emit CoinMetadataUpdated(token, metadata);
    }

    /// @notice Lock the coin's image and metadata for good. Only the coin's creator wallet, while editable.
    function lockMetadata(address token) external {
        _requireEditor(token);
        metadataEditable[token] = false;
        emit CoinMetadataLocked(token);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function predictKernel(address creator, bytes32 salt) public view returns (address) {
        return kernelFactory.getAddress(_kernelInitData(), keccak256(abi.encode(creator, salt)));
    }

    /// @notice The init code hash of the token `launch(p, s)` would create (`factory.launchTokenInitCodeHash`): it
    ///         depends on the name, symbol, contract URI, metadata keys, `metadataEditable` and whether dividends
    ///         are on, not on the salt, the tax, the slots or the pins. The web mines `p.salt` locally against
    ///         it: `predictToken` must end in `0xcccc`. Reads Clanker's live config version, not the pin.
    function tokenInitCodeHash(LaunchParams calldata p, TokenSettings calldata s) public view returns (bytes32) {
        return factory.launchTokenInitCodeHash(
            _v5Params(p, s, new ClankerV5.FeeSlotInput[](0), address(0), factory.configVersion())
        );
    }

    /// @notice The scoped CREATE2 salt Clanker uses for a launch by `creator` with `salt`:
    ///         `keccak256(this, keccak256(creator, salt))`.
    function scopedSalt(address creator, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), keccak256(abi.encode(creator, salt))));
    }

    /// @notice The token address `launch(p, s)` by `creator` creates (CREATE2 from Clanker's token deployer).
    function predictToken(address creator, LaunchParams calldata p, TokenSettings calldata s)
        external
        view
        returns (address)
    {
        return _create2(factory.tokenDeployer(), scopedSalt(creator, p.salt), tokenInitCodeHash(p, s));
    }

    /// @notice The fee-slot weights `launch` would create for `s` under the current defaults (agent, platform,
    ///         then one per reward row; sum 10_000). Reverts exactly as `launch` would on the settings' own rules;
    ///         the pins (`minDevBuyOut`, `expectedConfigVersion`, `maxLaunchFeeWei`, the expected shares) are
    ///         not read here: `launch` alone checks them.
    function previewSlotWeights(TokenSettings calldata s) external view returns (uint16[] memory) {
        return _slotWeights(s, agentDefaults);
    }

    /// @notice The Clanker `TaxConfiguration` `launch` builds from `s` (shares on Clanker's 1e8 scale).
    function taxConfigurationFor(TokenSettings calldata s) external pure returns (ClankerV5.TaxConfiguration memory) {
        return _taxConfiguration(s);
    }

    /// @notice The v4 pool key of a coin launched here: its quote, fee 0, the tick spacing its pool was created
    ///         with (stored at launch), the hook.
    function poolKeyFor(address token) external view returns (PoolKey memory) {
        return poolKeyFor(token, quoteOf[token], tickSpacingOf[token]);
    }

    /// @notice The v4 pool key Clanker creates for `token` paired with `quote`: currencies sorted (native ETH is
    ///         `address(0)` and so always currency0), fee 0, `tickSpacing`, hook = TaxLaunchHook.
    function poolKeyFor(address token, address quote, int24 tickSpacing) public view returns (PoolKey memory key) {
        (address c0, address c1) = token < quote ? (token, quote) : (quote, token);
        key = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: tickSpacing, hooks: hook});
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _setAgentDefaults(AgentDefaults memory d) internal {
        if (d.platformRecipient == address(0)) revert ZeroAddress();
        if (d.agentShareBps < MIN_AGENT_SHARE_BPS) revert InvalidAgentShare();
        if (d.platformShareBps == 0 || d.platformShareBps < minPlatformBps) revert InvalidPlatformShare();
        if (uint256(d.agentShareBps) + d.platformShareBps > MAX_LOCKED_SHARE_BPS) revert InvalidPlatformShare();
        if (d.minTaxBps == 0 || d.minTaxBps > d.maxTaxBps || d.maxTaxBps > MAX_TAX_CEILING_BPS) {
            revert InvalidTaxBounds();
        }
        if (d.maxRewardRows == 0 || d.maxRewardRows > MAX_REWARD_ROWS) revert InvalidRewardRowLimit();
        if (d.dormancyPeriod < MIN_DORMANCY_PERIOD) revert InvalidDormancyPeriod();
        agentDefaults = d;
        emit AgentDefaultsUpdated(d);
    }

    function _requireEditor(address token) internal view {
        if (msg.sender != coinCreator[token]) revert NotCoinCreator();
        if (!metadataEditable[token]) revert MetadataNotEditable();
    }

    function _emitClankerV5Launched(address token, bytes32 poolId, int24 spacing, TokenSettings calldata s)
        internal
    {
        emit ClankerV5Launched(
            token,
            poolId,
            hook,
            feeEscrow,
            s.quoteToken,
            spacing,
            s.buyTaxBps,
            s.sellTaxBps,
            s.burnBps,
            s.dividendBps,
            s.antiSnipe,
            s.metadataEditable
        );
    }

    /// @dev Every per-launch rule of the settings (design note section 2.2), then the slot weights over the slot
    ///      pool `P = 10_000 - burn - dividends`: the agent's rounded up (never under its share), the platform's
    ///      rounded down (never over its share), the rows splitting the rest by their bps (floored, the leftover
    ///      to row 0), every weight at least 1.
    function _slotWeights(TokenSettings calldata s, AgentDefaults memory d)
        internal
        view
        returns (uint16[] memory w)
    {
        if (!allowedQuote[LaunchKind.Agent][s.quoteToken]) revert QuoteNotAllowed(s.quoteToken);
        if (
            s.buyTaxBps < d.minTaxBps || s.buyTaxBps > d.maxTaxBps || s.sellTaxBps < d.minTaxBps
                || s.sellTaxBps > d.maxTaxBps
        ) revert TaxOutOfBounds();
        uint256 locked = uint256(d.agentShareBps) + d.platformShareBps;
        if (locked + s.burnBps + s.dividendBps > BPS) revert SharesExceedPool();
        if ((s.dividendBps == 0) != (s.minDividendHolding == 0)) revert DividendHoldingMismatch();

        uint256 pool = BPS - uint256(s.burnBps) - s.dividendBps;
        uint256 rows = s.rewards.length;
        if (pool == locked ? rows != 0 : (rows == 0 || rows > d.maxRewardRows)) revert InvalidRewardCount();

        w = new uint16[](2 + rows);
        uint256 agentWeight = (uint256(d.agentShareBps) * BPS + pool - 1) / pool;
        uint256 platformWeight = uint256(d.platformShareBps) * BPS / pool;
        w[0] = uint16(agentWeight);
        w[1] = uint16(platformWeight);
        if (rows == 0) return w; // agentWeight + platformWeight == 10_000 when the pool is theirs alone

        uint256 rest = BPS - agentWeight - platformWeight;
        uint256 bpsSum;
        uint256 given;
        for (uint256 i; i < rows; ++i) {
            RewardInput calldata r = s.rewards[i];
            if (r.recipient == address(0) || r.recipient == address(this)) revert InvalidRewardRecipient();
            if (r.admin == address(0) || r.admin == address(this)) revert InvalidRewardAdmin();
            if (r.bps == 0) revert InvalidRewardBps();
            bpsSum += r.bps;
            uint256 rw = rest * r.bps / BPS;
            w[2 + i] = uint16(rw);
            given += rw;
        }
        if (bpsSum != BPS) revert InvalidRewardBps();
        w[2] += uint16(rest - given);
        for (uint256 i = 2; i < w.length; ++i) {
            if (w[i] == 0) revert ZeroSlotWeight();
        }
    }

    /// @dev Slots in order: agent (kernel), platform, then the creator rows. Agent and platform are administered
    ///      by this contract (locked); every row by its own admin. No `isCreator` slot.
    function _feeSlots(TokenSettings calldata s, uint16[] memory w, address kernel, address platformRecipient)
        internal
        view
        returns (ClankerV5.FeeSlotInput[] memory slots)
    {
        slots = new ClankerV5.FeeSlotInput[](w.length);
        slots[0] =
            ClankerV5.FeeSlotInput({recipient: kernel, admin: address(this), relativeWeightBps: w[0], isCreator: false});
        slots[1] = ClankerV5.FeeSlotInput({
            recipient: platformRecipient, admin: address(this), relativeWeightBps: w[1], isCreator: false
        });
        for (uint256 i = 2; i < w.length; ++i) {
            RewardInput calldata r = s.rewards[i - 2];
            slots[i] =
                ClankerV5.FeeSlotInput({recipient: r.recipient, admin: r.admin, relativeWeightBps: w[i], isCreator: false});
        }
    }

    function _launchDefaults(TokenSettings calldata s, AgentDefaults memory d)
        internal
        pure
        returns (LaunchDefaults memory)
    {
        return LaunchDefaults({
            lpFeeBps: s.buyTaxBps,
            agentBps: d.agentShareBps,
            creatorBps: BPS - d.agentShareBps - d.platformShareBps - s.burnBps,
            burnBps: s.burnBps,
            platformBps: d.platformShareBps,
            platformRecipient: d.platformRecipient,
            minFuelUsdc: d.minFuelUsdc,
            dormancyPeriod: d.dormancyPeriod
        });
    }

    function _kernelInitData() internal view returns (bytes memory) {
        // hookData = 0x00: 1 flag byte, Kernel calls guardian.onInstall(hookData[1:]) on first install
        return
            abi.encodeCall(
                IKernel.initialize, (ROOT_VALIDATION_ID, address(guardian), bytes(""), hex"00", new bytes[](0))
            );
    }

    /// @dev `createLaunch`, or `createLaunchAndBuy` when there is a dev buy: one hop into a native-ETH pool, two
    ///      (v3 WETH -> quote, then the launch pool) into an ERC-20 pool, always funded in ETH. The bought coins
    ///      land on this contract (`originalCreator` of the factory call) and are forwarded whole; the buy reverts
    ///      under the creator's `minDevBuyOut`. Clanker's `expectedConfigVersion` is the creator's pin.
    function _createToken(
        LaunchParams calldata p,
        TokenSettings calldata s,
        ClankerV5.FeeSlotInput[] memory slots,
        address creator,
        bytes32 salt,
        uint256 clankerFee,
        int24 spacing
    ) internal returns (address token, bytes32 poolId) {
        ClankerV5.LaunchParams memory params = _v5Params(p, s, slots, creator, s.expectedConfigVersion);
        params.creatorSalt = salt;
        if (p.devBuyWei == 0) {
            (token, poolId) = factory.createLaunch{value: clankerFee}(params);
            return (token, poolId);
        }
        // the route names the token, so it is predicted first (the factory checks the prediction itself)
        address predicted =
            _create2(factory.tokenDeployer(), scopedSalt(creator, p.salt), factory.launchTokenInitCodeHash(params));
        ClankerV5.SwapDesc[] memory route = new ClankerV5.SwapDesc[](s.quoteToken == address(0) ? 1 : 2);
        if (route.length == 2) {
            DevBuyRoute memory r = devBuyRoute[s.quoteToken];
            route[0] = ClankerV5.SwapDesc({
                swapType: ClankerV5.SWAP_TYPE_UNISWAP_V3,
                tokenIn: weth,
                tokenOut: s.quoteToken,
                poolAddress: r.pool,
                fee: r.fee,
                tickSpacing: 0,
                hooks: address(0),
                hookData: ""
            });
        }
        route[route.length - 1] = ClankerV5.SwapDesc({
            swapType: ClankerV5.SWAP_TYPE_LAUNCH_POOL,
            tokenIn: s.quoteToken,
            tokenOut: predicted,
            poolAddress: address(0),
            fee: 0,
            tickSpacing: spacing,
            hooks: hook,
            hookData: ""
        });
        uint256 amountOut;
        (token, poolId, amountOut) = factory.createLaunchAndBuy{value: clankerFee + p.devBuyWei}(
            params,
            ClankerV5.LaunchBuyParams({
                fundingToken: address(0),
                amountIn: p.devBuyWei,
                minAmountOut: s.minDevBuyOut,
                routeData: abi.encode(route)
            })
        );
        IERC20(token).safeTransfer(creator, amountOut);
    }

    /// @dev Clanker's `LaunchParams` for `p` and `s`. The views pass no slots and no creator (the init code hash
    ///      depends on neither) and Clanker's live config version; `launch` passes the creator's pin, so Clanker
    ///      reverts `StaleConfig` when its policy moved after the creator read it. `creatorSalt` is set by the
    ///      caller; `creator = address(0)` makes this contract the creator-rights holder.
    function _v5Params(
        LaunchParams calldata p,
        TokenSettings calldata s,
        ClankerV5.FeeSlotInput[] memory slots,
        address creator,
        uint64 configVersion
    ) internal view returns (ClankerV5.LaunchParams memory params) {
        // the keys clanker-sdk writes, so clanker.world shows the image and the metadata JSON
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
            tokenContractURI: s.contractURI,
            creatorSalt: bytes32(0),
            quoteToken: s.quoteToken,
            expectedConfigVersion: configVersion,
            deadline: uint64(block.timestamp),
            metadataEditable: s.metadataEditable,
            metadataKeys: keys,
            metadataValues: values,
            taxConfiguration: _taxConfiguration(s),
            // unused for payouts (no slot is the creator slot); must be a valid recipient
            creatorFeeRecipient: creator == address(0) ? agentDefaults.platformRecipient : creator,
            integratorFeeRecipient: address(0),
            antiSnipeEnabled: s.antiSnipe
        });
    }

    function _taxConfiguration(TokenSettings calldata s) internal pure returns (ClankerV5.TaxConfiguration memory) {
        uint32 burnShare = uint32(s.burnBps) * SHARE_MULTIPLIER;
        uint32 dividendShare = uint32(s.dividendBps) * SHARE_MULTIPLIER;
        return ClankerV5.TaxConfiguration({
            buyTaxRate: uint32(s.buyTaxBps) * TAX_RATE_MULTIPLIER,
            sellTaxRate: uint32(s.sellTaxBps) * TAX_RATE_MULTIPLIER,
            creatorAllocationShare: ClankerV5.PERCENTAGE_SCALE - burnShare - dividendShare,
            burnAllocationShare: burnShare,
            dividendAllocationShare: dividendShare,
            integratorAllocationShare: 0,
            minimumDividendHolding: s.minDividendHolding
        });
    }

    function _create2(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
