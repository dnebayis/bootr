// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {BootrClankerLauncherV5} from "../../src/BootrClankerLauncherV5.sol";
import {ClankerV5, IClankerV5Factory} from "../../src/interfaces/IClankerV5.sol";
import {KernelLib} from "../../src/interfaces/IKernel.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4.sol";

/// @dev The factory surface the unit tests reach: the live config version, the tick spacing, the metadata
///      forwarder (recorded), and an init-code-hash view that answers with the config version it was handed.
contract MockClankerV5Factory {
    address public lastToken;
    string public lastKey;
    string public lastValue;
    uint256 public edits;

    function configVersion() external pure returns (uint64) {
        return 7;
    }

    function tickSpacing() external pure returns (int24) {
        return 200;
    }

    function launchTokenInitCodeHash(ClankerV5.LaunchParams calldata lp) external pure returns (bytes32) {
        return bytes32(uint256(lp.expectedConfigVersion));
    }

    function updateTokenExtraMetadata(address token, string calldata key, string calldata value) external {
        lastToken = token;
        lastKey = key;
        lastValue = value;
        ++edits;
    }
}

/// @dev Uniswap v3's `getPool`: the pools the test registers, order-insensitive, zero for none.
contract MockUniswapV3Factory {
    mapping(bytes32 => address) internal _pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        _pools[_key(a, b, fee)] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return _pools[_key(a, b, fee)];
    }

    function _key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(lo, hi, fee));
    }
}

/// @dev Exposes the launcher's internals that the unit tests check without a Clanker deployment: a coin's
///      records (normally written by `launch`) and the Clanker `LaunchParams` the launcher builds.
contract LauncherV5Harness is BootrClankerLauncherV5 {
    constructor(address owner_, Deps memory deps, AgentDefaults memory d, uint16 minPlatformBps_)
        BootrClankerLauncherV5(owner_, deps, d, minPlatformBps_)
    {}

    function seedCoin(address token, address creator, address quote, bool editable) external {
        coinCreator[token] = creator;
        quoteOf[token] = quote;
        metadataEditable[token] = editable;
    }

    function exposedV5Params(LaunchParams calldata p, TokenSettings calldata s, address kernel, address creator)
        external
        view
        returns (ClankerV5.LaunchParams memory)
    {
        AgentDefaults memory d = agentDefaults;
        uint16[] memory w = _slotWeights(s, d);
        return _v5Params(p, s, _feeSlots(s, w, kernel, d.platformRecipient), creator, s.expectedConfigVersion);
    }
}

