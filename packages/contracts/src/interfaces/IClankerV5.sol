// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Minimal vendored interfaces of Clanker v5 (the "tax suite"), field for field the verified sources of the
///      Base mainnet deployment on Sourcify (exact matches, verified 2026-11-03, read 2026-11-10):
///      `TaxRWAERC20LaunchpadFactory` `0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0`
///      (`src/tax/TaxLaunchpadFactoryCore.sol`, `TaxRWAERC20LaunchpadFactory.sol`, `TaxFeeMath.sol`),
///      `TaxLaunchHook` `0x5E320eA6278107968C119942E57d876c5F922AcC`, `FeeEscrow`
///      `0x5dd237d1f716C65426CCd2FAe82B95109825FA61`, `SwapXLaunchBuyAdapter`
///      `0x5C65823dC5eaf0C37205F73213fC2f73D359DA4d` (`ISwapX.SwapDesc`), `TaxLaunchToken` (created by
///      `TaxLaunchTokenDeployer` `0xc25FfE6374EdcCb5bFCcA3b9684046a426AbCE6A`), `TaxDividend` (the per-coin
///      dividend tracker, `src/tax/TaxDividend.sol`, `interfaces/ITaxDividend.sol`). Design:
///      docs/design/clanker-v5-migration.md section 1 and docs/design/clanker-v5-token-settings.md section 1.
library ClankerV5 {
    /// @dev `TaxFeeMath.TaxFeeBounds`: tax rates on the 1e8 scale (`PERCENTAGE_SCALE`, 1% = 1_000_000).
    struct TaxFeeBounds {
        uint32 minimumBuyTaxRate;
        uint32 maximumBuyTaxRate;
        uint32 minimumSellTaxRate;
        uint32 maximumSellTaxRate;
    }

    /// @dev Clanker takes `protocolTaxShare` of the tax, clamped to [`minimumProtocolFeeRate`,
    ///      `maximumProtocolFeeRate`] of the trade (live: 10%, 0.5%, 1%).
    struct ProtocolFeeConfiguration {
        uint32 protocolTaxShare;
        uint32 minimumProtocolFeeRate;
        uint32 maximumProtocolFeeRate;
        address protocolFeeRecipient;
    }

    /// @dev Buys in the first `windowSeconds` pay a total fee falling from `startTotalFeeRate` to the tax.
    struct AntiSnipeConfiguration {
        uint32 startTotalFeeRate;
        uint32 windowSeconds;
    }

    struct TaxPolicy {
        TaxFeeBounds taxFeeBounds;
        ProtocolFeeConfiguration protocolFeeConfiguration;
        AntiSnipeConfiguration antiSnipeConfiguration;
        uint256 minimumDividendHoldingRequirement;
    }

    /// @dev The four `*AllocationShare` fields divide the tax left after Clanker's share and must sum to 1e8.
    ///      The burn share is taken in the launched token; the others in the quote currency.
    struct TaxConfiguration {
        uint32 buyTaxRate;
        uint32 sellTaxRate;
        uint32 creatorAllocationShare;
        uint32 burnAllocationShare;
        uint32 dividendAllocationShare;
        uint32 integratorAllocationShare;
        uint256 minimumDividendHolding;
    }

    /// @dev `TaxFeeMath.Rates`, 1e24-scaled rates of a side (`effectiveFeeRates`, `previewTaxConfiguration`).
    struct Rates {
        uint256 quoteRate;
        uint256 burnRate;
        uint256 protocolRate;
        uint256 creatorRate;
        uint256 dividendRate;
        uint256 integratorRate;
        uint256 surchargeRate;
    }

    /// @dev `TaxLaunchHook.FeeSlotInput`: a share (`relativeWeightBps` of 10_000) of the creator allocation. An
    ///      `isCreator` slot follows the factory's creator rights; the others are managed by their `admin`.
    struct FeeSlotInput {
        address recipient;
        address admin;
        uint16 relativeWeightBps;
        bool isCreator;
    }

    /// @dev `TaxLaunchHook.FeeSlot` as stored (`poolFeeSlots`).
    struct FeeSlot {
        address recipient;
        address admin;
        uint16 weightBps;
        bool isCreator;
    }

    /// @dev `TaxLaunchpadFactoryCore.LaunchParams`. `creator == address(0)` means `msg.sender` holds the creator
    ///      rights. `creatorSalt` is scoped by the factory as `keccak256(abi.encode(msg.sender, creatorSalt))`.
    struct LaunchParams {
        address creator;
        FeeSlotInput[] feeSlots;
        string tokenName;
        string tokenSymbol;
        string tokenContractURI;
        bytes32 creatorSalt;
        address quoteToken;
        uint64 expectedConfigVersion;
        uint64 deadline;
        bool metadataEditable;
        string[] metadataKeys;
        string[] metadataValues;
        TaxConfiguration taxConfiguration;
        address creatorFeeRecipient;
        address integratorFeeRecipient;
        bool antiSnipeEnabled;
    }

    /// @dev `TaxLaunchpadFactoryCore.LaunchBuyParams`: `fundingToken == address(0)` funds the buy with
    ///      `msg.value - nativeLaunchFee`; `routeData` is `abi.encode(SwapDesc[])` for the launch-buy adapter.
    struct LaunchBuyParams {
        address fundingToken;
        uint256 amountIn;
        uint256 minAmountOut;
        bytes routeData;
    }

    /// @dev `ISwapX.SwapDesc` of the `SwapXLaunchBuyAdapter`. The final (or only) hop must be
    ///      `{swapType: 2, tokenIn: quote, tokenOut: token, poolAddress: 0, fee: 0, tickSpacing, hooks: hook}`.
    struct SwapDesc {
        uint8 swapType;
        address tokenIn;
        address tokenOut;
        address poolAddress;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    /// @dev `TaxLaunchpadFactoryCore.CreatorRights`.
    struct CreatorRights {
        address originalCreator;
        address currentCreator;
        address pendingCreator;
        address creatorFeeRecipient;
        bytes32 poolId;
        bool metadataEditable;
    }

    /// @dev `SwapDesc.swapType` of the launch pool hop (`UNISWAP_V4_SWAP_TYPE`).
    uint8 internal constant SWAP_TYPE_LAUNCH_POOL = 2;
    /// @dev `SwapDesc.swapType` of an external Uniswap v3 hop (`UNISWAP_V3_SWAP_TYPE`): the first leg of a dev
    ///      buy into an ERC-20-quoted pool (`{1, WETH, quote, v3 pool, fee, 0, address(0), ""}`), funded in ETH.
    uint8 internal constant SWAP_TYPE_UNISWAP_V3 = 1;
    /// @dev `TaxLaunchValidation`: at most seven fee slots per pool.
    uint8 internal constant MAX_FEE_SLOTS = 7;
    /// @dev `TaxSuiteConstants.PERCENTAGE_SCALE`: 100% of a tax rate or an allocation share.
    uint32 internal constant PERCENTAGE_SCALE = 100_000_000;
    /// @dev `TaxSuiteConstants.BURN_SINK`: the burn share's escrow recipient.
    address internal constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;
    /// @dev `TaxRWAERC20LaunchpadFactory.TOKEN_ADDRESS_SUFFIX`: the low 16 bits every v5 token address carries.
    uint16 internal constant TOKEN_ADDRESS_SUFFIX = 0xcccc;
}

/// @dev `TaxRWAERC20LaunchpadFactory` (the parts the launcher, the tests and the deploy script use).
interface IClankerV5Factory {
    event Launched(
        address indexed token,
        bytes32 indexed poolId,
        address indexed originalCreator,
        address quoteToken,
        uint256 launchSupply,
        int24 tickSpacing
    );
    /// @notice The tax configuration a launch was created with (and the policy it was admitted under).
    event LaunchTaxConfigured(
        bytes32 indexed poolId,
        address indexed token,
        uint64 indexed configVersion,
        ClankerV5.TaxPolicy admittedPolicy,
        ClankerV5.TaxConfiguration taxConfiguration,
        address integratorFeeRecipient,
        bool antiSnipeEnabled
    );
    event LaunchBuyExecuted(
        address indexed token,
        bytes32 indexed poolId,
        address indexed originalCreator,
        address fundingToken,
        uint256 amountIn,
        uint256 amountOut,
        address launchBuyAdapter
    );

    error StaleConfig(uint64 expectedConfigVersion, uint64 actualConfigVersion);
    error LaunchExpired(uint64 deadline);
    error InvalidTokenAddressSuffix(address predictedToken);
    error LaunchSaltUsed(bytes32 scopedSalt);
    error QuoteNotRegistered();
    error LaunchCreationDisabled();
    error LaunchBuyAdapterNotConfigured();
    error InvalidTaxConfiguration();
    error NotCurrentCreator();
    error MetadataNotEditable();
    error UnknownLaunchToken();
    error InvalidMinimumDividendHoldingRequirement();
    error AntiSnipeUnavailable();

    function createLaunch(ClankerV5.LaunchParams calldata launchParams)
        external
        payable
        returns (address token, bytes32 poolId);
    function createLaunchAndBuy(
        ClankerV5.LaunchParams calldata launchParams,
        ClankerV5.LaunchBuyParams calldata launchBuyParams
    ) external payable returns (address token, bytes32 poolId, uint256 amountOut);
    function launchTokenInitCodeHash(ClankerV5.LaunchParams calldata launchParams)
        external
        view
        returns (bytes32 initCodeHash);
    function previewTaxConfiguration(ClankerV5.TaxConfiguration calldata configuration)
        external
        view
        returns (
            uint64 configVersion,
            ClankerV5.Rates memory buyRates,
            ClankerV5.Rates memory sellRates,
            bool dividendsEnabled,
            uint256 minimumDividendHoldingRequirement
        );

    function configVersion() external view returns (uint64);
    function nativeLaunchFee() external view returns (uint256);
    function launchSupply() external view returns (uint256);
    function tickSpacing() external view returns (int24);
    function launchCreationEnabled() external view returns (bool);
    function launchBuyAdapter() external view returns (address);
    function hook() external view returns (address);
    function tokenDeployer() external view returns (address);
    function poolManager() external view returns (address);
    function announcementRegistry() external view returns (address);
    function owner() external view returns (address);
    function taxPolicy() external view returns (ClankerV5.TaxPolicy memory);
    function quoteConfig(address quoteToken)
        external
        view
        returns (bool registered, uint8 quoteDecimals, int24 startTickToken0Frame);
    function creatorRights(address token) external view returns (ClankerV5.CreatorRights memory);
    function isLaunchToken(address token) external view returns (bool);
    function isLaunchSaltUsed(bytes32 scopedSalt) external view returns (bool);

    // creator-rights functions (the launcher holds the rights and exposes none of them)
    function setCreatorFeeRecipient(address token, address newCreatorFeeRecipient) external;
    function proposeCreatorRightsTransfer(address token, address newCreator) external;
    /// @dev Metadata functions: only the current creator-rights holder, and only when the launch was
    ///      `metadataEditable` (`_requireMetadataEditor`). One switch covers all four. The launcher forwards only
    ///      `updateTokenExtraMetadata` for the keys `image` and `metadata`.
    function updateTokenName(address token, string calldata newName) external;
    function updateTokenSymbol(address token, string calldata newSymbol) external;
    function updateTokenContractURI(address token, string calldata newContractURI) external;
    function updateTokenExtraMetadata(address token, string calldata metadataKey, string calldata metadataValue)
        external;

    /// @dev The coin's `TaxDividend` tracker (`address(0)` when the launch had no dividend share).
    function dividendOf(address token) external view returns (address);
}

/// @dev `TaxLaunchHook` (the parts the launcher, the indexer and the tests use).
interface IClankerV5Hook {
    struct PoolConfig {
        bool initialized;
        bool tokenIsCurrency0;
        address token;
        address quoteToken;
        address currentCreator;
        address creatorFeeRecipient;
        ClankerV5.ProtocolFeeConfiguration protocolFeeConfiguration;
        ClankerV5.AntiSnipeConfiguration antiSnipeConfiguration;
        uint48 launchTime;
        bool antiSnipeEnabled;
        address integratorFeeRecipient;
        address dividend;
        ClankerV5.TaxConfiguration taxConfiguration;
    }

    event FeeSlotCreated(
        bytes32 indexed poolId,
        uint256 indexed slotIndex,
        address recipient,
        address admin,
        uint16 weightBps,
        bool isCreator
    );
    event PoolRegistered(bytes32 indexed poolId, address indexed originalCreator, address indexed creatorFeeRecipient);
    event Seeded(bytes32 indexed poolId, uint256 tokenAmountSeeded);
    /// @notice One per registered-pool swap: `quoteFeeAmount` is the whole quote-side tax (Clanker's share and
    ///         the anti-snipe surcharge included); the burn share is `BurnTaxCredited`.
    event Trade(
        bytes32 indexed poolId,
        address indexed executor,
        address indexed referrer,
        address quoteCurrency,
        uint256 quoteFeeAmount,
        bytes32 comment
    );
    event ProtocolFeeCredited(bytes32 indexed poolId, address indexed recipient, address currency, uint256 amount);
    event AntiSnipeFeeCredited(bytes32 indexed poolId, address indexed recipient, address currency, uint256 amount);
    /// @notice One per fee slot per swap: the slot's exact share of the creator allocation, in the quote.
    event CreatorTaxCredited(bytes32 indexed poolId, address indexed recipient, address currency, uint256 amount);
    /// @notice The burn share of a swap, in the launched token, credited to `BURN_SINK` in the escrow.
    event BurnTaxCredited(bytes32 indexed poolId, address indexed token, address indexed sink, uint256 amount);
    /// @notice The dividend share of a swap, in the quote, credited in the escrow to the coin's tracker.
    event DividendTaxCredited(bytes32 indexed poolId, address indexed dividend, address currency, uint256 amount);
    /// @notice The dividend share of a swap while no holder qualifies (`totalShares() == 0`): paid to Clanker.
    event DividendTaxRedirected(
        bytes32 indexed poolId, address indexed recipient, address indexed currency, uint256 amount
    );
    event FeeSlotRecipientUpdated(
        bytes32 indexed poolId, uint256 indexed slotIndex, address oldRecipient, address newRecipient
    );
    event FeeSlotAdminUpdated(bytes32 indexed poolId, uint256 indexed slotIndex, address oldAdmin, address newAdmin);

    error NotSlotAdmin();
    error CreatorSlotManagedByFactory();
    error ExactOutputDisabledDuringAntiSnipe();

    function factory() external view returns (address);
    function feeEscrow() external view returns (address);
    function launchBuyAdapter() external view returns (address);
    function poolManager() external view returns (address);
    /// @dev Flattened tuple of `PoolConfig` (the public mapping getter).
    function poolConfig(bytes32 poolId)
        external
        view
        returns (
            bool initialized,
            bool tokenIsCurrency0,
            address token,
            address quoteToken,
            address currentCreator,
            address creatorFeeRecipient,
            ClankerV5.ProtocolFeeConfiguration memory protocolFeeConfiguration,
            ClankerV5.AntiSnipeConfiguration memory antiSnipeConfiguration,
            uint48 launchTime,
            bool antiSnipeEnabled,
            address integratorFeeRecipient,
            address dividend,
            ClankerV5.TaxConfiguration memory taxConfiguration
        );
    function poolFeeSlots(bytes32 poolId) external view returns (ClankerV5.FeeSlot[] memory);
    function effectiveFeeRates(bytes32 poolId, bool isBuy)
        external
        view
        returns (ClankerV5.Rates memory rate, bool exactOutputRestricted);
    function updateFeeSlotRecipient(bytes32 poolId, uint256 slotIndex, address newRecipient) external;
    function updateFeeSlotAdmin(bytes32 poolId, uint256 slotIndex, address newAdmin) external;
}

/// @dev `FeeEscrow`: one balance per (recipient, currency) across every v5 pool; `currency == address(0)` is
///      native ETH. `claimFor` is permissionless and always pays `recipient`.
interface IClankerV5FeeEscrow {
    event Credited(address indexed recipient, address indexed currency, uint256 amount);
    event Claimed(address indexed recipient, address indexed currency, address indexed destination, uint256 amount);

    error NothingToClaim();

    function hook() external view returns (address);
    function owed(address recipient, address currency) external view returns (uint256);
    function claimFor(address recipient, address currency) external;
    function claimTo(address currency, address destination) external;
}

/// @dev `TaxLaunchToken`: fixed supply, no admin; metadata frozen unless the launch was `metadataEditable` (then
///      the factory is the `metadataAuthority` and forwards its creator-rights holder's edits).
interface IClankerV5Token {
    event ContractURIUpdated(address indexed updater, string newContractURI);
    event NameUpdated(address indexed updater, string newName);
    event SymbolUpdated(address indexed updater, string newSymbol);
    event ExtraMetadataUpdated(address indexed updater, string metadataKey, string metadataValue);

    function factory() external view returns (address);
    function dividend() external view returns (address);
    function contractURI() external view returns (string memory);
    function extraMetadata(string calldata key) external view returns (string memory);
    function metadataAuthority() external view returns (address);
    function supplyCap() external view returns (uint256);
}

/// @dev `TaxDividend`: the per-coin holder-dividend tracker (cloned at launch when `dividendAllocationShare > 0`,
///      owner = the factory). Shares follow balances at or above `minimumDividendHolding`; paid in the quote.
interface IClankerV5Dividend {
    function taxToken() external view returns (address);
    function rewardToken() external view returns (address);
    function minimumDividendHolding() external view returns (uint256);
    function totalShares() external view returns (uint256);
    function withdrawDividends() external returns (bool paid);
    function withdrawableDividendOf(address holder) external view returns (uint256);
    function excludedFromDividends(address holder) external view returns (bool);
}
