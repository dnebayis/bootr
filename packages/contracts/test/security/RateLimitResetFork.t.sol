// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";

struct Op {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IPolicyLike {
    function onInstall(bytes calldata data) external payable;
    function checkUserOpPolicy(bytes32 id, Op calldata userOp) external payable returns (uint256);
}

/// @notice The two ZeroDev rate limit policies on a Base fork, driven the way a Kernel drives them. The one the session
///         keys used first (`0xf63d...`) stops for good after `count` calls, whatever the interval says: $BOOTR's key
///         ran out after 60 userOps. `0x6a06...` opens again every interval. `vm.getBlockTimestamp` because
///         `block.timestamp` is cached across `vm.warp` in this test build.
contract RateLimitResetForkTest is Test {
    address constant PLAIN = 0xf63d4139B25c836334edD76641356c6b74C86873;
    address constant WITH_RESET = 0x6A06358E6b283921DECEAbe7e8A3741d506ccA9B;
    address constant KERNEL = address(0xB007);
    bytes32 constant ID = bytes32(bytes4(0x2b2137d9));
    uint48 constant INTERVAL = 3600;
    uint48 constant COUNT = 60;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
    }

    /// @dev What the EntryPoint would do with the returned validation data at the current time.
    function _usableNow(uint256 vd) internal view returns (bool) {
        if (address(uint160(vd)) != address(0)) return false;
        uint256 validUntil = uint48(vd >> 160);
        uint256 validAfter = uint48(vd >> 208);
        if (validUntil == 0) validUntil = type(uint48).max;
        uint256 nowTs = vm.getBlockTimestamp();
        return nowTs >= validAfter && nowTs <= validUntil;
    }

    /// @dev Calls the policy as the kernel; false when it reverts, fails or the time range excludes now.
    function _use(address policy) internal returns (bool) {
        Op memory op;
        op.sender = KERNEL;
        vm.prank(KERNEL);
        try IPolicyLike(policy).checkUserOpPolicy(ID, op) returns (uint256 vd) {
            return _usableNow(vd);
        } catch {
            return false;
        }
    }

    function _countUntilRefused(address policy, uint256 max) internal returns (uint256 n) {
        while (n < max && _use(policy)) n++;
    }

    function test_plainPolicy_neverOpensAgain() public {
        vm.prank(KERNEL);
        IPolicyLike(PLAIN).onInstall(abi.encodePacked(ID, INTERVAL, COUNT, uint48(0)));
        uint256 first = _countUntilRefused(PLAIN, 200);
        console2.log("plain: calls before refused", first);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        uint256 later = _countUntilRefused(PLAIN, 200);
        console2.log("plain: calls 30 days later", later);
        assertEq(first, COUNT);
        assertEq(later, 0);
    }

    function test_withReset_opensEveryInterval() public {
        vm.prank(KERNEL);
        IPolicyLike(WITH_RESET).onInstall(abi.encodePacked(ID, INTERVAL, COUNT));
        uint256 first = _countUntilRefused(WITH_RESET, 200);
        console2.log("reset: calls in the first hour", first);
        uint256 total = first;
        for (uint256 h = 1; h <= 6; h++) {
            vm.warp(vm.getBlockTimestamp() + INTERVAL + 1);
            uint256 n = _countUntilRefused(WITH_RESET, 200);
            console2.log("reset: hour", h, "calls", n);
            total += n;
            assertEq(n, COUNT, "the limit opens again, for the same count");
        }
        console2.log("reset: total", total);
        assertEq(first, COUNT);
        assertEq(total, COUNT * 7);
    }

    function test_withReset_oneCallEveryThirtyMinutes_keepsWorking() public {
        vm.prank(KERNEL);
        IPolicyLike(WITH_RESET).onInstall(abi.encodePacked(ID, INTERVAL, COUNT));
        for (uint256 i; i < 300; i++) {
            assertTrue(_use(WITH_RESET), "a slow agent must never be refused");
            vm.warp(vm.getBlockTimestamp() + 1800);
        }
    }
}
