// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    Execution,
    IERC7579Hook,
    IERC7579Validator,
    IKernel,
    KernelLib,
    PackedUserOperation
} from "./interfaces/IKernel.sol";

/// @title AgentGuardian
/// @notice ERC-7579 root validator + hook installed on every Bootr agent Kernel (ZeroDev Kernel v3.1).
///
/// How root authority works (Kernel v3.1, `Kernel.sol` lines 79-94, modifier `onlyEntryPointOrSelfOrRoot`):
/// when a caller that is neither the EntryPoint nor the kernel itself invokes `execute`,
/// `installValidations`, `uninstallValidation`, `invalidateNonce`, `installModule`,
/// `uninstallModule`, `changeRootValidator` or `upgradeTo`, the kernel loads its root validator and,
/// if that validator `isModuleType(4)` (hook), calls `preCheck(msg.sender, msg.value, msg.data)` on
/// it and continues only if that call does not revert. `preCheck` is therefore the access control
/// for the direct ("root") path. This contract allows that path only while it is itself performing
/// a root call on that kernel (`_rootCallKernel == kernel && sender == address(this)`).
///
/// The userOp path through root (`validateUserOp`) and ERC-1271 through root are always rejected,
/// with ONE deliberate exception needed by Kernel v3.1: installing a *permission-type* session key
/// that can actually send userOps requires Kernel's "enable mode" (`ValidationManager.sol` lines
/// 346-366), because `installValidations` never sets `allowedSelectors` (only enable mode and
/// `installModule` for validator-type modules do, see `Kernel.sol` lines 251-262 and 369-372).
/// Enable mode asks the root validator `isValidSignatureWithSender(kernel, enableDigest, sig)`.
/// The platform admin therefore pre-approves the exact enable digest on-chain with
/// `approveSessionKey`; this contract computes the digest itself and forces hook = this contract,
/// hookData = 0x00 and selectorData = `execute.selector`, so every session-key userOp is routed
/// through `executeUserOp` -> `preCheck` and refreshes `lastActivity`.
contract AgentGuardian is Ownable2Step, ReentrancyGuard, IERC7579Validator, IERC7579Hook {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct AgentInfo {
        address token;
        address creator;
        uint64 lastActivity;
        uint32 dormancyPeriod;
        bool paused;
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint256 private constant SIG_VALIDATION_FAILED = 1;
    bytes4 private constant ERC1271_MAGICVALUE = 0x1626ba7e;
    bytes4 private constant ERC1271_INVALID = 0xffffffff;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev keccak256("Enable(bytes21 validationId,uint32 nonce,address hook,bytes validatorData,bytes hookData,bytes selectorData)")
    bytes32 private constant ENABLE_TYPE_HASH = 0xb17ab1224aca0d4255ef8161acaf2ac121b8faa32a4b2258c912cc5f8308c505;
    /// @dev keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    bytes32 private constant DOMAIN_TYPEHASH = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f;
    bytes32 private constant KERNEL_NAME_HASH = keccak256("Kernel");
    bytes32 private constant KERNEL_VERSION_HASH = keccak256("0.3.1");

    /// @dev Hook install data forwarded by Kernel: 1 flag byte (0x00 = do not re-run onInstall).
    bytes public constant SESSION_HOOK_DATA = hex"00";
    /// @dev Selector the session key is allowed to call (wrapped in executeUserOp by the SDK).
    bytes public constant SESSION_SELECTOR_DATA = abi.encodePacked(IKernel.execute.selector);

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    IERC20 public immutable usdc;
    IERC20 public immutable weth;
    /// @dev ERC-4337 EntryPoint v0.7: the only caller allowed on the session (executeUserOp) path.
    address public immutable entryPoint;

    address public launcher;
    address public platformTreasury;

    mapping(address kernel => AgentInfo) private _agents;
    mapping(address kernel => bool) private _installed;
    /// @notice Enable-mode digests approved by the platform admin, per kernel.
    mapping(address kernel => mapping(bytes32 digest => bool)) public approvedEnableDigests;

    address private _rootCallKernel;

    // ------------------------------------------------------------------
    // Events / errors
    // ------------------------------------------------------------------

    event LauncherUpdated(address indexed launcher);
    event PlatformTreasuryUpdated(address indexed treasury);
    event AgentRegistered(
        address indexed kernel, address indexed token, address indexed creator, uint32 dormancyPeriod
    );
    event AgentPaused(address indexed kernel, bool paused);
    event Activity(address indexed kernel, uint64 timestamp);
    event SessionKeyApproved(
        address indexed kernel, bytes21 indexed validationId, uint32 nonce, bytes32 digest, bytes validatorData
    );
    event SessionKeyApprovalRevoked(address indexed kernel, bytes32 digest);
    event SessionKeyUninstalled(address indexed kernel, bytes21 indexed validationId);
    event SessionNonceInvalidated(address indexed kernel, uint32 nonce);
    event DormantClaimed(
        address indexed kernel, uint256 usdcAmount, uint256 wethAmount, uint256 ethAmount, uint256 tokenBurned
    );
    event GuardianInstalled(address indexed kernel);

    error NotLauncher();
    error NotCreator();
    error NotRegistered();
    error AlreadyRegistered();
    error ZeroAddress();
    error InvalidDormancyPeriod();
    error NotRootCall();
    error AgentIsPaused();
    error NotDormant(uint256 dormantAt);
    error TreasuryNotSet();
    error GuardianNotRootValidator();
    error CannotUninstall();
    error RootCallFailed(bytes reason);
    error UnauthorizedCaller(address sender);

    // ------------------------------------------------------------------
    // Constructor / admin
    // ------------------------------------------------------------------

    constructor(address owner_, address entryPoint_, address usdc_, address weth_) Ownable(owner_) {
        if (entryPoint_ == address(0) || usdc_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        entryPoint = entryPoint_;
        usdc = IERC20(usdc_);
        weth = IERC20(weth_);
    }

    function setLauncher(address launcher_) external onlyOwner {
        if (launcher_ == address(0)) revert ZeroAddress();
        launcher = launcher_;
        emit LauncherUpdated(launcher_);
    }

    function setPlatformTreasury(address treasury) external onlyOwner {
        if (treasury == address(0)) revert ZeroAddress();
        platformTreasury = treasury;
        emit PlatformTreasuryUpdated(treasury);
    }

    // ------------------------------------------------------------------
    // Registration (launcher only)
    // ------------------------------------------------------------------

    function registerAgent(address kernel, address token, address creator, uint32 dormancyPeriod) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (kernel == address(0) || token == address(0) || creator == address(0)) revert ZeroAddress();
        if (dormancyPeriod == 0) revert InvalidDormancyPeriod();
        if (_agents[kernel].token != address(0)) revert AlreadyRegistered();
        if (IKernel(kernel).rootValidator() != KernelLib.validatorId(address(this))) revert GuardianNotRootValidator();

        _agents[kernel] = AgentInfo({
            token: token,
            creator: creator,
            lastActivity: uint64(block.timestamp),
            dormancyPeriod: dormancyPeriod,
            paused: false
        });
        emit AgentRegistered(kernel, token, creator, dormancyPeriod);
    }

    // ------------------------------------------------------------------
    // Session keys (owner only)
    // ------------------------------------------------------------------

    /// @notice Approve the enable-mode digest for installing permission `permissionId` on `kernel`.
    /// @param validatorData `abi.encode(bytes[] permissionEnableData)` as built by the ZeroDev SDK:
    ///        each entry is `bytes2 flags ++ address policy ++ bytes policyInitData`, the last entry
    ///        being the signer. The supervisor then submits the enable userOp (see README/report).
    function approveSessionKey(address kernel, bytes4 permissionId, bytes calldata validatorData)
        external
        onlyOwner
        returns (bytes32 digest, uint32 nonce)
    {
        AgentInfo storage a = _agents[kernel];
        if (a.token == address(0)) revert NotRegistered();
        if (a.paused) revert AgentIsPaused();
        nonce = IKernel(kernel).currentNonce();
        bytes21 vId = KernelLib.permissionId(permissionId);
        digest = _enableDigest(kernel, vId, nonce, validatorData);
        approvedEnableDigests[kernel][digest] = true;
        emit SessionKeyApproved(kernel, vId, nonce, digest, validatorData);
    }

    function revokeSessionKeyApproval(address kernel, bytes32 digest) external onlyOwner {
        approvedEnableDigests[kernel][digest] = false;
        emit SessionKeyApprovalRevoked(kernel, digest);
    }

    /// @notice Uninstall a permission-type session key via root. `deinitData` is
    ///         `abi.encode(bytes[] permissionDisableData)` with `policies.length + 1` entries.
    function revokeSessionKey(address kernel, bytes4 permissionId, bytes calldata deinitData) external onlyOwner {
        if (_agents[kernel].token == address(0)) revert NotRegistered();
        bytes21 vId = KernelLib.permissionId(permissionId);
        _rootCall(kernel, abi.encodeCall(IKernel.uninstallValidation, (vId, deinitData, SESSION_HOOK_DATA)));
        emit SessionKeyUninstalled(kernel, vId);
    }

    /// @notice Revoke every non-root validation installed so far by bumping the kernel's valid nonce.
    ///         Root validation is unaffected (Kernel.sol line 240 skips the check for VALIDATION_TYPE_ROOT).
    function revokeAllSessionKeys(address kernel) external onlyOwner returns (uint32 nonce) {
        if (_agents[kernel].token == address(0)) revert NotRegistered();
        nonce = IKernel(kernel).currentNonce() + 1;
        _rootCall(kernel, abi.encodeCall(IKernel.invalidateNonce, (nonce)));
        emit SessionNonceInvalidated(kernel, nonce);
    }

    // ------------------------------------------------------------------
    // Dormancy sweep (owner only)
    // ------------------------------------------------------------------

    function claimDormant(address kernel)
        external
        onlyOwner
        nonReentrant
        returns (uint256 usdcAmount, uint256 wethAmount, uint256 ethAmount, uint256 tokenBurned)
    {
        AgentInfo storage a = _agents[kernel];
        if (a.token == address(0)) revert NotRegistered();
        address treasury = platformTreasury;
        if (treasury == address(0)) revert TreasuryNotSet();
        uint256 dormantAfter = uint256(a.lastActivity) + a.dormancyPeriod;
        if (block.timestamp < dormantAfter) revert NotDormant(dormantAfter);

        usdcAmount = usdc.balanceOf(kernel);
        wethAmount = weth.balanceOf(kernel);
        ethAmount = kernel.balance;
        tokenBurned = IERC20(a.token).balanceOf(kernel);

        Execution[] memory execs = new Execution[](4);
        uint256 n;
        if (usdcAmount > 0) {
            execs[n++] = Execution(address(usdc), 0, abi.encodeCall(IERC20.transfer, (treasury, usdcAmount)));
        }
        if (wethAmount > 0) {
            execs[n++] = Execution(address(weth), 0, abi.encodeCall(IERC20.transfer, (treasury, wethAmount)));
        }
        if (tokenBurned > 0) {
            execs[n++] = Execution(a.token, 0, abi.encodeCall(IERC20.transfer, (DEAD, tokenBurned)));
        }
        if (ethAmount > 0) {
            execs[n++] = Execution(treasury, ethAmount, "");
        }
        assembly ("memory-safe") {
            mstore(execs, n)
        }
        if (n > 0) {
            _rootCall(
                kernel, abi.encodeCall(IKernel.execute, (KernelLib.EXEC_MODE_BATCH, KernelLib.encodeBatch(execs)))
            );
        }
        emit DormantClaimed(kernel, usdcAmount, wethAmount, ethAmount, tokenBurned);
    }

    // ------------------------------------------------------------------
    // Creator controls
    // ------------------------------------------------------------------

    function pauseAgent(address kernel) external {
        AgentInfo storage a = _agents[kernel];
        if (a.token == address(0)) revert NotRegistered();
        if (msg.sender != a.creator) revert NotCreator();
        a.paused = true;
        emit AgentPaused(kernel, true);
    }

    function unpauseAgent(address kernel) external {
        AgentInfo storage a = _agents[kernel];
        if (a.token == address(0)) revert NotRegistered();
        if (msg.sender != a.creator) revert NotCreator();
        a.paused = false;
        emit AgentPaused(kernel, false);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function agentInfo(address kernel) external view returns (AgentInfo memory) {
        return _agents[kernel];
    }

    function isRegistered(address kernel) external view returns (bool) {
        return _agents[kernel].token != address(0);
    }

    function dormantAt(address kernel) public view returns (uint256) {
        AgentInfo storage a = _agents[kernel];
        if (a.token == address(0)) return type(uint256).max;
        return uint256(a.lastActivity) + a.dormancyPeriod;
    }

    function isDormant(address kernel) external view returns (bool) {
        return block.timestamp >= dormantAt(kernel);
    }

    /// @notice The enable-mode digest the supervisor must reproduce (see Kernel `_enableDigest`).
    function enableDigest(address kernel, bytes4 permissionId, uint32 nonce, bytes calldata validatorData)
        external
        view
        returns (bytes32)
    {
        return _enableDigest(kernel, KernelLib.permissionId(permissionId), nonce, validatorData);
    }

    // ------------------------------------------------------------------
    // ERC-7579 module: validator (root) - rejects everything
    // ------------------------------------------------------------------

    function validateUserOp(PackedUserOperation calldata, bytes32) external payable override returns (uint256) {
        return SIG_VALIDATION_FAILED;
    }

    /// @dev Only the enable-mode path is honoured: Kernel calls this with `sender == address(kernel)`
    ///      (`_checkEnableSig`, ValidationManager.sol line 378). ERC-1271 calls arrive with the
    ///      external caller as `sender` and a wrapped hash, and are rejected.
    function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        AgentInfo storage a = _agents[msg.sender];
        if (a.token == address(0) || a.paused) return ERC1271_INVALID;
        if (sender != msg.sender) return ERC1271_INVALID;
        return approvedEnableDigests[msg.sender][hash] ? ERC1271_MAGICVALUE : ERC1271_INVALID;
    }

    // ------------------------------------------------------------------
    // ERC-7579 module: hook
    // ------------------------------------------------------------------

    /// @dev `msg.sender` is the kernel. `sender` is the kernel's caller: this contract on the root
    ///      path, the EntryPoint on the `executeUserOp` path (HookManager `_doPreHook` passes
    ///      `msg.sender`). Any other sender is a direct call into an `onlyEntryPointOrSelfOrRoot`
    ///      function by a third party (Kernel.sol lines 84-87) and is rejected.
    function preCheck(address sender, uint256, bytes calldata) external payable override returns (bytes memory) {
        AgentInfo storage a = _agents[msg.sender];
        if (a.token == address(0)) revert NotRegistered();
        if (sender == address(this)) {
            if (_rootCallKernel != msg.sender) revert NotRootCall();
            return "";
        }
        if (sender != entryPoint) revert UnauthorizedCaller(sender);
        if (a.paused) revert AgentIsPaused();
        a.lastActivity = uint64(block.timestamp);
        emit Activity(msg.sender, uint64(block.timestamp));
        return "";
    }

    function postCheck(bytes calldata) external payable override {}

    // ------------------------------------------------------------------
    // ERC-7579 module: lifecycle
    // ------------------------------------------------------------------

    /// @dev Called twice during Kernel.initialize (once as hook, once as validator); idempotent.
    function onInstall(bytes calldata) external payable override {
        if (!_installed[msg.sender]) {
            _installed[msg.sender] = true;
            emit GuardianInstalled(msg.sender);
        }
    }

    function onUninstall(bytes calldata) external payable override {
        revert CannotUninstall();
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == KernelLib.MODULE_TYPE_VALIDATOR || moduleTypeId == KernelLib.MODULE_TYPE_HOOK;
    }

    function isInitialized(address smartAccount) external view override returns (bool) {
        return _installed[smartAccount];
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _rootCall(address kernel, bytes memory data) internal {
        _rootCallKernel = kernel;
        (bool ok, bytes memory ret) = kernel.call(data);
        _rootCallKernel = address(0);
        if (!ok) revert RootCallFailed(ret);
    }

    function _enableDigest(address kernel, bytes21 vId, uint32 nonce, bytes calldata validatorData)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                ENABLE_TYPE_HASH,
                vId,
                nonce,
                address(this),
                keccak256(validatorData),
                keccak256(SESSION_HOOK_DATA),
                keccak256(SESSION_SELECTOR_DATA)
            )
        );
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, KERNEL_NAME_HASH, KERNEL_VERSION_HASH, block.chainid, kernel));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }
}
