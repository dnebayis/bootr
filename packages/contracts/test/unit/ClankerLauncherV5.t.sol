// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {BootrClankerLauncherV5} from "../../src/BootrClankerLauncherV5.sol";
import {ClankerV5} from "../../src/interfaces/IClankerV5.sol";
import {KernelLib} from "../../src/interfaces/IKernel.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4.sol";

/// @dev No-fork unit tests for BootrClankerLauncherV5's presets, the v5 tax and fee-slot arithmetic and the admin
///      surface. Launches run on the mainnet fork (test/fork/ClankerV5Fork.t.sol).
contract ClankerLauncherV5Test is Test {
    BootrClankerLauncherV5 launcher;
    address owner = makeAddr("owner");
    address platform = makeAddr("platform");
    address guardian = makeAddr("guardian");
    address hook = makeAddr("hook");
    address stranger = makeAddr("stranger");

    function _deps() internal returns (BootrClankerLauncherV5.Deps memory d) {
        d = BootrClankerLauncherV5.Deps({
            factory: makeAddr("factory"),
            hook: hook,
            feeEscrow: makeAddr("feeEscrow"),
            quoteToken: address(0),
            usdc: makeAddr("usdc"),
            identityRegistry: makeAddr("identity"),
            kernelFactory: makeAddr("kernelFactory"),
            guardian: guardian,
            gate: makeAddr("gate")
        });
    }

    function _standard() internal view returns (BootrClankerLauncherV5.LaunchDefaults memory) {
        return BootrClankerLauncherV5.LaunchDefaults({
            lpFeeBps: 15_000,
            agentBps: 500,
            creatorBps: 6500,
            burnBps: 0,
            platformBps: 3000,
            platformRecipient: platform,
            minFuelUsdc: 25e6,
            dormancyPeriod: 90 days
        });
    }

    function _buyback() internal view returns (BootrClankerLauncherV5.LaunchDefaults memory) {
        BootrClankerLauncherV5.LaunchDefaults memory d = _standard();
        d.creatorBps = 5000;
        d.burnBps = 1500;
        return d;
    }

    function setUp() public {
        launcher = new BootrClankerLauncherV5(owner, _deps(), _standard(), _buyback(), 1000);
    }

    function test_presetsAndConstants() public view {
        (uint24 tax, uint16 a, uint16 c, uint16 b, uint16 p, address r, uint256 f, uint32 d) =
            launcher.standardDefaults();
        assertEq(tax, 15_000);
        assertEq(a, 500);
        assertEq(c, 6500);
        assertEq(b, 0);
        assertEq(p, 3000);
        assertEq(r, platform);
        assertEq(f, 25e6);
        assertEq(d, 90 days);
        (tax, a, c, b, p, r, f, d) = launcher.buybackDefaults();
        assertEq(tax, 15_000);
        assertEq(c, 5000);
        assertEq(b, 1500);
        assertEq(launcher.minPlatformBps(), 1000);
        assertEq(launcher.MIN_TAX_BPS(), 10_000, "Clanker's live floor, 1%");
        assertEq(launcher.MAX_TAX_BPS(), 30_000, "Bootr's ceiling, 3%");
        assertEq(launcher.quoteToken(), address(0), "native ETH quote");
        assertTrue(launcher.antiSnipe(), "anti-snipe on by default, like clanker.world");
        assertEq(launcher.platformTaxBps(), 0);
        assertEq(launcher.launchFeeWei(), 0);
        assertEq(launcher.owner(), owner);
        assertEq(launcher.ROOT_VALIDATION_ID(), KernelLib.validatorId(guardian));
        assertEq(launcher.DEAD(), 0x000000000000000000000000000000000000dEaD);
    }

    // ------------------------------------------------------------------
    // The v5 arithmetic (docs/design/clanker-v5-migration.md sections 2 and 4)
    // ------------------------------------------------------------------

    function test_slotWeightsStandardAreThePresetBps() public view {
        uint16[3] memory w = launcher.slotWeightsFor(false);
        assertEq(w[0], 500);
        assertEq(w[1], 6500);
        assertEq(w[2], 3000);
    }

    function test_slotWeightsBuybackRenormaliseOverTheBurnWithTheCreatorTakingTheRemainder() public view {
        uint16[3] memory w = launcher.slotWeightsFor(true);
        // 500 / 8500 = 588.2 -> 588, 3000 / 8500 = 3529.4 -> 3529, the creator takes 10000 - 588 - 3529
        assertEq(w[0], 588);
        assertEq(w[1], 5883);
        assertEq(w[2], 3529);
        assertEq(uint256(w[0]) + w[1] + w[2], 10_000, "weights sum to 10000 (Clanker's check)");
        // of the slot pool including the burn (85% to the slots): the platform never gets more than its 30%
        assertLe(uint256(w[2]) * 8500, 3000 * 10_000, "platform at most its stated share");
        assertLe(uint256(w[0]) * 8500, 500 * 10_000, "agent at most its stated share");
        assertGe(uint256(w[1]) * 8500, 5000 * 10_000, "the creator carries the rounding");
    }

    function test_taxConfigurationStandard() public view {
        ClankerV5.TaxConfiguration memory t = launcher.taxConfigurationFor(false);
        assertEq(t.buyTaxRate, 1_500_000, "1.5% on Clanker's 1e8 scale");
        assertEq(t.sellTaxRate, 1_500_000, "buy tax == sell tax");
        assertEq(t.creatorAllocationShare, 100_000_000, "everything after Clanker goes to the slots");
        assertEq(t.burnAllocationShare, 0);
        assertEq(t.dividendAllocationShare, 0);
        assertEq(t.integratorAllocationShare, 0);
        assertEq(t.minimumDividendHolding, 0);
    }

    function test_taxConfigurationBuyback() public view {
        ClankerV5.TaxConfiguration memory t = launcher.taxConfigurationFor(true);
        assertEq(t.buyTaxRate, 1_500_000);
        assertEq(t.sellTaxRate, 1_500_000);
        assertEq(t.burnAllocationShare, 15_000_000, "15% of the post-Clanker tax, burned in the coin");
        assertEq(t.creatorAllocationShare, 85_000_000);
        assertEq(uint256(t.creatorAllocationShare) + t.burnAllocationShare, ClankerV5.PERCENTAGE_SCALE);
    }

    function test_scopedSaltAndPoolKey() public {
        address creator = makeAddr("creator");
        bytes32 salt = bytes32(uint256(7));
        assertEq(
            launcher.scopedSalt(creator, salt),
            keccak256(abi.encode(address(launcher), keccak256(abi.encode(creator, salt)))),
            "Clanker scopes keccak(creator, salt) by the caller (this launcher)"
        );
        // native ETH is address(0) and therefore always currency0
        PoolKey memory key = launcher.poolKeyFor(0x000000000000000000000000000000000000CcCc, 200);
        assertEq(key.currency0, address(0));
        assertEq(key.currency1, 0x000000000000000000000000000000000000CcCc);
        assertEq(key.fee, 0, "v5 pools carry fee 0; the hook takes the tax");
        assertEq(key.tickSpacing, 200);
        assertEq(key.hooks, hook);
    }

    // ------------------------------------------------------------------
    // Admin surface
    // ------------------------------------------------------------------

    function test_setDefaultsBoundsTheTax() public {
        BootrClankerLauncherV5.LaunchDefaults memory d = _standard();
        d.lpFeeBps = 9_999;
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.InvalidTax.selector);
        launcher.setDefaults(false, d);
        d.lpFeeBps = 30_001;
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.InvalidTax.selector);
        launcher.setDefaults(false, d);
        d.lpFeeBps = 30_000;
        vm.prank(owner);
        launcher.setDefaults(false, d);
        (uint24 tax,,,,,,,) = launcher.standardDefaults();
        assertEq(tax, 30_000);
        d.lpFeeBps = 12_000;
        vm.prank(owner);
        launcher.setDefaults(false, d);
        ClankerV5.TaxConfiguration memory t = launcher.taxConfigurationFor(false);
        assertEq(t.buyTaxRate, 1_200_000);
    }

    function test_setDefaultsKeepsTheOtherChecks() public {
        BootrClankerLauncherV5.LaunchDefaults memory d = _standard();
        d.platformBps = 2999;
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.InvalidBpsSum.selector);
        launcher.setDefaults(false, d);
        d = _standard();
        d.burnBps = 100;
        d.creatorBps = 6400;
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.BurnBpsMismatch.selector);
        launcher.setDefaults(false, d);
        d = _standard();
        d.platformBps = 500;
        d.creatorBps = 9000;
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.PlatformBpsBelowMinimum.selector);
        launcher.setDefaults(false, d);
        d = _standard();
        d.dormancyPeriod = 29 days;
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.InvalidDormancyPeriod.selector);
        launcher.setDefaults(false, d);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launcher.setDefaults(false, _standard());
    }

    function test_platformTaxBounds() public {
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.InvalidTax.selector);
        launcher.setPlatformTaxBps(9_999);
        vm.prank(owner);
        vm.expectRevert(BootrClankerLauncherV5.InvalidTax.selector);
        launcher.setPlatformTaxBps(30_001);
        vm.prank(owner);
        launcher.setPlatformTaxBps(20_000);
        assertEq(launcher.platformTaxBps(), 20_000);
        vm.prank(owner);
        launcher.setPlatformTaxBps(0);
        assertEq(launcher.platformTaxBps(), 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launcher.setPlatformTaxBps(20_000);
    }

    function test_antiSnipeLaunchFeeAndPause() public {
        vm.prank(owner);
        launcher.setAntiSnipe(false);
        assertFalse(launcher.antiSnipe());
        vm.prank(owner);
        launcher.setLaunchFee(0.0005 ether);
        assertEq(launcher.launchFeeWei(), 0.0005 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launcher.setAntiSnipe(true);
        vm.prank(owner);
        launcher.pause();
        BootrClankerLauncherV5.LaunchParams memory p;
        p.name = "x";
        p.symbol = "X";
        vm.expectRevert(Pausable.EnforcedPause.selector);
        launcher.launch(p);
        vm.prank(owner);
        launcher.unpause();
        assertFalse(launcher.paused());
    }

    function test_constructorRejectsZeroDeps() public {
        BootrClankerLauncherV5.Deps memory d = _deps();
        d.factory = address(0);
        vm.expectRevert(BootrClankerLauncherV5.ZeroAddress.selector);
        new BootrClankerLauncherV5(owner, d, _standard(), _buyback(), 1000);
        d = _deps();
        d.feeEscrow = address(0);
        vm.expectRevert(BootrClankerLauncherV5.ZeroAddress.selector);
        new BootrClankerLauncherV5(owner, d, _standard(), _buyback(), 1000);
        // the quote may be the zero address (native ETH)
        d = _deps();
        d.quoteToken = address(0);
        new BootrClankerLauncherV5(owner, d, _standard(), _buyback(), 1000);
        vm.expectRevert(BootrClankerLauncherV5.InvalidMinPlatformBps.selector);
        new BootrClankerLauncherV5(owner, _deps(), _standard(), _buyback(), 10_001);
    }
}
