// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {BootrClankerLauncher} from "../../src/BootrClankerLauncher.sol";
import {IClanker, IClankerMevDescendingFees} from "../../src/interfaces/IClanker.sol";
import {KernelLib} from "../../src/interfaces/IKernel.sol";
import {PoolKey, V4Constants} from "../../src/interfaces/IUniswapV4.sol";

/// @dev No-fork unit tests for BootrClankerLauncher's presets, admin surface, platform LP fee and MEV module
///      settings. Launches themselves run on the mainnet fork (test/fork/ClankerFork.t.sol).
contract ClankerLauncherTest is Test {
    BootrClankerLauncher launcher;
    address owner = makeAddr("owner");
    address platform = makeAddr("platform");
    address guardian = makeAddr("guardian");
    address hook = makeAddr("hook");
    address weth = makeAddr("weth");
    address mevModule = makeAddr("mevModule");

    function _deps() internal returns (BootrClankerLauncher.Deps memory d) {
        d = BootrClankerLauncher.Deps({
            clanker: makeAddr("clanker"),
            feeLocker: makeAddr("feeLocker"),
            lpLocker: makeAddr("lpLocker"),
            staticHook: hook,
            devBuyExtension: makeAddr("devBuy"),
            weth: weth,
            usdc: makeAddr("usdc"),
            identityRegistry: makeAddr("identity"),
            kernelFactory: makeAddr("kernelFactory"),
            guardian: guardian,
            gate: makeAddr("gate")
        });
    }

    function _mev() internal view returns (IClanker.MevModuleConfig memory) {
        return IClanker.MevModuleConfig({
            mevModule: mevModule,
            mevModuleData: abi.encode(IClankerMevDescendingFees.FeeConfig(666_777, 41_673, 15))
        });
    }

    function _standard() internal view returns (BootrClankerLauncher.LaunchDefaults memory) {
        return BootrClankerLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: 6500,
            burnBps: 0,
            platformBps: 3000,
            platformRecipient: platform,
            minFuelUsdc: 25e6,
            dormancyPeriod: 90 days
        });
    }

    function _buyback() internal view returns (BootrClankerLauncher.LaunchDefaults memory) {
        BootrClankerLauncher.LaunchDefaults memory d = _standard();
        d.creatorBps = 5000;
        d.burnBps = 1500;
        return d;
    }

    function setUp() public {
        launcher = new BootrClankerLauncher(owner, _deps(), _mev(), _standard(), _buyback(), 1000);
    }

    function test_presetsAndConstants() public view {
        (uint24 lp, uint16 a, uint16 c, uint16 b, uint16 p, address r, uint256 f, uint32 d) =
            launcher.standardDefaults();
        assertEq(lp, 10_000);
        assertEq(a, 500);
        assertEq(c, 6500);
        assertEq(b, 0);
        assertEq(p, 3000);
        assertEq(r, platform);
        assertEq(f, 25e6);
        assertEq(d, 90 days);
        (, a, c, b, p,,,) = launcher.buybackDefaults();
        assertEq(uint256(a) + c + b + p, 10_000);
        assertEq(b, 1500);
        assertEq(launcher.minPlatformBps(), 1000);
        assertEq(launcher.owner(), owner);
        assertEq(launcher.ROOT_VALIDATION_ID(), KernelLib.validatorId(guardian));
        // Clanker Standard layout, usable ticks
        assertEq(launcher.STARTING_TICK(), -230_400);
        assertEq(launcher.POSITION_TICK_UPPER(), -120_000);
        assertEq(launcher.TICK_SPACING(), 200);
        assertEq(launcher.STARTING_TICK() % launcher.TICK_SPACING(), 0);
        assertEq(launcher.POSITION_TICK_UPPER() % launcher.TICK_SPACING(), 0);
        assertEq(launcher.TOTAL_SUPPLY(), 100_000_000_000e18);
        assertEq(launcher.DEAD(), 0x000000000000000000000000000000000000dEaD);
        assertEq(launcher.platformLpFeeBps(), 0);
        assertEq(launcher.mevModule(), mevModule);
        assertEq(launcher.mevModuleData(), abi.encode(IClankerMevDescendingFees.FeeConfig(666_777, 41_673, 15)));
    }

    function test_poolKeyUsesDynamicFeeFlagAndSortsCurrencies() public view {
        address token = address(uint160(weth) - 1);
        PoolKey memory k = launcher.poolKeyFor(token);
        assertEq(k.currency0, token);
        assertEq(k.currency1, weth);
        assertEq(k.fee, V4Constants.DYNAMIC_FEE_FLAG);
        assertEq(k.tickSpacing, 200);
        assertEq(k.hooks, hook);
        token = address(uint160(weth) + 1);
        k = launcher.poolKeyFor(token);
        assertEq(k.currency0, weth);
        assertEq(k.currency1, token);
    }

    function test_constructorRejectsZeroDepsAndMevModule() public {
        BootrClankerLauncher.Deps memory d = _deps();
        d.gate = address(0);
        vm.expectRevert(BootrClankerLauncher.ZeroAddress.selector);
        new BootrClankerLauncher(owner, d, _mev(), _standard(), _buyback(), 1000);
        d = _deps();
        d.lpLocker = address(0);
        vm.expectRevert(BootrClankerLauncher.ZeroAddress.selector);
        new BootrClankerLauncher(owner, d, _mev(), _standard(), _buyback(), 1000);
        IClanker.MevModuleConfig memory m = _mev();
        m.mevModule = address(0);
        vm.expectRevert(BootrClankerLauncher.ZeroAddress.selector);
        new BootrClankerLauncher(owner, _deps(), m, _standard(), _buyback(), 1000);
    }

    function test_presetValidation() public {
        BootrClankerLauncher.LaunchDefaults memory d = _standard();
        vm.startPrank(owner);
        d.platformBps = 2999;
        vm.expectRevert(BootrClankerLauncher.InvalidBpsSum.selector);
        launcher.setDefaults(false, d);
        d = _standard();
        d.agentBps = 0;
        d.creatorBps = 7000;
        vm.expectRevert(BootrClankerLauncher.ZeroBps.selector);
        launcher.setDefaults(false, d);
        vm.expectRevert(BootrClankerLauncher.BurnBpsMismatch.selector);
        launcher.setDefaults(true, _standard());
        vm.expectRevert(BootrClankerLauncher.BurnBpsMismatch.selector);
        launcher.setDefaults(false, _buyback());
        d = _standard();
        d.lpFeeBps = 100_001;
        vm.expectRevert(BootrClankerLauncher.InvalidLpFee.selector);
        launcher.setDefaults(false, d);
        d.lpFeeBps = 0;
        vm.expectRevert(BootrClankerLauncher.InvalidLpFee.selector);
        launcher.setDefaults(false, d);
        d = _standard();
        d.dormancyPeriod = 29 days;
        vm.expectRevert(BootrClankerLauncher.InvalidDormancyPeriod.selector);
        launcher.setDefaults(false, d);
        d = _standard();
        d.platformRecipient = address(0);
        vm.expectRevert(BootrClankerLauncher.ZeroAddress.selector);
        launcher.setDefaults(false, d);
        launcher.setMinPlatformBps(3500);
        vm.expectRevert(BootrClankerLauncher.PlatformBpsBelowMinimum.selector);
        launcher.setDefaults(false, _standard());
        vm.expectRevert(BootrClankerLauncher.InvalidMinPlatformBps.selector);
        launcher.setMinPlatformBps(10_001);
        vm.stopPrank();
    }

    function test_platformLpFeeBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(BootrClankerLauncher.InvalidLpFee.selector);
        launcher.setPlatformLpFeeBps(100_001);
        vm.expectEmit(true, true, true, true);
        emit BootrClankerLauncher.PlatformLpFeeUpdated(20_000);
        launcher.setPlatformLpFeeBps(20_000);
        assertEq(launcher.platformLpFeeBps(), 20_000);
        launcher.setPlatformLpFeeBps(0); // off again
        assertEq(launcher.platformLpFeeBps(), 0);
        vm.stopPrank();
    }

    function test_mevModuleUpdate() public {
        address other = makeAddr("otherModule");
        vm.startPrank(owner);
        vm.expectRevert(BootrClankerLauncher.ZeroAddress.selector);
        launcher.setMevModule(address(0), "");
        vm.expectEmit(true, true, true, true);
        emit BootrClankerLauncher.MevModuleUpdated(other, "");
        launcher.setMevModule(other, "");
        vm.stopPrank();
        assertEq(launcher.mevModule(), other);
        assertEq(launcher.mevModuleData(), "");
    }

    function test_onlyOwner() public {
        vm.expectRevert();
        launcher.setDefaults(false, _standard());
        vm.expectRevert();
        launcher.setMinPlatformBps(1);
        vm.expectRevert();
        launcher.setLaunchFee(1);
        vm.expectRevert();
        launcher.setPlatformLpFeeBps(1);
        vm.expectRevert();
        launcher.setMevModule(makeAddr("x"), "");
        vm.expectRevert();
        launcher.pause();
    }

    function test_launchParamChecksBeforeExternalCalls() public {
        vm.prank(owner);
        launcher.setLaunchFee(0.0005 ether);
        BootrClankerLauncher.LaunchParams memory p;
        p.name = "A";
        p.symbol = "A";
        p.devBuyWei = 0.01 ether;
        vm.deal(address(this), 1 ether);
        vm.expectRevert(BootrClankerLauncher.InsufficientValue.selector);
        launcher.launch{value: 0.01 ether}(p);
        vm.expectRevert(BootrClankerLauncher.InsufficientValue.selector);
        launcher.launch{value: 0.0105 ether - 1}(p);
        p.name = "";
        vm.expectRevert(BootrClankerLauncher.EmptyNameOrSymbol.selector);
        launcher.launch{value: 0.0105 ether}(p);
        p.name = "A";
        p.fuelUsdc = 1e6; // below minFuelUsdc
        vm.expectRevert(BootrClankerLauncher.InsufficientFuel.selector);
        launcher.launch{value: 0.0105 ether}(p);
    }

    function test_pauseBlocksLaunch() public {
        vm.prank(owner);
        launcher.pause();
        BootrClankerLauncher.LaunchParams memory p;
        p.name = "A";
        p.symbol = "A";
        vm.expectRevert(Pausable.EnforcedPause.selector);
        launcher.launch(p);
        vm.prank(owner);
        launcher.unpause();
        assertFalse(launcher.paused());
    }
}
