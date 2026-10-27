// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrCallPolicy} from "../../src/BootrCallPolicy.sol";
import {BootrLauncher} from "../../src/BootrLauncher.sol";
import {BuybackBurner} from "../../src/BuybackBurner.sol";
import {IEntryPoint, IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";

/// @dev Shared Base Sepolia fork fixture for the security regression tests: deploys the Bootr stack,
///      launches one standard agent and installs a BootrCallPolicy session key through the guardian's
///      enable-mode path exactly as `apps/supervisor` does. Kept close to `test/fork/BootrFork.t.sol`.
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
    address constant ECDSA_SIGNER = 0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF;

    bytes4 constant PID = bytes4(keccak256("bootr.session.v1"));
    bytes2 constant NOT_FOR_VALIDATE_SIG = 0x0002;
    uint256 constant FUEL = 100e6;
    uint256 constant USDC_CAP = 50e6;
    uint32 constant DORMANCY = 90 days;

    /// @dev keccak256("Kernel(bytes32 hash)") - Kernel v3.1 `KERNEL_WRAPPER_TYPE_HASH` (ERC-1271 wrapping).
    bytes32 constant KERNEL_WRAPPER_TYPE_HASH = 0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83;
    bytes32 constant DOMAIN_TYPEHASH = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f;

    AgentGuardian guardian;
    BootrLauncher launcher;
    BootrCallPolicy callPolicy;
    IEntryPoint entryPoint = IEntryPoint(ENTRY_POINT);

    address platformRecipient = makeAddr("platformRecipient");
    address treasury = makeAddr("treasury");
    address bundler = makeAddr("bundler");
    address payTo = makeAddr("inferencePayTo");
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
        BootrLauncher.LaunchDefaults memory d = BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 2000,
            creatorBps: 5000,
            burnBps: 0,
            platformBps: 3000,
            platformRecipient: platformRecipient,
            minFuelUsdc: 25e6,
            dormancyPeriod: DORMANCY
        });
        // NB: `b = d` would alias the same memory struct, so build buyback defaults independently.
        BootrLauncher.LaunchDefaults memory b = BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 2000,
            creatorBps: 3500,
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

    function _permissionData(BootrCallPolicy.Rule[] memory rules) internal view returns (bytes memory) {
        bytes[] memory enableData = new bytes[](2);
        enableData[0] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, address(callPolicy), abi.encode(rules));
        enableData[1] = abi.encodePacked(bytes2(0), ECDSA_SIGNER, sessionKey);
        return abi.encode(enableData);
    }

    /// @dev The four production rules from `apps/supervisor/src/session-key.ts`.
    function _productionRules(address kernel) internal view returns (BootrCallPolicy.Rule[] memory rules) {
        rules = new BootrCallPolicy.Rule[](4);
        rules[0].target = FEE_LOCKER;
        rules[0].selector = bytes4(keccak256("claim(address,address)"));
        rules[0].args = new BootrCallPolicy.ArgRule[](1);
        rules[0].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(kernel))));
        rules[1].target = UNIVERSAL_ROUTER;
        rules[1].selector = bytes4(keccak256("execute(bytes,bytes[],uint256)"));
        rules[1].args = new BootrCallPolicy.ArgRule[](0);
        rules[2].target = USDC;
        rules[2].selector = IERC20.transfer.selector;
        rules[2].args = new BootrCallPolicy.ArgRule[](2);
        rules[2].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(payTo))));
        rules[2].args[1] = BootrCallPolicy.ArgRule(1, 2, bytes32(USDC_CAP));
        rules[3].target = WETH;
        rules[3].selector = IERC20.transfer.selector;
        rules[3].args = new BootrCallPolicy.ArgRule[](1);
        rules[3].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(UNIVERSAL_ROUTER))));
    }

    /// @dev Approves the digest (admin), then sends the enable-mode userOp whose first action is an
    ///      allowed no-op transfer.
    function _installSession(address kernel, BootrCallPolicy.Rule[] memory rules) internal {
        bytes memory validatorData = _permissionData(rules);
        guardian.approveSessionKey(kernel, PID, validatorData);
        entryPoint.depositTo{value: 1 ether}(kernel);
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x01), USDC, abi.encodeCall(IERC20.transfer, (payTo, 0)));
        bytes memory userOpSig = _signSession(op);
        op.signature = abi.encodePacked(
            address(guardian),
            abi.encode(validatorData, hex"00", abi.encodePacked(IKernel.execute.selector), bytes(""), userOpSig)
        );
        assertTrue(_handle(op), "enable userOp executed");
    }

    // ------------------------------------------------------------------
    // ERC-1271 helpers (Kernel v3.1 `_toWrappedHash`)
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

    /// @dev `0x02 ‖ permissionId ‖ 0xff ‖ ecdsa(wrappedHash)` - `encodeErc1271Signature` in session-key.ts.
    function _erc1271Signature(address kernel, bytes32 hash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, _wrappedHash(kernel, hash));
        return abi.encodePacked(bytes1(0x02), PID, bytes1(0xff), r, s, v);
    }
}
