// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrLaunchGate} from "../../src/BootrLaunchGate.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockKernel} from "../mocks/MockKernel.sol";

/// @dev No-fork unit tests for the gate: allowlist, forwarding, events, ownership.
contract BootrLaunchGateTest is Test {
    AgentGuardian guardian;
    BootrLaunchGate gate;
    MockKernel kernel;
    MockERC20 token;

    address owner = makeAddr("owner");
    address launcherA = makeAddr("launcherA");
    address launcherB = makeAddr("launcherB");
    address creator = makeAddr("creator");
    address stranger = makeAddr("stranger");
    uint32 constant DORMANCY = 90 days;

    function setUp() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", 6);
        MockERC20 weth = new MockERC20("WETH", "WETH", 18);
        token = new MockERC20("AGENT", "AGENT", 18);
        guardian = new AgentGuardian(owner, makeAddr("entryPoint"), address(usdc), address(weth));
        gate = new BootrLaunchGate(owner, address(guardian));
        kernel = new MockKernel(address(guardian));
        vm.prank(owner);
        guardian.setLauncher(address(gate));
        vm.prank(address(kernel));
        guardian.onInstall("");
    }

    function test_constructorRejectsZeroGuardian() public {
        vm.expectRevert(BootrLaunchGate.ZeroAddress.selector);
        new BootrLaunchGate(owner, address(0));
        assertEq(address(gate.guardian()), address(guardian));
        assertEq(gate.owner(), owner);
    }

    function test_forwardsForAllowlistedLauncherOnly() public {
        // nobody is allow-listed yet: the gate rejects, the guardian is never reached
        vm.prank(launcherA);
        vm.expectRevert(BootrLaunchGate.NotLauncher.selector);
        gate.registerAgent(address(kernel), address(token), creator, DORMANCY);

        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit BootrLaunchGate.LauncherAdded(launcherA);
        gate.addLauncher(launcherA);
        assertTrue(gate.launchers(launcherA));
        assertFalse(gate.launchers(launcherB));

        vm.prank(launcherB);
        vm.expectRevert(BootrLaunchGate.NotLauncher.selector);
        gate.registerAgent(address(kernel), address(token), creator, DORMANCY);

        vm.prank(launcherA);
        vm.expectEmit(true, true, true, true);
        emit AgentGuardian.AgentRegistered(address(kernel), address(token), creator, DORMANCY);
        gate.registerAgent(address(kernel), address(token), creator, DORMANCY);
        AgentGuardian.AgentInfo memory info = guardian.agentInfo(address(kernel));
        assertEq(info.token, address(token));
        assertEq(info.creator, creator);
        assertEq(info.dormancyPeriod, DORMANCY);
    }

    function test_guardianChecksStillApplyThroughTheGate() public {
        vm.prank(owner);
        gate.addLauncher(launcherA);
        // the guardian's own validation is untouched (zero address, dormancy, duplicate, root validator)
        vm.startPrank(launcherA);
        vm.expectRevert(AgentGuardian.ZeroAddress.selector);
        gate.registerAgent(address(kernel), address(0), creator, DORMANCY);
        vm.expectRevert(AgentGuardian.InvalidDormancyPeriod.selector);
        gate.registerAgent(address(kernel), address(token), creator, 0);
        MockKernel foreign = new MockKernel(stranger);
        vm.expectRevert(AgentGuardian.GuardianNotRootValidator.selector);
        gate.registerAgent(address(foreign), address(token), creator, DORMANCY);
        gate.registerAgent(address(kernel), address(token), creator, DORMANCY);
        vm.expectRevert(AgentGuardian.AlreadyRegistered.selector);
        gate.registerAgent(address(kernel), address(token), creator, DORMANCY);
        vm.stopPrank();
        // and a launcher that bypasses the gate is rejected by the guardian itself
        MockKernel fresh = new MockKernel(address(guardian));
        vm.prank(launcherA);
        vm.expectRevert(AgentGuardian.NotLauncher.selector);
        guardian.registerAgent(address(fresh), address(token), creator, DORMANCY);
    }

    function test_removeLauncher() public {
        vm.startPrank(owner);
        gate.addLauncher(launcherA);
        gate.addLauncher(launcherB);
        vm.expectRevert(BootrLaunchGate.AlreadyAdded.selector);
        gate.addLauncher(launcherA);
        vm.expectEmit(true, false, false, true);
        emit BootrLaunchGate.LauncherRemoved(launcherA);
        gate.removeLauncher(launcherA);
        vm.expectRevert(BootrLaunchGate.NotAdded.selector);
        gate.removeLauncher(launcherA);
        vm.expectRevert(BootrLaunchGate.ZeroAddress.selector);
        gate.addLauncher(address(0));
        vm.stopPrank();
        assertFalse(gate.launchers(launcherA));
        assertTrue(gate.launchers(launcherB));
        vm.prank(launcherA);
        vm.expectRevert(BootrLaunchGate.NotLauncher.selector);
        gate.registerAgent(address(kernel), address(token), creator, DORMANCY);
        vm.prank(launcherB);
        gate.registerAgent(address(kernel), address(token), creator, DORMANCY);
        assertTrue(guardian.isRegistered(address(kernel)));
    }

    function test_onlyOwnerManagesTheAllowlist() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        gate.addLauncher(launcherA);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        gate.removeLauncher(launcherA);
        // two-step ownership
        vm.prank(owner);
        gate.transferOwnership(stranger);
        assertEq(gate.owner(), owner);
        assertEq(gate.pendingOwner(), stranger);
        vm.prank(stranger);
        gate.acceptOwnership();
        assertEq(gate.owner(), stranger);
    }
}
