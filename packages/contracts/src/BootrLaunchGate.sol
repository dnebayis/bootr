// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {AgentGuardian} from "./AgentGuardian.sol";

/// @title BootrLaunchGate
/// @notice `AgentGuardian.registerAgent` accepts exactly one caller (`guardian.launcher`). With two launchers
///         (`BootrLauncher` on RWAGMI, `BootrClankerLauncher` on Clanker) the guardian's `launcher` is this gate:
///         an owner-controlled allowlist of launchers that forwards `registerAgent` unchanged. The owner is the
///         platform admin (`Ownable2Step`). Nothing else lives here.
contract BootrLaunchGate is Ownable2Step {
    AgentGuardian public immutable guardian;

    mapping(address launcher => bool allowed) public launchers;

    event LauncherAdded(address indexed launcher);
    event LauncherRemoved(address indexed launcher);

    error ZeroAddress();
    error NotLauncher();
    error AlreadyAdded();
    error NotAdded();

    constructor(address owner_, address guardian_) Ownable(owner_) {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = AgentGuardian(guardian_);
    }

    function addLauncher(address launcher) external onlyOwner {
        if (launcher == address(0)) revert ZeroAddress();
        if (launchers[launcher]) revert AlreadyAdded();
        launchers[launcher] = true;
        emit LauncherAdded(launcher);
    }

    function removeLauncher(address launcher) external onlyOwner {
        if (!launchers[launcher]) revert NotAdded();
        launchers[launcher] = false;
        emit LauncherRemoved(launcher);
    }

    /// @notice Forwarded to `guardian.registerAgent` for allow-listed launchers only; the guardian keeps every
    ///         other check (zero addresses, dormancy, duplicate, root validator).
    function registerAgent(address kernel, address token, address creator, uint32 dormancyPeriod) external {
        if (!launchers[msg.sender]) revert NotLauncher();
        guardian.registerAgent(kernel, token, creator, dormancyPeriod);
    }
}
