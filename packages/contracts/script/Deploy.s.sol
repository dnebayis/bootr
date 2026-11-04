// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {AgentGuardian} from "../src/AgentGuardian.sol";
import {BootrLaunchGate} from "../src/BootrLaunchGate.sol";
import {BootrLauncher} from "../src/BootrLauncher.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";

/// @notice Deploys AgentGuardian, BootrLaunchGate, BuybackBurner implementation and BootrLauncher (v3.1), wires
///         them (`guardian.setLauncher(gate)`, `gate.addLauncher(launcher)`) and hands ownership to PLATFORM_ADMIN
///         (Ownable2Step: the admin must `acceptOwnership` on guardian, gate and launcher).
///
/// Env:
///   PRIVATE_KEY           deployer key (broadcaster)
///   PLATFORM_ADMIN        final owner of guardian + gate + launcher (default: deployer)
///   PLATFORM_RECIPIENT    LP-fee recipient for the platform share
///   PLATFORM_TREASURY     receiver of dormant sweeps (default: PLATFORM_RECIPIENT)
///   MIN_FUEL_USDC         6-decimals, default 0
///   DORMANCY_PERIOD       seconds, default 90 days
///   MIN_PLATFORM_BPS      default 1000
///   LP_FEE_BPS            1e6-based, default 10_000 (1%)
///   ERC8004_IDENTITY      optional override of the ERC-8004 identity registry
contract Deploy is Script {
    address constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    struct ChainDeps {
        address rwagmiLauncher; // RwagmiB20LauncherV3
        address rwagmiLocker; // RwagmiLpLockerV3
        address rwagmiHook; // RwagmiHookV3
        address rwagmiDevBuy; // RwagmiEthDevBuyV3
        address b20Factory; // Base B20Factory precompile
        address weth;
        address usdc;
        address identity;
        address kernelFactory;
        address universalRouter;
        address permit2;
    }

    function chainConfig() public view returns (ChainDeps memory c) {
        if (block.chainid == 84532) {
            // RWAGMI v3 has no Base Sepolia deployment (only the v2 single-pool launcher, with no launchable
            // pair). Launches are tested on a Base mainnet fork (`base-anvil`), see test/fork/BootrFork.t.sol.
            revert("RWAGMI v3 is not deployed on Base Sepolia");
        } else if (block.chainid == 8453) {
            // Base mainnet - verified on-chain 2026-10-27 (see packages/shared/src/addresses.ts for the sources and
            // test/fork/BootrFork.t.sol for the fork suite that launches through this exact configuration).
            c = ChainDeps({
                // RWAGMI v3 stack (docs/rwagmi-migration.md), verified on Basescan; launcher created at block 52,861,401
                rwagmiLauncher: 0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20,
                rwagmiLocker: 0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20,
                rwagmiHook: 0xB20B00367E37F826a0652c85a6DF375D784B20Ec,
                rwagmiDevBuy: 0xb20A2dCBC4AA42474072381aEb52CbFc5C751B20,
                b20Factory: 0xB20f000000000000000000000000000000000000,
                weth: 0x4200000000000000000000000000000000000006,
                usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
                // ERC-8004 IdentityRegistry, same address on every ERC-8004 mainnet (erc-8004-contracts README);
                // `name() == "AgentIdentity"`, ReputationRegistry.getIdentityRegistry() points at it.
                identity: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432,
                kernelFactory: 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419,
                universalRouter: 0x6fF5693b99212Da76ad316178A184AB56D299b43,
                permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3
            });
        } else {
            revert("unsupported chain");
        }
        address identityOverride = vm.envOr("ERC8004_IDENTITY", address(0));
        if (identityOverride != address(0)) c.identity = identityOverride;
        require(c.identity != address(0), "ERC8004_IDENTITY required");
    }

    function run() external virtual {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.envOr("PLATFORM_ADMIN", deployer);
        address platformRecipient = vm.envAddress("PLATFORM_RECIPIENT");
        address treasury = vm.envOr("PLATFORM_TREASURY", platformRecipient);
        uint256 minFuel = vm.envOr("MIN_FUEL_USDC", uint256(0));
        uint32 dormancy = uint32(vm.envOr("DORMANCY_PERIOD", uint256(90 days)));
        uint16 minPlatformBps = uint16(vm.envOr("MIN_PLATFORM_BPS", uint256(1000)));
        uint24 lpFee = uint24(vm.envOr("LP_FEE_BPS", uint256(10_000)));

        ChainDeps memory c = chainConfig();

        vm.startBroadcast(pk);
        AgentGuardian guardian = new AgentGuardian(deployer, ENTRY_POINT_V07, c.usdc, c.weth);
        BootrLaunchGate gate = new BootrLaunchGate(deployer, address(guardian));
        BuybackBurner burnerImpl = new BuybackBurner();
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
                burnerImplementation: address(burnerImpl),
                universalRouter: c.universalRouter,
                permit2: c.permit2
            }),
            BootrLauncher.LaunchDefaults({
                lpFeeBps: lpFee,
                agentBps: 500,
                creatorBps: 6500,
                burnBps: 0,
                platformBps: 3000,
                platformRecipient: platformRecipient,
                minFuelUsdc: minFuel,
                dormancyPeriod: dormancy
            }),
            BootrLauncher.LaunchDefaults({
                lpFeeBps: lpFee,
                agentBps: 500,
                creatorBps: 5000,
                burnBps: 1500,
                platformBps: 3000,
                platformRecipient: platformRecipient,
                minFuelUsdc: minFuel,
                dormancyPeriod: dormancy
            }),
            minPlatformBps
        );
        guardian.setLauncher(address(gate));
        gate.addLauncher(address(launcher));
        guardian.setPlatformTreasury(treasury);
        if (admin != deployer) {
            guardian.transferOwnership(admin);
            gate.transferOwnership(admin);
            launcher.transferOwnership(admin);
        }
        vm.stopBroadcast();

        console2.log("chainId            ", block.chainid);
        console2.log("AgentGuardian      ", address(guardian));
        console2.log("BootrLaunchGate    ", address(gate));
        console2.log("BuybackBurner impl ", address(burnerImpl));
        console2.log("BootrLauncher      ", address(launcher));
        console2.log("pending owner      ", admin);
        if (admin != deployer) console2.log("NOTE: admin must call acceptOwnership() on guardian, gate and launcher");
    }

    /// @dev Reads both presets of a live launcher (any launcher with BootrLauncher's `standardDefaults` /
    ///      `buybackDefaults` getters, BootrClankerLauncher included), for redeploys that copy them.
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
