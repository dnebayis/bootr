// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {BootrCallPolicy} from "../src/BootrCallPolicy.sol";

/// @notice Deploys BootrCallPolicy (stateless allow-list policy module for Kernel v3.1 session
///         permissions). No constructor arguments, no owner, nothing to wire: paste the address
///         into `packages/shared/src/addresses.ts` (`bootr.callPolicy`) for the chain.
///
/// Env:
///   PRIVATE_KEY   deployer key (broadcaster)
contract DeployCallPolicy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        BootrCallPolicy policy = new BootrCallPolicy();
        vm.stopBroadcast();

        console2.log("chainId            ", block.chainid);
        console2.log("BootrCallPolicy    ", address(policy));
    }
}
