// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {BootrClankerLauncher} from "../src/BootrClankerLauncher.sol";
import {BootrClankerLauncherV5} from "../src/BootrClankerLauncherV5.sol";
import {ClankerV5, IClankerV5Factory, IClankerV5Hook} from "../src/interfaces/IClankerV5.sol";

interface IUniswapV3FactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @notice The Clanker v5 path with creator-set token settings (docs/design/clanker-v5-token-settings.md section 2,
///         docs/design/clanker-v5-migration.md section 8): deploys `BootrClankerLauncherV5` against the live
///         guardian, gate, identity registry and kernel factory read from the live v4 Clanker launcher, with
///         - the agent defaults: agent 5% and platform 30% of the post-Clanker pool (`AGENT_SHARE_BPS`,
///           `PLATFORM_SHARE_BPS`), each side's tax between 1% and 5% (`MIN_TAX_BPS`, `MAX_TAX_BPS`), up to five
///           creator rows (the creator's own and four extras), the platform recipient, minimum fuel and dormancy
///           period of the v4 launcher's standard preset;
///         - `minPlatformBps` and the launch fee copied from it;
///         - the paired-asset allow-list for agent coins: native ETH and Base USDC (the plain-token kind stays empty);
///         - the USDC dev-buy route through Uniswap v3 WETH/USDC 0.05%;
///         then hands ownership to PLATFORM_ADMIN.
///
///         The script never touches the gate: `gate.addLauncher(v5)` is the admin's own transaction, after the
///         read-back (until then every v5 launch reverts `NotLauncher`, the intended order). It reads the live v5
///         factory first and stops if Clanker's policy does not admit the tax bounds or a quote.
///
/// Env:
///   PRIVATE_KEY             deployer (broadcaster)
///   PLATFORM_ADMIN          final owner of the launcher (default: deployer); the guardian owner on mainnet
///   OLD_CLANKER_LAUNCHER    live BootrClankerLauncher v4 (guardian, gate, identity, kernel factory, USDC, the
///                           standard preset's recipient / fuel / dormancy, minPlatformBps and the launch fee)
///   AGENT_SHARE_BPS         default 500 (5%, the floor)
///   PLATFORM_SHARE_BPS      default 3000 (30%)
///   MIN_TAX_BPS / MAX_TAX_BPS  default 10_000 / 50_000 (1% / 5%, hundredths of a bip)
///   MAX_REWARD_ROWS         default 5
///   LAUNCH_FEE_WEI          launch fee (default: OLD_CLANKER_LAUNCHER.launchFeeWei())
contract DeployClankerLauncherV5 is Script {
    // Clanker v5 on Base mainnet, verified sources on Sourcify and the live factory read on 2026-11-10
    // (docs/design/clanker-v5-migration.md section 1; packages/shared/src/addresses.ts `clankerV5`).
    address constant FACTORY = 0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0;
    address constant HOOK = 0x5E320eA6278107968C119942E57d876c5F922AcC;
    address constant FEE_ESCROW = 0x5dd237d1f716C65426CCd2FAe82B95109825FA61;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant NATIVE = address(0);
    // Uniswap v3 on Base: the factory the launch-buy adapter accepts, and its WETH/USDC 0.05% pool (read live).
    address constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant WETH_USDC_500 = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    uint24 constant WETH_USDC_FEE = 500;

    function run() external {
        require(block.chainid == 8453, "Clanker v5 path: Base mainnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.envOr("PLATFORM_ADMIN", deployer);
        BootrClankerLauncher old = BootrClankerLauncher(vm.envAddress("OLD_CLANKER_LAUNCHER"));
        uint256 launchFee = vm.envOr("LAUNCH_FEE_WEI", old.launchFeeWei());
        BootrClankerLauncherV5.AgentDefaults memory d = _defaults(old);

        // the live v5 factory must admit what the launcher will send
        IClankerV5Factory factory = IClankerV5Factory(FACTORY);
        require(factory.hook() == HOOK, "factory.hook() moved");
        require(IClankerV5Hook(HOOK).feeEscrow() == FEE_ESCROW, "hook.feeEscrow() moved");
        require(factory.launchCreationEnabled(), "v5 launches are closed");
        (bool ethRegistered,,) = factory.quoteConfig(NATIVE);
        (bool usdcRegistered,,) = factory.quoteConfig(USDC);
        require(ethRegistered && usdcRegistered, "ETH or USDC not a registered v5 quote");
        ClankerV5.TaxFeeBounds memory b = factory.taxPolicy().taxFeeBounds;
        uint32 lo = uint32(d.minTaxBps) * 100;
        uint32 hi = uint32(d.maxTaxBps) * 100;
        require(
            lo >= b.minimumBuyTaxRate && hi <= b.maximumBuyTaxRate && lo >= b.minimumSellTaxRate
                && hi <= b.maximumSellTaxRate,
            "tax bounds outside Clanker's policy"
        );
        require(
            IUniswapV3FactoryLike(UNISWAP_V3_FACTORY).getPool(WETH, USDC, WETH_USDC_FEE) == WETH_USDC_500,
            "WETH/USDC 0.05% pool moved"
        );

        require(address(old.usdc()) == USDC, "v4 launcher's USDC is not Base USDC");

        vm.startBroadcast(pk);
        BootrClankerLauncherV5 launcher = new BootrClankerLauncherV5(
            deployer,
            BootrClankerLauncherV5.Deps({
                factory: FACTORY,
                hook: HOOK,
                feeEscrow: FEE_ESCROW,
                weth: WETH,
                usdc: address(old.usdc()),
                identityRegistry: address(old.identityRegistry()),
                kernelFactory: address(old.kernelFactory()),
                guardian: address(old.guardian()),
                gate: address(old.gate())
            }),
            d,
            old.minPlatformBps()
        );
        launcher.setQuoteAllowed(BootrClankerLauncherV5.LaunchKind.Agent, NATIVE, true);
        launcher.setQuoteAllowed(BootrClankerLauncherV5.LaunchKind.Agent, USDC, true);
        launcher.setDevBuyRoute(USDC, WETH_USDC_500, WETH_USDC_FEE);
        if (launchFee > 0) launcher.setLaunchFee(launchFee);
        if (admin != deployer) launcher.transferOwnership(admin);
        vm.stopBroadcast();

        console2.log("chainId                 ", block.chainid);
        console2.log("BootrClankerLauncherV5  ", address(launcher));
        console2.log("BootrClankerLauncher v4 ", address(old));
        console2.log("gate                    ", address(old.gate()));
        console2.log("guardian                ", address(old.guardian()));
        console2.log("agentShareBps           ", d.agentShareBps);
        console2.log("platformShareBps        ", d.platformShareBps);
        console2.log("platformRecipient       ", d.platformRecipient);
        console2.log("tax bounds (1e6 = 100%) ", d.minTaxBps, d.maxTaxBps);
        console2.log("maxRewardRows           ", d.maxRewardRows);
        console2.log("agent quotes            ", "native ETH, USDC");
        console2.log("launchFeeWei            ", launchFee);
        console2.log("pending owner           ", admin);
        console2.log("simulation block        ", block.number);
        console2.log("factory configVersion   ", factory.configVersion());
        if (admin != deployer) console2.log("NOTE: admin must call acceptOwnership() on the launcher");
        console2.log("NOTE: as the gate owner (the admin), after the read-back (launches revert NotLauncher until then):");
        console2.log("  cast send <gate> 'addLauncher(address)' <v5 launcher> --rpc-url base --private-key <admin>");
        console2.log("  then, if v4 is to stop: cast send <v4 launcher> 'pause()' --rpc-url base --private-key <admin>");
    }

    /// @dev The agent defaults: shares and tax bounds from the env (design note section 2.3 defaults), the
    ///      recipient, fuel minimum and dormancy period of the live v4 launcher's standard preset.
    function _defaults(BootrClankerLauncher old) internal view returns (BootrClankerLauncherV5.AgentDefaults memory) {
        (,,,,, address r, uint256 f, uint32 dormancy) = old.standardDefaults();
        return BootrClankerLauncherV5.AgentDefaults({
            agentShareBps: uint16(vm.envOr("AGENT_SHARE_BPS", uint256(500))),
            platformShareBps: uint16(vm.envOr("PLATFORM_SHARE_BPS", uint256(3000))),
            platformRecipient: r,
            minFuelUsdc: f,
            dormancyPeriod: dormancy,
            minTaxBps: uint24(vm.envOr("MIN_TAX_BPS", uint256(10_000))),
            maxTaxBps: uint24(vm.envOr("MAX_TAX_BPS", uint256(50_000))),
            maxRewardRows: uint8(vm.envOr("MAX_REWARD_ROWS", uint256(5)))
        });
    }
}
