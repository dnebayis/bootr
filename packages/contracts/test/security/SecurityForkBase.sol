// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrCallPolicy} from "../../src/BootrCallPolicy.sol";
import {BootrLauncher} from "../../src/BootrLauncher.sol";
import {BootrSwapHelper} from "../../src/BootrSwapHelper.sol";
import {BuybackBurner} from "../../src/BuybackBurner.sol";
import {IEntryPoint, IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";

interface IUsdcEip3009 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @dev Shared Base Sepolia fork fixture for the security regression tests: deploys the Bootr stack,
///      launches one standard agent and installs session keys through the guardian's enable-mode path
///      exactly as `apps/supervisor` does. Two permission layouts are available:
///        * `_legacyPermissionData`: BootrCallPolicy + ECDSA signer only (the pre-C-01 layout, kept to prove
///          the finding and the Kernel revocation gap);
///        * `_productionPermissionData`: the full production set `BootrCallPolicy` (NOT_FOR_VALIDATE_SIG, index 0),
///          GasPolicy, RateLimitPolicy (both NOT_FOR_VALIDATE_SIG), TimestampPolicy, ECDSASigner flagged
///          SKIP_SIGNATURE (0x0002) - the signer flags become `permissionFlag`, so `Kernel.isValidSignature` reverts
///          `PermissionNotAlllowedForSignature` for the permission: the session key has no ERC-1271 path at all.
///      Policy-signature slots are unusable on Kernel v3.1's ERC-1271 path (`_checkSignaturePolicy` re-reads the
///      original slice after the policies and reverts `SignerPrefixNotPresent`); `RevocationFork.t.sol` proves it.
abstract contract SecurityForkBase is Test {
    address constant CLANKER = 0xE85A59c628F7d27878ACeB4bf3b35733630083a9;
    address constant FEE_LOCKER = 0x42A95190B4088C88Dd904d930c79deC1158bF09D;
    address constant LP_LOCKER = 0x824bB048a5EC6e06a09aEd115E9eEA4618DC2c8f;
    address constant HOOK = 0x11b51DBC2f7F683b81CeDa83DC0078D57bA328cc;
    address constant DEV_BUY = 0x691f97752E91feAcD7933F32a1FEdCeDae7bB59c;
    address constant MEV = 0x71DB365E93e170ba3B053339A917c11024e7a9d4;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant KERNEL_FACTORY = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant UNIVERSAL_ROUTER = 0x492E6456D9528771018DeB9E87ef7750EF184104;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant SWAP_ROUTER_02 = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address constant ETH_USD_FEED = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;
    // ZeroDev permission modules (packages/shared/src/addresses.ts, Base Sepolia)
    address constant ECDSA_SIGNER = 0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF;
    address constant GAS_POLICY = 0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23;
    address constant RATE_LIMIT_POLICY = 0xf63d4139B25c836334edD76641356c6b74C86873;
    address constant TIMESTAMP_POLICY = 0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F;

    bytes4 constant PID = bytes4(keccak256("bootr.session.v1"));
    bytes2 constant FOR_ALL_VALIDATION = 0x0000;
    bytes2 constant NOT_FOR_VALIDATE_USEROP = 0x0001;
    bytes2 constant NOT_FOR_VALIDATE_SIG = 0x0002;
    uint256 constant FUEL = 100e6;
    uint256 constant USDC_CAP = 50e6;
    /// @dev Window of the spender funding rule (`USDC.transfer(spender, SUM_PER_WINDOW <= USDC_CAP)`).
    uint32 constant FUND_WINDOW = 1 days;
    uint32 constant DORMANCY = 90 days;
    /// @dev Index of BootrCallPolicy in the policy list (the `idx` byte of its time slot on the userOp path).
    uint8 constant CALL_POLICY_INDEX = 0;
    bytes4 constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 constant PERMISSION_NOT_ALLOWED_FOR_SIGNATURE = bytes4(keccak256("PermissionNotAlllowedForSignature()"));
    bytes4 constant SIGNER_PREFIX_NOT_PRESENT = bytes4(keccak256("SignerPrefixNotPresent()"));

    /// @dev keccak256("Kernel(bytes32 hash)") - Kernel v3.1 `KERNEL_WRAPPER_TYPE_HASH` (ERC-1271 wrapping).
    bytes32 constant KERNEL_WRAPPER_TYPE_HASH = 0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83;
    bytes32 constant DOMAIN_TYPEHASH = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f;
    bytes32 constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    AgentGuardian guardian;
    BootrLauncher launcher;
    BootrCallPolicy callPolicy;
    BootrSwapHelper swapHelper;
    IEntryPoint entryPoint = IEntryPoint(ENTRY_POINT);

    address platformRecipient = makeAddr("platformRecipient");
    address treasury = makeAddr("treasury");
    address bundler = makeAddr("bundler");
    address payTo = makeAddr("inferencePayTo");
    /// @dev The agent's per-agent x402 spender EOA (the only USDC recipient of the session key).
    address spender = makeAddr("spender");
    address thirdParty = makeAddr("thirdParty");
    uint256 sessionPk = 0xA11CE;
    address sessionKey = vm.addr(sessionPk);
    uint256 creatorPk = 0xC0FFEE;
    address creator = vm.addr(creatorPk);

    function setUp() public virtual {
        vm.createSelectFork(vm.envOr("BASE_SEPOLIA_RPC_URL", string("https://sepolia.base.org")));
        guardian = new AgentGuardian(address(this), ENTRY_POINT, USDC, WETH);
        BuybackBurner burnerImpl = new BuybackBurner();
        callPolicy = new BootrCallPolicy();
        swapHelper = new BootrSwapHelper(WETH, USDC, SWAP_ROUTER_02, ETH_USD_FEED, 500);
        BootrLauncher.LaunchDefaults memory d = BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: 6500,
            burnBps: 0,
            platformBps: 3000,
            platformRecipient: platformRecipient,
            minFuelUsdc: 25e6,
            dormancyPeriod: DORMANCY
        });
        // NB: `b = d` would alias the same memory struct, so build buyback defaults independently.
        BootrLauncher.LaunchDefaults memory b = BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: 5000,
            burnBps: 1500,
            platformBps: 3000,
            platformRecipient: platformRecipient,
            minFuelUsdc: 25e6,
            dormancyPeriod: DORMANCY
        });
        launcher = new BootrLauncher(
            address(this),
            BootrLauncher.Deps({
                clanker: CLANKER,
                feeLocker: FEE_LOCKER,
                lpLocker: LP_LOCKER,
                staticHook: HOOK,
                devBuyExtension: DEV_BUY,
                mevModule: MEV,
                weth: WETH,
                usdc: USDC,
                identityRegistry: IDENTITY,
                kernelFactory: KERNEL_FACTORY,
                guardian: address(guardian),
                burnerImplementation: address(burnerImpl),
                universalRouter: UNIVERSAL_ROUTER,
                permit2: PERMIT2
            }),
            d,
            b,
            1000
        );
        guardian.setLauncher(address(launcher));
        guardian.setPlatformTreasury(treasury);
        deal(USDC, creator, 10_000e6);
        vm.deal(creator, 100 ether);
        vm.prank(creator);
        IERC20(USDC).approve(address(launcher), type(uint256).max);
    }

    function _launch() internal returns (address token, address kernel) {
        BootrLauncher.LaunchParams memory p = BootrLauncher.LaunchParams({
            name: "Bootr Agent",
            symbol: "BOOTR",
            image: "ipfs://image",
            metadata: "{}",
            context: "{}",
            salt: bytes32(uint256(7)),
            buybackBurn: false,
            fuelUsdc: FUEL,
            devBuyWei: 0,
            workerHash: keccak256("worker"),
            model: "m",
            agentURI: "https://bootr.example/agent.json",
            supervisorSessionKey: sessionKey
        });
        vm.prank(creator);
        (token, kernel,,) = launcher.launch(p);
    }

    // ------------------------------------------------------------------
    // userOp plumbing (mirrors apps/supervisor/src/session-key.ts)
    // ------------------------------------------------------------------

    function _permissionNonce(address kernel, bytes1 mode) internal view returns (uint256) {
        uint192 key = (uint192(uint8(mode)) << 184) | (uint192(0x02) << 176)
            | (uint192(uint160(bytes20(abi.encodePacked(PID, bytes16(0))))) << 16);
        return entryPoint.getNonce(kernel, key);
    }

    function _userOp(address kernel, uint256 nonce, address target, bytes memory data)
        internal
        pure
        returns (PackedUserOperation memory op)
    {
        bytes memory inner =
            abi.encodeCall(IKernel.execute, (KernelLib.EXEC_MODE_SINGLE, KernelLib.encodeSingle(target, 0, data)));
        op = PackedUserOperation({
            sender: kernel,
            nonce: nonce,
            initCode: "",
            callData: abi.encodePacked(IKernel.executeUserOp.selector, inner),
            accountGasLimits: bytes32((uint256(3_000_000) << 128) | 3_000_000),
            preVerificationGas: 200_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | 1 gwei),
            paymasterAndData: "",
            signature: ""
        });
    }

    function _signSession(PackedUserOperation memory op) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, entryPoint.getUserOpHash(op));
        return abi.encodePacked(bytes1(0xff), r, s, v);
    }

    /// @dev `[0 ‖ uint64(32) ‖ abi.encode(now)] ‖ 0xff ‖ sig`: the call policy's time slot (session-key.ts
    ///      `encodeSessionSignature(sig, claimedNow)`), used by every op that spends from a windowed rule.
    function _signSessionAt(PackedUserOperation memory op, uint256 claimedNow) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, entryPoint.getUserOpHash(op));
        return abi.encodePacked(CALL_POLICY_INDEX, uint64(32), abi.encode(claimedNow), bytes1(0xff), r, s, v);
    }

    function _handle(PackedUserOperation memory op) internal returns (bool success) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.recordLogs();
        vm.prank(bundler);
        entryPoint.handleOps(ops, payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    /// @dev The four production rules from `apps/supervisor/src/session-key.ts` (swap helper, not the router).
    function _productionRules(address kernel) internal view returns (BootrCallPolicy.Rule[] memory rules) {
        rules = new BootrCallPolicy.Rule[](4);
        rules[0].target = FEE_LOCKER;
        rules[0].selector = bytes4(keccak256("claim(address,address)"));
        rules[0].args = new BootrCallPolicy.ArgRule[](1);
        rules[0].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(kernel))));
        rules[1].target = WETH;
        rules[1].selector = IERC20.approve.selector;
        rules[1].args = new BootrCallPolicy.ArgRule[](1);
        rules[1].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(address(swapHelper)))));
        rules[2].target = address(swapHelper);
        rules[2].selector = BootrSwapHelper.swapWethToUsdc.selector;
        rules[2].args = new BootrCallPolicy.ArgRule[](0);
        // USDC.transfer(spender, SUM_PER_WINDOW <= USDC_CAP per FUND_WINDOW)
        rules[3].target = USDC;
        rules[3].selector = IERC20.transfer.selector;
        rules[3].windowSeconds = FUND_WINDOW;
        rules[3].args = new BootrCallPolicy.ArgRule[](2);
        rules[3].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(spender))));
        rules[3].args[1] = BootrCallPolicy.ArgRule(1, 3, bytes32(USDC_CAP));
    }

    /// @dev Pre-fix layout: BootrCallPolicy (NOT_FOR_VALIDATE_SIG) + ECDSA signer with FOR_ALL_VALIDATION, i.e.
    ///      the signature path is open and ungated (the C-01 / BOOTR-01 finding).
    function _legacyPermissionData(address kernel) internal view returns (bytes memory) {
        bytes[] memory enableData = new bytes[](2);
        enableData[0] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, address(callPolicy), abi.encode(_productionRules(kernel)));
        enableData[1] = abi.encodePacked(FOR_ALL_VALIDATION, ECDSA_SIGNER, sessionKey);
        return abi.encode(enableData);
    }

    /// @dev The production layout (same order and flags as `policyEntries` in session-key.ts): the signer entry
    ///      carries SKIP_SIGNATURE, so the permission cannot be used for ERC-1271 at all.
    function _productionPermissionData(address kernel) internal view returns (bytes memory) {
        bytes[] memory enableData = new bytes[](5);
        enableData[0] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, address(callPolicy), abi.encode(_productionRules(kernel)));
        // GasPolicy: abi.encode(uint128 allowed, bool enforcePaymaster, address allowedPaymaster)
        enableData[1] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, GAS_POLICY, abi.encode(uint128(1e17), false, address(0)));
        // RateLimitPolicy: interval(6) ‖ count(6) ‖ startAt(6)
        enableData[2] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, RATE_LIMIT_POLICY, uint48(3600), uint48(60), uint48(0));
        // TimestampPolicy: abi.encode(uint48 validAfter, uint48 validUntil)
        enableData[3] = abi.encodePacked(
            FOR_ALL_VALIDATION, TIMESTAMP_POLICY, abi.encode(uint48(0), uint48(vm.getBlockTimestamp() + 30 days))
        );
        enableData[4] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, ECDSA_SIGNER, sessionKey);
        return abi.encode(enableData);
    }

    /// @dev `abi.encode(bytes[])` with one empty entry per module (what `buildDeinitData` produces).
    function _productionDeinitData() internal pure returns (bytes memory) {
        return abi.encode(new bytes[](5));
    }

    /// @dev Approves the digest (admin), then sends the enable-mode userOp whose first action is an
    ///      allowed no-op transfer.
    function _installSession(address kernel, bytes memory validatorData) internal returns (bytes32 digest) {
        (digest,) = guardian.approveSessionKey(kernel, PID, validatorData);
        entryPoint.depositTo{value: 1 ether}(kernel);
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x01), USDC, abi.encodeCall(IERC20.transfer, (spender, 0)));
        bytes memory userOpSig = _signSession(op);
        op.signature = abi.encodePacked(
            address(guardian),
            abi.encode(validatorData, hex"00", abi.encodePacked(IKernel.execute.selector), bytes(""), userOpSig)
        );
        assertTrue(_handle(op), "enable userOp executed");
    }

    // ------------------------------------------------------------------
    // ERC-1271 helpers (Kernel v3.1 `_toWrappedHash`, EIP-3009 digests, policy-signature layout)
    // ------------------------------------------------------------------

    function _kernelDomainSeparator(address kernel) internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Kernel"), keccak256("0.3.1"), block.chainid, kernel)
        );
    }

    function _wrappedHash(address kernel, bytes32 hash) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(KERNEL_WRAPPER_TYPE_HASH, hash));
        return keccak256(abi.encodePacked(hex"1901", _kernelDomainSeparator(kernel), structHash));
    }

    /// @dev `0x02 ‖ permissionId ‖ 0xff ‖ ecdsa(wrappedHash)` - the legacy `encodeErc1271Signature`.
    function _erc1271Signature(address kernel, bytes32 hash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, _wrappedHash(kernel, hash));
        return abi.encodePacked(bytes1(0x02), PID, bytes1(0xff), r, s, v);
    }

    /// @dev `0x02 ‖ permissionId ‖ idx ‖ uint64 len ‖ data ‖ 0xff ‖ ecdsa(wrappedHash)`: an ERC-1271 signature that
    ///      carries a policy-signature slot for policy `idx` (what a content policy on the signature path would need).
    function _erc1271SignatureWithPolicySlot(address kernel, bytes32 hash, uint8 idx, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, _wrappedHash(kernel, hash));
        return abi.encodePacked(bytes1(0x02), PID, idx, uint64(data.length), data, bytes1(0xff), r, s, v);
    }

    /// @dev The USDC (FiatTokenV2_2) `TransferWithAuthorization` digest with the live domain separator.
    function _usdcTransferDigest(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        return keccak256(abi.encodePacked(hex"1901", IUsdcEip3009(USDC).DOMAIN_SEPARATOR(), structHash));
    }
}
