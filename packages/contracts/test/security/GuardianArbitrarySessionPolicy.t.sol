// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {IKernel, KernelLib} from "../../src/interfaces/IKernel.sol";
import {SecurityForkBase} from "./SecurityForkBase.sol";

/// @notice Property test for finding BOOTR-02: `AgentGuardian.approveSessionKey` performs NO validation
///         of the policy composition inside `validatorData`. The guardian only fixes the hook, hookData
///         and selectorData and computes the enable digest; it does not require that the session include
///         `BootrCallPolicy` or any spend limit. The platform owner can therefore approve (and then,
///         while the agent is not paused, install and drive) a session whose only policy is a permissive
///         one -- e.g. ZeroDev's SudoPolicy -- which is an unrestricted key over the kernel, available
///         immediately and independent of the 90-day dormancy gate.
///
///         This test asserts only the load-bearing property (the approval of an unrestricted policy set
///         succeeds and the digest is marked approved); it does not install or exercise the session.
contract GuardianArbitrarySessionPolicyTest is SecurityForkBase {
    address constant SUDO_POLICY = 0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7;

    function test_ownerCanApproveUnrestrictedSudoSessionDigest() public {
        (, address kernel) = _launch();

        // validatorData that installs ONLY SudoPolicy + the session signer: no BootrCallPolicy, no cap,
        // no recipient allow-list. The guardian accepts it without inspecting the policies.
        bytes[] memory enableData = new bytes[](2);
        enableData[0] = abi.encodePacked(bytes2(0), SUDO_POLICY); // sudo: passes every call
        enableData[1] = abi.encodePacked(bytes2(0), ECDSA_SIGNER, sessionKey);
        bytes memory validatorData = abi.encode(enableData);

        // only the owner may approve, but the owner may approve ANY policy shape
        vm.prank(thirdParty);
        vm.expectRevert();
        guardian.approveSessionKey(kernel, PID, validatorData);

        (bytes32 digest, uint32 nonce) = guardian.approveSessionKey(kernel, PID, validatorData);
        assertEq(nonce, IKernel(kernel).currentNonce(), "digest bound to the kernel's current nonce");
        assertTrue(guardian.approvedEnableDigests(kernel, digest), "unrestricted-session digest is approved");
        assertEq(
            guardian.enableDigest(kernel, PID, nonce, validatorData), digest, "guardian reproduced the digest with no policy check"
        );
    }
}
