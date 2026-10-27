// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrCallPolicy} from "../../src/BootrCallPolicy.sol";
import {IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";
import {SecurityForkBase} from "./SecurityForkBase.sol";

/// @notice Property test for finding BOOTR-01: the permission *signature* path (ERC-1271) is not gated
///         by BootrCallPolicy, nor by the AgentGuardian hook (pause / activity).
///
///         BootrCallPolicy is installed `NOT_FOR_VALIDATE_SIG`, so `Kernel.isValidSignature` for the
///         session permission never runs it; the guardian is the kernel's root validator+hook, but
///         `Kernel.isValidSignature` for a permission resolves the permission signer directly and never
///         calls the root validator or `preCheck`. Consequence: a signature produced by the session key
///         (as used for x402 / EIP-3009 settlement in `apps/supervisor`) is accepted even while the agent
///         is paused and regardless of the USDC transfer cap / recipient allow-list that the userOp path
///         enforces, and it leaves `lastActivity` untouched.
///
///         Production additionally installs ZeroDev's SignatureCallerPolicy (caller must be USDC) and
///         TimestampPolicy (validity window); those narrow the exposure to "USDC EIP-3009 settlement
///         inside the validity window" but do NOT restore the BootrCallPolicy cap/recipient or the
///         guardian pause/activity. This harness omits them to isolate the contract-level property.
contract SessionKeySignaturePathTest is SecurityForkBase {
    bytes4 constant ERC1271_MAGIC = 0x1626ba7e;

    function test_userOpPathEnforcesCapAndRecipient() public {
        (, address kernel) = _launch();
        _installSession(kernel, _productionRules(kernel));

        // over the cap -> rejected by BootrCallPolicy (policy index 0)
        PackedUserOperation memory op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (payTo, USDC_CAP + 1))
        );
        op.signature = _signSession(op);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(
            abi.encodeWithSignature(
                "FailedOpWithRevert(uint256,string,bytes)",
                0,
                "AA23 reverted",
                abi.encodeWithSignature("PolicyFailed(uint256)", 0)
            )
        );
        entryPoint.handleOps(ops, payable(bundler));

        // wrong recipient -> also rejected
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (thirdParty, 1)));
        op.signature = _signSession(op);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(
            abi.encodeWithSignature(
                "FailedOpWithRevert(uint256,string,bytes)",
                0,
                "AA23 reverted",
                abi.encodeWithSignature("PolicyFailed(uint256)", 0)
            )
        );
        entryPoint.handleOps(ops, payable(bundler));
    }

    function test_signaturePathUngatedByPolicyAndPauseAndActivity() public {
        (, address kernel) = _launch();
        _installSession(kernel, _productionRules(kernel));
        uint64 activityAfterInstall = guardian.agentInfo(kernel).lastActivity;

        // the creator pauses: the userOp (execution) path is now blocked by the guardian hook
        vm.prank(creator);
        guardian.pauseAgent(kernel);
        assertTrue(guardian.agentInfo(kernel).paused);

        // an arbitrary digest (e.g. the hash of an EIP-3009 authorization) signed by the session key is
        // still accepted by the kernel -- the signature path never consults BootrCallPolicy or the guardian.
        bytes32 arbitraryDigest = keccak256("any x402 / EIP-3009 authorization the session key signs");
        bytes memory sig = _erc1271Signature(kernel, arbitraryDigest);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        assertEq(
            IKernel(kernel).isValidSignature(arbitraryDigest, sig),
            ERC1271_MAGIC,
            "kernel accepts session-key signature while paused"
        );

        // the signature validation stamped no activity: it is invisible to the dormancy clock
        assertEq(guardian.agentInfo(kernel).lastActivity, activityAfterInstall, "no Activity stamp on the signature path");

        // and a digest NOT signed by the session key is rejected (sanity: the signer still matters)
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, _wrappedHash(kernel, arbitraryDigest));
        bytes memory badSig = abi.encodePacked(bytes1(0x02), PID, bytes1(0xff), r, s, v);
        assertEq(IKernel(kernel).isValidSignature(arbitraryDigest, badSig), bytes4(0xffffffff), "non-session signer rejected");
    }
}
