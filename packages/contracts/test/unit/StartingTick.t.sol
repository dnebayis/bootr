// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {BootrLauncher} from "../../src/BootrLauncher.sol";

/// @dev No-fork unit test pinning the opening price of every Bootr coin.
///
///      Uniswap v4 price at a tick is 1.0001^tick (token1 per token0). The launcher places the coin's
///      whole supply one-sided at STARTING_TICK, stated "as if the coin is token0", so the opening price is
///      1.0001^STARTING_TICK WETH per coin and the fully diluted value is TOTAL_SUPPLY * 1.0001^STARTING_TICK.
///      With a 100B supply, tick -243_400 gives ~2.7e-11 WETH per coin, ~2.7 ETH fully diluted (about $6k at
///      $2,250/ETH; the USD figure moves with ETH).
///
///      1.0001^n is computed here by exponentiation by squaring in 1e18 fixed point (WAD). Each multiply
///      truncates at most 1 wei of a value >= 1e18, so after the ~18 squarings the relative error is far below
///      1e-12, nothing the 2.5-2.9 ETH window could notice. The helper is itself checked against
///      1.0001^10_000 ~= e^0.99995 ~= 2.71815 before it is trusted.
contract StartingTickTest is Test {
    BootrLauncher launcher;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant ONE_POINT_0001 = 1_000_100_000_000_000_000; // 1.0001 in WAD

    /// @dev 1.0001^n in WAD, exponentiation by squaring.
    function _pow10001(uint256 n) internal pure returns (uint256 result) {
        result = WAD;
        uint256 base = ONE_POINT_0001;
        while (n > 0) {
            if (n & 1 == 1) result = result * base / WAD;
            base = base * base / WAD;
            n >>= 1;
        }
    }

    function setUp() public {
        BootrLauncher.Deps memory d = BootrLauncher.Deps({
            rwagmiLauncher: makeAddr("rwagmiLauncher"),
            rwagmiLocker: makeAddr("rwagmiLocker"),
            rwagmiHook: makeAddr("rwagmiHook"),
            rwagmiDevBuy: makeAddr("rwagmiDevBuy"),
            b20Factory: makeAddr("b20Factory"),
            weth: makeAddr("weth"),
            usdc: makeAddr("usdc"),
            identityRegistry: makeAddr("identity"),
            kernelFactory: makeAddr("kernelFactory"),
            guardian: makeAddr("guardian"),
            burnerImplementation: makeAddr("burnerImpl"),
            universalRouter: makeAddr("router"),
            permit2: makeAddr("permit2")
        });
        BootrLauncher.LaunchDefaults memory standard = BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: 6500,
            burnBps: 0,
            platformBps: 3000,
            platformRecipient: makeAddr("platform"),
            minFuelUsdc: 25e6,
            dormancyPeriod: 90 days
        });
        BootrLauncher.LaunchDefaults memory buyback = BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: 5000,
            burnBps: 1500,
            platformBps: 3000,
            platformRecipient: makeAddr("platform"),
            minFuelUsdc: 25e6,
            dormancyPeriod: 90 days
        });
        launcher = new BootrLauncher(makeAddr("owner"), d, standard, buyback, 1000);
    }

    function test_powHelperMatchesE() public pure {
        // 1.0001^10000 = e^(10000 * ln 1.0001) = e^0.99995 ~= 2.718146
        uint256 p = _pow10001(10_000);
        assertGt(p, 2_718_100_000_000_000_000);
        assertLt(p, 2_718_200_000_000_000_000);
    }

    function test_startingTickValue() public view {
        int24 tick = launcher.STARTING_TICK();
        int24 spacing = launcher.TICK_SPACING();
        int24 upper = launcher.POSITION_TICK_UPPER();
        assertEq(tick, -243_400);
        assertEq(spacing, 200);
        assertEq(tick % spacing, 0, "tick must be usable");
        assertEq(upper % spacing, 0, "upper must be usable");
        assertLt(tick, upper, "one-sided range must be non-empty");
    }

    function test_impliedFdvAbout2point7Eth() public view {
        int24 tick = launcher.STARTING_TICK();
        assertLt(tick, 0);
        uint256 n = uint256(uint24(-tick));
        // price = 1 / 1.0001^n WETH per coin; fdvWei = TOTAL_SUPPLY (coin wei) * price.
        // TOTAL_SUPPLY has 18 decimals, so fdvWei = TOTAL_SUPPLY * WAD / pow(1.0001, n)_wad.
        uint256 powWad = _pow10001(n);
        uint256 fdvWei = launcher.TOTAL_SUPPLY() * WAD / powWad;
        assertGt(fdvWei, 2.5 ether, "fdv below 2.5 ETH");
        assertLt(fdvWei, 2.9 ether, "fdv above 2.9 ETH");
        // and the comment's figure, 2.7 ETH, to two digits
        assertGt(fdvWei, 2.65 ether);
        assertLt(fdvWei, 2.75 ether);
    }

    function test_rangeSpansAbout228000x() public view {
        uint256 span = uint256(uint24(launcher.POSITION_TICK_UPPER() - launcher.STARTING_TICK()));
        assertEq(span, 123_400);
        uint256 mult = _pow10001(span);
        assertGt(mult, 225_000 * WAD);
        assertLt(mult, 232_000 * WAD);
    }
}
