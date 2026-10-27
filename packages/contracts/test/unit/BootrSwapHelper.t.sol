// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {BootrSwapHelper} from "../../src/BootrSwapHelper.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator, MockSwapRouter} from "../mocks/MockSwapInfra.sol";

/// @dev No-fork unit tests for BootrSwapHelper against a mock router and a mock Chainlink feed. The real
///      pool path is covered by `test/fork/SwapHelperFork.t.sol`.
contract BootrSwapHelperTest is Test {
    BootrSwapHelper helper;
    MockERC20 weth;
    MockERC20 usdc;
    MockSwapRouter router;
    MockAggregator feed;

    address kernel = makeAddr("kernel");
    address attacker = makeAddr("attacker");

    int256 constant PRICE = 3000e8; // 3000 USD / ETH

    function setUp() public {
        vm.warp(1_800_000_000);
        weth = new MockERC20("WETH", "WETH", 18);
        usdc = new MockERC20("USDC", "USDC", 6);
        router = new MockSwapRouter(uint256(PRICE));
        feed = new MockAggregator(8, PRICE);
        helper = new BootrSwapHelper(address(weth), address(usdc), address(router), address(feed), 500);
        weth.mint(kernel, 10 ether);
        vm.prank(kernel);
        weth.approve(address(helper), type(uint256).max);
    }

    function test_constructorAndConstants() public view {
        assertEq(address(helper.weth()), address(weth));
        assertEq(address(helper.usdc()), address(usdc));
        assertEq(address(helper.swapRouter()), address(router));
        assertEq(address(helper.ethUsdFeed()), address(feed));
        assertEq(helper.poolFee(), 500);
        assertEq(helper.feedDecimals(), 8);
        assertEq(helper.MAX_SLIPPAGE_BPS(), 300);
        assertEq(helper.MAX_PRICE_AGE(), 1 hours);
        assertEq(weth.allowance(address(helper), address(router)), type(uint256).max);
        assertEq(helper.ethUsdPrice(), uint256(PRICE));
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(BootrSwapHelper.ZeroAddress.selector);
        new BootrSwapHelper(address(0), address(usdc), address(router), address(feed), 500);
        vm.expectRevert(BootrSwapHelper.ZeroAddress.selector);
        new BootrSwapHelper(address(weth), address(usdc), address(router), address(0), 500);
    }

    function test_floorMath() public view {
        // 1 ETH at 3000 USD, 1% slippage -> 2970 USDC
        assertEq(helper.minUsdcOut(1 ether, 100), 2970e6);
        assertEq(helper.minUsdcOut(0.01 ether, 0), 30e6);
        assertEq(helper.minUsdcOut(0.01 ether, 300), 29.1e6);
    }

    function test_swapPaysCallerAtLeastFloor() public {
        vm.prank(kernel);
        uint256 out = helper.swapWethToUsdc(1 ether, 100);
        assertEq(out, 3000e6);
        assertEq(usdc.balanceOf(kernel), 3000e6);
        assertEq(weth.balanceOf(kernel), 9 ether);
        assertEq(weth.balanceOf(address(helper)), 0, "helper keeps nothing");
        assertEq(usdc.balanceOf(address(helper)), 0);
    }

    function test_slippageAboveMaxRejected() public {
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.SlippageTooHigh.selector, 301, 300));
        helper.swapWethToUsdc(1 ether, 301);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.SlippageTooHigh.selector, 10_000, 300));
        helper.minUsdcOut(1 ether, 10_000);
    }

    function test_zeroAmountRejected() public {
        vm.prank(kernel);
        vm.expectRevert(BootrSwapHelper.ZeroAmount.selector);
        helper.swapWethToUsdc(0, 100);
    }

    function test_poolWorseThanOracleFloorReverts() public {
        // the pool pays 5% under the oracle: a 3% cap must reject it (a sandwiched / drained pool)
        router.set(uint256(PRICE), 500, address(0));
        vm.prank(kernel);
        vm.expectRevert("Too little received");
        helper.swapWethToUsdc(1 ether, 300);
        // 2% under passes with the 3% cap, fails with a 1% cap
        router.set(uint256(PRICE), 200, address(0));
        vm.prank(kernel);
        vm.expectRevert("Too little received");
        helper.swapWethToUsdc(1 ether, 100);
        vm.prank(kernel);
        assertEq(helper.swapWethToUsdc(1 ether, 300), 2940e6);
    }

    function test_outputDivertedElsewhereReverts() public {
        // a router that pays someone else: the helper measures the caller's balance and reverts
        router.set(uint256(PRICE), 0, attacker);
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.InsufficientOutput.selector, 0, 2970e6));
        helper.swapWethToUsdc(1 ether, 100);
    }

    function test_stalePriceReverts() public {
        feed.set(PRICE, block.timestamp - 1 hours - 1, 10, 10);
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.StalePrice.selector, block.timestamp - 1 hours - 1, block.timestamp));
        helper.swapWethToUsdc(1 ether, 100);
        // exactly one hour old is still accepted
        feed.set(PRICE, block.timestamp - 1 hours, 10, 10);
        vm.prank(kernel);
        helper.swapWethToUsdc(1 ether, 100);
        // answeredInRound behind roundId -> stale
        feed.set(PRICE, block.timestamp, 11, 10);
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.StalePrice.selector, block.timestamp, block.timestamp));
        helper.swapWethToUsdc(1 ether, 100);
        // zero updatedAt -> stale
        feed.set(PRICE, 0, 10, 10);
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.StalePrice.selector, 0, block.timestamp));
        helper.swapWethToUsdc(1 ether, 100);
    }

    function test_zeroOrNegativePriceReverts() public {
        feed.set(0, block.timestamp, 10, 10);
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.InvalidPrice.selector, 0));
        helper.swapWethToUsdc(1 ether, 100);
        feed.set(-1, block.timestamp, 10, 10);
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.InvalidPrice.selector, -1));
        helper.swapWethToUsdc(1 ether, 100);
    }

    function test_feedDecimalsScaled() public {
        MockAggregator f18 = new MockAggregator(18, 3000e18);
        BootrSwapHelper h = new BootrSwapHelper(address(weth), address(usdc), address(router), address(f18), 500);
        assertEq(h.ethUsdPrice(), 3000e8);
        MockAggregator f6 = new MockAggregator(6, 3000e6);
        h = new BootrSwapHelper(address(weth), address(usdc), address(router), address(f6), 500);
        assertEq(h.ethUsdPrice(), 3000e8);
    }

    function test_thirdPartyCannotSpendCallerAllowance() public {
        // the only transferFrom is from msg.sender: an attacker without WETH/allowance gets nothing
        vm.prank(attacker);
        vm.expectRevert();
        helper.swapWethToUsdc(1 ether, 100);
        assertEq(weth.balanceOf(kernel), 10 ether);
    }

    function test_fuzzOutputNeverBelowFloor(uint256 amountIn, uint256 bps, uint256 skim) public {
        amountIn = bound(amountIn, 1, 1000 ether);
        bps = bound(bps, 0, 300);
        skim = bound(skim, 0, 1000);
        weth.mint(kernel, amountIn);
        router.set(uint256(PRICE), skim, address(0));
        uint256 floor = helper.minUsdcOut(amountIn, bps);
        uint256 poolOut = (amountIn * uint256(PRICE) * (10_000 - skim)) / (10_000 * 1e20);
        vm.prank(kernel);
        if (poolOut < floor) {
            vm.expectRevert("Too little received");
            helper.swapWethToUsdc(amountIn, bps);
        } else {
            uint256 out = helper.swapWethToUsdc(amountIn, bps);
            assertGe(out, floor);
            assertEq(usdc.balanceOf(kernel), out);
        }
    }
}
