// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrClankerLauncher} from "../../src/BootrClankerLauncher.sol";
import {BootrLaunchGate} from "../../src/BootrLaunchGate.sol";
import {BootrLauncher} from "../../src/BootrLauncher.sol";
import {BuybackBurner} from "../../src/BuybackBurner.sol";
import {ClankerMetadataJson} from "./ClankerMetadataJson.sol";
import {
    IClanker,
    IClankerFeeLocker,
    IClankerHookStaticFee,
    IClankerHookV2,
    IClankerLpLocker,
    IClankerLpLockerFeeConversion,
    IClankerMevDescendingFees,
    IClankerToken
} from "../../src/interfaces/IClanker.sol";
import {IERC8004IdentityRegistry} from "../../src/interfaces/IERC8004IdentityRegistry.sol";
import {IKernel, KernelLib} from "../../src/interfaces/IKernel.sol";
import {IPermit2, IUniversalRouter, IV4Router, IWETH9, PoolKey, V4Constants} from "../../src/interfaces/IUniswapV4.sol";

/// @notice Fork tests of the Clanker path against Base MAINNET: `BootrClankerLauncher` through the live Clanker
///         v4 factory (static-fee hook V2, fee-conversion locker, dev-buy extension, sniper auction V2), the
///         `BootrLaunchGate` in front of the guardian, and `BootrLauncher` v3.1 still launching the RWAGMI path
///         through the same gate (that last test needs `base-forge`, the Base B20 precompiles).
///         Restored in part from `390468e:test/fork/MainnetDryRun.t.sol` (Bootr launcher v1 on Clanker).
///         RPC: `BASE_RPC_URL` env or https://mainnet.base.org (no archive state needed).
contract ClankerForkTest is Test {
    // --- Clanker v4 on Base mainnet (docs/design/clanker-launch.md section 1, packages/shared/src/addresses.ts) ---
    address constant CLANKER = 0xE85A59c628F7d27878ACeB4bf3b35733630083a9;
    address constant FEE_LOCKER = 0xF3622742b1E446D92e45E22923Ef11C2fcD55D68;
    address constant LP_LOCKER = 0xffA37784D619F228D8B379d287a4D7282e500762;
    address constant HOOK = 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC;
    address constant DEV_BUY = 0x1331f0788F9c08C8F38D52c7a1152250A9dE00be;
    address constant SNIPER_AUCTION_V2 = 0xebB25BB797D82CB78E1bc70406b13233c0854413;
    address constant MEV_BLOCK_DELAY = 0xE143f9872A33c955F23cF442BB4B1EFB3A7402A2;
    address constant README_LOCKER_NOT_ENABLED = 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496;
    // Clanker.sol storage: Ownable._owner (0), OwnerAdmins.admins (1), ReentrancyGuard._status (2),
    // deprecated + teamFeeRecipient (3), deploymentInfoForToken (4), enabledHooks (5), enabledLockers (6),
    // enabledExtensions (7), enabledMevModules (8). Only enabledLockers is public; the others are read by slot
    // and the layout is checked against that public getter in test_clankerAllowlistsOnFork.
    uint256 constant SLOT_ENABLED_HOOKS = 5;
    uint256 constant SLOT_ENABLED_LOCKERS = 6;
    uint256 constant SLOT_ENABLED_EXTENSIONS = 7;
    uint256 constant SLOT_ENABLED_MEV_MODULES = 8;
    // --- RWAGMI v3 (for the v3.1 launcher), shared infra ---
    address constant RWAGMI_LAUNCHER = 0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20;
    address constant RWAGMI_LOCKER = 0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20;
    address constant RWAGMI_HOOK = 0xB20B00367E37F826a0652c85a6DF375D784B20Ec;
    address constant RWAGMI_DEV_BUY = 0xb20A2dCBC4AA42474072381aEb52CbFc5C751B20;
    address constant B20_FACTORY = 0xB20f000000000000000000000000000000000000;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant KERNEL_FACTORY = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant TOTAL_SUPPLY = 100_000_000_000e18;
    uint256 constant MAX_CODE_SIZE = 24_576;

    AgentGuardian guardian;
    BootrLaunchGate gate;
    BuybackBurner burnerImpl;
    BootrLauncher launcher; // v3.1, RWAGMI path
    BootrClankerLauncher clankerLauncher;

    // Labels are namespaced: generic labels resolve to contracts on mainnet that forward ETH.
    address platformRecipient = makeAddr("bootr.fork.clanker.platformRecipient");
    address treasury = makeAddr("bootr.fork.clanker.treasury");
    address trader = makeAddr("bootr.fork.clanker.trader");
    address stranger = makeAddr("bootr.fork.clanker.stranger");
    address creator;
    uint256 creatorPk = uint256(keccak256("bootr.fork.clanker.creator.pk"));
    address sessionKey = vm.addr(0xA11CE);

    uint256 constant FUEL = 100e6;
    uint32 constant DORMANCY = 90 days;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        require(block.chainid == 8453, "not a Base mainnet fork");
        creator = vm.addr(creatorPk);

        guardian = new AgentGuardian(address(this), ENTRY_POINT, USDC, WETH);
        gate = new BootrLaunchGate(address(this), address(guardian));
        burnerImpl = new BuybackBurner();
        launcher = new BootrLauncher(
            address(this),
            BootrLauncher.Deps({
                rwagmiLauncher: RWAGMI_LAUNCHER,
                rwagmiLocker: RWAGMI_LOCKER,
                rwagmiHook: RWAGMI_HOOK,
                rwagmiDevBuy: RWAGMI_DEV_BUY,
                b20Factory: B20_FACTORY,
                weth: WETH,
                usdc: USDC,
                identityRegistry: IDENTITY,
                kernelFactory: KERNEL_FACTORY,
                guardian: address(guardian),
                gate: address(gate),
                burnerImplementation: address(burnerImpl),
                universalRouter: UNIVERSAL_ROUTER,
                permit2: PERMIT2
            }),
            _bootrDefaults(false),
            _bootrDefaults(true),
            1000
        );
        clankerLauncher = new BootrClankerLauncher(
            address(this),
            BootrClankerLauncher.Deps({
                clanker: CLANKER,
                feeLocker: FEE_LOCKER,
                lpLocker: LP_LOCKER,
                staticHook: HOOK,
                devBuyExtension: DEV_BUY,
                weth: WETH,
                usdc: USDC,
                identityRegistry: IDENTITY,
                kernelFactory: KERNEL_FACTORY,
                guardian: address(guardian),
                gate: address(gate)
            }),
            _sniperConfig(),
            _defaults(false),
            _defaults(true),
            1000
        );
        guardian.setLauncher(address(gate));
        gate.addLauncher(address(launcher));
        gate.addLauncher(address(clankerLauncher));
        guardian.setPlatformTreasury(treasury);

        deal(USDC, creator, 10_000e6);
        deal(USDC, platformRecipient, 10_000e6);
        vm.deal(creator, 100 ether);
        vm.deal(platformRecipient, 100 ether);
        vm.startPrank(creator);
        IERC20(USDC).approve(address(launcher), type(uint256).max);
        IERC20(USDC).approve(address(clankerLauncher), type(uint256).max);
        vm.stopPrank();
        vm.prank(platformRecipient);
        IERC20(USDC).approve(address(clankerLauncher), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Fixture
    // ------------------------------------------------------------------

    /// @dev clanker-sdk's default sniper auction config (startingFee 66.7%, endingFee 4.2%, 15 s decay).
    function _sniperConfig() internal pure returns (IClanker.MevModuleConfig memory) {
        return IClanker.MevModuleConfig({
            mevModule: SNIPER_AUCTION_V2,
            mevModuleData: abi.encode(IClankerMevDescendingFees.FeeConfig(666_777, 41_673, 15))
        });
    }

    /// @dev The presets of script/Deploy.s.sol (5 / 65 / 30 and 5 / 50 / 15 / 30, 1% LP fee), no scaling on Clanker.
    function _defaults(bool buyback) internal view returns (BootrClankerLauncher.LaunchDefaults memory) {
        return BootrClankerLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: buyback ? 5000 : 6500,
            burnBps: buyback ? 1500 : 0,
            platformBps: 3000,
            platformRecipient: platformRecipient,
            minFuelUsdc: 25e6,
            dormancyPeriod: DORMANCY
        });
    }

    function _bootrDefaults(bool buyback) internal view returns (BootrLauncher.LaunchDefaults memory) {
        return BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: buyback ? 5000 : 6500,
            burnBps: buyback ? 1500 : 0,
            platformBps: 3000,
            platformRecipient: platformRecipient,
            minFuelUsdc: 25e6,
            dormancyPeriod: DORMANCY
        });
    }

    function _params(bool buyback, uint256 devBuyWei, bytes32 salt)
        internal
        view
        returns (BootrClankerLauncher.LaunchParams memory p)
    {
        p = BootrClankerLauncher.LaunchParams({
            name: "Bootr Clanker Agent",
            symbol: "BCLNK",
            image: "https://bootr.fun/images/test.png",
            metadata: '{"description":"mainnet fork launch through Clanker"}',
            context: '{"interface":"Bootr","platform":"bootr.fun","id":"draft-1"}',
            salt: salt,
            buybackBurn: buyback,
            fuelUsdc: FUEL,
            devBuyWei: devBuyWei,
            workerHash: keccak256("worker"),
            model: "claude-sonnet-4-5",
            agentURI: "https://bootr.fun/agents/test.json",
            supervisorSessionKey: sessionKey
        });
    }

    function _launchAs(address who, bool buyback, uint256 devBuyWei, bytes32 salt)
        internal
        returns (address token, address kernel, address burner, uint256 agentId)
    {
        vm.prank(who);
        (token, kernel, burner, agentId) = clankerLauncher.launch{value: devBuyWei}(_params(buyback, devBuyWei, salt));
    }

    function _launch(bool buyback, uint256 devBuyWei)
        internal
        returns (address token, address kernel, address burner, uint256 agentId)
    {
        return _launchAs(creator, buyback, devBuyWei, bytes32(uint256(7)));
    }

    /// @dev Lets the MEV module expire (hook MAX_MEV_MODULE_DELAY = 2 minutes) so swaps need no auction data and
    ///      the locker collects.
    function _passMevWindow() internal {
        vm.warp(vm.getBlockTimestamp() + 3 minutes);
        vm.roll(block.number + 5);
    }

    function _poolId(address token) internal view returns (bytes32) {
        return V4Constants.poolId(clankerLauncher.poolKeyFor(token));
    }

    function _available(address who, address asset) internal view returns (uint256) {
        return IClankerFeeLocker(FEE_LOCKER).availableFees(who, asset);
    }

    function _factoryFlag(uint256 slot, address key) internal view returns (bool) {
        return uint256(vm.load(CLANKER, keccak256(abi.encode(key, slot)))) == 1;
    }

    /// @dev Exact-input WETH -> coin swap through the Universal Router (what traders do).
    function _buy(address token, uint256 wethIn) internal {
        PoolKey memory key = clankerLauncher.poolKeyFor(token);
        vm.deal(trader, wethIn + 1 ether);
        vm.startPrank(trader);
        IWETH9(WETH).deposit{value: wethIn}();
        IWETH9(WETH).approve(PERMIT2, wethIn);
        IPermit2(PERMIT2).approve(WETH, UNIVERSAL_ROUTER, uint160(wethIn), uint48(block.timestamp + 1 hours));
        bytes memory actions = abi.encodePacked(
            V4Constants.ACTION_SWAP_EXACT_IN_SINGLE, V4Constants.ACTION_SETTLE_ALL, V4Constants.ACTION_TAKE_ALL
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: key.currency0 == WETH,
                amountIn: uint128(wethIn),
                amountOutMinimum: 1,
                hookData: ""
            })
        );
        params[1] = abi.encode(WETH, wethIn);
        params[2] = abi.encode(token, uint256(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        IUniversalRouter(UNIVERSAL_ROUTER).execute(abi.encodePacked(V4Constants.CMD_V4_SWAP), inputs, block.timestamp);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Allowlists on the fork (what the day-of checks read; Clanker's admin can change them without notice)
    // ------------------------------------------------------------------

    function test_clankerAllowlistsOnFork() public view {
        IClanker clanker = IClanker(CLANKER);
        assertFalse(clanker.deprecated(), "Clanker factory deprecated");
        assertEq(clanker.TOKEN_SUPPLY(), TOTAL_SUPPLY);
        // the public getter and the slot read agree -> the slot layout above is right
        assertTrue(clanker.enabledLockers(LP_LOCKER, HOOK), "fee-conversion locker not enabled for the static V2 hook");
        assertFalse(clanker.enabledLockers(README_LOCKER_NOT_ENABLED, HOOK), "README locker unexpectedly enabled");
        bytes32 lockerSlot = keccak256(abi.encode(HOOK, keccak256(abi.encode(LP_LOCKER, SLOT_ENABLED_LOCKERS))));
        assertEq(uint256(vm.load(CLANKER, lockerSlot)), 1, "enabledLockers slot layout");
        bytes32 badSlot =
            keccak256(abi.encode(HOOK, keccak256(abi.encode(README_LOCKER_NOT_ENABLED, SLOT_ENABLED_LOCKERS))));
        assertEq(uint256(vm.load(CLANKER, badSlot)), 0);
        // private allowlists by slot
        assertTrue(_factoryFlag(SLOT_ENABLED_HOOKS, HOOK), "ClankerHookStaticFeeV2 not enabled");
        assertTrue(_factoryFlag(SLOT_ENABLED_EXTENSIONS, DEV_BUY), "ClankerUniv4EthDevBuy not enabled");
        bool sniper = _factoryFlag(SLOT_ENABLED_MEV_MODULES, SNIPER_AUCTION_V2);
        bool delay = _factoryFlag(SLOT_ENABLED_MEV_MODULES, MEV_BLOCK_DELAY);
        console2.log("enabledMevModules[ClankerSniperAuctionV2]:", sniper);
        console2.log("enabledMevModules[ClankerMevBlockDelay]:  ", delay);
        assertTrue(sniper, "ClankerSniperAuctionV2 not enabled (switch the launcher to ClankerMevBlockDelay)");
        assertFalse(_factoryFlag(SLOT_ENABLED_MEV_MODULES, address(0xBEEF)));
        // the rest of the stack
        assertTrue(IClankerFeeLocker(FEE_LOCKER).allowedDepositors(LP_LOCKER), "locker cannot deposit into the fee locker");
        assertEq(IClankerLpLockerFeeConversion(LP_LOCKER).feeLocker(), FEE_LOCKER);
        assertEq(IClankerLpLockerFeeConversion(LP_LOCKER).MAX_REWARD_PARTICIPANTS(), 7);
        assertEq(IClankerHookV2(HOOK).MAX_LP_FEE(), 100_000);
        assertEq(IClankerHookV2(HOOK).PROTOCOL_FEE_NUMERATOR(), 200_000, "20% protocol fee on top");
        assertEq(IClankerHookV2(HOOK).MAX_MEV_MODULE_DELAY(), 2 minutes);
        assertGe(IClankerHookV2(HOOK).MAX_MEV_LP_FEE(), 666_777, "sniper starting fee above the hook's MEV cap");
        assertEq(clankerLauncher.MAX_LP_FEE(), IClankerHookV2(HOOK).MAX_LP_FEE());
    }

    // ------------------------------------------------------------------
    // Launches: both presets, with and without a dev buy
    // ------------------------------------------------------------------

    function test_launchStandardNoDevBuy() public {
        (address token, address kernel, address burner, uint256 agentId) = _launch(false, 0);
        assertEq(burner, address(0));
        _assertLaunchInvariants(token, kernel, burner, agentId, false, 10_000);
        assertEq(IERC20(token).balanceOf(creator), 0);
        IClanker.DeploymentInfo memory info = IClanker(CLANKER).tokenDeploymentInfo(token);
        assertEq(info.extensions.length, 0, "no extension without a dev buy");
    }

    function test_launchStandardWithDevBuy() public {
        uint256 before = creator.balance;
        (address token, address kernel, address burner, uint256 agentId) = _launch(false, 0.01 ether);
        _assertLaunchInvariants(token, kernel, burner, agentId, false, 10_000);
        assertGt(IERC20(token).balanceOf(creator), 0, "dev buy delivered to the creator");
        assertEq(before - creator.balance, 0.01 ether, "exactly the dev buy was spent");
        IClanker.DeploymentInfo memory info = IClanker(CLANKER).tokenDeploymentInfo(token);
        assertEq(info.extensions.length, 1);
        assertEq(info.extensions[0], DEV_BUY);
    }

    function test_launchBuybackWithDevBuy() public {
        (address token, address kernel, address burner, uint256 agentId) = _launch(true, 0.02 ether);
        assertEq(burner, DEAD, "the burn slot is the dead address, no burner contract");
        _assertLaunchInvariants(token, kernel, burner, agentId, true, 10_000);
        assertGt(IERC20(token).balanceOf(creator), 0);
    }

    function test_launchBuybackNoDevBuy() public {
        (address token, address kernel, address burner, uint256 agentId) = _launch(true, 0);
        assertEq(burner, DEAD);
        _assertLaunchInvariants(token, kernel, burner, agentId, true, 10_000);
    }

    function test_launchEventsCarryTheClankerFacts() public {
        vm.recordLogs();
        (address token, address kernel,,) = _launch(false, 0.01 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawAgent;
        bool sawClanker;
        bool sawContext;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(clankerLauncher)) continue;
            if (logs[i].topics[0] == BootrClankerLauncher.AgentLaunched.selector) {
                sawAgent = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), kernel);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), creator);
                (address burner,, BootrClankerLauncher.LaunchDefaults memory d,,,,) = abi.decode(
                    logs[i].data,
                    (address, uint256, BootrClankerLauncher.LaunchDefaults, bytes32, string, string, address)
                );
                assertEq(burner, address(0));
                assertEq(d.lpFeeBps, 10_000);
                assertEq(d.platformRecipient, platformRecipient);
            } else if (logs[i].topics[0] == BootrClankerLauncher.ClankerLaunched.selector) {
                sawClanker = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
                (bytes32 poolId, address hook, address locker, address mev, int24 tick, uint24 lpFee) =
                    abi.decode(logs[i].data, (bytes32, address, address, address, int24, uint24));
                assertEq(poolId, _poolId(token));
                assertEq(hook, HOOK);
                assertEq(locker, LP_LOCKER);
                assertEq(mev, SNIPER_AUCTION_V2);
                assertEq(tick, -230_400);
                assertEq(lpFee, 10_000);
            } else if (logs[i].topics[0] == BootrClankerLauncher.LaunchContext.selector) {
                sawContext = true;
                assertEq(abi.decode(logs[i].data, (string)), '{"interface":"Bootr","platform":"bootr.fun","id":"draft-1"}');
            }
        }
        assertTrue(sawAgent && sawClanker && sawContext, "all three launch events");
        // Clanker's own TokenCreated names this launcher as msgSender and the launcher as tokenAdmin
        bytes32 created = IClanker.TokenCreated.selector;
        bool sawCreated;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == CLANKER && logs[i].topics[0] == created) {
                sawCreated = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), address(clankerLauncher), "tokenAdmin");
            }
        }
        assertTrue(sawCreated, "TokenCreated");
    }

    // ------------------------------------------------------------------
    // Platform LP fee: the treasury's own coin ($BOOTR) at 2%, everyone else at the preset 1%
    // ------------------------------------------------------------------

    function test_platformTreasuryLaunchesAtPlatformLpFee() public {
        // off by default: the treasury gets the preset fee like anyone else
        (address t0,,,) = _launchAs(platformRecipient, false, 0, bytes32(uint256(1)));
        assertEq(IClankerHookStaticFee(HOOK).clankerFee(_poolId(t0)), 10_000);

        clankerLauncher.setPlatformLpFeeBps(20_000);
        vm.recordLogs();
        (address t1, address k1,, uint256 id1) = _launchAs(platformRecipient, false, 0.01 ether, bytes32(uint256(2)));
        _assertLaunchInvariants(t1, k1, address(0), id1, false, 20_000);
        assertEq(IClankerHookStaticFee(HOOK).clankerFee(_poolId(t1)), 20_000, "treasury coin: 2% LP fee");
        assertEq(IClankerHookStaticFee(HOOK).pairedFee(_poolId(t1)), 20_000);
        // both events carry the fee actually used
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(clankerLauncher)) continue;
            if (logs[i].topics[0] == BootrClankerLauncher.ClankerLaunched.selector) {
                (,,,,, uint24 lpFee) = abi.decode(logs[i].data, (bytes32, address, address, address, int24, uint24));
                assertEq(lpFee, 20_000, "ClankerLaunched.lpFeeBps");
            } else if (logs[i].topics[0] == BootrClankerLauncher.AgentLaunched.selector) {
                (,, BootrClankerLauncher.LaunchDefaults memory d,,,,) = abi.decode(
                    logs[i].data,
                    (address, uint256, BootrClankerLauncher.LaunchDefaults, bytes32, string, string, address)
                );
                assertEq(d.lpFeeBps, 20_000, "AgentLaunched.defaults.lpFeeBps");
            }
        }
        // the stored preset is untouched and another creator still gets 1%
        (uint24 lp,,,,,,,) = clankerLauncher.standardDefaults();
        assertEq(lp, 10_000);
        (address t2, address k2,, uint256 id2) = _launch(false, 0);
        _assertLaunchInvariants(t2, k2, address(0), id2, false, 10_000);
        assertEq(IClankerHookStaticFee(HOOK).clankerFee(_poolId(t2)), 10_000, "other creator: preset 1%");
        // the 2% applies on the buyback preset too, and switching it off restores the preset
        (address t3,,,) = _launchAs(platformRecipient, true, 0, bytes32(uint256(3)));
        assertEq(IClankerHookStaticFee(HOOK).clankerFee(_poolId(t3)), 20_000);
        clankerLauncher.setPlatformLpFeeBps(0);
        (address t4,,,) = _launchAs(platformRecipient, false, 0, bytes32(uint256(4)));
        assertEq(IClankerHookStaticFee(HOOK).clankerFee(_poolId(t4)), 10_000);
    }

    // ------------------------------------------------------------------
    // Launch fee, refund, prediction, replay, pause
    // ------------------------------------------------------------------

    function test_launchFeePaidAndExcessRefunded() public {
        clankerLauncher.setLaunchFee(0.0005 ether);
        uint256 before = creator.balance;
        uint256 platformBefore = platformRecipient.balance;
        vm.prank(creator);
        clankerLauncher.launch{value: 0.5 ether}(_params(false, 0.01 ether, bytes32(uint256(9))));
        assertEq(before - creator.balance, 0.0105 ether, "dev buy + fee spent, excess refunded");
        assertEq(platformRecipient.balance - platformBefore, 0.0005 ether, "fee paid to the platform");
        vm.prank(creator);
        vm.expectRevert(BootrClankerLauncher.InsufficientValue.selector);
        clankerLauncher.launch{value: 0.01 ether}(_params(false, 0.01 ether, bytes32(uint256(10))));
    }

    function test_launchPredictsKernelAndRejectsReplay() public {
        address predicted = clankerLauncher.predictKernel(creator, bytes32(uint256(7)));
        (, address kernel,,) = _launch(false, 0);
        assertEq(kernel, predicted);
        // same creator + salt -> same kernel address -> KernelFactory / guardian reject the duplicate
        vm.prank(creator);
        vm.expectRevert();
        clankerLauncher.launch(_params(false, 0, bytes32(uint256(7))));
    }

    function test_pausedLauncherRejects() public {
        clankerLauncher.pause();
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        clankerLauncher.launch(_params(false, 0, bytes32(uint256(7))));
        clankerLauncher.unpause();
        _launch(false, 0);
    }

    function test_launchGasAndCodeSize() public {
        assertLt(address(clankerLauncher).code.length, MAX_CODE_SIZE, "BootrClankerLauncher over 24 kB");
        assertLt(address(launcher).code.length, MAX_CODE_SIZE, "BootrLauncher v3.1 over 24 kB");
        console2.log("BootrClankerLauncher runtime bytes:", address(clankerLauncher).code.length);
        console2.log("BootrLauncher v3.1 runtime bytes:  ", address(launcher).code.length);
        console2.log("BootrLaunchGate runtime bytes:     ", address(gate).code.length);
        BootrClankerLauncher.LaunchParams memory p = _params(false, 0.01 ether, bytes32(uint256(11)));
        vm.prank(creator);
        uint256 g = gasleft();
        clankerLauncher.launch{value: 0.01 ether}(p);
        console2.log("launch gas (standard, dev buy):   ", g - gasleft());
        p = _params(true, 0, bytes32(uint256(12)));
        vm.prank(creator);
        g = gasleft();
        clankerLauncher.launch(p);
        console2.log("launch gas (buyback, no dev buy): ", g - gasleft());
    }

    // ------------------------------------------------------------------
    // Fee path: swap -> collectRewards -> fee locker -> claim pays the recipient; burn slot gets the coin
    // ------------------------------------------------------------------

    function test_swapAccruesFeesAndKernelClaimsWeth() public {
        (address token, address kernel,,) = _launch(false, 0);
        _passMevWindow();
        uint256 wethIn = 1 ether;
        _buy(token, wethIn);
        // nothing is credited until a collection
        assertEq(_available(kernel, WETH), 0);
        // the kernel's own claim op: collectRewards(token) then claim(kernel, WETH), both from the kernel
        vm.startPrank(kernel);
        IClankerLpLocker(LP_LOCKER).collectRewards(token);
        uint256 fKernel = _available(kernel, WETH);
        uint256 fCreator = _available(creator, WETH);
        uint256 fPlatform = _available(platformRecipient, WETH);
        uint256 lpTotal = fKernel + fCreator + fPlatform;
        assertGt(lpTotal, 0, "swap accrued LP fees");
        // 1% LP fee of the swapped WETH (Clanker's 20% protocol share is taken on top, before the pool)
        assertApproxEqRel(lpTotal, wethIn / 100, 0.05e18, "LP fee ~1% of the swap");
        assertApproxEqAbs(fKernel, lpTotal * 500 / 10_000, 2);
        assertApproxEqAbs(fCreator, lpTotal * 6500 / 10_000, 2);
        assertApproxEqAbs(fPlatform, lpTotal * 3000 / 10_000, 2);
        // everything arrives as WETH (Paired): no coin in any slot
        assertEq(_available(kernel, token), 0);
        assertEq(_available(creator, token), 0);
        assertEq(_available(platformRecipient, token), 0);
        IClankerFeeLocker(FEE_LOCKER).claim(kernel, WETH);
        vm.stopPrank();
        assertEq(IERC20(WETH).balanceOf(kernel), fKernel, "kernel received its WETH share");
        assertEq(_available(kernel, WETH), 0);
        // claim is permissionless and always pays the fee owner: a stranger claiming for the creator pays the creator
        vm.prank(stranger);
        IClankerFeeLocker(FEE_LOCKER).claim(creator, WETH);
        assertEq(IERC20(WETH).balanceOf(creator), fCreator);
        assertEq(IERC20(WETH).balanceOf(stranger), 0);
        vm.prank(stranger);
        vm.expectRevert(); // NoFeesToClaim
        IClankerFeeLocker(FEE_LOCKER).claim(creator, WETH);
    }

    function test_burnSlotReceivesCoinAtDeadAddress() public {
        (address token, address kernel, address burner,) = _launch(true, 0);
        assertEq(burner, DEAD);
        _passMevWindow();
        _buy(token, 1 ether);
        IClankerLpLocker(LP_LOCKER).collectRewards(token);
        uint256 fKernel = _available(kernel, WETH);
        uint256 fCreator = _available(creator, WETH);
        uint256 fPlatform = _available(platformRecipient, WETH);
        uint256 fDeadCoin = _available(DEAD, token);
        assertGt(fDeadCoin, 0, "the burn slot's WETH share was converted into the coin");
        assertEq(_available(DEAD, WETH), 0, "nothing left in WETH for the burn slot");
        // the three WETH slots share 85% of the LP fee in the 5 / 50 / 30 ratio
        uint256 wethTotal = fKernel + fCreator + fPlatform;
        assertApproxEqAbs(fKernel, wethTotal * 500 / 8500, 2);
        assertApproxEqAbs(fCreator, wethTotal * 5000 / 8500, 2);
        assertApproxEqAbs(fPlatform, wethTotal * 3000 / 8500, 2);
        // anyone finalises the burn: the coin lands at 0x...dEaD and is out of circulation
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        vm.prank(stranger);
        IClankerFeeLocker(FEE_LOCKER).claim(DEAD, token);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, fDeadCoin);
        assertEq(_available(DEAD, token), 0);
    }

    // ------------------------------------------------------------------
    // The metadata JSON Clanker's page reads
    // ------------------------------------------------------------------

    /// @dev The web writes the JSON itself into `metadata` (lib/contract-metadata.ts): Clanker v4 takes it as is,
    ///      at the longest size the web produces, and the token returns it byte for byte from `metadata()`.
    function test_launchCarriesClankerMetadataJson() public {
        string[2] memory docs = [ClankerMetadataJson.typical(), ClankerMetadataJson.longest()];
        for (uint256 i; i < docs.length; ++i) {
            BootrClankerLauncher.LaunchParams memory p = _params(false, 0, bytes32(uint256(70 + i)));
            p.metadata = docs[i];
            vm.prank(creator);
            (address token,,,) = clankerLauncher.launch(p);
            assertEq(IClankerToken(token).metadata(), docs[i], "metadata, byte for byte");
            assertEq(IClankerToken(token).imageUrl(), p.image);
            // valid JSON in Clanker's shape (a parse error would revert here)
            assertEq(vm.parseJsonString(docs[i], ".socialMediaUrls[0].platform"), "x");
            assertEq(vm.parseJsonStringArray(docs[i], ".auditUrls").length, 0);
        }
        assertGt(bytes(docs[1]).length, 1_000, "the long case is long");
    }

    // ------------------------------------------------------------------
    // Immutability of rewards, preferences and token metadata
    // ------------------------------------------------------------------

    function test_rewardsPreferencesAndTokenAreLocked() public {
        (address token,,,) = _launch(true, 0);
        IClankerLpLockerFeeConversion locker = IClankerLpLockerFeeConversion(LP_LOCKER);
        address[3] memory callers = [clankerLauncher.owner(), creator, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert();
            locker.updateRewardRecipient(token, 0, stranger);
            vm.expectRevert();
            locker.updateRewardAdmin(token, 0, stranger);
            vm.expectRevert();
            locker.updateFeePreference(token, 2, IClankerLpLockerFeeConversion.FeeIn.Both);
            vm.stopPrank();
        }
        // the launcher (the admin) exposes no pass-through to the locker or the token
        (bool ok,) = address(clankerLauncher).call(abi.encodeCall(locker.updateRewardRecipient, (token, 0, stranger)));
        assertFalse(ok);
        (ok,) = address(clankerLauncher).call(abi.encodeCall(locker.updateRewardAdmin, (token, 0, stranger)));
        assertFalse(ok);
        (ok,) = address(clankerLauncher).call(
            abi.encodeCall(locker.updateFeePreference, (token, 2, IClankerLpLockerFeeConversion.FeeIn.Both))
        );
        assertFalse(ok);
        (ok,) = address(clankerLauncher).call(abi.encodeWithSignature("updateImage(string)", "x"));
        assertFalse(ok);
        vm.prank(creator);
        (ok,) = token.call(abi.encodeWithSignature("updateImage(string)", "x"));
        assertFalse(ok, "only the token admin (the launcher) could, and it has no such function");
        assertEq(IClankerToken(token).admin(), address(clankerLauncher));
        IClankerLpLocker.TokenRewardInfo memory r = locker.tokenRewards(token);
        assertEq(r.rewardAdmins[0], address(clankerLauncher));
        assertEq(guardian.agentInfo(r.rewardRecipients[0]).token, token, "slot 0 is still the agent kernel");
    }

    // ------------------------------------------------------------------
    // Gate: forwarding, rejections, and the v3.1 Bootr path through the same gate
    // ------------------------------------------------------------------

    function test_gateForwardsOnlyForAllowlistedLaunchers() public {
        assertEq(guardian.launcher(), address(gate));
        assertTrue(gate.launchers(address(launcher)));
        assertTrue(gate.launchers(address(clankerLauncher)));
        (, address kernel,,) = _launch(false, 0);
        assertTrue(guardian.isRegistered(kernel), "registered through the gate");
        // a stranger cannot register through the gate, a launcher cannot bypass it
        vm.prank(stranger);
        vm.expectRevert(BootrLaunchGate.NotLauncher.selector);
        gate.registerAgent(kernel, address(1), creator, DORMANCY);
        vm.prank(address(clankerLauncher));
        vm.expectRevert(AgentGuardian.NotLauncher.selector);
        guardian.registerAgent(kernel, address(1), creator, DORMANCY);
        // removing a launcher from the gate stops its launches at the registration step
        gate.removeLauncher(address(clankerLauncher));
        vm.prank(creator);
        vm.expectRevert(BootrLaunchGate.NotLauncher.selector);
        clankerLauncher.launch(_params(false, 0, bytes32(uint256(8))));
        gate.addLauncher(address(clankerLauncher));
        _launchAs(creator, false, 0, bytes32(uint256(8)));
    }

    /// @dev Needs `base-forge` (B20 precompiles): the RWAGMI path of BootrLauncher v3.1, registering through the gate.
    function test_v31LauncherLaunchesBootrPathThroughGate() public {
        assertEq(launcher.STARTING_TICK(), -243_400, "Bootr path keeps its ~$6k opening cap");
        assertEq(address(launcher.gate()), address(gate));
        BootrLauncher.LaunchParams memory p = BootrLauncher.LaunchParams({
            name: "Bootr Agent",
            symbol: "BOOTR",
            image: "ipfs://image",
            metadata: "https://bootr.example/tokens/test.json",
            context: '{"interface":"bootr"}',
            salt: bytes32(uint256(21)),
            buybackBurn: false,
            fuelUsdc: FUEL,
            devBuyWei: 0,
            workerHash: keccak256("worker"),
            model: "claude-sonnet-4-5",
            agentURI: "https://bootr.example/agent.json",
            supervisorSessionKey: sessionKey
        });
        vm.prank(creator);
        (address token, address kernel,,) = launcher.launch(p);
        assertEq(token, launcher.predictToken(creator, bytes32(uint256(21))));
        AgentGuardian.AgentInfo memory a = guardian.agentInfo(kernel);
        assertEq(a.token, token, "registered on the guardian through the gate");
        assertEq(a.creator, creator);
        assertEq(IKernel(kernel).rootValidator(), KernelLib.validatorId(address(guardian)));
        // and a Clanker launch by the same creator lands next to it on the same guardian
        (address t2, address k2,,) = _launch(false, 0);
        assertEq(guardian.agentInfo(k2).token, t2);
        assertTrue(k2 != kernel);
    }

    // ------------------------------------------------------------------
    // MEV module: the fallback also launches when Clanker still enables it
    // ------------------------------------------------------------------

    function test_mevBlockDelayFallbackLaunchesIfEnabled() public {
        bool enabled = _factoryFlag(SLOT_ENABLED_MEV_MODULES, MEV_BLOCK_DELAY);
        console2.log("ClankerMevBlockDelay enabled:", enabled);
        clankerLauncher.setMevModule(MEV_BLOCK_DELAY, "");
        if (!enabled) {
            vm.prank(creator);
            vm.expectRevert(IClanker.MevModuleNotEnabled.selector);
            clankerLauncher.launch(_params(false, 0, bytes32(uint256(7))));
            return;
        }
        (address token, address kernel,, uint256 agentId) = _launch(false, 0.01 ether);
        _assertLaunchInvariants(token, kernel, address(0), agentId, false, 10_000);
        assertEq(IClankerHookV2(HOOK).mevModule(_poolId(token)), MEV_BLOCK_DELAY);
        _passMevWindow();
        _buy(token, 0.1 ether);
        IClankerLpLocker(LP_LOCKER).collectRewards(token);
        assertGt(_available(kernel, WETH), 0);
    }

    // ------------------------------------------------------------------
    // Invariants
    // ------------------------------------------------------------------

    function _assertLaunchInvariants(
        address token,
        address kernel,
        address burner,
        uint256 agentId,
        bool buyback,
        uint24 lpFee
    ) internal view {
        // token: Clanker token, admin = launcher (no update path), fixed supply
        assertEq(IClankerToken(token).admin(), address(clankerLauncher), "tokenAdmin is the launcher");
        assertEq(IERC20(token).totalSupply(), TOTAL_SUPPLY);
        assertEq(IClankerToken(token).imageUrl(), "https://bootr.fun/images/test.png");
        assertEq(IClankerToken(token).context(), '{"interface":"Bootr","platform":"bootr.fun","id":"draft-1"}');
        IClanker.DeploymentInfo memory info = IClanker(CLANKER).tokenDeploymentInfo(token);
        assertEq(info.token, token);
        assertEq(info.hook, HOOK);
        assertEq(info.locker, LP_LOCKER);

        // pool: static fee both directions, Standard starting tick, locker + MEV module wired on the hook
        bytes32 poolId = _poolId(token);
        assertEq(IClankerHookStaticFee(HOOK).clankerFee(poolId), lpFee);
        assertEq(IClankerHookStaticFee(HOOK).pairedFee(poolId), lpFee);
        assertEq(IClankerHookV2(HOOK).locker(poolId), LP_LOCKER);
        assertEq(IClankerHookV2(HOOK).mevModule(poolId), clankerLauncher.mevModule());
        assertTrue(IClankerHookV2(HOOK).mevModuleEnabled(poolId), "MEV module armed right after the launch");
        assertEq(IClankerHookV2(HOOK).clankerIsToken0(poolId), token < WETH);

        // rewards in the live locker: slots, bps straight from the preset, admins, fee preferences
        IClankerLpLocker.TokenRewardInfo memory r = IClankerLpLocker(LP_LOCKER).tokenRewards(token);
        uint256 n = buyback ? 4 : 3;
        assertEq(r.token, token);
        assertEq(r.numPositions, 1, "Standard layout: one position");
        assertEq(V4Constants.poolId(r.poolKey), poolId, "locker pool key == launcher poolKeyFor");
        assertEq(r.poolKey.fee, V4Constants.DYNAMIC_FEE_FLAG);
        assertEq(r.rewardAdmins.length, n);
        assertEq(r.rewardRecipients.length, n);
        assertEq(r.rewardBps.length, n);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            assertEq(r.rewardAdmins[i], address(clankerLauncher), "rewardAdmin is the launcher");
            sum += r.rewardBps[i];
        }
        assertEq(sum, 10_000, "Bootr slots share 100% of the LP fee");
        assertEq(r.rewardRecipients[0], kernel);
        assertEq(r.rewardBps[0], 500);
        assertEq(r.rewardRecipients[1], creatorOf(kernel));
        assertEq(r.rewardBps[1], buyback ? 5000 : 6500);
        if (buyback) {
            assertEq(burner, DEAD);
            assertEq(r.rewardRecipients[2], DEAD, "burn slot recipient is the dead address");
            assertEq(r.rewardBps[2], 1500);
            assertEq(
                uint8(IClankerLpLockerFeeConversion(LP_LOCKER).feePreferences(token, 2)),
                uint8(IClankerLpLockerFeeConversion.FeeIn.Clanker),
                "burn slot takes the coin"
            );
        } else {
            assertEq(burner, address(0));
        }
        assertEq(r.rewardRecipients[n - 1], platformRecipient);
        assertEq(r.rewardBps[n - 1], 3000);
        for (uint256 i; i < n; ++i) {
            if (buyback && i == 2) continue;
            assertEq(
                uint8(IClankerLpLockerFeeConversion(LP_LOCKER).feePreferences(token, i)),
                uint8(IClankerLpLockerFeeConversion.FeeIn.Paired),
                "WETH slots take the paired token"
            );
        }

        // kernel: root validator + hook = guardian, fuel inside
        assertEq(IKernel(kernel).rootValidator(), KernelLib.validatorId(address(guardian)), "root is the guardian");
        assertEq(IKernel(kernel).validationConfig(KernelLib.validatorId(address(guardian))).hook, address(guardian));
        assertEq(IKernel(kernel).entrypoint(), ENTRY_POINT);
        assertEq(IERC20(USDC).balanceOf(kernel), FUEL, "fuel in the kernel");

        // ERC-8004 identity owned by the kernel
        assertEq(IERC8004IdentityRegistry(IDENTITY).ownerOf(agentId), kernel, "identity owned by the kernel");
        assertEq(IERC8004IdentityRegistry(IDENTITY).tokenURI(agentId), "https://bootr.fun/agents/test.json");

        // guardian
        AgentGuardian.AgentInfo memory a = guardian.agentInfo(kernel);
        assertEq(a.token, token);
        assertEq(a.creator, creatorOf(kernel));
        assertEq(a.dormancyPeriod, DORMANCY);
        assertFalse(a.paused);
        // nothing stays in the launcher
        assertEq(address(clankerLauncher).balance, 0);
        assertEq(IERC20(token).balanceOf(address(clankerLauncher)), 0);
        assertEq(IERC20(WETH).balanceOf(address(clankerLauncher)), 0);
    }

    /// @dev The creator the guardian recorded for `kernel` (launches come from `creator` or the treasury).
    function creatorOf(address kernel) internal view returns (address) {
        return guardian.agentInfo(kernel).creator;
    }
}
