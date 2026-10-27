// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {AgentGuardian} from "../src/AgentGuardian.sol";
import {BootrLauncher} from "../src/BootrLauncher.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";

/// @notice Deploys AgentGuardian, BuybackBurner implementation and BootrLauncher, wires them and
///         hands ownership to PLATFORM_ADMIN (Ownable2Step: the admin must `acceptOwnership`).
///
/// Env:
///   PRIVATE_KEY           deployer key (broadcaster)
///   PLATFORM_ADMIN        final owner of guardian + launcher (default: deployer)
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
        address clanker;
        address feeLocker;
        address lpLockerFeeConversion;
        address hookStaticFeeV2;
        address devBuy;
        address mevBlockDelay;
        address weth;
        address usdc;
        address identity;
        address kernelFactory;
        address universalRouter;
        address permit2;
    }

    function chainConfig() public view returns (ChainDeps memory c) {
        if (block.chainid == 84532) {
            c = ChainDeps({
                clanker: 0xE85A59c628F7d27878ACeB4bf3b35733630083a9,
                feeLocker: 0x42A95190B4088C88Dd904d930c79deC1158bF09D,
                lpLockerFeeConversion: 0x824bB048a5EC6e06a09aEd115E9eEA4618DC2c8f,
                hookStaticFeeV2: 0x11b51DBC2f7F683b81CeDa83DC0078D57bA328cc,
                devBuy: 0x691f97752E91feAcD7933F32a1FEdCeDae7bB59c,
                mevBlockDelay: 0x71DB365E93e170ba3B053339A917c11024e7a9d4,
                weth: 0x4200000000000000000000000000000000000006,
                usdc: 0x036CbD53842c5426634e7929541eC2318f3dCF7e,
                identity: 0x8004A818BFB912233c491871b3d84c89A494BD9e,
                kernelFactory: 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419,
                universalRouter: 0x492E6456D9528771018DeB9E87ef7750EF184104,
                permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3
            });
        } else if (block.chainid == 8453) {
            // Base mainnet - verified on-chain 2026-10-27 (see packages/shared/src/addresses.ts for the sources and
            // test/fork/MainnetDryRun.t.sol for the fork dry-run that launches through this exact configuration).
            c = ChainDeps({
                clanker: 0xE85A59c628F7d27878ACeB4bf3b35733630083a9,
                feeLocker: 0xF3622742b1E446D92e45E22923Ef11C2fcD55D68,
                // NOT the README's 0x63D2...3496 (v4.0 locker; `enabledLockers(0x63D2, hookStaticFeeV2) == false` on
                // mainnet): the live ClankerLpLockerFeeConversion that clanker-sdk and every current launch use.
                lpLockerFeeConversion: 0xffA37784D619F228D8B379d287a4D7282e500762,
                hookStaticFeeV2: 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC,
                devBuy: 0x1331f0788F9c08C8F38D52c7a1152250A9dE00be,
                mevBlockDelay: 0xE143f9872A33c955F23cF442BB4B1EFB3A7402A2,
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
        BuybackBurner burnerImpl = new BuybackBurner();
        BootrLauncher launcher = new BootrLauncher(
            deployer,
            BootrLauncher.Deps({
                clanker: c.clanker,
                feeLocker: c.feeLocker,
                lpLocker: c.lpLockerFeeConversion,
                staticHook: c.hookStaticFeeV2,
                devBuyExtension: c.devBuy,
                mevModule: c.mevBlockDelay,
                weth: c.weth,
                usdc: c.usdc,
                identityRegistry: c.identity,
                kernelFactory: c.kernelFactory,
                guardian: address(guardian),
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
        guardian.setLauncher(address(launcher));
        guardian.setPlatformTreasury(treasury);
        if (admin != deployer) {
            guardian.transferOwnership(admin);
            launcher.transferOwnership(admin);
        }
        vm.stopBroadcast();

        console2.log("chainId            ", block.chainid);
        console2.log("AgentGuardian      ", address(guardian));
        console2.log("BuybackBurner impl ", address(burnerImpl));
        console2.log("BootrLauncher      ", address(launcher));
        console2.log("pending owner      ", admin);
        if (admin != deployer) console2.log("NOTE: admin must call acceptOwnership() on both contracts");
    }
}
