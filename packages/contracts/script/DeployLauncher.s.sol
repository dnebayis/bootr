// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {AgentGuardian} from "../src/AgentGuardian.sol";
import {BootrLauncher} from "../src/BootrLauncher.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Redeploys only BootrLauncher against the existing guardian and burner implementation, copying
///         the live presets and minPlatformBps from the old launcher, then re-points the guardian at the
///         new launcher and pauses the old one. Used when the launcher gains a feature (e.g. the launch fee)
///         while agents, kernels and the guardian stay where they are.
///
/// env:
///   PRIVATE_KEY         deployer (pays for the new launcher)
///   ADMIN_PRIVATE_KEY   owner of guardian + old launcher (setLauncher, pause); also receives ownership
///   OLD_LAUNCHER        current BootrLauncher (presets + minPlatformBps are copied from it)
///   LAUNCH_FEE_WEI      optional initial launch fee (default 0; the console can change it later)
///   ERC8004_IDENTITY    optional override, as in Deploy.s.sol
contract DeployLauncher is Deploy {
    function run() external override {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 adminPk = vm.envUint("ADMIN_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.addr(adminPk);
        BootrLauncher old = BootrLauncher(vm.envAddress("OLD_LAUNCHER"));
        uint256 launchFee = vm.envOr("LAUNCH_FEE_WEI", uint256(0));

        AgentGuardian guardian = old.guardian();
        require(guardian.owner() == admin, "ADMIN_PRIVATE_KEY is not the guardian owner");
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
        guardian.setLauncher(address(launcher));
        if (!old.paused()) old.pause();
        vm.stopBroadcast();

        require(launcher.owner() == admin, "ownership");
        require(guardian.launcher() == address(launcher), "guardian.launcher");
        require(address(launcher.guardian()) == address(guardian), "launcher.guardian");

        console2.log("BootrLauncher (new):", address(launcher));
        console2.log("BootrLauncher (old, paused):", address(old));
        console2.log("launchFeeWei:", launcher.launchFeeWei());
        console2.log("deploy block:", block.number);
    }

    function _presets(BootrLauncher old)
        internal
        view
        returns (BootrLauncher.LaunchDefaults memory standard, BootrLauncher.LaunchDefaults memory buyback)
    {
        (uint24 lp, uint16 a, uint16 cr, uint16 b, uint16 pl, address r, uint256 f, uint32 d) = old.standardDefaults();
        standard = BootrLauncher.LaunchDefaults({
            lpFeeBps: lp,
            agentBps: a,
            creatorBps: cr,
            burnBps: b,
            platformBps: pl,
            platformRecipient: r,
            minFuelUsdc: f,
            dormancyPeriod: d
        });
        (lp, a, cr, b, pl, r, f, d) = old.buybackDefaults();
        buyback = BootrLauncher.LaunchDefaults({
            lpFeeBps: lp,
            agentBps: a,
            creatorBps: cr,
            burnBps: b,
            platformBps: pl,
            platformRecipient: r,
            minFuelUsdc: f,
            dormancyPeriod: d
        });
    }
}