/// @dev No-fork unit tests for BootrClankerLauncherV5: the agent defaults and their bounds, the paired-asset
///      allow-list per launch kind, every per-launch rule of the token settings (tax bounds, share sums, reward
///      rows and their admins, the dividend minimum), the slot weights and their rounding, the Clanker parameters
///      built from the settings (sniper switch, editable metadata, contract URI), and the creator-only image and
///      metadata edits with the lock. Launches run on the mainnet fork (test/fork/ClankerV5Fork.t.sol).
contract ClankerLauncherV5Test is Test {
    LauncherV5Harness launcher;
    MockClankerV5Factory factory;
    MockUniswapV3Factory v3Factory;
    address weth = makeAddr("weth");
    address owner = makeAddr("owner");
    address platform = makeAddr("platform");
    address guardian = makeAddr("guardian");
    address hook = makeAddr("hook");
    address creator = makeAddr("creator");
    address stranger = makeAddr("stranger");
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant NATIVE = address(0);
    BootrClankerLauncherV5.LaunchKind constant AGENT = BootrClankerLauncherV5.LaunchKind.Agent;
    BootrClankerLauncherV5.LaunchKind constant PLAIN = BootrClankerLauncherV5.LaunchKind.Plain;

    function _deps() internal returns (BootrClankerLauncherV5.Deps memory d) {
        d = BootrClankerLauncherV5.Deps({
            factory: address(factory),
            hook: hook,
            feeEscrow: makeAddr("feeEscrow"),
            weth: weth,
            uniswapV3Factory: address(v3Factory),
            usdc: USDC,
            identityRegistry: makeAddr("identity"),
            kernelFactory: makeAddr("kernelFactory"),
            guardian: guardian,
            gate: makeAddr("gate")
        });
    }

    function _defaults() internal view returns (BootrClankerLauncherV5.AgentDefaults memory) {
        return BootrClankerLauncherV5.AgentDefaults({
            agentShareBps: 500,
            platformShareBps: 3000,
            platformRecipient: platform,
            minFuelUsdc: 25e6,
            dormancyPeriod: 90 days,
            minTaxBps: 10_000,
            maxTaxBps: 50_000,
            maxRewardRows: 5
        });
    }

    function setUp() public {
        factory = new MockClankerV5Factory();
        v3Factory = new MockUniswapV3Factory();
        launcher = new LauncherV5Harness(owner, _deps(), _defaults(), 1000);
        vm.startPrank(owner);
        launcher.setQuoteAllowed(AGENT, NATIVE, true);
        launcher.setQuoteAllowed(AGENT, USDC, true);
        vm.stopPrank();
    }

    /// @dev The recommended settings (design note section 2.3): ETH, 1.5% both ways, all to creator funds, one
    ///      row (the creator, admin the creator), sniper tax on, editable metadata; pinned to the mock factory's
    ///      config version.
    function _settings() internal view returns (BootrClankerLauncherV5.TokenSettings memory s) {
        s.quoteToken = NATIVE;
        s.expectedConfigVersion = 7;
        s.buyTaxBps = 15_000;
        s.sellTaxBps = 15_000;
        s.rewards = new BootrClankerLauncherV5.RewardInput[](1);
        s.rewards[0] = BootrClankerLauncherV5.RewardInput({recipient: creator, admin: creator, bps: 10_000});
        s.antiSnipe = true;
        s.metadataEditable = true;
        s.contractURI = "https://bootr.fun/tokens/launch-1.json";
    }

    function _rows(uint256 n) internal returns (BootrClankerLauncherV5.RewardInput[] memory rows) {
        rows = new BootrClankerLauncherV5.RewardInput[](n);
        uint16 each = uint16(10_000 / n);
        for (uint256 i; i < n; ++i) {
            address who = makeAddr(string.concat("row", vm.toString(i)));
            rows[i] = BootrClankerLauncherV5.RewardInput({recipient: who, admin: who, bps: each});
        }
        rows[0].bps += uint16(10_000 - uint256(each) * n);
    }

    function _params() internal pure returns (BootrClankerLauncherV5.LaunchParams memory p) {
        p.name = "Agent";
        p.symbol = "AGT";
        p.image = "https://bootr.fun/images/a.png";
        p.metadata = '{"description":"an agent","socialMediaUrls":[],"auditUrls":[]}';
        p.context = '{"interface":"Bootr","platform":"bootr.fun","id":"draft-1"}';
        p.fuelUsdc = 25e6;
    }

    function _weights(BootrClankerLauncherV5.TokenSettings memory s) internal view returns (uint16[] memory) {
        return launcher.previewSlotWeights(s);
    }

    function _expectWeightsRevert(BootrClankerLauncherV5.TokenSettings memory s, bytes memory err) internal {
        vm.expectRevert(err);
        launcher.previewSlotWeights(s);
    }

    // ------------------------------------------------------------------
    // Defaults and constants
    // ------------------------------------------------------------------

    function test_defaultsAndConstants() public view {
        (uint16 a, uint16 p, address r, uint256 f, uint32 d, uint24 lo, uint24 hi, uint8 rows) =
            launcher.agentDefaults();
        assertEq(a, 500, "agent 5% of the post-Clanker pool");
        assertEq(p, 3000, "platform 30%");
        assertEq(r, platform);
        assertEq(f, 25e6);
        assertEq(d, 90 days);
        assertEq(lo, 10_000, "1% per side");
        assertEq(hi, 50_000, "5% per side");
        assertEq(rows, 5, "the creator's row and four extras");
        assertEq(launcher.minPlatformBps(), 1000);
        assertEq(launcher.MIN_AGENT_SHARE_BPS(), 500);
        assertEq(launcher.MAX_LOCKED_SHARE_BPS(), 5000);
        assertEq(launcher.MAX_REWARD_ROWS(), 5, "7 Clanker slots - agent - platform");
        assertEq(launcher.MAX_TAX_CEILING_BPS(), 100_000);
        assertEq(launcher.launchFeeWei(), 0);
        assertEq(launcher.owner(), owner);
        assertEq(launcher.ROOT_VALIDATION_ID(), KernelLib.validatorId(guardian));
        assertEq(launcher.DEAD(), 0x000000000000000000000000000000000000dEaD);
    }

    function test_constructorRejectsZeroDepsAndBadDefaults() public {
        BootrClankerLauncherV5.Deps memory d = _deps();
        d.factory = address(0);
        vm.expectRevert(BootrClankerLauncherV5.ZeroAddress.selector);
        new BootrClankerLauncherV5(owner, d, _defaults(), 1000);
        d = _deps();
        d.weth = address(0);
        vm.expectRevert(BootrClankerLauncherV5.ZeroAddress.selector);
        new BootrClankerLauncherV5(owner, d, _defaults(), 1000);
        d = _deps();
        d.uniswapV3Factory = address(0);
        vm.expectRevert(BootrClankerLauncherV5.ZeroAddress.selector);
        new BootrClankerLauncherV5(owner, d, _defaults(), 1000);
        vm.expectRevert(BootrClankerLauncherV5.InvalidMinPlatformBps.selector);
        new BootrClankerLauncherV5(owner, _deps(), _defaults(), 5001);
        BootrClankerLauncherV5.AgentDefaults memory bad = _defaults();
        bad.agentShareBps = 499;
        vm.expectRevert(BootrClankerLauncherV5.InvalidAgentShare.selector);
        new BootrClankerLauncherV5(owner, _deps(), bad, 1000);
    }

    // ------------------------------------------------------------------
    // Agent defaults: owner-settable within the design note's bounds (section 2.2)
    // ------------------------------------------------------------------

    function _setDefaultsExpect(BootrClankerLauncherV5.AgentDefaults memory d, bytes4 err) internal {
        vm.prank(owner);
        vm.expectRevert(err);
        launcher.setAgentDefaults(d);
    }

    function test_setAgentDefaultsBounds() public {
        BootrClankerLauncherV5.AgentDefaults memory d = _defaults();
        d.agentShareBps = 499;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidAgentShare.selector);
        d = _defaults();
        d.platformShareBps = 999;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidPlatformShare.selector);
        d = _defaults();
        d.agentShareBps = 2001;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidPlatformShare.selector); // 2001 + 3000 > 5000
        d = _defaults();
        d.minTaxBps = 0;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidTaxBounds.selector);
        d = _defaults();
        d.minTaxBps = 50_001;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidTaxBounds.selector);
        d = _defaults();
        d.maxTaxBps = 100_001;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidTaxBounds.selector);
        d = _defaults();
        d.maxRewardRows = 0;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidRewardRowLimit.selector);
        d.maxRewardRows = 6;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidRewardRowLimit.selector);
        d = _defaults();
        d.dormancyPeriod = 29 days;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidDormancyPeriod.selector);
        d = _defaults();
        d.platformRecipient = address(0);
        _setDefaultsExpect(d, BootrClankerLauncherV5.ZeroAddress.selector);

        // the extremes are accepted: agent 20%, platform 30% (sum 50%); tax 0.5%..10%
        d = _defaults();
        d.agentShareBps = 2000;
        d.minTaxBps = 5000;
        d.maxTaxBps = 100_000;
        d.maxRewardRows = 1;
        vm.expectEmit(address(launcher));
        emit BootrClankerLauncherV5.AgentDefaultsUpdated(d);
        vm.prank(owner);
        launcher.setAgentDefaults(d);
        (uint16 a,,,,, uint24 lo, uint24 hi, uint8 rows) = launcher.agentDefaults();
        assertEq(a, 2000);
        assertEq(lo, 5000);
        assertEq(hi, 100_000);
        assertEq(rows, 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launcher.setAgentDefaults(_defaults());
    }

    function test_minPlatformBpsGuardsThePlatformShare() public {
        vm.prank(owner);
        launcher.setMinPlatformBps(3500);
        BootrClankerLauncherV5.AgentDefaults memory d = _defaults();
        d.platformShareBps = 3499;
        _setDefaultsExpect(d, BootrClankerLauncherV5.InvalidPlatformShare.selector);
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.InvalidMinPlatformBps.selector);
        launcher.setMinPlatformBps(5001);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launcher.setMinPlatformBps(0);
    }

    function test_newDefaultsApplyToFutureWeightsOnly() public {
        BootrClankerLauncherV5.AgentDefaults memory d = _defaults();
        d.agentShareBps = 1000;
        d.platformShareBps = 2500;
        vm.prank(owner);
        launcher.setAgentDefaults(d);
        uint16[] memory w = _weights(_settings());
        assertEq(w[0], 1000);
        assertEq(w[1], 2500);
        assertEq(w[2], 6500);
    }

    // ------------------------------------------------------------------
    // Paired-asset allow-list per launch kind
    // ------------------------------------------------------------------

    function test_allowListPerKind() public {
        assertTrue(launcher.allowedQuote(AGENT, NATIVE));
        assertTrue(launcher.allowedQuote(AGENT, USDC));
        assertFalse(launcher.allowedQuote(PLAIN, NATIVE), "the plain kind is a reserved, empty list");

        address cbBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.quoteToken = cbBTC;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.QuoteNotAllowed.selector, cbBTC));

        // allowing an asset for plain tokens does not admit it for agent coins
        vm.expectEmit(address(launcher));
        emit BootrClankerLauncherV5.QuoteAllowedUpdated(PLAIN, cbBTC, true);
        vm.prank(owner);
        launcher.setQuoteAllowed(PLAIN, cbBTC, true);
        assertTrue(launcher.allowedQuote(PLAIN, cbBTC));
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.QuoteNotAllowed.selector, cbBTC));

        // and removing USDC for agent coins refuses USDC launches
        vm.prank(owner);
        launcher.setQuoteAllowed(AGENT, USDC, false);
        s.quoteToken = USDC;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.QuoteNotAllowed.selector, USDC));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launcher.setQuoteAllowed(AGENT, cbBTC, true);
    }

    function test_devBuyRouteAdmin() public {
        address pool = makeAddr("pool");
        v3Factory.setPool(weth, USDC, 500, pool);
        assertEq(address(launcher.uniswapV3Factory()), address(v3Factory));
        assertEq(launcher.MAX_DEV_BUY_ROUTE_FEE(), 3000, "0.3% at most");
        vm.expectEmit(address(launcher));
        emit BootrClankerLauncherV5.DevBuyRouteUpdated(USDC, pool, 500);
        vm.prank(owner);
        launcher.setDevBuyRoute(USDC, pool, 500);
        (address p, uint24 fee) = launcher.devBuyRoute(USDC);
        assertEq(p, pool);
        assertEq(fee, 500);
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.ZeroAddress.selector);
        launcher.setDevBuyRoute(NATIVE, pool, 500);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launcher.setDevBuyRoute(USDC, address(0), 0);
    }

    /// @dev A route must be the Uniswap v3 factory's own WETH / quote pool at that fee, at a fee of 0.3% or less:
    ///      a mistyped pool, a pool of another pair or tier, and the 1% tier are refused by the setter.
    function test_devBuyRouteMustBeTheFactoryPoolWithinTheFeeBound() public {
        address pool = makeAddr("pool");
        address other = makeAddr("otherPool");
        address cbBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
        v3Factory.setPool(weth, USDC, 500, pool);
        v3Factory.setPool(weth, USDC, 3000, other);
        v3Factory.setPool(weth, USDC, 10_000, makeAddr("onePercentPool"));
        v3Factory.setPool(weth, cbBTC, 500, makeAddr("cbBtcPool"));
        vm.startPrank(owner);

        // not a pool of the factory at all (a typo), or the factory's pool of another tier or another pair
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteNotFactoryPool.selector);
        launcher.setDevBuyRoute(USDC, makeAddr("typo"), 500);
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteNotFactoryPool.selector);
        launcher.setDevBuyRoute(USDC, other, 500);
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteNotFactoryPool.selector);
        launcher.setDevBuyRoute(USDC, makeAddr("cbBtcPool"), 500);
        // a tier with no pool: the factory answers address(0), which is not the pool given
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteNotFactoryPool.selector);
        launcher.setDevBuyRoute(USDC, pool, 100);

        // the fee bound: 0 and anything above 0.3%, even when the pool is the factory's
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteFeeOutOfBounds.selector);
        launcher.setDevBuyRoute(USDC, pool, 0);
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteFeeOutOfBounds.selector);
        launcher.setDevBuyRoute(USDC, makeAddr("onePercentPool"), 10_000);
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteFeeOutOfBounds.selector);
        launcher.setDevBuyRoute(USDC, other, 3001);

        // the edge of the bound is accepted
        launcher.setDevBuyRoute(USDC, other, 3000);
        (address p, uint24 fee) = launcher.devBuyRoute(USDC);
        assertEq(p, other);
        assertEq(fee, 3000);

        // clearing needs no pool and stores no fee, whatever fee is passed
        vm.expectEmit(address(launcher));
        emit BootrClankerLauncherV5.DevBuyRouteUpdated(USDC, address(0), 0);
        launcher.setDevBuyRoute(USDC, address(0), 500);
        (p, fee) = launcher.devBuyRoute(USDC);
        assertEq(p, address(0));
        assertEq(fee, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Tax bounds per side
    // ------------------------------------------------------------------

    function test_taxBoundsPerSide() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.buyTaxBps = 9_999;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.TaxOutOfBounds.selector));
        s.buyTaxBps = 50_001;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.TaxOutOfBounds.selector));
        s = _settings();
        s.sellTaxBps = 9_999;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.TaxOutOfBounds.selector));
        s.sellTaxBps = 50_001;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.TaxOutOfBounds.selector));
        // the edges, and buy != sell
        s.buyTaxBps = 10_000;
        s.sellTaxBps = 50_000;
        _weights(s);
        ClankerV5.TaxConfiguration memory t = launcher.taxConfigurationFor(s);
        assertEq(t.buyTaxRate, 1_000_000, "1% on Clanker's 1e8 scale");
        assertEq(t.sellTaxRate, 5_000_000, "5%");
    }

    // ------------------------------------------------------------------
    // Shares: burn, dividends, creator funds; the dividend minimum
    // ------------------------------------------------------------------

    function test_taxConfigurationCarriesBurnAndDividends() public view {
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        ClankerV5.TaxConfiguration memory t = launcher.taxConfigurationFor(s);
        assertEq(t.buyTaxRate, 1_500_000);
        assertEq(t.sellTaxRate, 1_500_000);
        assertEq(t.creatorAllocationShare, 100_000_000, "everything after Clanker to the slots");
        assertEq(t.burnAllocationShare + t.dividendAllocationShare + t.integratorAllocationShare, 0);
        assertEq(t.minimumDividendHolding, 0);

        s.burnBps = 1500;
        s.dividendBps = 2000;
        s.minDividendHolding = 10_000e18;
        t = launcher.taxConfigurationFor(s);
        assertEq(t.burnAllocationShare, 15_000_000);
        assertEq(t.dividendAllocationShare, 20_000_000);
        assertEq(t.creatorAllocationShare, 65_000_000, "agent + platform + creator funds");
        assertEq(t.integratorAllocationShare, 0, "no integrator share, ever");
        assertEq(t.minimumDividendHolding, 10_000e18);
        assertEq(
            uint256(t.creatorAllocationShare) + t.burnAllocationShare + t.dividendAllocationShare,
            ClankerV5.PERCENTAGE_SCALE
        );
    }

    function test_sharesMayNotExceedThePool() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.burnBps = 3000;
        s.dividendBps = 3501; // 500 + 3000 + 6501 > 10_000
        s.minDividendHolding = 10_000e18;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.SharesExceedPool.selector));
        s.burnBps = 6501;
        s.dividendBps = 0;
        s.minDividendHolding = 0;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.SharesExceedPool.selector));
    }

    function test_dividendMinimumIffDividends() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.dividendBps = 1000;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.DividendHoldingMismatch.selector));
        s.dividendBps = 0;
        s.minDividendHolding = 10_000e18;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.DividendHoldingMismatch.selector));
        s.dividendBps = 1000;
        _weights(s);
    }

    // ------------------------------------------------------------------
    // Slot weights: order, rounding, sums (design note section 2.2 examples)
    // ------------------------------------------------------------------

    function test_weightsAllToCreatorFunds() public view {
        uint16[] memory w = _weights(_settings());
        assertEq(w.length, 3, "agent, platform, the creator's row");
        assertEq(w[0], 500);
        assertEq(w[1], 3000);
        assertEq(w[2], 6500);
    }

    function test_weightsBurnAndDividendsTakeTheWholeRest() public {
        // burn 30% + dividends 35%: P = 3500, weights 1429 / 8571, no creator rows allowed
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.burnBps = 3000;
        s.dividendBps = 3500;
        s.minDividendHolding = 10_000e18;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardCount.selector));
        s.rewards = new BootrClankerLauncherV5.RewardInput[](0);
        uint16[] memory w = _weights(s);
        assertEq(w.length, 2);
        assertEq(w[0], 1429, "agent rounded up: 5.0015% of the pool");
        assertEq(w[1], 8571, "platform rounded down: 29.9985%");
    }

    function test_weightsWithBurnRoundAgentUpAndPlatformDown() public view {
        // buyback-like: burn 15%, P = 8500: agent 588.2 -> 589, platform 3529.4 -> 3529, creator 5882
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.burnBps = 1500;
        uint16[] memory w = _weights(s);
        assertEq(w[0], 589);
        assertEq(w[1], 3529);
        assertEq(w[2], 5882);
        assertGe(uint256(w[0]) * 8500, 500 * 10_000, "agent never under its floor");
        assertLe(uint256(w[1]) * 8500, 3000 * 10_000, "platform never over its share");
    }

    function test_weightsFiveRowsSplitTheRestWithTheLeftoverToRowZero() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.burnBps = 1000;
        s.dividendBps = 1000;
        s.minDividendHolding = 10_000e18;
        s.rewards = _rows(5);
        s.rewards[0].bps = 4000;
        s.rewards[1].bps = 1500;
        s.rewards[2].bps = 1500;
        s.rewards[3].bps = 1500;
        s.rewards[4].bps = 1500;
        // P = 8000: agent 625 (exact), platform 3750 (exact), rest 5625
        uint16[] memory w = _weights(s);
        assertEq(w.length, 7, "Clanker's seven slots");
        assertEq(w[0], 625);
        assertEq(w[1], 3750);
        // rows: 5625 * 0.15 = 843.75 -> 843 each; row 0: 2250 + the leftover 3
        assertEq(w[3], 843);
        assertEq(w[6], 843);
        assertEq(w[2], 2250 + 3);
        uint256 sum;
        for (uint256 i; i < w.length; ++i) sum += w[i];
        assertEq(sum, 10_000);
    }

    function testFuzz_weightsAlwaysSumAndRespectTheFloors(uint16 burn, uint16 dividends, uint8 rowCount, uint16 seed)
        public
    {
        burn = uint16(bound(burn, 0, 6500));
        dividends = uint16(bound(dividends, 0, 6500 - burn));
        uint256 pool = 10_000 - uint256(burn) - dividends;
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.burnBps = burn;
        s.dividendBps = dividends;
        s.minDividendHolding = dividends == 0 ? 0 : 10_000e18;
        if (pool == 3500) {
            s.rewards = new BootrClankerLauncherV5.RewardInput[](0);
        } else {
            s.rewards = _rows(bound(rowCount, 1, 5));
            // an uneven split: move up to half of row 0 to the last row
            uint16 moved = uint16(bound(seed, 0, s.rewards[0].bps / 2));
            if (s.rewards.length > 1) {
                s.rewards[0].bps -= moved;
                s.rewards[s.rewards.length - 1].bps += moved;
            }
        }
        uint16[] memory w;
        try launcher.previewSlotWeights(s) returns (uint16[] memory out) {
            w = out;
        } catch (bytes memory err) {
            // the only refusal a valid split may hit: a row too small to get one unit of weight
            assertEq(bytes4(err), BootrClankerLauncherV5.ZeroSlotWeight.selector);
            return;
        }
        uint256 sum;
        for (uint256 i; i < w.length; ++i) {
            assertGt(w[i], 0, "every slot weighs at least 1");
            sum += w[i];
        }
        assertEq(sum, 10_000, "weights sum to 10000 (Clanker's check)");
        assertEq(w.length, 2 + s.rewards.length);
        assertGe(uint256(w[0]) * pool, 500 * 10_000, "agent at least 5% of the post-Clanker pool");
        assertLe(uint256(w[1]) * pool, 3000 * 10_000, "platform at most 30%");
        assertLt(uint256(w[0]) * pool, 500 * 10_000 + pool, "agent rounded up by less than one weight unit");
    }

    function test_zeroWeightRowRefused() public {
        // creator funds 0.01%: P = 3501, rest = 3; a 0.01% row gets 0 weight
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.burnBps = 6499;
        s.rewards = _rows(2);
        s.rewards[0].bps = 9999;
        s.rewards[1].bps = 1;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.ZeroSlotWeight.selector));
        s.rewards = _rows(1);
        uint16[] memory w = _weights(s);
        assertEq(w[0], 1429);
        assertEq(w[1], 8568);
        assertEq(w[2], 3);
    }

    // ------------------------------------------------------------------
    // Reward rows: count, sums, admins
    // ------------------------------------------------------------------

    function test_rowCount() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.rewards = new BootrClankerLauncherV5.RewardInput[](0);
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardCount.selector));
        s.rewards = _rows(6);
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardCount.selector));
        s.rewards = _rows(5);
        assertEq(_weights(s).length, 7, "the creator's row and four extras");
        BootrClankerLauncherV5.AgentDefaults memory d = _defaults();
        d.maxRewardRows = 3;
        vm.prank(owner);
        launcher.setAgentDefaults(d);
        s.rewards = _rows(4);
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardCount.selector));
        s.rewards = _rows(3);
        _weights(s);
    }

    function test_rowSums() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.rewards = _rows(2);
        s.rewards[1].bps -= 1;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardBps.selector));
        s.rewards[1].bps += 2;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardBps.selector));
        s.rewards = _rows(2);
        s.rewards[0].bps = 10_000;
        s.rewards[1].bps = 0;
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardBps.selector));
    }

    function test_rowAdminsAndRecipients() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.rewards = _rows(2);
        s.rewards[1].admin = address(launcher);
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardAdmin.selector));
        s.rewards[1].admin = address(0);
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardAdmin.selector));
        s.rewards = _rows(2);
        s.rewards[0].recipient = address(launcher);
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardRecipient.selector));
        s.rewards[0].recipient = address(0);
        _expectWeightsRevert(s, abi.encodeWithSelector(BootrClankerLauncherV5.InvalidRewardRecipient.selector));
        // a row's admin may differ from its recipient (the Rewards panel's "admin" column)
        s.rewards = _rows(2);
        s.rewards[1].admin = stranger;
        _weights(s);
    }

    // ------------------------------------------------------------------
    // The Clanker parameters built from the settings
    // ------------------------------------------------------------------

    function test_v5ParamsSlotsInOrderWithLockedAdmins() public {
        address kernel = makeAddr("kernel");
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.rewards = _rows(3);
        s.rewards[2].admin = stranger;
        ClankerV5.LaunchParams memory v = launcher.exposedV5Params(_params(), s, kernel, creator);
        assertEq(v.feeSlots.length, 5);
        assertEq(v.feeSlots[0].recipient, kernel, "slot 0: the agent");
        assertEq(v.feeSlots[0].admin, address(launcher), "agent slot locked");
        assertEq(v.feeSlots[1].recipient, platform, "slot 1: the platform");
        assertEq(v.feeSlots[1].admin, address(launcher), "platform slot locked");
        for (uint256 i = 2; i < 5; ++i) {
            assertEq(v.feeSlots[i].recipient, s.rewards[i - 2].recipient);
            assertEq(v.feeSlots[i].admin, s.rewards[i - 2].admin, "each row keeps its own admin");
            assertTrue(v.feeSlots[i].admin != address(launcher));
        }
        uint256 sum;
        for (uint256 i; i < 5; ++i) {
            assertFalse(v.feeSlots[i].isCreator, "no factory-managed creator slot");
            sum += v.feeSlots[i].relativeWeightBps;
        }
        assertEq(sum, 10_000);
        assertEq(v.creator, address(0), "the launcher keeps Clanker's creator rights");
        assertEq(v.creatorFeeRecipient, creator);
        assertEq(v.integratorFeeRecipient, address(0));
        assertEq(v.expectedConfigVersion, 7);
    }

    /// @dev The launch hands Clanker the config version the creator signed (so Clanker's `StaleConfig` guard
    ///      works), never the live one; the salt-mining view reads the live one and ignores the pin.
    function test_v5ParamsCarryTheCreatorsConfigVersionAndTheViewsTheLiveOne() public view {
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.expectedConfigVersion = 3;
        ClankerV5.LaunchParams memory v = launcher.exposedV5Params(_params(), s, address(1), creator);
        assertEq(v.expectedConfigVersion, 3, "the creator's pin, though the factory is at 7");
        s.expectedConfigVersion = 0;
        v = launcher.exposedV5Params(_params(), s, address(1), creator);
        assertEq(v.expectedConfigVersion, 0, "an unset pin is passed as it is (Clanker refuses it)");
        assertEq(launcher.tokenInitCodeHash(_params(), s), bytes32(uint256(7)), "the view reads the live version");
    }

    function test_v5ParamsCarrySniperSwitchMetadataAndContractUri() public view {
        BootrClankerLauncherV5.LaunchParams memory p = _params();
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        ClankerV5.LaunchParams memory v = launcher.exposedV5Params(p, s, address(1), creator);
        assertTrue(v.antiSnipeEnabled, "sniper tax on by default");
        assertTrue(v.metadataEditable);
        assertEq(v.tokenContractURI, s.contractURI, "contract URI is its own field");
        assertEq(v.quoteToken, NATIVE);
        assertEq(v.metadataKeys.length, 3);
        assertEq(v.metadataKeys[0], "image");
        assertEq(v.metadataValues[0], p.image);
        assertEq(v.metadataKeys[1], "metadata");
        assertEq(v.metadataValues[1], p.metadata, "the metadata key is Clanker's JSON");
        assertEq(v.metadataKeys[2], "context");
        assertEq(v.metadataValues[2], p.context);

        s.antiSnipe = false;
        s.metadataEditable = false;
        s.quoteToken = USDC;
        v = launcher.exposedV5Params(p, s, address(1), creator);
        assertFalse(v.antiSnipeEnabled, "sniper switch off");
        assertFalse(v.metadataEditable);
        assertEq(v.quoteToken, USDC);
    }

    // ------------------------------------------------------------------
    // Launch refusals before any external call
    // ------------------------------------------------------------------

    function test_launchRefusesBadSettingsAndInputsFirst() public {
        BootrClankerLauncherV5.LaunchParams memory p = _params();
        BootrClankerLauncherV5.TokenSettings memory s = _settings();
        s.buyTaxBps = 60_000;
        vm.expectRevert(BootrClankerLauncherV5.TaxOutOfBounds.selector);
        launcher.launch(p, s);
        s = _settings();
        s.quoteToken = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(BootrClankerLauncherV5.QuoteNotAllowed.selector, address(0xBEEF)));
        launcher.launch(p, s);
        s = _settings();
        p.name = "";
        vm.expectRevert(BootrClankerLauncherV5.EmptyNameOrSymbol.selector);
        launcher.launch(p, s);
        p = _params();
        p.fuelUsdc = 25e6 - 1;
        vm.expectRevert(BootrClankerLauncherV5.InsufficientFuel.selector);
        launcher.launch(p, s);
        // a dev buy needs the creator's minimum output, into ETH and into USDC alike
        p = _params();
        p.devBuyWei = 0.01 ether;
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(BootrClankerLauncherV5.MinDevBuyOutRequired.selector);
        launcher.launch{value: 0.01 ether}(p, s);
        s.quoteToken = USDC;
        vm.prank(creator);
        vm.expectRevert(BootrClankerLauncherV5.MinDevBuyOutRequired.selector);
        launcher.launch{value: 0.01 ether}(p, s);
        // and a dev buy into USDC needs the owner's v3 route
        s.minDevBuyOut = 1;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BootrClankerLauncherV5.DevBuyRouteMissing.selector, USDC));
        launcher.launch{value: 0.01 ether}(p, s);
    }

    function test_pauseRefusesLaunches() public {
        vm.prank(owner);
        launcher.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        launcher.launch(_params(), _settings());
        vm.prank(owner);
        launcher.unpause();
        assertFalse(launcher.paused());
        vm.prank(owner);
        launcher.setLaunchFee(0.0005 ether);
        assertEq(launcher.launchFeeWei(), 0.0005 ether);
    }

    // ------------------------------------------------------------------
    // Image and metadata: the coin's creator only, while editable; the lock; no handover
    // ------------------------------------------------------------------

    function test_creatorEditsImageAndMetadata() public {
        address token = makeAddr("token");
        launcher.seedCoin(token, creator, NATIVE, true);
        assertTrue(launcher.metadataEditable(token));

        vm.expectEmit(address(launcher));
        emit BootrClankerLauncherV5.CoinImageUpdated(token, "ipfs://new");
        vm.prank(creator);
        launcher.updateImage(token, "ipfs://new");
        assertEq(factory.lastToken(), token);
        assertEq(factory.lastKey(), "image");
        assertEq(factory.lastValue(), "ipfs://new");

        vm.expectEmit(address(launcher));
        emit BootrClankerLauncherV5.CoinMetadataUpdated(token, '{"description":"new"}');
        vm.prank(creator);
        launcher.updateMetadata(token, '{"description":"new"}');
        assertEq(factory.lastKey(), "metadata");
        assertEq(factory.lastValue(), '{"description":"new"}');
        assertEq(factory.edits(), 2);
    }

    function test_onlyTheCreatorEdits() public {
        address token = makeAddr("token");
        launcher.seedCoin(token, creator, NATIVE, true);
        address[3] memory others = [stranger, owner, platform];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert(BootrClankerLauncherV5.NotCoinCreator.selector);
            launcher.updateImage(token, "x");
            vm.expectRevert(BootrClankerLauncherV5.NotCoinCreator.selector);
            launcher.updateMetadata(token, "x");
            vm.expectRevert(BootrClankerLauncherV5.NotCoinCreator.selector);
            launcher.lockMetadata(token);
            vm.stopPrank();
        }
        // an unknown coin has no creator
        vm.prank(creator);
        vm.expectRevert(BootrClankerLauncherV5.NotCoinCreator.selector);
        launcher.updateImage(makeAddr("other"), "x");
        assertEq(factory.edits(), 0);
    }

    function test_lockIsForGood() public {
        address token = makeAddr("token");
        launcher.seedCoin(token, creator, NATIVE, true);
        vm.expectEmit(address(launcher));
        emit BootrClankerLauncherV5.CoinMetadataLocked(token);
        vm.prank(creator);
        launcher.lockMetadata(token);
        assertFalse(launcher.metadataEditable(token));
        vm.startPrank(creator);
        vm.expectRevert(BootrClankerLauncherV5.MetadataNotEditable.selector);
        launcher.updateImage(token, "x");
        vm.expectRevert(BootrClankerLauncherV5.MetadataNotEditable.selector);
        launcher.updateMetadata(token, "x");
        vm.expectRevert(BootrClankerLauncherV5.MetadataNotEditable.selector);
        launcher.lockMetadata(token);
        vm.stopPrank();
        assertEq(factory.edits(), 0);
    }

    function test_notEditableAtLaunchStaysFrozen() public {
        address token = makeAddr("token");
        launcher.seedCoin(token, creator, NATIVE, false);
        vm.prank(creator);
        vm.expectRevert(BootrClankerLauncherV5.MetadataNotEditable.selector);
        launcher.updateImage(token, "x");
    }

    /// @dev No forwarder for the name, symbol, contract URI, creator rights or the locked slots, and no
    ///      editor handover: the selectors do not exist on the launcher.
    function test_noForwardersAndNoHandover() public {
        address token = makeAddr("token");
        launcher.seedCoin(token, creator, NATIVE, true);
        bytes[7] memory calls = [
            abi.encodeWithSignature("updateTokenName(address,string)", token, "x"),
            abi.encodeWithSignature("updateTokenSymbol(address,string)", token, "x"),
            abi.encodeWithSignature("updateTokenContractURI(address,string)", token, "x"),
            abi.encodeWithSignature("proposeCreatorRightsTransfer(address,address)", token, stranger),
            abi.encodeWithSignature("updateFeeSlotRecipient(bytes32,uint256,address)", bytes32(0), 0, stranger),
            abi.encodeWithSignature("proposeCoinCreator(address,address)", token, stranger),
            abi.encodeWithSignature("setCoinCreator(address,address)", token, stranger)
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(creator);
            (bool ok,) = address(launcher).call(calls[i]);
            assertFalse(ok);
        }
        assertEq(launcher.coinCreator(token), creator);
    }

    // ------------------------------------------------------------------
    // Pool keys
    // ------------------------------------------------------------------

    function test_poolKeys() public {
        address token = 0x000000000000000000000000000000000000CcCc;
        launcher.seedCoin(token, creator, NATIVE, false);
        PoolKey memory key = launcher.poolKeyFor(token);
        assertEq(key.currency0, NATIVE, "native ETH is always currency0");
        assertEq(key.currency1, token);
        assertEq(key.fee, 0, "v5 pools carry fee 0; the hook takes the tax");
        assertEq(key.tickSpacing, 200);
        assertEq(key.hooks, hook);
        // a USDC coin sorts by address
        address high = 0xfFFffFfffffFffffFfffFfFFFFffFfFfFfFFcccc;
        launcher.seedCoin(high, creator, USDC, false);
        key = launcher.poolKeyFor(high);
        assertEq(key.currency0, USDC);
        assertEq(key.currency1, high);
        key = launcher.poolKeyFor(token, USDC, 200);
        assertEq(key.currency0, token);
        assertEq(key.currency1, USDC);
    }

    function test_scopedSalt() public view {
        bytes32 salt = bytes32(uint256(7));
        assertEq(
            launcher.scopedSalt(creator, salt),
            keccak256(abi.encode(address(launcher), keccak256(abi.encode(creator, salt)))),
            "Clanker scopes keccak(creator, salt) by the caller (this launcher)"
        );
    }
}
