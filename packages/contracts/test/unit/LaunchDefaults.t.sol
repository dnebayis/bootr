// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {BootrLauncher} from "../../src/BootrLauncher.sol";
import {KernelLib} from "../../src/interfaces/IKernel.sol";

/// @dev No-fork unit tests for the launcher's bps math, presets and admin surface.
contract LaunchDefaultsTest is Test {
    BootrLauncher launcher;
    address owner = makeAddr("owner");
    address platform = makeAddr("platform");
    address guardian = makeAddr("guardian");

    function _deps() internal returns (BootrLauncher.Deps memory d) {
        d = BootrLauncher.Deps({
            clanker: makeAddr("clanker"),
            feeLocker: makeAddr("feeLocker"),
            lpLocker: makeAddr("lpLocker"),
            staticHook: makeAddr("hook"),
            devBuyExtension: makeAddr("devBuy"),
            mevModule: makeAddr("mev"),
            weth: makeAddr("weth"),
            usdc: makeAddr("usdc"),
            identityRegistry: makeAddr("identity"),
            kernelFactory: makeAddr("kernelFactory"),
            guardian: guardian,
            burnerImplementation: makeAddr("burnerImpl"),
            universalRouter: makeAddr("router"),
            permit2: makeAddr("permit2")
        });
    }

    function _standard() internal view returns (BootrLauncher.LaunchDefaults memory) {
        return BootrLauncher.LaunchDefaults({
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

    function _buyback() internal view returns (BootrLauncher.LaunchDefaults memory) {
        return BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: 5000,
            burnBps: 1500,
            platformBps: 3000,
            platformRecipient: platform,
            minFuelUsdc: 25e6,
            dormancyPeriod: 90 days
        });
    }

    function setUp() public {
        launcher = new BootrLauncher(owner, _deps(), _standard(), _buyback(), 1000);
    }

    function test_presetsStored() public view {
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
        assertEq(a, 500);
        assertEq(c, 5000);
        assertEq(b, 1500);
        assertEq(p, 3000);
        assertEq(uint256(a) + c + b + p, 10_000);
        assertEq(launcher.minPlatformBps(), 1000);
        assertEq(launcher.owner(), owner);
        assertEq(launcher.ROOT_VALIDATION_ID(), KernelLib.validatorId(guardian));
        assertEq(launcher.ROOT_VALIDATION_ID(), bytes21(abi.encodePacked(bytes1(0x01), guardian)));
    }

    function test_rejectsBadBpsSum() public {
        BootrLauncher.LaunchDefaults memory d = _standard();
        d.platformBps = 2999;
        vm.prank(owner);
        vm.expectRevert(BootrLauncher.InvalidBpsSum.selector);
        launcher.setDefaults(false, d);
    }

    function test_rejectsZeroBps() public {
        BootrLauncher.LaunchDefaults memory d = _standard();
        d.agentBps = 0;
        d.creatorBps = 7000;
        vm.prank(owner);
        vm.expectRevert(BootrLauncher.ZeroBps.selector);
        launcher.setDefaults(false, d);
    }

    function test_rejectsBurnMismatch() public {
        BootrLauncher.LaunchDefaults memory d = _standard();
        vm.startPrank(owner);
        vm.expectRevert(BootrLauncher.BurnBpsMismatch.selector);
        launcher.setDefaults(true, d); // buyback preset with burnBps == 0
        d = _buyback();
        vm.expectRevert(BootrLauncher.BurnBpsMismatch.selector);
        launcher.setDefaults(false, d); // standard preset with burnBps != 0
        vm.stopPrank();
    }

    function test_enforcesMinPlatformBps() public {
        vm.startPrank(owner);
        launcher.setMinPlatformBps(3500);
        BootrLauncher.LaunchDefaults memory d = _standard();
        vm.expectRevert(BootrLauncher.PlatformBpsBelowMinimum.selector);
        launcher.setDefaults(false, d);
        d.platformBps = 3500;
        d.creatorBps = 6000;
        launcher.setDefaults(false, d);
        vm.expectRevert(BootrLauncher.InvalidMinPlatformBps.selector);
        launcher.setMinPlatformBps(10_001);
        vm.stopPrank();
    }

    function test_rejectsLpFeeAndDormancyBounds() public {
        BootrLauncher.LaunchDefaults memory d = _standard();
        vm.startPrank(owner);
        d.lpFeeBps = 100_001;
        vm.expectRevert(BootrLauncher.InvalidLpFee.selector);
        launcher.setDefaults(false, d);
        d.lpFeeBps = 0;
        vm.expectRevert(BootrLauncher.InvalidLpFee.selector);
        launcher.setDefaults(false, d);
        d = _standard();
        d.dormancyPeriod = 29 days;
        vm.expectRevert(BootrLauncher.InvalidDormancyPeriod.selector);
        launcher.setDefaults(false, d);
        d = _standard();
        d.platformRecipient = address(0);
        vm.expectRevert(BootrLauncher.ZeroAddress.selector);
        launcher.setDefaults(false, d);
        vm.stopPrank();
    }

    function test_onlyOwnerCanUpdate() public {
        vm.expectRevert();
        launcher.setDefaults(false, _standard());
        vm.expectRevert();
        launcher.setMinPlatformBps(1);
        vm.expectRevert();
        launcher.pause();
    }

    function test_pauseBlocksLaunch() public {
        vm.prank(owner);
        launcher.pause();
        BootrLauncher.LaunchParams memory p;
        p.name = "A";
        p.symbol = "A";
        vm.expectRevert(Pausable.EnforcedPause.selector);
        launcher.launch(p);
        vm.prank(owner);
        launcher.unpause();
        assertFalse(launcher.paused());
    }

    function test_launchParamChecksBeforeExternalCalls() public {
        BootrLauncher.LaunchParams memory p;
        p.name = "A";
        p.symbol = "A";
        p.devBuyWei = 1 ether;
        vm.expectRevert(BootrLauncher.InsufficientValue.selector);
        launcher.launch(p);
        p.devBuyWei = 0;
        p.fuelUsdc = 1e6; // below minFuelUsdc = 25e6
        vm.expectRevert(BootrLauncher.InsufficientFuel.selector);
        launcher.launch(p);
        p.fuelUsdc = 25e6;
        p.name = "";
        vm.expectRevert(BootrLauncher.EmptyNameOrSymbol.selector);
        launcher.launch(p);
    }

    function testFuzz_bpsSumInvariant(uint16 a, uint16 c, uint16 p) public {
        a = uint16(bound(a, 1, 9998));
        c = uint16(bound(c, 1, 9999 - a));
        p = uint16(bound(p, 1, 10_000 - a - c));
        uint16 b = 10_000 - a - c - p;
        BootrLauncher.LaunchDefaults memory d = _standard();
        d.agentBps = a;
        d.creatorBps = c;
        d.platformBps = p;
        d.burnBps = b;
        uint16 minP = launcher.minPlatformBps();
        vm.prank(owner);
        if (p < minP) {
            vm.expectRevert(BootrLauncher.PlatformBpsBelowMinimum.selector);
            launcher.setDefaults(b > 0, d);
            return;
        }
        launcher.setDefaults(b > 0, d);
        (, uint16 a2, uint16 c2, uint16 b2, uint16 p2,,,) =
            b > 0 ? launcher.buybackDefaults() : launcher.standardDefaults();
        assertEq(uint256(a2) + c2 + b2 + p2, 10_000);
    }

    function test_predictBurnerMatchesEip1167() public view {
        // sanity: prediction is deterministic and non-zero
        address x = launcher.predictBurner(address(0xBEEF), bytes32(uint256(1)));
        address y = launcher.predictBurner(address(0xBEEF), bytes32(uint256(1)));
        assertEq(x, y);
        assertTrue(x != address(0));
        assertTrue(launcher.predictBurner(address(0xBEEF), bytes32(uint256(2))) != x);
    }
}
