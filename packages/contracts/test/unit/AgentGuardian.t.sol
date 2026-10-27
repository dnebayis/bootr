// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockKernel} from "../mocks/MockKernel.sol";

/// @dev No-fork unit tests for AgentGuardian using a MockKernel that mirrors Kernel v3.1's
///      root-path semantics (hook preCheck/postCheck around `onlyEntryPointOrSelfOrRoot`).
contract AgentGuardianTest is Test {
    AgentGuardian guardian;
    MockKernel kernel;
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 token;

    address owner = makeAddr("owner");
    address launcher = makeAddr("launcher");
    address creator = makeAddr("creator");
    address treasury = makeAddr("treasury");
    address entryPoint = makeAddr("entryPoint");
    address attacker = makeAddr("attacker");

    uint32 constant DORMANCY = 90 days;

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        weth = new MockERC20("WETH", "WETH", 18);
        token = new MockERC20("AGENT", "AGENT", 18);
        guardian = new AgentGuardian(owner, entryPoint, address(usdc), address(weth));
        kernel = new MockKernel(address(guardian));
        vm.startPrank(owner);
        guardian.setLauncher(launcher);
        guardian.setPlatformTreasury(treasury);
        vm.stopPrank();
        // kernel installs the guardian (as Kernel.initialize would)
        vm.prank(address(kernel));
        guardian.onInstall("");
    }

    function _register() internal {
        vm.prank(launcher);
        guardian.registerAgent(address(kernel), address(token), creator, DORMANCY);
    }

    // ---------------- registration ----------------

    function test_registerOnlyLauncher() public {
        vm.expectRevert(AgentGuardian.NotLauncher.selector);
        guardian.registerAgent(address(kernel), address(token), creator, DORMANCY);
        vm.prank(owner);
        vm.expectRevert(AgentGuardian.NotLauncher.selector);
        guardian.registerAgent(address(kernel), address(token), creator, DORMANCY);
        _register();
        AgentGuardian.AgentInfo memory info = guardian.agentInfo(address(kernel));
        assertEq(info.token, address(token));
        assertEq(info.creator, creator);
        assertEq(info.lastActivity, vm.getBlockTimestamp());
        assertEq(info.dormancyPeriod, DORMANCY);
        assertFalse(info.paused);
        assertTrue(guardian.isRegistered(address(kernel)));
        assertTrue(guardian.isInitialized(address(kernel)));
    }

    function test_registerRejectsDuplicateAndBadRoot() public {
        _register();
        vm.prank(launcher);
        vm.expectRevert(AgentGuardian.AlreadyRegistered.selector);
        guardian.registerAgent(address(kernel), address(token), creator, DORMANCY);
        MockKernel other = new MockKernel(attacker); // root validator != guardian
        vm.prank(launcher);
        vm.expectRevert(AgentGuardian.GuardianNotRootValidator.selector);
        guardian.registerAgent(address(other), address(token), creator, DORMANCY);
        MockKernel fresh = new MockKernel(address(guardian));
        vm.prank(launcher);
        vm.expectRevert(AgentGuardian.InvalidDormancyPeriod.selector);
        guardian.registerAgent(address(fresh), address(token), creator, 0);
    }

    // ---------------- module surface ----------------

    function test_moduleTypesAndRootValidatorRejectsEverything() public {
        assertTrue(guardian.isModuleType(1));
        assertTrue(guardian.isModuleType(4));
        assertFalse(guardian.isModuleType(2));
        PackedUserOperation memory op;
        assertEq(guardian.validateUserOp(op, bytes32(0)), 1);
        _register();
        assertEq(kernel.simulateErc1271(attacker, keccak256("x")), bytes4(0xffffffff));
        assertEq(kernel.simulateEnableCheck(keccak256("x")), bytes4(0xffffffff));
        vm.prank(address(kernel));
        vm.expectRevert(AgentGuardian.CannotUninstall.selector);
        guardian.onUninstall("");
        // onInstall is idempotent (Kernel calls it twice at initialize)
        vm.prank(address(kernel));
        guardian.onInstall("");
    }

    // ---------------- hook: root path ----------------

    function test_directCallersCannotDriveKernel() public {
        _register();
        usdc.mint(address(kernel), 100e6);
        bytes memory data = KernelLib.encodeSingle(address(usdc), 0, abi.encodeCall(IERC20.transfer, (attacker, 100e6)));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(AgentGuardian.UnauthorizedCaller.selector, attacker));
        kernel.execute(KernelLib.EXEC_MODE_SINGLE, data);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentGuardian.UnauthorizedCaller.selector, creator));
        kernel.execute(KernelLib.EXEC_MODE_SINGLE, data);
        // even the guardian owner cannot: no root call is in flight
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentGuardian.UnauthorizedCaller.selector, owner));
        kernel.execute(KernelLib.EXEC_MODE_SINGLE, data);
        // a spoofed root call (sender == guardian) is rejected while no root call is in flight
        vm.prank(address(kernel));
        vm.expectRevert(AgentGuardian.NotRootCall.selector);
        guardian.preCheck(address(guardian), 0, "");
        assertEq(usdc.balanceOf(address(kernel)), 100e6);
    }

    function test_preCheckRevertsForUnregisteredKernel() public {
        vm.prank(attacker);
        vm.expectRevert(AgentGuardian.NotRegistered.selector);
        kernel.execute(KernelLib.EXEC_MODE_SINGLE, KernelLib.encodeSingle(address(usdc), 0, ""));
    }

    // ---------------- hook: session path ----------------

    function test_sessionPathUpdatesActivityAndRespectsPause() public {
        _register();
        uint256 t0 = vm.getBlockTimestamp(); // via_ir can re-materialize block.timestamp across vm.warp
        vm.warp(t0 + 10 days);
        kernel.simulateUserOp(entryPoint);
        assertEq(guardian.agentInfo(address(kernel)).lastActivity, t0 + 10 days);
        assertEq(guardian.dormantAt(address(kernel)), t0 + 10 days + DORMANCY);

        vm.prank(attacker);
        vm.expectRevert(AgentGuardian.NotCreator.selector);
        guardian.pauseAgent(address(kernel));
        vm.prank(creator);
        guardian.pauseAgent(address(kernel));
        assertTrue(guardian.agentInfo(address(kernel)).paused);
        vm.warp(t0 + 20 days);
        vm.expectRevert(AgentGuardian.AgentIsPaused.selector);
        kernel.simulateUserOp(entryPoint);
        // pause does not reset activity and does not move funds
        assertEq(guardian.agentInfo(address(kernel)).lastActivity, t0 + 10 days);
        vm.prank(creator);
        guardian.unpauseAgent(address(kernel));
        kernel.simulateUserOp(entryPoint);
        assertEq(guardian.agentInfo(address(kernel)).lastActivity, t0 + 20 days);
    }

    // ---------------- dormancy ----------------

    function test_claimDormantTimingAndAmounts() public {
        _register();
        usdc.mint(address(kernel), 500e6);
        weth.mint(address(kernel), 2 ether);
        token.mint(address(kernel), 1_000_000e18);
        vm.deal(address(kernel), 1 ether);

        vm.prank(attacker);
        vm.expectRevert();
        guardian.claimDormant(address(kernel), new address[](0));

        uint256 dormantAfter = guardian.dormantAt(address(kernel));
        assertEq(dormantAfter, uint256(guardian.agentInfo(address(kernel)).lastActivity) + DORMANCY);
        vm.warp(dormantAfter - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentGuardian.NotDormant.selector, dormantAfter));
        guardian.claimDormant(address(kernel), new address[](0));

        vm.warp(dormantAfter);
        assertTrue(guardian.isDormant(address(kernel)));
        vm.prank(owner);
        (uint256 u, uint256 w, uint256 e, uint256 b) = guardian.claimDormant(address(kernel), new address[](0));
        assertEq(u, 500e6);
        assertEq(w, 2 ether);
        assertEq(e, 1 ether);
        assertEq(b, 1_000_000e18);
        assertEq(usdc.balanceOf(treasury), 500e6);
        assertEq(weth.balanceOf(treasury), 2 ether);
        assertEq(treasury.balance, 1 ether);
        assertEq(token.balanceOf(guardian.DEAD()), 1_000_000e18);
        assertEq(usdc.balanceOf(address(kernel)), 0);
        assertEq(token.balanceOf(address(kernel)), 0);
        assertEq(address(kernel).balance, 0);
        // paused agents can still be swept (pause never protects a dormant treasury)
        vm.prank(creator);
        guardian.pauseAgent(address(kernel));
        usdc.mint(address(kernel), 1e6);
        vm.prank(owner);
        guardian.claimDormant(address(kernel), new address[](0));
        assertEq(usdc.balanceOf(treasury), 501e6);
    }

    function test_claimDormantSweepsExtraTokensAndToleratesFailures() public {
        _register();
        MockERC20 airdrop = new MockERC20("AIR", "AIR", 18);
        MockERC20 other = new MockERC20("OTH", "OTH", 6);
        airdrop.mint(address(kernel), 123e18);
        other.mint(address(kernel), 7e6);
        usdc.mint(address(kernel), 5e6);
        vm.deal(address(kernel), 0.5 ether);
        RevertingReceiver badTreasury = new RevertingReceiver();
        vm.prank(owner);
        guardian.setPlatformTreasury(address(badTreasury));
        vm.warp(guardian.dormantAt(address(kernel)));

        address[] memory extras = new address[](4);
        extras[0] = address(airdrop);
        extras[1] = address(other);
        extras[2] = address(usdc); // duplicate of a core asset: balance already 0 -> skipped
        extras[3] = address(new RevertingToken()); // a token that reverts: try-mode, must not block
        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(guardian));
        emit AgentGuardian.DormantExtraTokenSwept(address(kernel), address(airdrop), 123e18);
        (uint256 u,, uint256 e,) = guardian.claimDormant(address(kernel), extras);
        assertEq(u, 5e6);
        assertEq(e, 0.5 ether);
        assertEq(usdc.balanceOf(address(badTreasury)), 5e6, "core assets moved");
        assertEq(airdrop.balanceOf(address(badTreasury)), 123e18, "extra token swept");
        assertEq(other.balanceOf(address(badTreasury)), 7e6);
        assertEq(airdrop.balanceOf(address(kernel)), 0);
        // the ETH leg failed (treasury rejects ETH) without reverting the sweep; ETH stays on the kernel
        assertEq(address(kernel).balance, 0.5 ether, "ETH left behind, sweep not blocked");
        // once the treasury accepts ETH, a second call moves it
        vm.prank(owner);
        guardian.setPlatformTreasury(treasury);
        vm.prank(owner);
        guardian.claimDormant(address(kernel), new address[](0));
        assertEq(treasury.balance, 0.5 ether);
        assertEq(address(kernel).balance, 0);
    }

    function test_claimDormantRequiresTreasury() public {
        AgentGuardian g2 = new AgentGuardian(owner, entryPoint, address(usdc), address(weth));
        MockKernel k2 = new MockKernel(address(g2));
        vm.prank(address(k2));
        g2.onInstall("");
        vm.prank(owner);
        g2.setLauncher(launcher);
        vm.prank(launcher);
        g2.registerAgent(address(k2), address(token), creator, DORMANCY);
        vm.warp(vm.getBlockTimestamp() + DORMANCY);
        vm.prank(owner);
        vm.expectRevert(AgentGuardian.TreasuryNotSet.selector);
        g2.claimDormant(address(k2), new address[](0));
    }

    // ---------------- session keys ----------------

    function test_approveSessionKeyDigestAndEnableCheck() public {
        _register();
        bytes4 pid = bytes4(keccak256("perm"));
        bytes memory validatorData = abi.encode(new bytes[](0));
        vm.prank(attacker);
        vm.expectRevert();
        guardian.approveSessionKey(address(kernel), pid, validatorData);

        vm.prank(owner);
        (bytes32 digest, uint32 nonce) = guardian.approveSessionKey(address(kernel), pid, validatorData);
        assertEq(nonce, 1);
        assertTrue(guardian.approvedEnableDigests(address(kernel), digest));
        assertEq(guardian.enableDigest(address(kernel), pid, nonce, validatorData), digest);

        // manual reproduction of Kernel v3.1's `_enableDigest`
        bytes21 vId = bytes21(abi.encodePacked(bytes1(0x02), pid, bytes16(0)));
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Enable(bytes21 validationId,uint32 nonce,address hook,bytes validatorData,bytes hookData,bytes selectorData)"
                ),
                vId,
                nonce,
                address(guardian),
                keccak256(validatorData),
                keccak256(hex"00"),
                keccak256(abi.encodePacked(IKernel.execute.selector))
            )
        );
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Kernel"),
                keccak256("0.3.1"),
                block.chainid,
                address(kernel)
            )
        );
        assertEq(digest, keccak256(abi.encodePacked(hex"1901", ds, structHash)));

        // only the kernel asking about itself gets the magic value
        assertEq(kernel.simulateEnableCheck(digest), bytes4(0x1626ba7e));
        assertEq(kernel.simulateErc1271(attacker, digest), bytes4(0xffffffff));
        assertEq(kernel.simulateEnableCheck(keccak256("other")), bytes4(0xffffffff));

        // paused agents cannot enable session keys
        vm.prank(creator);
        guardian.pauseAgent(address(kernel));
        assertEq(kernel.simulateEnableCheck(digest), bytes4(0xffffffff));
        vm.prank(owner);
        vm.expectRevert(AgentGuardian.AgentIsPaused.selector);
        guardian.approveSessionKey(address(kernel), pid, validatorData);
        vm.prank(creator);
        guardian.unpauseAgent(address(kernel));

        vm.prank(owner);
        guardian.revokeSessionKeyApproval(address(kernel), digest);
        assertEq(kernel.simulateEnableCheck(digest), bytes4(0xffffffff));
    }

    function test_revokeSessionKeysViaRoot() public {
        _register();
        bytes4 pid = bytes4(keccak256("perm"));
        bytes21 vId = bytes21(abi.encodePacked(bytes1(0x02), pid, bytes16(0)));
        // approve, then revoke: the approval is withdrawn together with the uninstall (H-01 / BOOTR-07)
        vm.prank(owner);
        (bytes32 digest,) = guardian.approveSessionKey(address(kernel), pid, abi.encode(new bytes[](0)));
        assertEq(guardian.approvedDigestOf(address(kernel), vId), digest);
        assertTrue(guardian.approvedEnableDigests(address(kernel), digest));
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(guardian));
        emit AgentGuardian.SessionKeyApprovalRevoked(address(kernel), digest);
        guardian.revokeSessionKey(address(kernel), pid, abi.encode(new bytes[](1)));
        assertEq(kernel.lastUninstalled(), vId);
        assertFalse(guardian.approvedEnableDigests(address(kernel), digest), "approval consumed on uninstall");
        assertEq(guardian.approvedDigestOf(address(kernel), vId), bytes32(0));
        assertEq(kernel.simulateEnableCheck(digest), bytes4(0xffffffff), "cannot re-enable with the old digest");
        // revoking a never-approved permission is fine (no approval to withdraw)
        vm.prank(owner);
        guardian.revokeSessionKey(address(kernel), bytes4(keccak256("other")), abi.encode(new bytes[](1)));
        vm.prank(owner);
        uint32 n = guardian.revokeAllSessionKeys(address(kernel));
        assertEq(n, 2);
        assertEq(kernel.validNonceFrom(), 2);
        assertEq(kernel.currentNonce(), 2);
        // root calls never count as "activity"
        uint64 before = guardian.agentInfo(address(kernel)).lastActivity;
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(owner);
        guardian.revokeAllSessionKeys(address(kernel));
        assertEq(guardian.agentInfo(address(kernel)).lastActivity, before);
    }

    function test_revokeAllSessionKeysBatch() public {
        _register();
        MockKernel k2 = new MockKernel(address(guardian));
        vm.prank(address(k2));
        guardian.onInstall("");
        vm.prank(launcher);
        guardian.registerAgent(address(k2), address(token), creator, DORMANCY);
        address[] memory kernels = new address[](2);
        kernels[0] = address(kernel);
        kernels[1] = address(k2);
        vm.prank(attacker);
        vm.expectRevert();
        guardian.revokeAllSessionKeysBatch(kernels);
        vm.prank(owner);
        vm.expectRevert(AgentGuardian.EmptyBatch.selector);
        guardian.revokeAllSessionKeysBatch(new address[](0));
        vm.prank(owner);
        uint32[] memory nonces = guardian.revokeAllSessionKeysBatch(kernels);
        assertEq(nonces.length, 2);
        assertEq(nonces[0], 2);
        assertEq(nonces[1], 2);
        assertEq(kernel.validNonceFrom(), 2);
        assertEq(k2.validNonceFrom(), 2);
        // an unregistered kernel in the batch reverts the whole batch
        kernels[1] = address(new MockKernel(address(guardian)));
        vm.prank(owner);
        vm.expectRevert(AgentGuardian.NotRegistered.selector);
        guardian.revokeAllSessionKeysBatch(kernels);
    }

    function test_adminSetters() public {
        vm.prank(attacker);
        vm.expectRevert();
        guardian.setLauncher(attacker);
        vm.startPrank(owner);
        vm.expectRevert(AgentGuardian.ZeroAddress.selector);
        guardian.setLauncher(address(0));
        vm.expectRevert(AgentGuardian.ZeroAddress.selector);
        guardian.setPlatformTreasury(address(0));
        vm.stopPrank();
    }
}

/// @dev A treasury that rejects ETH (BOOTR-04: must not brick the sweep).
contract RevertingReceiver {
    receive() external payable {
        revert("no eth");
    }
}

/// @dev An ERC-20 whose every call reverts (a broken airdrop token in `extraTokens`).
contract RevertingToken {
    function balanceOf(address) external pure returns (uint256) {
        return 1;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("broken token");
    }
}
