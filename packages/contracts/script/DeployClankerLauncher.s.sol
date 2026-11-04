// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";

import {AgentGuardian} from "../src/AgentGuardian.sol";
import {BootrClankerLauncher} from "../src/BootrClankerLauncher.sol";
import {BootrLaunchGate} from "../src/BootrLaunchGate.sol";
import {BootrLauncher} from "../src/BootrLauncher.sol";
import {IClanker, IClankerMevDescendingFees} from "../src/interfaces/IClanker.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice The Clanker path (docs/design/clanker-launch.md, docs/deploy/mainnet.md "Clanker path"): deploys
///         `BootrLaunchGate`, `BootrLauncher` v3.1 (RWAGMI backend, registers through the gate) and
///         `BootrClankerLauncher` against the live guardian, copying presets / minPlatformBps / launch fee from the
///         live v3 launcher, allow-lists both launchers in the gate and hands ownership to PLATFORM_ADMIN.
///
///         `guardian.setLauncher(gate)` and `old.pause()` are the admin's own transactions: the script sends them
///         only when the broadcaster IS the guardian owner (e.g. a fork rehearsal); otherwise it prints the two
///         `cast send` lines. Until `guardian.launcher == gate`, neither new launcher can register an agent (every
///         launch reverts `NotLauncher`), which is the intended order: deploy, verify, then switch.
///
/// Env:
///   PRIVATE_KEY             deployer (broadcaster)
///   PLATFORM_ADMIN          final owner of gate + both launchers (default: deployer); the guardian owner on mainnet
///   OLD_LAUNCHER            live BootrLauncher v3 (guardian, burner implementation, presets, minPlatformBps copied)
///   LAUNCH_FEE_WEI          launch fee for both new launchers (default: OLD_LAUNCHER.launchFeeWei())
///   MEV_MODULE              Clanker MEV module (default ClankerSniperAuctionV2 0xebB2…; ClankerMevBlockDelay
///                           0xE143… takes empty data)
///   MEV_STARTING_FEE        sniper auction FeeConfig, 1e6-based (default 666_777 = clanker-sdk default)
///   MEV_ENDING_FEE          (default 41_673)
///   MEV_SECONDS_TO_DECAY    (default 15; hook max 120)
///   PLATFORM_LP_FEE_BPS     LP fee of the platform's own coins (default 0 = preset; 20_000 before $BOOTR)
///   ERC8004_IDENTITY        optional override, as in Deploy.s.sol
contract DeployClankerLauncher is Deploy {
    address constant SNIPER_AUCTION_V2 = 0xebB25BB797D82CB78E1bc70406b13233c0854413;
    address constant MEV_BLOCK_DELAY = 0xE143f9872A33c955F23cF442BB4B1EFB3A7402A2;

    struct ClankerDeps {
        address clanker; // Clanker v4.0.0 factory
        address feeLocker; // ClankerFeeLocker
        address lpLockerFeeConversion; // ClankerLpLockerFeeConversion (the one enabled for the V2 hooks)
        address hookStaticFeeV2; // ClankerHookStaticFeeV2
        address devBuy; // ClankerUniv4EthDevBuy
    }

    /// @dev Base mainnet, re-verified 2026-11-04 (docs/design/clanker-launch.md section 1; sources in
    ///      packages/shared/src/addresses.ts `clanker`). Allowlists are Clanker-controlled: read them the day of
    ///      the deploy (`test/fork/ClankerFork.t.sol::test_clankerAllowlistsOnFork`).
    function clankerConfig() public view returns (ClankerDeps memory c) {
        require(block.chainid == 8453, "Clanker path: Base mainnet only");
        c = ClankerDeps({
            clanker: 0xE85A59c628F7d27878ACeB4bf3b35733630083a9,
            feeLocker: 0xF3622742b1E446D92e45E22923Ef11C2fcD55D68,
            // NOT the README's 0x63D2DfEA… (not enabled): the live locker, clanker-sdk `related.locker`.
            lpLockerFeeConversion: 0xffA37784D619F228D8B379d287a4D7282e500762,
            hookStaticFeeV2: 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC,
            devBuy: 0x1331f0788F9c08C8F38D52c7a1152250A9dE00be
        });
    }

    /// @dev `MevModuleConfig` from the environment: the sniper auction's descending-fee config, or empty data
    ///      for ClankerMevBlockDelay.
    function mevConfig() public view returns (IClanker.MevModuleConfig memory m) {
        m.mevModule = vm.envOr("MEV_MODULE", SNIPER_AUCTION_V2);
        if (m.mevModule == MEV_BLOCK_DELAY) return m;
        m.mevModuleData = abi.encode(
            IClankerMevDescendingFees.FeeConfig({
                startingFee: uint24(vm.envOr("MEV_STARTING_FEE", uint256(666_777))),
                endingFee: uint24(vm.envOr("MEV_ENDING_FEE", uint256(41_673))),
                secondsToDecay: vm.envOr("MEV_SECONDS_TO_DECAY", uint256(15))
            })
        );
    }

    function run() external override {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.envOr("PLATFORM_ADMIN", deployer);
        BootrLauncher old = BootrLauncher(vm.envAddress("OLD_LAUNCHER"));
        uint256 launchFee = vm.envOr("LAUNCH_FEE_WEI", old.launchFeeWei());
        uint24 platformLpFee = uint24(vm.envOr("PLATFORM_LP_FEE_BPS", uint256(0)));

        AgentGuardian guardian = old.guardian();
        ChainDeps memory c = chainConfig();
        ClankerDeps memory k = clankerConfig();
        IClanker.MevModuleConfig memory mev = mevConfig();
        (BootrLauncher.LaunchDefaults memory standard, BootrLauncher.LaunchDefaults memory buyback) = _presets(old);

        vm.startBroadcast(pk);
        BootrLaunchGate gate = new BootrLaunchGate(deployer, address(guardian));
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
        BootrClankerLauncher clankerLauncher = new BootrClankerLauncher(
            deployer,
            BootrClankerLauncher.Deps({
                clanker: k.clanker,
                feeLocker: k.feeLocker,
                lpLocker: k.lpLockerFeeConversion,
                staticHook: k.hookStaticFeeV2,
                devBuyExtension: k.devBuy,
                weth: c.weth,
                usdc: c.usdc,
                identityRegistry: c.identity,
                kernelFactory: c.kernelFactory,
                guardian: address(guardian),
                gate: address(gate)
            }),
            mev,
            _asClanker(standard),
            _asClanker(buyback),
            old.minPlatformBps()
        );
        gate.addLauncher(address(launcher));
        gate.addLauncher(address(clankerLauncher));
        if (launchFee > 0) {
            launcher.setLaunchFee(launchFee);
            clankerLauncher.setLaunchFee(launchFee);
        }
        if (platformLpFee > 0) clankerLauncher.setPlatformLpFeeBps(platformLpFee);
        if (admin != deployer) {
            gate.transferOwnership(admin);
            launcher.transferOwnership(admin);
            clankerLauncher.transferOwnership(admin);
        }
        // the switch itself belongs to the guardian owner
        bool switched;
        if (guardian.owner() == deployer) {
            guardian.setLauncher(address(gate));
            switched = true;
        }
        if (old.owner() == deployer && !old.paused()) old.pause();
        vm.stopBroadcast();

        console2.log("chainId                 ", block.chainid);
        console2.log("AgentGuardian (live)    ", address(guardian));
        console2.log("BootrLaunchGate         ", address(gate));
        console2.log("BootrLauncher v3.1      ", address(launcher));
        console2.log("BootrClankerLauncher    ", address(clankerLauncher));
        console2.log("BootrLauncher v3 (old)  ", address(old));
        console2.log("mevModule               ", mev.mevModule);
        console2.log("launchFeeWei            ", launchFee);
        console2.log("platformLpFeeBps        ", platformLpFee);
        console2.log("pending owner           ", admin);
        console2.log("simulation block        ", block.number);
        if (admin != deployer) console2.log("NOTE: admin must call acceptOwnership() on gate and both launchers");
        if (!switched) {
            console2.log("NOTE: as the guardian owner, in this order (both launchers revert NotLauncher until then):");
            console2.log("  cast send <guardian> 'setLauncher(address)' <gate> --rpc-url base --private-key <admin>");
            console2.log("  cast send <old launcher> 'pause()' --rpc-url base --private-key <admin>");
        }
    }

    /// @dev Same field layout; `LaunchDefaults` is declared in both launchers so each ABI stands alone.
    function _asClanker(BootrLauncher.LaunchDefaults memory d)
        internal
        pure
        returns (BootrClankerLauncher.LaunchDefaults memory)
    {
        return BootrClankerLauncher.LaunchDefaults({
            lpFeeBps: d.lpFeeBps,
            agentBps: d.agentBps,
            creatorBps: d.creatorBps,
            burnBps: d.burnBps,
            platformBps: d.platformBps,
            platformRecipient: d.platformRecipient,
            minFuelUsdc: d.minFuelUsdc,
            dormancyPeriod: d.dormancyPeriod
        });
    }
}
