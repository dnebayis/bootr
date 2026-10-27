// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Execution, IERC7579Hook, KernelLib} from "../../src/interfaces/IKernel.sol";

/// @dev Mimics the parts of Kernel v3.1 the guardian relies on: the `onlyEntryPointOrSelfOrRoot`
///      modifier (root validator hook preCheck/postCheck around the call), `execute`,
///      `invalidateNonce`, `uninstallValidation`, and the nonce views.
contract MockKernel {
    bytes21 public rootValidator;
    address public hook;
    uint32 public currentNonce = 1;
    uint32 public validNonceFrom;
    bytes21 public lastUninstalled;

    error InvalidCaller();

    constructor(address guardian) {
        rootValidator = KernelLib.validatorId(guardian);
        hook = guardian;
    }

    modifier onlyEntryPointOrSelfOrRoot() {
        if (msg.sender != address(this)) {
            bytes memory ctx = IERC7579Hook(hook).preCheck(msg.sender, msg.value, msg.data);
            _;
            IERC7579Hook(hook).postCheck(ctx);
        } else {
            _;
        }
    }

    function execute(bytes32 mode, bytes calldata data) external payable onlyEntryPointOrSelfOrRoot {
        if (mode == KernelLib.EXEC_MODE_BATCH) {
            Execution[] memory execs = abi.decode(data, (Execution[]));
            for (uint256 i; i < execs.length; ++i) {
                _call(execs[i].target, execs[i].value, execs[i].callData);
            }
        } else {
            address target = address(bytes20(data[0:20]));
            uint256 value = uint256(bytes32(data[20:52]));
            _call(target, value, data[52:]);
        }
    }

    function invalidateNonce(uint32 nonce) external payable onlyEntryPointOrSelfOrRoot {
        validNonceFrom = nonce;
        if (currentNonce < nonce) currentNonce = nonce;
    }

    function uninstallValidation(bytes21 vId, bytes calldata, bytes calldata)
        external
        payable
        onlyEntryPointOrSelfOrRoot
    {
        lastUninstalled = vId;
    }

    /// @dev Simulates the `executeUserOp` path: Kernel calls the execution hook with msg.sender = EntryPoint.
    function simulateUserOp(address entryPoint) external returns (bytes memory) {
        return IERC7579Hook(hook).preCheck(entryPoint, 0, "");
    }

    /// @dev Simulates `_checkEnableSig`: Kernel asks the root validator with sender = itself.
    function simulateEnableCheck(bytes32 digest) external view returns (bytes4) {
        (bool ok, bytes memory ret) = hook.staticcall(
            abi.encodeWithSignature("isValidSignatureWithSender(address,bytes32,bytes)", address(this), digest, "")
        );
        require(ok, "call failed");
        return abi.decode(ret, (bytes4));
    }

    /// @dev Simulates the ERC-1271 path: sender is the external caller.
    function simulateErc1271(address caller, bytes32 digest) external view returns (bytes4) {
        (bool ok, bytes memory ret) = hook.staticcall(
            abi.encodeWithSignature("isValidSignatureWithSender(address,bytes32,bytes)", caller, digest, "")
        );
        require(ok, "call failed");
        return abi.decode(ret, (bytes4));
    }

    function _call(address target, uint256 value, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    receive() external payable {}
}
