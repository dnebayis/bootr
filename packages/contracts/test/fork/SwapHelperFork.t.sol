// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BootrSwapHelper} from "../../src/BootrSwapHelper.sol";
import {IAggregatorV3} from "../../src/interfaces/IChainlink.sol";
import {IKernel, PackedUserOperation} from "../../src/interfaces/IKernel.sol";
import {IWETH9} from "../../src/interfaces/IUniswapV4.sol";
import {SecurityForkBase} from "../security/SecurityForkBase.sol";

/// @notice Base Sepolia fork tests for BootrSwapHelper through the real Uniswap v3 SwapRouter02, the real
///         WETH/USDC 0.05% pool (0x94bfc0574FF48E92cE43d495376C477B1d0EEeC0, ~0.05 WETH / ~430 USDC of
///         liquidity at review time, priced within 0.2% of Chainlink) and the real Chainlink ETH/USD feed.
contract SwapHelperForkTest is SecurityForkBase {
    function test_directSwapPaysCallerAboveOracleFloor() public {
        vm.deal(address(this), 1 ether);
        // the mainnet WETH/USDC 0.05% pool is deep: a small swap lands well inside the 2% Chainlink floor
        IWETH9(WETH).deposit{value: 0.0005 ether}();
        IWETH9(WETH).approve(address(swapHelper), 0.0005 ether);
        uint256 price = swapHelper.ethUsdPrice();
        assertGt(price, 100e8, "feed is live");
        uint256 floor = swapHelper.minUsdcOut(0.0005 ether, 200);
        assertEq(floor, (0.0005 ether * price * 9800) / (10_000 * 1e20));
        // deltas: the default test address may already hold USDC dust on mainnet
        uint256 usdcBefore = IERC20(USDC).balanceOf(address(this));
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));
        uint256 out = swapHelper.swapWethToUsdc(0.0005 ether, 200);
        assertGe(out, floor);
        assertEq(IERC20(USDC).balanceOf(address(this)) - usdcBefore, out);
        assertEq(wethBefore - IERC20(WETH).balanceOf(address(this)), 0.0005 ether);
        assertEq(IERC20(WETH).balanceOf(address(swapHelper)), 0);
        assertEq(IERC20(USDC).balanceOf(address(swapHelper)), 0);
    }

    function test_staleFeedReverts() public {
        vm.deal(address(this), 1 ether);
        IWETH9(WETH).deposit{value: 0.001 ether}();
        IWETH9(WETH).approve(address(swapHelper), 0.001 ether);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            IAggregatorV3(ETH_USD_FEED).latestRoundData();
        uint256 stale = vm.getBlockTimestamp() - 1 hours - 1;
        vm.mockCall(
            ETH_USD_FEED,
            abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(roundId, answer, startedAt, stale, answeredInRound)
        );
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.StalePrice.selector, stale, vm.getBlockTimestamp()));
        swapHelper.swapWethToUsdc(0.001 ether, 100);
        vm.clearMockedCalls();
        // a zero answer is rejected too
        vm.mockCall(
            ETH_USD_FEED,
            abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(roundId, int256(0), startedAt, updatedAt, answeredInRound)
        );
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.InvalidPrice.selector, int256(0)));
        swapHelper.swapWethToUsdc(0.001 ether, 100);
    }

    function test_slippageIsCappedByTheContract() public {
        vm.deal(address(this), 1 ether);
        IWETH9(WETH).deposit{value: 0.001 ether}();
        IWETH9(WETH).approve(address(swapHelper), 0.001 ether);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.SlippageTooHigh.selector, 301, 300));
        swapHelper.swapWethToUsdc(0.001 ether, 301);
        // a swap large enough to push even the deep mainnet pool past 3% is refused by the router floor
        vm.deal(address(this), 5_000 ether);
        IWETH9(WETH).deposit{value: 4_000 ether}();
        IWETH9(WETH).approve(address(swapHelper), 4_000 ether);
        vm.expectRevert(bytes("Too little received"));
        swapHelper.swapWethToUsdc(4_000 ether, 300);
    }

    function test_sessionKeyCanOnlyTurnKernelWethIntoKernelUsdc() public {
        (, address kernel) = _launch();
        _installSession(kernel, _productionPermissionData(kernel));
        vm.deal(address(this), 1 ether);
        IWETH9(WETH).deposit{value: 0.01 ether}();
        IWETH9(WETH).transfer(kernel, 0.01 ether);

        // (1) approve the helper from the session key (allow-listed)
        PackedUserOperation memory op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), WETH, abi.encodeCall(IERC20.approve, (address(swapHelper), type(uint256).max))
        );
        op.signature = _signSession(op);
        assertTrue(_handle(op), "approve executed");
        assertEq(IERC20(WETH).allowance(kernel, address(swapHelper)), type(uint256).max);

        // (2) the approval is useless to anybody else: the helper only pulls from msg.sender
        vm.prank(thirdParty);
        vm.expectRevert();
        swapHelper.swapWethToUsdc(0.001 ether, 100);
        assertEq(IERC20(WETH).balanceOf(kernel), 0.01 ether);

        // (3) the swap from the session key pays the kernel, never a third party
        uint256 usdcBefore = IERC20(USDC).balanceOf(kernel);
        uint256 floor = swapHelper.minUsdcOut(0.0005 ether, 200);
        op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), address(swapHelper), abi.encodeCall(BootrSwapHelper.swapWethToUsdc, (0.0005 ether, 200))
        );
        op.signature = _signSession(op);
        assertTrue(_handle(op), "swap executed");
        assertGe(IERC20(USDC).balanceOf(kernel) - usdcBefore, floor);
        assertEq(IERC20(WETH).balanceOf(kernel), 0.0095 ether);

        // (4) the old escape hatches are not allow-listed: WETH.transfer(anyone) and approve(anyone) fail at validation
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), WETH, abi.encodeCall(IERC20.transfer, (thirdParty, 1)));
        op.signature = _signSession(op);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(
            abi.encodeWithSignature(
                "FailedOpWithRevert(uint256,string,bytes)", 0, "AA23 reverted", abi.encodeWithSignature("PolicyFailed(uint256)", 0)
            )
        );
        entryPoint.handleOps(ops, payable(bundler));
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), WETH, abi.encodeCall(IERC20.approve, (thirdParty, 1)));
        op.signature = _signSession(op);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(
            abi.encodeWithSignature(
                "FailedOpWithRevert(uint256,string,bytes)", 0, "AA23 reverted", abi.encodeWithSignature("PolicyFailed(uint256)", 0)
            )
        );
        entryPoint.handleOps(ops, payable(bundler));
        // (5) a slippage above the contract cap is refused at execution (the op mines but the call reverts)
        op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), address(swapHelper), abi.encodeCall(BootrSwapHelper.swapWethToUsdc, (0.001 ether, 1000))
        );
        op.signature = _signSession(op);
        assertFalse(_handle(op), "slippage over MAX_SLIPPAGE_BPS reverts");
        assertEq(IERC20(WETH).balanceOf(kernel), 0.0095 ether);
        // (6) a swap the thin pool cannot fill inside the floor reverts at execution too (funds stay)
        op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), address(swapHelper), abi.encodeCall(BootrSwapHelper.swapWethToUsdc, (0.009 ether, 100))
        );
        op.signature = _signSession(op);
        assertFalse(_handle(op), "pool worse than the oracle floor reverts");
        assertEq(IERC20(WETH).balanceOf(kernel), 0.0095 ether);
    }
}
