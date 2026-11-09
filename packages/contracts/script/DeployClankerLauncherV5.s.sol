// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {BootrClankerLauncher} from "../src/BootrClankerLauncher.sol";
import {BootrClankerLauncherV5} from "../src/BootrClankerLauncherV5.sol";
import {ClankerV5, IClankerV5Factory, IClankerV5Hook} from "../src/interfaces/IClankerV5.sol";

/// @notice The Clanker v5 path (docs/design/clanker-v5-migration.md section 8): deploys `BootrClankerLauncherV5`
///         against the live guardian, gate, identity registry and kernel factory read from the live v4 Clanker
///         launcher, with both presets, `minPlatformBps` and the launch fee copied from it and each preset's fee
///         replaced by the tax `TAX_BPS`, then hands ownership to PLATFORM_ADMIN.
///
///         The script never touches the gate: `gate.addLauncher(v5)` is the admin's own transaction, after the
///         read-back (until then every v5 launch reverts `NotLauncher`, the intended order). It reads the live v5
///         factory first and stops if Clanker's policy does not admit the tax or the quote.
///
/// Env:
///   PRIVATE_KEY             deployer (broadcaster)
///   PLATFORM_ADMIN          final owner of the launcher (default: deployer); the guardian owner on mainnet
///   OLD_CLANKER_LAUNCHER    live BootrClankerLauncher v4 (guardian, gate, identity, kernel factory, USDC, presets,
///                           minPlatformBps and the launch fee are copied from it)
///   TAX_BPS                 buy and sell tax in hundredths of a bip (default 15_000 = 1.5%; 10_000 to 30_000)
///   PLATFORM_TAX_BPS        tax of the platform's own coins (default 0 = the preset tax)
///   QUOTE_TOKEN             the pool's quote (default address(0) = native ETH; USDC is the other registered quote)
///   ANTI_SNIPE              Clanker's anti-snipe fee on new pools (default true)
///   LAUNCH_FEE_WEI          launch fee (default: OLD_CLANKER_LAUNCHER.launchFeeWei())
contract DeployClankerLauncherV5 is Script {
    // Clanker v5 on Base mainnet, verified sources on Sourcify and the live factory read on 2026-11-10
    // (docs/design/clanker-v5-migration.md section 1; packages/shared/src/addresses.ts `clankerV5`).
    address constant FACTORY = 0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0;
    address constant HOOK = 0x5E320eA6278107968C119942E57d876c5F922AcC;
    address constant FEE_ESCROW = 0x5dd237d1f716C65426CCd2FAe82B95109825FA61;

    function run() external {
        require(block.chainid == 8453, "Clanker v5 path: Base mainnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.envOr("PLATFORM_ADMIN", deployer);
        BootrClankerLauncher old = BootrClankerLauncher(vm.envAddress("OLD_CLANKER_LAUNCHER"));
        uint24 tax = uint24(vm.envOr("TAX_BPS", uint256(15_000)));
        uint24 platformTax = uint24(vm.envOr("PLATFORM_TAX_BPS", uint256(0)));
        address quote = vm.envOr("QUOTE_TOKEN", address(0));
        bool antiSnipe = vm.envOr("ANTI_SNIPE", true);
        uint256 launchFee = vm.envOr("LAUNCH_FEE_WEI", old.launchFeeWei());

        // the live v5 factory must admit what the launcher will send
        IClankerV5Factory factory = IClankerV5Factory(FACTORY);
        require(factory.hook() == HOOK, "factory.hook() moved");
        require(IClankerV5Hook(HOOK).feeEscrow() == FEE_ESCROW, "hook.feeEscrow() moved");
        require(factory.launchCreationEnabled(), "v5 launches are closed");
        (bool registered,,) = factory.quoteConfig(quote);
        require(registered, "quote token not registered on the v5 factory");
        ClankerV5.TaxPolicy memory policy = factory.taxPolicy();
        uint32 rate = uint32(tax) * 100;
        require(
            rate >= policy.taxFeeBounds.minimumBuyTaxRate && rate <= policy.taxFeeBounds.maximumBuyTaxRate
                && rate >= policy.taxFeeBounds.minimumSellTaxRate && rate <= policy.taxFeeBounds.maximumSellTaxRate,
            "TAX_BPS outside Clanker's bounds"
        );

        (BootrClankerLauncherV5.LaunchDefaults memory standard, BootrClankerLauncherV5.LaunchDefaults memory buyback) =
            _presets(old, tax);

        vm.startBroadcast(pk);
        BootrClankerLauncherV5 launcher = new BootrClankerLauncherV5(
            deployer,
            BootrClankerLauncherV5.Deps({
                factory: FACTORY,
                hook: HOOK,
                feeEscrow: FEE_ESCROW,
                quoteToken: quote,
                usdc: address(old.usdc()),
                identityRegistry: address(old.identityRegistry()),
                kernelFactory: address(old.kernelFactory()),
                guardian: address(old.guardian()),
                gate: address(old.gate())
            }),
            standard,
            buyback,
            old.minPlatformBps()
        );
        if (launchFee > 0) launcher.setLaunchFee(launchFee);
        if (platformTax > 0) launcher.setPlatformTaxBps(platformTax);
        if (!antiSnipe) launcher.setAntiSnipe(false);
        if (admin != deployer) launcher.transferOwnership(admin);
        vm.stopBroadcast();

        console2.log("chainId                 ", block.chainid);
        console2.log("BootrClankerLauncherV5  ", address(launcher));
        console2.log("BootrClankerLauncher v4 ", address(old));
        console2.log("gate                    ", address(old.gate()));
        console2.log("guardian                ", address(old.guardian()));
        console2.log("quoteToken              ", quote);
        console2.log("taxBps                  ", tax);
        console2.log("platformTaxBps          ", platformTax);
        console2.log("antiSnipe               ", antiSnipe);
        console2.log("launchFeeWei            ", launchFee);
        console2.log("pending owner           ", admin);
        console2.log("simulation block        ", block.number);
        console2.log("factory configVersion   ", factory.configVersion());
        if (admin != deployer) console2.log("NOTE: admin must call acceptOwnership() on the launcher");
        console2.log("NOTE: as the gate owner (the admin), after the read-back (launches revert NotLauncher until then):");
        console2.log("  cast send <gate> 'addLauncher(address)' <v5 launcher> --rpc-url base --private-key <admin>");
        console2.log("  then, if v4 is to stop: cast send <v4 launcher> 'pause()' --rpc-url base --private-key <admin>");
    }

    /// @dev Both presets of the live v4 Clanker launcher with the LP fee replaced by the tax; the same field
    ///      layout, declared in both contracts so each ABI stands alone.
    function _presets(BootrClankerLauncher old, uint24 tax)
        internal
        view
        returns (BootrClankerLauncherV5.LaunchDefaults memory standard, BootrClankerLauncherV5.LaunchDefaults memory buyback)
    {
        (, uint16 a, uint16 cr, uint16 b, uint16 pl, address r, uint256 f, uint32 d) = old.standardDefaults();
        standard = BootrClankerLauncherV5.LaunchDefaults({
            lpFeeBps: tax,
            agentBps: a,
            creatorBps: cr,
            burnBps: b,
            platformBps: pl,
            platformRecipient: r,
            minFuelUsdc: f,
            dormancyPeriod: d
        });
        (, a, cr, b, pl, r, f, d) = old.buybackDefaults();
        buyback = BootrClankerLauncherV5.LaunchDefaults({
            lpFeeBps: tax,
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
