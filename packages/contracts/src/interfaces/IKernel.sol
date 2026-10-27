// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev ERC-4337 v0.7 packed user operation.
struct PackedUserOperation {
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

/// @dev ERC-7579 execution tuple (Kernel `Execution`).
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

interface IEntryPoint {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256 nonce);
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
}

interface IERC7579Module {
    function onInstall(bytes calldata data) external payable;
    function onUninstall(bytes calldata data) external payable;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
    function isInitialized(address smartAccount) external view returns (bool);
}

interface IERC7579Validator is IERC7579Module {
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external payable returns (uint256);
    function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata data)
        external
        view
        returns (bytes4);
}

interface IERC7579Hook is IERC7579Module {
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        payable
        returns (bytes memory hookData);
    function postCheck(bytes calldata hookData) external payable;
}

/// @dev Minimal ZeroDev Kernel v3.1 surface used by Bootr. `ValidationId` is `bytes21`
/// (1 byte type + 20 bytes: 0x01 = validator address, 0x02 = permission id + zero padding).
interface IKernel {
    struct ValidationConfig {
        uint32 nonce;
        address hook;
    }

    function initialize(
        bytes21 rootValidator,
        address hook,
        bytes calldata validatorData,
        bytes calldata hookData,
        bytes[] calldata initConfig
    ) external;

    function execute(bytes32 execMode, bytes calldata executionCalldata) external payable;
    function executeUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external payable;
    function installValidations(
        bytes21[] calldata vIds,
        ValidationConfig[] memory configs,
        bytes[] calldata validationData,
        bytes[] calldata hookData
    ) external payable;
    function uninstallValidation(bytes21 vId, bytes calldata deinitData, bytes calldata hookDeinitData) external payable;
    function invalidateNonce(uint32 nonce) external payable;
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);

    function rootValidator() external view returns (bytes21);
    function currentNonce() external view returns (uint32);
    function validNonceFrom() external view returns (uint32);
    function validationConfig(bytes21 vId) external view returns (ValidationConfig memory);
    function isAllowedSelector(bytes21 vId, bytes4 selector) external view returns (bool);
    function entrypoint() external view returns (address);
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
}

interface IKernelFactory {
    function createAccount(bytes calldata data, bytes32 salt) external payable returns (address);
    function getAddress(bytes calldata data, bytes32 salt) external view returns (address);
    function implementation() external view returns (address);
}

library KernelLib {
    /// @dev ExecMode: callType (1 byte) | execType (1) | unused (4) | modeSelector (4) | payload (22).
    bytes32 internal constant EXEC_MODE_SINGLE = bytes32(0);
    bytes32 internal constant EXEC_MODE_BATCH = bytes32(uint256(0x01) << 248);

    bytes1 internal constant VALIDATION_TYPE_VALIDATOR = 0x01;
    bytes1 internal constant VALIDATION_TYPE_PERMISSION = 0x02;

    uint256 internal constant MODULE_TYPE_VALIDATOR = 1;
    uint256 internal constant MODULE_TYPE_HOOK = 4;

    function validatorId(address validator) internal pure returns (bytes21) {
        return bytes21(abi.encodePacked(VALIDATION_TYPE_VALIDATOR, validator));
    }

    function permissionId(bytes4 pId) internal pure returns (bytes21) {
        return bytes21(abi.encodePacked(VALIDATION_TYPE_PERMISSION, pId, bytes16(0)));
    }

    function encodeSingle(address target, uint256 value, bytes memory callData) internal pure returns (bytes memory) {
        return abi.encodePacked(target, value, callData);
    }

    function encodeBatch(Execution[] memory executions) internal pure returns (bytes memory) {
        return abi.encode(executions);
    }
}
