// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {AgentGuardian} from "../src/AgentGuardian.sol";
import {BootrLaunchGate} from "../src/BootrLaunchGate.sol";
import {BootrLauncher} from "../src/BootrLauncher.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Redeploys only BootrLauncher (v3.1+, registering through the gate) against the existing guardian, gate
///         and burner implementation, copying the live presets and minPlatformBps from the old launcher, then
///         swaps the launcher in the gate's allowlist and pauses the old one. Used when the launcher gains a
///         feature while agents, kernels, the guardian and the gate stay where they are.
///
///         For the one-time move from v3 (registers on the guardian directly) to the gate, use
///         `DeployClankerLauncher.s.sol`, which deploys the gate too.
///
/// env:
///   PRIVATE_KEY         deployer (pays for the new launcher)
///   ADMIN_PRIVATE_KEY   owner of gate + old launcher (addLauncher / removeLauncher, pause); also receives ownership
///   OLD_LAUNCHER        current BootrLauncher (presets + minPlatformBps are copied from it)
///   GATE                BootrLaunchGate (default: OLD_LAUNCHER.gate(), which v3 does not have)
///   LAUNCH_FEE_WEI      optional initial launch fee (default: the old launcher's)
///   ERC8004_IDENTITY    optional override, as in Deploy.s.sol
contract DeployLauncher is Deploy {
    function run() external override {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 adminPk = vm.envUint("ADMIN_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.addr(adminPk);
        BootrLauncher old = BootrLauncher(vm.envAddress("OLD_LAUNCHER"));
        BootrLaunchGate gate = BootrLaunchGate(vm.envOr("GATE", address(old.gate())));
        uint256 launchFee = vm.envOr("LAUNCH_FEE_WEI", old.launchFeeWei());

        AgentGuardian guardian = old.guardian();
        require(address(gate.guardian()) == address(guardian), "GATE is not the launcher's guardian's gate");
        require(guardian.launcher() == address(gate), "guardian.launcher is not GATE");
        require(gate.owner() == admin, "ADMIN_PRIVATE_KEY is not the gate owner");
        require(old.owner() == admin, "ADMIN_PRIVATE_KEY is not the old launcher owner");

        ChainDeps memory c = chainConfig();
        (BootrLauncher.LaunchDefaults memory standard, BootrLauncher.LaunchDefaults memory buyback) = _presets(old);

        vm.startBroadcast(pk);
        BootrLauncher launcher = new BootrLauncher(
            deployer,
            BootrLauncher.Deps({
                rwagmiLauncher: c.rwagmiLauncher,
                rwagmiLocker: c.rwagmiLocker,
                rwagmiHook: c.rwagmiHook,
                rwagmiDevBuy: c.rwagmiDevBuy,
                b20Factory: c.b20Factory,
                weth: c.weth,
                usdc: c.usdc,
                identityRegistry: c.identity,
                kernelFactory: c.kernelFactory,
                guardian: address(guardian),
                gate: address(gate),
                burnerImplementation: old.burnerImplementation(),
                universalRouter: c.universalRouter,
                permit2: c.permit2
            }),
            standard,
            buyback,
            old.minPlatformBps()
        );
        if (launchFee > 0) launcher.setLaunchFee(launchFee);
        launcher.transferOwnership(admin);
        vm.stopBroadcast();

        vm.startBroadcast(adminPk);
        launcher.acceptOwnership();
        gate.addLauncher(address(launcher));
        if (gate.launchers(address(old))) gate.removeLauncher(address(old));
        if (!old.paused()) old.pause();
        vm.stopBroadcast();

        require(launcher.owner() == admin, "ownership");
        require(gate.launchers(address(launcher)), "gate.launchers(new)");
        require(address(launcher.guardian()) == address(guardian), "launcher.guardian");

        console2.log("BootrLauncher (new):", address(launcher));
        console2.log("BootrLauncher (old, paused):", address(old));
        console2.log("BootrLaunchGate:", address(gate));
        console2.log("launchFeeWei:", launcher.launchFeeWei());
        console2.log("deploy block:", block.number);
    }
}
