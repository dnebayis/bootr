// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";
import {SecurityForkBase} from "./SecurityForkBase.sol";

/// @notice Base Sepolia fork tests for the C-01 / BOOTR-01 fix (the session permission has NO ERC-1271 path:
///         signer flagged SKIP_SIGNATURE) and for the revocation questions of H-01 / BOOTR-07, against the live
///         Kernel v3.1 implementation (0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D).
contract RevocationForkTest is SecurityForkBase {
    bytes4 constant INVALID_VALIDATOR = bytes4(keccak256("InvalidValidator()"));

    // ------------------------------------------------------------------
    // Kernel limitations that shaped the design
    // ------------------------------------------------------------------

    /// @dev Why a content policy on the signature path is impossible on this Kernel: `_checkSignaturePolicy`
    ///      re-reads the ORIGINAL signature slice after `_checkPermissionPolicy` (the inner `sig = sig[9+len:]`
    ///      never propagates), so any policy-signature slot makes `isValidSignature` revert `SignerPrefixNotPresent`.
    function test_kernelRejectsAnyPolicySlotOnSignaturePath() public {
        (, address kernel) = _launch();
        _installSession(kernel, _legacyPermissionData(kernel));
        bytes32 digest = _usdcTransferDigest(kernel, payTo, 1e6, 0, vm.getBlockTimestamp() + 600, keccak256("n"));
        // without a slot the legacy permission accepts anything (the original finding)
        assertEq(IKernel(kernel).isValidSignature(digest, _erc1271Signature(kernel, digest)), ERC1271_MAGIC);
        // with a slot addressed to policy 0 (BootrCallPolicy, which would accept it) the Kernel itself reverts
        bytes memory sig = _erc1271SignatureWithPolicySlot(kernel, digest, 0, abi.encode(uint256(1e6)));
        vm.expectRevert(SIGNER_PREFIX_NOT_PRESENT);
        IKernel(kernel).isValidSignature(digest, sig);
        // even an empty slot
        sig = _erc1271SignatureWithPolicySlot(kernel, digest, 0, "");
        vm.expectRevert(SIGNER_PREFIX_NOT_PRESENT);
        IKernel(kernel).isValidSignature(digest, sig);
    }

    /// @dev The fix: the signer entry's flags become `permissionFlag`; SKIP_SIGNATURE closes the ERC-1271 path for
    ///      the whole permission before any policy or signer runs, while the userOp path is untouched.
    function test_productionLayoutHasNoSignaturePath() public {
        (, address kernel) = _launch();
        _installSession(kernel, _productionPermissionData(kernel));
        bytes32 digest = _usdcTransferDigest(kernel, payTo, 1e6, 0, vm.getBlockTimestamp() + 600, keccak256("n"));
        vm.expectRevert(PERMISSION_NOT_ALLOWED_FOR_SIGNATURE);
        IKernel(kernel).isValidSignature(digest, _erc1271Signature(kernel, digest));
        vm.expectRevert(PERMISSION_NOT_ALLOWED_FOR_SIGNATURE);
        IKernel(kernel).isValidSignature(keccak256("anything"), _erc1271Signature(kernel, keccak256("anything")));
        vm.expectRevert(PERMISSION_NOT_ALLOWED_FOR_SIGNATURE);
        IKernel(kernel).isValidSignature(digest, _erc1271SignatureWithPolicySlot(kernel, digest, 0, abi.encode(uint256(1))));
        // the creator pausing or not makes no difference: the path is closed at the permission level
        vm.prank(creator);
        guardian.pauseAgent(kernel);
        vm.expectRevert(PERMISSION_NOT_ALLOWED_FOR_SIGNATURE);
        IKernel(kernel).isValidSignature(digest, _erc1271Signature(kernel, digest));
        vm.prank(creator);
        guardian.unpauseAgent(kernel);

        // the userOp path works as before: a funding transfer to the spender inside the window
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (spender, 1e6)));
        op.signature = _signSessionAt(op, vm.getBlockTimestamp());
        assertTrue(_handle(op), "userOp path unaffected");
        assertEq(IERC20(USDC).balanceOf(spender), 1e6);
    }

    // ------------------------------------------------------------------
    // H-01 / BOOTR-07: revocation semantics on the live Kernel
    // ------------------------------------------------------------------

    /// @dev Open question 1 of the review, answered: Kernel.isValidSignature ignores `validNonceFrom`, so on the
    ///      legacy layout `revokeAllSessionKeys` leaves the ERC-1271 path alive. Only `revokeSessionKey` (uninstall)
    ///      closes it there. The production layout has no such path, so the nonce bump is complete.
    function test_legacyLayout_nonceBumpDoesNotKillSignaturePath() public {
        (, address kernel) = _launch();
        _installSession(kernel, _legacyPermissionData(kernel));
        bytes32 digest = keccak256("anything");
        bytes memory sig = _erc1271Signature(kernel, digest);
        assertEq(IKernel(kernel).isValidSignature(digest, sig), ERC1271_MAGIC);

        guardian.revokeAllSessionKeys(kernel);
        assertEq(IKernel(kernel).validNonceFrom(), 2);
        assertEq(IKernel(kernel).isValidSignature(digest, sig), ERC1271_MAGIC, "GAP: nonce bump ignored by isValidSignature");

        // uninstall is what kills it: validationConfig.hook == 0 -> InvalidValidator
        bytes[] memory disable = new bytes[](2);
        guardian.revokeSessionKey(kernel, PID, abi.encode(disable));
        vm.expectRevert(INVALID_VALIDATOR);
        IKernel(kernel).isValidSignature(digest, sig);
    }

    function test_productionLayout_nonceBumpKillsUserOpPath() public {
        (, address kernel) = _launch();
        _installSession(kernel, _productionPermissionData(kernel));
        guardian.revokeAllSessionKeys(kernel);
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (spender, 1)));
        op.signature = _signSessionAt(op, vm.getBlockTimestamp());
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(bundler));
        assertEq(IERC20(USDC).balanceOf(kernel), FUEL);
        // and there never was a signature path to worry about
        vm.expectRevert(PERMISSION_NOT_ALLOWED_FOR_SIGNATURE);
        IKernel(kernel).isValidSignature(keccak256("x"), _erc1271Signature(kernel, keccak256("x")));
    }

    function test_batchRevokeAcrossKernels() public {
        (, address kernel) = _launch();
        _installSession(kernel, _productionPermissionData(kernel));
        address[] memory kernels = new address[](1);
        kernels[0] = kernel;
        uint32[] memory nonces = guardian.revokeAllSessionKeysBatch(kernels);
        assertEq(nonces[0], 2);
        assertEq(IKernel(kernel).validNonceFrom(), 2);
    }

    /// @dev Open question 2, answered: an uninstalled permission cannot be re-enabled with the old digest. The
    ///      guardian withdraws the approval on uninstall (EnableNotApproved), and even a fresh identical approval
    ///      is rejected by the Kernel (`_installValidation` -> InvalidNonce for a re-used ValidationId).
    function test_uninstalledPermissionCannotBeReEnabled() public {
        (, address kernel) = _launch();
        bytes memory validatorData = _productionPermissionData(kernel);
        bytes32 digest = _installSession(kernel, validatorData);
        assertTrue(guardian.approvedEnableDigests(kernel, digest));
        bytes21 vId = KernelLib.permissionId(PID);
        assertEq(guardian.approvedDigestOf(kernel, vId), digest);

        guardian.revokeSessionKey(kernel, PID, _productionDeinitData());
        assertEq(IKernel(kernel).validationConfig(vId).hook, address(0));
        assertFalse(callPolicy.installed(bytes32(PID), kernel), "rules deleted by the Kernel");
        assertFalse(guardian.approvedEnableDigests(kernel, digest), "approval withdrawn on uninstall");

        // the same enable op again: guardian rejects (no approval) -> AA23
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x01), USDC, abi.encodeCall(IERC20.transfer, (spender, 0)));
        bytes memory userOpSig = _signSession(op);
        op.signature = abi.encodePacked(
            address(guardian),
            abi.encode(validatorData, hex"00", abi.encodePacked(IKernel.execute.selector), bytes(""), userOpSig)
        );
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(
            abi.encodeWithSignature(
                "FailedOpWithRevert(uint256,string,bytes)", 0, "AA23 reverted", abi.encodeWithSignature("EnableNotApproved()")
            )
        );
        entryPoint.handleOps(ops, payable(bundler));

        // even if the admin re-approved the identical digest, Kernel refuses to re-use the ValidationId
        (bytes32 again,) = guardian.approveSessionKey(kernel, PID, validatorData);
        assertEq(again, digest, "same nonce, same data: same digest");
        vm.prank(bundler);
        vm.expectRevert(
            abi.encodeWithSignature(
                "FailedOpWithRevert(uint256,string,bytes)", 0, "AA23 reverted", abi.encodeWithSignature("InvalidNonce()")
            )
        );
        entryPoint.handleOps(ops, payable(bundler));
        assertEq(IKernel(kernel).validationConfig(vId).hook, address(0), "still uninstalled");
    }

    /// @dev After a panic revoke the fleet must be re-onboardable: a new permission id enables at the new nonce.
    function test_newPermissionInstallsAfterPanicRevoke() public {
        (, address kernel) = _launch();
        _installSession(kernel, _productionPermissionData(kernel));
        guardian.revokeAllSessionKeys(kernel);
        bytes4 pid2 = bytes4(keccak256("bootr.session.v2"));
        bytes21 vId2 = KernelLib.permissionId(pid2);
        bytes memory validatorData = _productionPermissionData(kernel);
        (bytes32 digest, uint32 nonce) = guardian.approveSessionKey(kernel, pid2, validatorData);
        assertEq(nonce, 2);
        uint192 key = (uint192(0x01) << 184) | (uint192(0x02) << 176)
            | (uint192(uint160(bytes20(abi.encodePacked(pid2, bytes16(0))))) << 16);
        PackedUserOperation memory op =
            _userOp(kernel, entryPoint.getNonce(kernel, key), USDC, abi.encodeCall(IERC20.transfer, (spender, 0)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, entryPoint.getUserOpHash(op));
        op.signature = abi.encodePacked(
            address(guardian),
            abi.encode(
                validatorData,
                hex"00",
                abi.encodePacked(IKernel.execute.selector),
                bytes(""),
                abi.encodePacked(bytes1(0xff), r, s, v)
            )
        );
        assertTrue(_handle(op), "re-onboarded after panic revoke");
        assertEq(IKernel(kernel).validationConfig(vId2).hook, address(guardian));
        assertEq(IKernel(kernel).validationConfig(vId2).nonce, 2);
        assertTrue(guardian.approvedEnableDigests(kernel, digest));
    }
}
