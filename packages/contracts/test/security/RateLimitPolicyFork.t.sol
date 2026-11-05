// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

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

/// @notice ZeroDev's plain RateLimitPolicy on a Base fork, driven the way a Kernel drives it. Its `count` is a total over
///         the key's life whatever the `interval` says, which stopped $BOOTR's key after 60 userOps. The session keys use
///         a high count (`SESSION_USEROP_LIMIT`). The policy with reset (`0x6a06...`) works here but reads TIMESTAMP in
///         validation, and the bundler refused it on mainnet on 2026-11-05 ("account uses banned opcode: TIMESTAMP").
contract RateLimitPolicyForkTest is Test {
    address constant PLAIN = 0xf63d4139B25c836334edD76641356c6b74C86873;
    address constant KERNEL = address(0xB007);
    bytes32 constant ID = bytes32(bytes4(0x2b2137d9));
    uint48 constant INTERVAL = 3600;
    uint48 constant USEROP_LIMIT = 100_000;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
    }

    /// @dev Calls the policy as the kernel; false when it reverts, fails or the time range the EntryPoint would check excludes now.
    function _use() internal returns (bool) {
        Op memory op;
        op.sender = KERNEL;
        vm.prank(KERNEL);
        try IPolicyLike(PLAIN).checkUserOpPolicy(ID, op) returns (uint256 vd) {
            if (address(uint160(vd)) != address(0)) return false;
            uint256 validUntil = uint48(vd >> 160);
            uint256 validAfter = uint48(vd >> 208);
            if (validUntil == 0) validUntil = type(uint48).max;
            uint256 nowTs = vm.getBlockTimestamp();
            return nowTs >= validAfter && nowTs <= validUntil;
        } catch {
            return false;
        }
    }

    function _install(uint48 count) internal {
        vm.prank(KERNEL);
        IPolicyLike(PLAIN).onInstall(abi.encodePacked(ID, INTERVAL, count, uint48(0)));
    }

    function test_countIsALifetimeTotal() public {
        _install(60);
        for (uint256 i; i < 60; i++) assertTrue(_use());
        assertFalse(_use(), "the 61st is refused");
        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertFalse(_use(), "and it never opens again");
    }

    function test_highLimitKeepsWorking() public {
        _install(USEROP_LIMIT);
        for (uint256 i; i < 500; i++) assertTrue(_use());
        // Each use moves validAfter an hour forward from 0; the whole allowance stays in the past.
        assertLt(uint256(USEROP_LIMIT) * INTERVAL, vm.getBlockTimestamp());
    }
}
