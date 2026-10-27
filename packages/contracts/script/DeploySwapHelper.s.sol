// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {BootrSwapHelper} from "../src/BootrSwapHelper.sol";

/// @notice Deploys BootrSwapHelper (immutable WETH -> USDC helper with a Chainlink floor) for the chain.
///         No owner, nothing to wire: paste the address into `packages/shared/src/addresses.ts`
///         (`bootr.swapHelper`), then rotate every agent's session key so the call policy allow-lists it.
///
/// Env:
///   PRIVATE_KEY      deployer key (broadcaster)
///   SWAP_POOL_FEE    Uniswap v3 fee tier of the WETH/USDC pool (default 500 = 0.05%)
///   ETH_USD_FEED     override of the Chainlink ETH/USD aggregator (defaults per chain below)
///   SWAP_ROUTER_02   override of the Uniswap SwapRouter02 (defaults per chain below)
contract DeploySwapHelper is Script {
    struct ChainDeps {
        address weth;
        address usdc;
        address swapRouter02;
        address ethUsdFeed;
    }

    function chainConfig() public view returns (ChainDeps memory c) {
        if (block.chainid == 84532) {
            c = ChainDeps({
                weth: 0x4200000000000000000000000000000000000006,
                usdc: 0x036CbD53842c5426634e7929541eC2318f3dCF7e,
                swapRouter02: 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4,
                ethUsdFeed: 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1
            });
        } else if (block.chainid == 8453) {
            // Base mainnet - verified on-chain 2026-10-27: SwapRouter02.factory() = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD,
            // WETH9() = 0x4200...0006 (Base docs "swapRouter"); feed description() = "ETH / USD", 8 decimals, live
            // (docs.chain.link Base). The WETH/USDC 0.05% pool is 0xd0b53D9277642d899DF5C87A3966A349A798F224.
            c = ChainDeps({
                weth: 0x4200000000000000000000000000000000000006,
                usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
                swapRouter02: 0x2626664c2603336E57B271c5C0b26F421741e481,
                ethUsdFeed: 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70
            });
        } else {
            revert("unsupported chain");
        }
        address feed = vm.envOr("ETH_USD_FEED", address(0));
        if (feed != address(0)) c.ethUsdFeed = feed;
        address router = vm.envOr("SWAP_ROUTER_02", address(0));
        if (router != address(0)) c.swapRouter02 = router;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint24 poolFee = uint24(vm.envOr("SWAP_POOL_FEE", uint256(500)));
        ChainDeps memory c = chainConfig();

        vm.startBroadcast(pk);
        BootrSwapHelper helper = new BootrSwapHelper(c.weth, c.usdc, c.swapRouter02, c.ethUsdFeed, poolFee);
        vm.stopBroadcast();

        console2.log("chainId            ", block.chainid);
        console2.log("BootrSwapHelper    ", address(helper));
        console2.log("pool fee           ", uint256(poolFee));
        console2.log("ETH/USD (8 dp)     ", helper.ethUsdPrice());
    }
}
