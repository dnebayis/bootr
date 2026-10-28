// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Execution, IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";
import {SecurityForkBase} from "./SecurityForkBase.sol";

/// @notice Base Sepolia fork tests for BootrCallPolicy's `SUM_PER_WINDOW` cap through the live EntryPoint:
///         the spender funding rule `USDC.transfer(spender, <= 50 USDC per day)` with the time slot.
contract WindowedCapForkTest is SecurityForkBase {
    function _fund(address kernel, uint256 amount, uint256 claimedNow) internal returns (PackedUserOperation memory op) {
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (spender, amount)));
        op.signature = _signSessionAt(op, claimedNow);
    }

    /// @dev Sends `op` expecting `handleOps` to revert with `data`. The op must be built BEFORE this call: building
    ///      it reads `EntryPoint.getNonce`, which would otherwise consume the armed `expectRevert`.
    function _sendExpectingRevert(PackedUserOperation memory op, bytes memory data) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(data);
        entryPoint.handleOps(ops, payable(bundler));
    }

    function _sendExpectingAA22(PackedUserOperation memory op) internal {
        _sendExpectingRevert(op, abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA22 expired or not due"));
    }

    function _sendExpectingPolicyFailed(PackedUserOperation memory op) internal {
        _sendExpectingRevert(
            op,
            abi.encodeWithSignature(
                "FailedOpWithRevert(uint256,string,bytes)", 0, "AA23 reverted", abi.encodeWithSignature("PolicyFailed(uint256)", 0)
            )
        );
    }

    function test_capIsCumulativePerWindowAndRollsWithTime() public {
        (, address kernel) = _launch();
        deal(USDC, kernel, 1_000e6); // the test spends more than the 100 USDC launch fuel
        uint256 t0 = vm.getBlockTimestamp();
        _installSession(kernel, _productionPermissionData(kernel));
        (uint48 windowEnd, uint128 spent, uint32 window, uint256 cap) = callPolicy.windowOf(bytes32(PID), kernel, 3, 1);
        assertEq(window, FUND_WINDOW);
        assertEq(cap, USDC_CAP);
        assertEq(windowEnd, t0 + FUND_WINDOW);
        assertEq(spent, 0, "the enable no-op spent nothing");

        // 30 + 20 = cap inside the first window
        assertTrue(_handle(_fund(kernel, 30e6, t0 + 1 hours)));
        vm.warp(t0 + 2 hours);
        assertTrue(_handle(_fund(kernel, 20e6, t0 + 2 hours)));
        (, spent,,) = callPolicy.windowOf(bytes32(PID), kernel, 3, 1);
        assertEq(spent, 50e6);
        assertEq(IERC20(USDC).balanceOf(spender), 50e6);
        // one more micro-USDC is over budget for this window
        _sendExpectingPolicyFailed(_fund(kernel, 1, t0 + 2 hours));
        // a batch that sums over the cap fails as a whole (M-02), zero-amount ops are free
        assertTrue(_handle(_fund(kernel, 0, t0 + 2 hours)));

        // next day: the window rolls and the budget is back
        vm.warp(t0 + FUND_WINDOW + 10);
        assertTrue(_handle(_fund(kernel, 25e6, t0 + FUND_WINDOW + 10)));
        (windowEnd, spent,,) = callPolicy.windowOf(bytes32(PID), kernel, 3, 1);
        assertEq(windowEnd, t0 + 2 * FUND_WINDOW);
        assertEq(spent, 25e6);
        // ...after a long idle period the grid catches up to the window containing `now`, no catch-up burst
        vm.warp(t0 + 10 * FUND_WINDOW + 5);
        assertTrue(_handle(_fund(kernel, 50e6, t0 + 10 * FUND_WINDOW + 5)));
        (windowEnd, spent,,) = callPolicy.windowOf(bytes32(PID), kernel, 3, 1);
        assertEq(windowEnd, t0 + 11 * FUND_WINDOW);
        assertEq(spent, 50e6);
        _sendExpectingPolicyFailed(_fund(kernel, 1, t0 + 10 * FUND_WINDOW + 5));
        assertEq(IERC20(USDC).balanceOf(spender), 125e6);
    }

    function test_lyingAboutTimeDoesNotHelp() public {
        (, address kernel) = _launch();
        uint256 t0 = vm.getBlockTimestamp();
        _installSession(kernel, _productionPermissionData(kernel));
        assertTrue(_handle(_fund(kernel, 10e6, t0)));
        // claim the future to open a fresh window: the policy passes but validAfter is in the future -> AA22, and
        // the failed validation rolls the window state back
        _sendExpectingAA22(_fund(kernel, 50e6, t0 + FUND_WINDOW + 1));
        (uint48 windowEnd, uint128 spent,,) = callPolicy.windowOf(bytes32(PID), kernel, 3, 1);
        assertEq(windowEnd, t0 + FUND_WINDOW);
        assertEq(spent, 10e6);
        // after the window lapsed, claiming the past (or nothing) keeps the stale window: validUntil passed -> AA22
        vm.warp(t0 + FUND_WINDOW + 1);
        _sendExpectingAA22(_fund(kernel, 1e6, t0));
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (spender, 1e6)));
        op.signature = _signSession(op); // no time slot
        _sendExpectingAA22(op);
        (windowEnd, spent,,) = callPolicy.windowOf(bytes32(PID), kernel, 3, 1);
        assertEq(spent, 10e6, "rejected ops never account");
        // the honest claim works and resets the budget
        assertTrue(_handle(_fund(kernel, 1e6, t0 + FUND_WINDOW + 1)));
        (windowEnd, spent,,) = callPolicy.windowOf(bytes32(PID), kernel, 3, 1);
        assertEq(windowEnd, t0 + 2 * FUND_WINDOW);
        assertEq(spent, 1e6);
        assertEq(IERC20(USDC).balanceOf(spender), 11e6);
        // ops that do not spend carry no time bound at all: a claim with a stale claimed time validates fine
        vm.warp(t0 + 3 * FUND_WINDOW);
        PackedUserOperation memory claim = _userOp(
            kernel,
            _permissionNonce(kernel, 0x00),
            RWAGMI_LOCKER,
            abi.encodeWithSignature("settleAndClaim(bytes32[],address,address)", new bytes32[](0), WETH, kernel)
        );
        claim.signature = _signSessionAt(claim, t0);
        _handle(claim); // validation passes (nothing to claim: the locker pays 0)
    }

    function test_otherRecipientsAndBatchesOverCapFail() public {
        (, address kernel) = _launch();
        uint256 t0 = vm.getBlockTimestamp();
        _installSession(kernel, _productionPermissionData(kernel));
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (payTo, 1)));
        op.signature = _signSessionAt(op, t0);
        _sendExpectingPolicyFailed(op);
        Execution[] memory execs = new Execution[](2);
        execs[0] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (spender, 30e6)));
        execs[1] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (spender, 21e6)));
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), address(0), "");
        op.callData = abi.encodePacked(
            IKernel.executeUserOp.selector, abi.encodeCall(IKernel.execute, (KernelLib.EXEC_MODE_BATCH, KernelLib.encodeBatch(execs)))
        );
        op.signature = _signSessionAt(op, t0);
        _sendExpectingPolicyFailed(op);
        execs[1] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (spender, 20e6)));
        op.callData = abi.encodePacked(
            IKernel.executeUserOp.selector, abi.encodeCall(IKernel.execute, (KernelLib.EXEC_MODE_BATCH, KernelLib.encodeBatch(execs)))
        );
        op.signature = _signSessionAt(op, t0);
        assertTrue(_handle(op));
        assertEq(IERC20(USDC).balanceOf(spender), 50e6);
    }
}
