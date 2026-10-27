// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BootrCallPolicy} from "../../src/BootrCallPolicy.sol";
import {Execution, IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";

interface IFeeLockerClaim {
    function claim(address feeOwner, address token) external;
}

interface IUniversalRouterExecute {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev No-fork unit tests for BootrCallPolicy. The "kernel" is a plain address that pranks the
///      calls the real Kernel v3.1 makes (`onInstall`, `checkUserOpPolicy`, `onUninstall`).
contract BootrCallPolicyTest is Test {
    BootrCallPolicy policy;

    address kernel = makeAddr("kernel");
    address otherKernel = makeAddr("otherKernel");
    address feeLocker = makeAddr("feeLocker");
    address universalRouter = makeAddr("universalRouter");
    address usdc = makeAddr("usdc");
    address weth = makeAddr("weth");
    address payTo = makeAddr("payTo");
    address creator = makeAddr("creator");

    uint256 constant CAP = 50e6;
    bytes4 constant PID = 0x5bc28724;
    bytes32 constant ID = bytes32(PID); // left-aligned, as the Kernel passes it
    bytes32 constant OTHER_ID = bytes32(bytes4(0xdeadbeef));
    bytes32 constant EXEC_MODE_DELEGATECALL = bytes32(uint256(0xff) << 248);
    uint8 constant EQ = 1;
    uint8 constant LTE = 2;
    uint8 constant WIN = 3;
    uint32 constant WINDOW = 1 days;
    bytes32 constant WIN_ID = bytes32(bytes4(0x5e550001));
    uint256 constant T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);
        policy = new BootrCallPolicy();
        assertEq(policy.OP_EQUAL(), EQ);
        assertEq(policy.OP_LESS_THAN_OR_EQUAL(), LTE);
        assertEq(policy.OP_SUM_PER_WINDOW(), WIN);
        bytes memory initData = abi.encodePacked(ID, abi.encode(_rules()));
        vm.prank(kernel);
        policy.onInstall(initData);
        // a second permission on the same kernel with the production funding rule: USDC.transfer(payTo, <= CAP per day)
        bytes memory winData = abi.encodePacked(WIN_ID, abi.encode(_windowRules()));
        vm.prank(kernel);
        policy.onInstall(winData);
    }

    /// @dev The production money rule: `USDC.transfer(spender, SUM_PER_WINDOW <= CAP)` with a 1-day window.
    function _windowRules() internal view returns (BootrCallPolicy.Rule[] memory rules) {
        rules = new BootrCallPolicy.Rule[](2);
        rules[0].target = usdc;
        rules[0].selector = IERC20.transfer.selector;
        rules[0].windowSeconds = WINDOW;
        rules[0].args = new BootrCallPolicy.ArgRule[](2);
        rules[0].args[0] = BootrCallPolicy.ArgRule(0, EQ, bytes32(uint256(uint160(payTo))));
        rules[0].args[1] = BootrCallPolicy.ArgRule(1, WIN, bytes32(CAP));
        rules[1].target = feeLocker;
        rules[1].selector = IFeeLockerClaim.claim.selector;
        rules[1].args = new BootrCallPolicy.ArgRule[](1);
        rules[1].args[0] = BootrCallPolicy.ArgRule(0, EQ, bytes32(uint256(uint160(kernel))));
    }

    /// @dev `checkUserOpPolicy` on the windowed permission with the time slot in `userOp.signature`.
    function _checkWin(bytes memory callData, uint256 claimedNow) internal returns (uint256) {
        PackedUserOperation memory op = _op(callData);
        op.signature = abi.encode(claimedNow);
        vm.prank(kernel);
        return policy.checkUserOpPolicy(WIN_ID, op);
    }

    function _packed(uint256 validAfter, uint256 validUntil) internal pure returns (uint256) {
        return (validUntil << 160) | (validAfter << 208);
    }

    function _window() internal view returns (uint48 windowEnd, uint128 spent) {
        (windowEnd, spent,,) = policy.windowOf(WIN_ID, kernel, 0, 1);
    }

    // ------------------------------------------------------------------
    // Fixtures (the four supervisor rules)
    // ------------------------------------------------------------------

    function _rules() internal view returns (BootrCallPolicy.Rule[] memory rules) {
        // literal ops (1 = EQUAL, 2 = LESS_THAN_OR_EQUAL): no external call here, so callers may prank
        rules = new BootrCallPolicy.Rule[](4);
        // FeeLocker.claim(kernel, *)
        rules[0].target = feeLocker;
        rules[0].selector = IFeeLockerClaim.claim.selector;
        rules[0].args = new BootrCallPolicy.ArgRule[](1);
        rules[0].args[0] = BootrCallPolicy.ArgRule(0, EQ, bytes32(uint256(uint160(kernel))));
        // UniversalRouter.execute(bytes,bytes[],uint256), any args
        rules[1].target = universalRouter;
        rules[1].selector = IUniversalRouterExecute.execute.selector;
        rules[1].args = new BootrCallPolicy.ArgRule[](0);
        // USDC.transfer(payTo, <= CAP)
        rules[2].target = usdc;
        rules[2].selector = IERC20.transfer.selector;
        rules[2].args = new BootrCallPolicy.ArgRule[](2);
        rules[2].args[0] = BootrCallPolicy.ArgRule(0, EQ, bytes32(uint256(uint160(payTo))));
        rules[2].args[1] = BootrCallPolicy.ArgRule(1, LTE, bytes32(CAP));
        // WETH.transfer(universalRouter, *)
        rules[3].target = weth;
        rules[3].selector = IERC20.transfer.selector;
        rules[3].args = new BootrCallPolicy.ArgRule[](1);
        rules[3].args[0] = BootrCallPolicy.ArgRule(0, EQ, bytes32(uint256(uint160(universalRouter))));
    }

    function _op(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = kernel;
        op.callData = callData;
    }

    function _execute(bytes32 mode, bytes memory executionCalldata) internal pure returns (bytes memory) {
        return abi.encodeCall(IKernel.execute, (mode, executionCalldata));
    }

    function _wrap(bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodePacked(IKernel.executeUserOp.selector, inner);
    }

    function _single(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return _wrap(_execute(KernelLib.EXEC_MODE_SINGLE, KernelLib.encodeSingle(target, value, data)));
    }

    function _check(bytes memory callData) internal returns (uint256) {
        vm.prank(kernel);
        return policy.checkUserOpPolicy(ID, _op(callData));
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.transfer, (to, amount));
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    function test_installStoresRulesAndFlags() public view {
        assertTrue(policy.installed(ID, kernel));
        assertEq(policy.installedCount(kernel), 2);
        assertTrue(policy.isInitialized(kernel));
        assertFalse(policy.isInitialized(otherKernel));
        assertTrue(policy.isModuleType(5));
        assertFalse(policy.isModuleType(1));
        assertFalse(policy.isModuleType(4));
        BootrCallPolicy.Rule[] memory stored = policy.rulesOf(ID, kernel);
        assertEq(stored.length, 4);
        assertEq(stored[2].target, usdc);
        assertEq(stored[2].selector, IERC20.transfer.selector);
        assertEq(stored[2].args.length, 2);
        assertEq(stored[2].args[1].op, LTE);
        assertEq(stored[2].args[1].value, bytes32(CAP));
        assertEq(stored[1].args.length, 0);
        assertEq(stored[2].windowSeconds, 0);
        BootrCallPolicy.Rule[] memory win = policy.rulesOf(WIN_ID, kernel);
        assertEq(win[0].windowSeconds, WINDOW);
        assertEq(win[0].args[1].op, WIN);
        (uint48 windowEnd, uint128 spent, uint32 windowSeconds, uint256 cap) = policy.windowOf(WIN_ID, kernel, 0, 1);
        assertEq(windowEnd, T0 + WINDOW, "first window ends one window after install");
        assertEq(spent, 0);
        assertEq(windowSeconds, WINDOW);
        assertEq(cap, CAP);
    }

    function test_installRejectsDuplicateEmptyAndBadOp() public {
        bytes memory again = abi.encodePacked(ID, abi.encode(_rules()));
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.AlreadyInstalled.selector, ID, kernel));
        policy.onInstall(again);

        BootrCallPolicy.Rule[] memory none = new BootrCallPolicy.Rule[](0);
        vm.prank(otherKernel);
        vm.expectRevert(BootrCallPolicy.NoRules.selector);
        policy.onInstall(abi.encodePacked(ID, abi.encode(none)));

        BootrCallPolicy.Rule[] memory bad = _rules();
        bad[0].args[0].op = 4;
        bytes memory badData = abi.encodePacked(ID, abi.encode(bad));
        vm.prank(otherKernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.InvalidOp.selector, 4));
        policy.onInstall(badData);

        vm.prank(otherKernel);
        vm.expectRevert(BootrCallPolicy.InvalidInstallData.selector);
        policy.onInstall(hex"1234");

        // SUM_PER_WINDOW needs a window and a cap that fits uint128
        BootrCallPolicy.Rule[] memory win = _windowRules();
        win[0].windowSeconds = 0;
        bytes memory noWindow = abi.encodePacked(ID, abi.encode(win));
        vm.prank(otherKernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.WindowRequired.selector, 0));
        policy.onInstall(noWindow);
        win = _windowRules();
        win[0].args[1].value = bytes32(uint256(type(uint128).max) + 1);
        bytes memory bigCap = abi.encodePacked(ID, abi.encode(win));
        vm.prank(otherKernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.CapTooLarge.selector, 0, 1));
        policy.onInstall(bigCap);
    }

    function test_uninstallDeletesRulesAndIsIdempotent() public {
        vm.prank(kernel);
        policy.onUninstall(abi.encodePacked(WIN_ID));
        vm.prank(kernel);
        policy.onUninstall(abi.encodePacked(ID));
        assertFalse(policy.installed(ID, kernel));
        assertEq(policy.installedCount(kernel), 0);
        assertFalse(policy.isInitialized(kernel));
        assertEq(policy.rulesOf(ID, kernel).length, 0);
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.NotInstalled.selector, ID, kernel));
        policy.checkUserOpPolicy(ID, _op(_single(usdc, 0, _transfer(payTo, 1))));
        // second uninstall is a no-op
        vm.prank(kernel);
        policy.onUninstall(abi.encodePacked(ID, hex"abcd"));
        assertEq(policy.installedCount(kernel), 0);
        // re-install after uninstall works and starts from a clean rule set
        BootrCallPolicy.Rule[] memory one = new BootrCallPolicy.Rule[](1);
        one[0] = _rules()[2];
        bytes memory oneData = abi.encodePacked(ID, abi.encode(one));
        vm.prank(kernel);
        policy.onInstall(oneData);
        assertEq(policy.rulesOf(ID, kernel).length, 1);
        assertEq(_check(_single(usdc, 0, _transfer(payTo, 1))), 0);
        assertEq(_check(_single(weth, 0, _transfer(universalRouter, 1))), 1);
    }

    function test_rulesIsolatedPerIdAndKernel() public {
        bytes memory allowedHere = _single(usdc, 0, _transfer(payTo, 1));
        // same id, another kernel: not installed
        vm.prank(otherKernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.NotInstalled.selector, ID, otherKernel));
        policy.checkUserOpPolicy(ID, _op(allowedHere));
        // another id, same kernel: not installed
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.NotInstalled.selector, OTHER_ID, kernel));
        policy.checkUserOpPolicy(OTHER_ID, _op(allowedHere));
        // other kernel installs a different rule set under the same id: only its rule applies there
        BootrCallPolicy.Rule[] memory one = new BootrCallPolicy.Rule[](1);
        one[0] = _rules()[3];
        bytes memory oneData = abi.encodePacked(ID, abi.encode(one));
        vm.prank(otherKernel);
        policy.onInstall(oneData);
        vm.prank(otherKernel);
        assertEq(policy.checkUserOpPolicy(ID, _op(allowedHere)), 1);
        vm.prank(otherKernel);
        assertEq(policy.checkUserOpPolicy(ID, _op(_single(weth, 0, _transfer(universalRouter, 5)))), 0);
        assertEq(_check(allowedHere), 0);
        // uninstalling on the other kernel leaves this kernel untouched
        vm.prank(otherKernel);
        policy.onUninstall(abi.encodePacked(ID));
        assertEq(_check(allowedHere), 0);
        assertTrue(policy.installed(ID, kernel));
    }

    // ------------------------------------------------------------------
    // Single calls
    // ------------------------------------------------------------------

    function test_singleAllowed() public {
        assertEq(_check(_single(usdc, 0, _transfer(payTo, CAP))), 0, "transfer at cap");
        assertEq(_check(_single(usdc, 0, _transfer(payTo, 0))), 0, "transfer zero");
        assertEq(_check(_single(feeLocker, 0, abi.encodeCall(IFeeLockerClaim.claim, (kernel, weth)))), 0, "claim");
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = hex"00";
        assertEq(
            _check(_single(universalRouter, 0, abi.encodeCall(IUniversalRouterExecute.execute, (hex"10", inputs, 1)))),
            0,
            "router execute"
        );
        assertEq(_check(_single(weth, 0, _transfer(universalRouter, 1 ether))), 0, "weth to router");
    }

    function test_plainExecuteWithoutWrapperAccepted() public {
        bytes memory plain = _execute(KernelLib.EXEC_MODE_SINGLE, KernelLib.encodeSingle(usdc, 0, _transfer(payTo, 1)));
        assertEq(_check(plain), 0);
        assertEq(_check(_wrap(plain)), 0, "wrapper stripped");
    }

    function test_wrongTarget() public {
        assertEq(_check(_single(creator, 0, _transfer(payTo, 1))), 1);
        assertEq(_check(_single(weth, 0, _transfer(payTo, 1))), 1, "payTo rule is for USDC only");
        assertEq(_check(_single(usdc, 0, _transfer(universalRouter, 1))), 1, "router rule is for WETH only");
    }

    function test_wrongSelector() public {
        assertEq(_check(_single(usdc, 0, abi.encodeCall(IERC20.approve, (payTo, 1)))), 1);
        assertEq(_check(_single(usdc, 0, abi.encodeCall(IERC20.transferFrom, (kernel, payTo, 1)))), 1);
        assertEq(_check(_single(feeLocker, 0, abi.encodeCall(IERC20.transfer, (kernel, 1)))), 1);
    }

    function test_argEqualFails() public {
        assertEq(_check(_single(usdc, 0, _transfer(creator, 1))), 1, "usdc to creator");
        assertEq(
            _check(_single(feeLocker, 0, abi.encodeCall(IFeeLockerClaim.claim, (creator, weth)))),
            1,
            "claim for creator"
        );
        assertEq(_check(_single(weth, 0, _transfer(creator, 1))), 1, "weth to creator");
        // dirty upper bits in the address word break the bytes32 equality
        bytes memory dirty =
            abi.encodePacked(IERC20.transfer.selector, bytes32(uint256(uint160(payTo)) | (1 << 200)), uint256(1));
        assertEq(_check(_single(usdc, 0, dirty)), 1, "dirty address word");
    }

    function test_argLessThanOrEqualFails() public {
        assertEq(_check(_single(usdc, 0, _transfer(payTo, CAP + 1))), 1);
        assertEq(_check(_single(usdc, 0, _transfer(payTo, type(uint256).max))), 1);
    }

    function test_nonZeroValueFails() public {
        assertEq(_check(_single(usdc, 1, _transfer(payTo, 1))), 1);
        assertEq(_check(_single(universalRouter, 1 wei, abi.encodePacked(IUniversalRouterExecute.execute.selector))), 1);
    }

    function test_delegatecallModeFails() public {
        bytes memory cd = _wrap(_execute(EXEC_MODE_DELEGATECALL, abi.encodePacked(usdc, _transfer(payTo, 1))));
        assertEq(_check(cd), 1);
        // any other call type too (0x02, 0xfe)
        cd = _wrap(_execute(bytes32(uint256(0x02) << 248), KernelLib.encodeSingle(usdc, 0, _transfer(payTo, 1))));
        assertEq(_check(cd), 1);
        cd = _wrap(_execute(bytes32(uint256(0xfe) << 248), KernelLib.encodeSingle(usdc, 0, _transfer(payTo, 1))));
        assertEq(_check(cd), 1);
    }

    function test_execTypeTryStillChecked() public {
        // execType (mode byte 1) = 0x01 "try": the policy only looks at the call type
        bytes32 modeTry = bytes32(uint256(0x01) << 240);
        assertEq(_check(_wrap(_execute(modeTry, KernelLib.encodeSingle(usdc, 0, _transfer(payTo, 1))))), 0);
        assertEq(_check(_wrap(_execute(modeTry, KernelLib.encodeSingle(usdc, 0, _transfer(creator, 1))))), 1);
    }

    // ------------------------------------------------------------------
    // Batches
    // ------------------------------------------------------------------

    function _batch(Execution[] memory execs) internal pure returns (bytes memory) {
        return _wrap(_execute(KernelLib.EXEC_MODE_BATCH, KernelLib.encodeBatch(execs)));
    }

    function test_batchAllowed() public {
        Execution[] memory execs = new Execution[](3);
        execs[0] = Execution(feeLocker, 0, abi.encodeCall(IFeeLockerClaim.claim, (kernel, weth)));
        execs[1] = Execution(weth, 0, _transfer(universalRouter, 1 ether));
        execs[2] = Execution(usdc, 0, _transfer(payTo, CAP));
        assertEq(_check(_batch(execs)), 0);
        // an empty batch has nothing disallowed
        assertEq(_check(_batch(new Execution[](0))), 0);
    }

    function test_batchOneBadCallFails() public {
        Execution[] memory execs = new Execution[](2);
        execs[0] = Execution(usdc, 0, _transfer(payTo, 1));
        execs[1] = Execution(usdc, 0, _transfer(creator, 1));
        assertEq(_check(_batch(execs)), 1, "second call wrong recipient");
        execs[1] = Execution(usdc, 1, _transfer(payTo, 1));
        assertEq(_check(_batch(execs)), 1, "second call has value");
        execs[1] = Execution(creator, 0, "");
        assertEq(_check(_batch(execs)), 1, "second call has no selector");
        execs[1] = Execution(usdc, 0, hex"a9059c");
        assertEq(_check(_batch(execs)), 1, "second call has 3-byte data");
    }

    // ------------------------------------------------------------------
    // Malformed call data
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // M-02: LESS_THAN_OR_EQUAL bounds are cumulative per batch
    // ------------------------------------------------------------------

    function test_batchSumOfCappedTransfersEnforced() public {
        // two transfers that each fit the cap but sum above it
        Execution[] memory execs = new Execution[](2);
        execs[0] = Execution(usdc, 0, _transfer(payTo, CAP));
        execs[1] = Execution(usdc, 0, _transfer(payTo, 1));
        assertEq(_check(_batch(execs)), 1, "sum over cap");
        // exactly the cap in total passes
        execs[0] = Execution(usdc, 0, _transfer(payTo, CAP - 1));
        assertEq(_check(_batch(execs)), 0, "sum == cap");
        // many small ones
        Execution[] memory many = new Execution[](50);
        for (uint256 i; i < 50; ++i) {
            many[i] = Execution(usdc, 0, _transfer(payTo, CAP / 50));
        }
        assertEq(_check(_batch(many)), 0);
        many[49] = Execution(usdc, 0, _transfer(payTo, CAP / 50 + 1));
        assertEq(_check(_batch(many)), 1);
        // zero-amount calls never add up
        for (uint256 i; i < 50; ++i) {
            many[i] = Execution(usdc, 0, _transfer(payTo, 0));
        }
        assertEq(_check(_batch(many)), 0);
    }

    function test_batchSumIsPerRuleAndDoesNotTouchEqualOrUnboundedRules() public {
        // EQUAL-only rules (claim, weth transfer) and arg-less rules (router) are not summed
        Execution[] memory execs = new Execution[](4);
        execs[0] = Execution(weth, 0, _transfer(universalRouter, type(uint256).max));
        execs[1] = Execution(weth, 0, _transfer(universalRouter, type(uint256).max));
        execs[2] = Execution(feeLocker, 0, abi.encodeCall(IFeeLockerClaim.claim, (kernel, weth)));
        execs[3] = Execution(usdc, 0, _transfer(payTo, CAP));
        assertEq(_check(_batch(execs)), 0);
    }

    function test_batchSumSaturatesOnHugeWords() public {
        // a rule with cap = max: two max words would wrap a naive sum back under the bound
        BootrCallPolicy.Rule[] memory one = new BootrCallPolicy.Rule[](1);
        one[0].target = usdc;
        one[0].selector = IERC20.transfer.selector;
        one[0].args = new BootrCallPolicy.ArgRule[](1);
        one[0].args[0] = BootrCallPolicy.ArgRule(1, LTE, bytes32(type(uint256).max));
        bytes memory data = abi.encodePacked(OTHER_ID, abi.encode(one));
        vm.prank(otherKernel);
        policy.onInstall(data);
        Execution[] memory execs = new Execution[](2);
        execs[0] = Execution(usdc, 0, _transfer(payTo, type(uint256).max));
        execs[1] = Execution(usdc, 0, _transfer(payTo, 1));
        vm.prank(otherKernel);
        assertEq(policy.checkUserOpPolicy(OTHER_ID, _op(_batch(execs))), 1, "overflow must fail, not wrap");
        execs[1] = Execution(usdc, 0, _transfer(payTo, 0));
        vm.prank(otherKernel);
        assertEq(policy.checkUserOpPolicy(OTHER_ID, _op(_batch(execs))), 0);
    }

    function test_fuzzBatchSum(uint64 a, uint64 b, uint64 c) public {
        Execution[] memory execs = new Execution[](3);
        execs[0] = Execution(usdc, 0, _transfer(payTo, a));
        execs[1] = Execution(usdc, 0, _transfer(payTo, b));
        execs[2] = Execution(usdc, 0, _transfer(payTo, c));
        uint256 res = _check(_batch(execs));
        bool ok = uint256(a) <= CAP && uint256(b) <= CAP && uint256(c) <= CAP && uint256(a) + b + c <= CAP;
        assertEq(res, ok ? 0 : 1);
    }

    function test_truncatedCallDataFails() public {
        assertEq(_check(""), 1, "empty");
        assertEq(_check(hex"8dd771"), 1, "3 bytes");
        assertEq(_check(abi.encodePacked(IKernel.executeUserOp.selector)), 1, "wrapper only");
        assertEq(_check(abi.encodePacked(IKernel.execute.selector)), 1, "execute selector only");
        assertEq(
            _check(abi.encodePacked(IKernel.executeUserOp.selector, IKernel.execute.selector)), 1, "both selectors only"
        );
        bytes memory full = _single(usdc, 0, _transfer(payTo, 1));
        // executionCalldata = 20 + 32 + 68 = 120 bytes, so the encoding ends with 8 bytes of ABI padding.
        // Dropping only the padding is still a well-formed `bytes` for the Kernel's decoder and for us.
        uint256 padding = 8;
        assertEq(_check(_prefix(full, full.length - padding)), 0, "padding is optional");
        // every shorter strict prefix is rejected without reverting
        for (uint256 len = 0; len < full.length - padding; ++len) {
            assertEq(_check(_prefix(full, len)), 1);
        }
        // single call shorter than target + value
        assertEq(_check(_wrap(_execute(KernelLib.EXEC_MODE_SINGLE, abi.encodePacked(usdc, uint128(0))))), 1);
        // single call with target + value but no selector
        assertEq(_check(_wrap(_execute(KernelLib.EXEC_MODE_SINGLE, abi.encodePacked(usdc, uint256(0))))), 1);
        // single call with a 3-byte selector
        assertEq(
            _check(_wrap(_execute(KernelLib.EXEC_MODE_SINGLE, abi.encodePacked(usdc, uint256(0), hex"a9059c")))), 1
        );
        // arg rule beyond the call data: transfer(payTo) without the amount word
        assertEq(
            _check(
                _wrap(
                    _execute(
                        KernelLib.EXEC_MODE_SINGLE, abi.encodePacked(usdc, uint256(0), IERC20.transfer.selector, payTo)
                    )
                )
            ),
            1
        );
    }

    function _prefix(bytes memory data, uint256 len) internal pure returns (bytes memory cut) {
        cut = new bytes(len);
        for (uint256 i; i < len; ++i) {
            cut[i] = data[i];
        }
    }

    function test_otherKernelSelectorFails() public {
        // executeUserOp wrapping anything but execute(bytes32,bytes) is rejected
        bytes memory inner = abi.encodeWithSignature("installModule(uint256,address,bytes)", 1, creator, "");
        assertEq(_check(_wrap(inner)), 1);
        assertEq(_check(inner), 1);
    }

    function test_outOfBoundsOffsetOrLengthFails() public {
        // execute(mode, bytes) with an offset word pointing past the end
        bytes memory cd = abi.encodePacked(IKernel.execute.selector, KernelLib.EXEC_MODE_SINGLE, type(uint256).max);
        assertEq(_check(cd), 1);
        cd = abi.encodePacked(
            IKernel.execute.selector, KernelLib.EXEC_MODE_SINGLE, uint256(0x40), uint256(0x20), uint256(0x40)
        );
        assertEq(_check(cd), 1, "offset in range, payload missing");
        // length claims more than remains
        cd = abi.encodePacked(
            IKernel.execute.selector, KernelLib.EXEC_MODE_SINGLE, uint256(0x40), type(uint256).max, uint256(1)
        );
        assertEq(_check(cd), 1);
    }

    // ------------------------------------------------------------------
    // ERC-8021 attribution suffix (Base Builder Codes)
    // ------------------------------------------------------------------

    /// @dev `Attribution.toDataSuffix({ codes: ['bc_a1b2c3d4'] })` from ox 0.14.57:
    ///      ascii("bc_a1b2c3d4") ‖ codesLength 0x0b ‖ schemaId 0x00 ‖ 16-byte marker 0x8021…8021.
    bytes constant ERC8021_SUFFIX = hex"62635f61316232633364340b0080218021802180218021802180218021";

    function test_erc8021SuffixIgnored() public {
        assertEq(ERC8021_SUFFIX.length, 29);
        // the supervisor appends the suffix after the full `executeUserOp ‖ execute(...)` encoding
        bytes memory allowed = abi.encodePacked(_single(usdc, 0, _transfer(payTo, CAP)), ERC8021_SUFFIX);
        assertEq(_check(allowed), 0, "allowed single call with suffix");
        bytes memory plain = abi.encodePacked(
            _execute(KernelLib.EXEC_MODE_SINGLE, KernelLib.encodeSingle(usdc, 0, _transfer(payTo, 1))), ERC8021_SUFFIX
        );
        assertEq(_check(plain), 0, "unwrapped execute with suffix");
        Execution[] memory execs = new Execution[](2);
        execs[0] = Execution(feeLocker, 0, abi.encodeCall(IFeeLockerClaim.claim, (kernel, weth)));
        execs[1] = Execution(usdc, 0, _transfer(payTo, CAP));
        assertEq(_check(abi.encodePacked(_batch(execs), ERC8021_SUFFIX)), 0, "allowed batch with suffix");

        // the suffix never turns a disallowed call into an allowed one
        assertEq(
            _check(abi.encodePacked(_single(usdc, 0, _transfer(creator, 1)), ERC8021_SUFFIX)), 1, "wrong recipient"
        );
        assertEq(_check(abi.encodePacked(_single(usdc, 0, _transfer(payTo, CAP + 1)), ERC8021_SUFFIX)), 1, "over cap");
        assertEq(_check(abi.encodePacked(_single(usdc, 1, _transfer(payTo, 1)), ERC8021_SUFFIX)), 1, "value");
        execs[1] = Execution(usdc, 0, _transfer(creator, 1));
        assertEq(_check(abi.encodePacked(_batch(execs), ERC8021_SUFFIX)), 1, "batch with one bad call");
        // nor does it rescue malformed call data (the marker alone is not a call)
        assertEq(_check(ERC8021_SUFFIX), 1, "suffix alone");
        assertEq(_check(abi.encodePacked(IKernel.executeUserOp.selector, ERC8021_SUFFIX)), 1, "wrapper + suffix");
    }

    function test_fuzzTrailingBytesIgnored(bytes calldata trailing) public {
        // any trailing bytes (not only ERC-8021) are ignored: the policy decodes from the head with bounds checks
        assertEq(_check(abi.encodePacked(_single(usdc, 0, _transfer(payTo, CAP)), trailing)), 0);
        assertEq(_check(abi.encodePacked(_single(usdc, 0, _transfer(creator, 1)), trailing)), 1);
    }

    function test_signaturePolicyAlwaysPasses() public view {
        assertEq(policy.checkSignaturePolicy(ID, creator, bytes32(0), ""), 0);
        assertEq(policy.checkSignaturePolicy(OTHER_ID, creator, keccak256("x"), hex"ff"), 0);
    }

    function test_fuzzSingleTransferAmount(uint256 amount, address to) public {
        uint256 res = _check(_single(usdc, 0, _transfer(to, amount)));
        assertEq(res, (to == payTo && amount <= CAP) ? 0 : 1);
    }

    // ------------------------------------------------------------------
    // Fixed-size storage: limits, slot count, ERC-7562 associated storage
    // ------------------------------------------------------------------

    /// @dev `_configs` is declared in slot 0 of BootrCallPolicy (see its NatSpec).
    uint256 constant CONFIGS_SLOT = 0;

    /// @dev ERC-7562 associated-storage base for `(id, kernel)`: `keccak256(kernel ‖ keccak256(id ‖ slot))`.
    function _base(bytes32 id, address k) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(k, keccak256(abi.encode(id, CONFIGS_SLOT)))));
    }

    /// @dev `count` rules with `argsEach` argument rules each; rule i allows `transfer(addr(i+1), <= i)` on `usdc`.
    function _manyRules(uint256 count, uint256 argsEach) internal view returns (BootrCallPolicy.Rule[] memory rules) {
        rules = new BootrCallPolicy.Rule[](count);
        for (uint256 i; i < count; ++i) {
            rules[i].target = usdc;
            rules[i].selector = IERC20.transfer.selector;
            rules[i].args = new BootrCallPolicy.ArgRule[](argsEach);
            for (uint256 j; j < argsEach; ++j) {
                // arg 0: recipient == address(i + 1); every further arg: word j <= i (all on the same amount word
                // when j == 1, and past-the-end words are avoided by keeping index within transfer's 2 words)
                rules[i].args[j] = j == 0
                    ? BootrCallPolicy.ArgRule(0, EQ, bytes32(uint256(i + 1)))
                    : BootrCallPolicy.ArgRule(1, LTE, bytes32(uint256(i)));
            }
        }
    }

    function test_constantsAndSlotCount() public view {
        assertEq(policy.MAX_RULES(), 8);
        assertEq(policy.MAX_ARGS(), 4);
        assertEq(policy.CONFIG_SLOTS(), 73);
        assertLt(policy.CONFIG_SLOTS(), 128, "ERC-7562 associated storage bound");
    }

    function test_installRejectsTooManyRulesOrArgs() public {
        bytes memory nine = abi.encodePacked(ID, abi.encode(_manyRules(9, 0)));
        vm.prank(otherKernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.TooManyRules.selector, 9, 8));
        policy.onInstall(nine);

        BootrCallPolicy.Rule[] memory rules = _manyRules(3, 0);
        rules[2].args = new BootrCallPolicy.ArgRule[](5);
        for (uint256 j; j < 5; ++j) {
            rules[2].args[j] = BootrCallPolicy.ArgRule(0, EQ, bytes32(0));
        }
        bytes memory fiveArgs = abi.encodePacked(ID, abi.encode(rules));
        vm.prank(otherKernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.TooManyArgs.selector, 2, 5, 4));
        policy.onInstall(fiveArgs);

        // nothing was written for the rejected installs
        assertFalse(policy.installed(ID, otherKernel));
        assertEq(policy.installedCount(otherKernel), 0);
        for (uint256 n; n < 128; ++n) {
            assertEq(vm.load(address(policy), bytes32(_base(ID, otherKernel) + n)), bytes32(0));
        }
    }

    function test_installMaxRulesAndArgsUsesExactlyConfigSlots() public {
        bytes memory full = abi.encodePacked(ID, abi.encode(_manyRules(8, 4)));
        uint256 base = _base(ID, otherKernel);
        vm.record();
        vm.prank(otherKernel);
        policy.onInstall(full);
        (, bytes32[] memory writes) = vm.accesses(address(policy));
        // every written slot is either in the Config struct or `installedCount[otherKernel]`
        bytes32 countSlot = keccak256(abi.encode(otherKernel, uint256(1)));
        uint256 maxOffset;
        bool wroteCount;
        for (uint256 i; i < writes.length; ++i) {
            if (writes[i] == countSlot) {
                wroteCount = true;
                continue;
            }
            uint256 slot = uint256(writes[i]);
            assertTrue(slot >= base && slot < base + 128, "install wrote outside the Config struct");
            if (slot - base > maxOffset) maxOffset = slot - base;
        }
        assertTrue(wroteCount);
        // the highest slot of a full config is `CONFIG_SLOTS - 1`: 8 rules x (1 + 4 x 2) + 1 header = 73 slots
        assertEq(maxOffset, policy.CONFIG_SLOTS() - 1, "slot count documented in NatSpec");
        assertEq(uint8(uint256(vm.load(address(policy), bytes32(base)))), 1, "status in the header slot");

        BootrCallPolicy.Rule[] memory stored = policy.rulesOf(ID, otherKernel);
        assertEq(stored.length, 8);
        assertEq(stored[7].args.length, 4);
        assertEq(stored[7].args[3].value, bytes32(uint256(7)));
        // rule 7: transfer(address(8), <= 7)
        vm.prank(otherKernel);
        assertEq(policy.checkUserOpPolicy(ID, _op(_single(usdc, 0, _transfer(address(8), 7)))), 0);
        vm.prank(otherKernel);
        assertEq(policy.checkUserOpPolicy(ID, _op(_single(usdc, 0, _transfer(address(8), 8)))), 1);
        vm.prank(otherKernel);
        assertEq(policy.checkUserOpPolicy(ID, _op(_single(usdc, 0, _transfer(address(9), 0)))), 1);

        // uninstall clears every slot of the struct and the count
        vm.prank(otherKernel);
        policy.onUninstall(abi.encodePacked(ID));
        for (uint256 n; n < 128; ++n) {
            assertEq(vm.load(address(policy), bytes32(base + n)), bytes32(0), "slot not cleared");
        }
        assertEq(policy.installedCount(otherKernel), 0);
        assertEq(policy.rulesOf(ID, otherKernel).length, 0);
    }

    /// @dev Asserts the ERC-7562 property: during `checkUserOpPolicy` every storage slot read or written lies in
    ///      `[base, base + 128)` with `base = keccak256(kernel ‖ keccak256(id ‖ slot))` (writes happen only for
    ///      `SUM_PER_WINDOW` accounting; ERC-7562 allows writes to the sender's associated storage).
    function _assertAssociatedAccess(address k, bytes32 id, bytes memory callData, bytes memory slotSig, uint256 expected, bool expectWrites)
        internal
    {
        uint256 base = _base(id, k);
        PackedUserOperation memory op = _op(callData);
        op.signature = slotSig;
        vm.record();
        vm.prank(k);
        uint256 res = policy.checkUserOpPolicy(id, op);
        assertEq(res, expected);
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(policy));
        assertEq(writes.length > 0, expectWrites, "window accounting writes exactly when spending");
        assertGt(reads.length, 0, "the config was read");
        for (uint256 i; i < reads.length; ++i) {
            uint256 slot = uint256(reads[i]);
            assertTrue(slot >= base && slot < base + 128, "read outside the sender's associated storage");
        }
        for (uint256 i; i < writes.length; ++i) {
            uint256 slot = uint256(writes[i]);
            assertTrue(slot >= base && slot < base + 128, "write outside the sender's associated storage");
        }
    }

    function _assertAssociatedReads(address k, bytes32 id, bytes memory callData, uint256 expected) internal {
        _assertAssociatedAccess(k, id, callData, "", expected, false);
    }

    function test_validationTouchesOnlyAssociatedStorage() public {
        // windowed spend: reads + writes, all inside the struct
        _assertAssociatedAccess(kernel, WIN_ID, _single(usdc, 0, _transfer(payTo, 1e6)), abi.encode(T0), _packed(T0, T0 + WINDOW), true);
        // a non-spending op on the windowed permission writes nothing
        _assertAssociatedAccess(kernel, WIN_ID, _single(feeLocker, 0, abi.encodeCall(IFeeLockerClaim.claim, (kernel, weth))), abi.encode(T0), 0, false);
        _assertAssociatedAccess(kernel, WIN_ID, _single(usdc, 0, _transfer(payTo, 0)), abi.encode(T0), 0, false);
        // a rejected spend writes nothing either
        _assertAssociatedAccess(kernel, WIN_ID, _single(usdc, 0, _transfer(payTo, CAP)), abi.encode(T0), 1, false);
    }

    // ------------------------------------------------------------------
    // SUM_PER_WINDOW
    // ------------------------------------------------------------------

    function test_windowAccumulatesAndReturnsBounds() public {
        bytes memory spend30 = _single(usdc, 0, _transfer(payTo, 30e6));
        assertEq(_checkWin(spend30, T0 + 1), _packed(T0, T0 + WINDOW));
        (uint48 windowEnd, uint128 spent) = _window();
        assertEq(windowEnd, T0 + WINDOW);
        assertEq(spent, 30e6);
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, 20e6)), T0 + 2), _packed(T0, T0 + WINDOW));
        (, spent) = _window();
        assertEq(spent, CAP);
        // exhausted: even 1 fails, state untouched
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, 1)), T0 + 3), 1);
        (, spent) = _window();
        assertEq(spent, CAP);
        // zero spends never touch the window and carry no bound
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, 0)), T0 + 3), 0);
        // per-call bound still applies before any accounting (a single call over the cap)
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, CAP + 1)), T0 + WINDOW + 1), 1);
    }

    function test_windowRollsToTheGridWindowContainingTheClaimedTime() public {
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, CAP)), T0), _packed(T0, T0 + WINDOW));
        // claiming a time inside the window does not roll; claiming the past neither
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, 1)), T0 + WINDOW - 1), 1);
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, 1)), 0), 1);
        // the next window: budget back, bounds = that window
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, 10e6)), T0 + WINDOW), _packed(T0 + WINDOW, T0 + 2 * WINDOW));
        (uint48 windowEnd, uint128 spent) = _window();
        assertEq(windowEnd, T0 + 2 * WINDOW);
        assertEq(spent, 10e6);
        // a long idle gap: the grid jumps straight to the window containing `now` (no catch-up burst)
        uint256 later = T0 + 7 * WINDOW + 123;
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, CAP)), later), _packed(T0 + 7 * WINDOW, T0 + 8 * WINDOW));
        (windowEnd, spent) = _window();
        assertEq(windowEnd, T0 + 8 * WINDOW);
        assertEq(spent, CAP);
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, 1)), later), 1);
        // a claimed time at the exact window end belongs to the next window
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, 1)), T0 + 8 * WINDOW), _packed(T0 + 8 * WINDOW, T0 + 9 * WINDOW));
        // an absurd claim that would overflow uint48 fails instead of corrupting the grid
        assertEq(_checkWin(_single(usdc, 0, _transfer(payTo, 1)), type(uint256).max), 1);
        (windowEnd,) = _window();
        assertEq(windowEnd, T0 + 9 * WINDOW);
    }

    function test_windowWithoutTimeSlotKeepsTheCurrentWindow() public {
        PackedUserOperation memory op = _op(_single(usdc, 0, _transfer(payTo, 5e6)));
        vm.prank(kernel);
        assertEq(policy.checkUserOpPolicy(WIN_ID, op), _packed(T0, T0 + WINDOW));
        // a slot of the wrong length is ignored (treated as "no claim")
        op.signature = hex"1234";
        vm.prank(kernel);
        assertEq(policy.checkUserOpPolicy(WIN_ID, op), _packed(T0, T0 + WINDOW));
        (, uint128 spent) = _window();
        assertEq(spent, 10e6);
    }

    function test_windowBatchSumsCountOnce() public {
        Execution[] memory execs = new Execution[](3);
        execs[0] = Execution(usdc, 0, _transfer(payTo, 20e6));
        execs[1] = Execution(feeLocker, 0, abi.encodeCall(IFeeLockerClaim.claim, (kernel, weth)));
        execs[2] = Execution(usdc, 0, _transfer(payTo, 20e6));
        assertEq(_checkWin(_batch(execs), T0), _packed(T0, T0 + WINDOW));
        (, uint128 spent) = _window();
        assertEq(spent, 40e6);
        execs[0] = Execution(usdc, 0, _transfer(payTo, 5e6));
        execs[2] = Execution(usdc, 0, _transfer(payTo, 6e6));
        assertEq(_checkWin(_batch(execs), T0), 1, "batch over the remaining budget fails as a whole");
        (, spent) = _window();
        assertEq(spent, 40e6);
        execs[2] = Execution(usdc, 0, _transfer(payTo, 5e6));
        assertEq(_checkWin(_batch(execs), T0), _packed(T0, T0 + WINDOW));
        (, spent) = _window();
        assertEq(spent, CAP);
    }

    function test_windowStateClearedOnUninstall() public {
        _checkWin(_single(usdc, 0, _transfer(payTo, 5e6)), T0);
        vm.prank(kernel);
        policy.onUninstall(abi.encodePacked(WIN_ID));
        (uint48 windowEnd, uint128 spent,,) = policy.windowOf(WIN_ID, kernel, 0, 1);
        assertEq(windowEnd, 0);
        assertEq(spent, 0);
        uint256 base = _base(WIN_ID, kernel);
        for (uint256 n; n < 128; ++n) {
            assertEq(vm.load(address(policy), bytes32(base + n)), bytes32(0), "slot not cleared");
        }
    }

    /// @dev Invariant: whatever the sequence of spends and claimed times, `spent` never exceeds the cap, the window
    ///      end always sits on the install grid, and every accepted spend is bounded by its window.
    function test_fuzzWindowInvariants(uint64[8] calldata amounts, uint32[8] calldata offsets) public {
        uint256 claimed = T0;
        for (uint256 i; i < 8; ++i) {
            claimed += offsets[i];
            uint256 amount = uint256(amounts[i]) % (CAP + 2);
            uint256 res = _checkWin(_single(usdc, 0, _transfer(payTo, amount)), claimed);
            (uint48 windowEnd, uint128 spent) = _window();
            assertLe(spent, CAP, "spent over cap");
            assertEq((uint256(windowEnd) - T0) % WINDOW, 0, "window off the grid");
            if (res != 1 && amount > 0) {
                uint256 validAfter = res >> 208;
                uint256 validUntil = (res >> 160) & type(uint48).max;
                assertEq(validUntil, windowEnd);
                assertEq(validAfter, windowEnd - WINDOW);
                assertTrue(claimed >= validAfter && claimed < validUntil, "accepted spend outside its window");
            }
        }
    }

    function test_validationReadsOnlyAssociatedStorage() public {
        // allowed single call that scans all four rules' headers and the matching rule's args
        _assertAssociatedReads(kernel, ID, _single(weth, 0, _transfer(universalRouter, 1)), 0);
        // rejected call: every rule header is read, no match
        _assertAssociatedReads(kernel, ID, _single(usdc, 0, _transfer(creator, 1)), 1);
        // batch
        Execution[] memory execs = new Execution[](3);
        execs[0] = Execution(feeLocker, 0, abi.encodeCall(IFeeLockerClaim.claim, (kernel, weth)));
        execs[1] = Execution(weth, 0, _transfer(universalRouter, 1 ether));
        execs[2] = Execution(usdc, 0, _transfer(payTo, CAP));
        _assertAssociatedReads(kernel, ID, _batch(execs), 0);
        // a full config (8 rules x 4 args) on another kernel: worst-case scan of every slot
        vm.prank(otherKernel);
        policy.onInstall(abi.encodePacked(OTHER_ID, abi.encode(_manyRules(8, 4))));
        _assertAssociatedReads(otherKernel, OTHER_ID, _single(usdc, 0, _transfer(address(8), 7)), 0);
        _assertAssociatedReads(otherKernel, OTHER_ID, _single(usdc, 0, _transfer(address(9), 7)), 1);
        // not-installed revert path reads only the header slot of the (foreign) id
        uint256 base = _base(OTHER_ID, kernel);
        vm.record();
        vm.prank(kernel);
        vm.expectRevert(abi.encodeWithSelector(BootrCallPolicy.NotInstalled.selector, OTHER_ID, kernel));
        policy.checkUserOpPolicy(OTHER_ID, _op(_single(usdc, 0, _transfer(payTo, 1))));
        (bytes32[] memory reads,) = vm.accesses(address(policy));
        assertEq(reads.length, 1);
        assertEq(uint256(reads[0]), base);
    }
}
