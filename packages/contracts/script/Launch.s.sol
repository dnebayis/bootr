// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BootrLauncher} from "../src/BootrLauncher.sol";

/// @notice Example launch of a test agent from a creator key.
///
/// Env:
///   CREATOR_PRIVATE_KEY   creator key (pays USDC fuel + optional dev buy)
///   LAUNCHER              BootrLauncher address
///   AGENT_NAME / AGENT_SYMBOL / AGENT_IMAGE / AGENT_URI / AGENT_MODEL
///   FUEL_USDC             6-decimals (default 0)
///   DEV_BUY_WEI           default 0
///   BUYBACK               default false
///   SALT                  bytes32, default keccak(name, timestamp)
///   AGENT_CONTEXT         Clanker token context JSON (default {"interface":"Bootr","platform":"bootr.fun"})
///   AGENT_METADATA        Clanker token metadata JSON (description, socialMediaUrls, auditUrls)
///   WORKER_HASH           bytes32, default 0
///   SUPERVISOR_KEY        optional session-key address (informational)
contract Launch is Script {
    function run() external {
        uint256 pk = vm.envUint("CREATOR_PRIVATE_KEY");
        BootrLauncher launcher = BootrLauncher(vm.envAddress("LAUNCHER"));
        string memory name = vm.envOr("AGENT_NAME", string("Bootr Test Agent"));
        string memory symbol = vm.envOr("AGENT_SYMBOL", string("BOOTR"));
        uint256 fuel = vm.envOr("FUEL_USDC", uint256(0));
        uint256 devBuy = vm.envOr("DEV_BUY_WEI", uint256(0));
        bool buyback = vm.envOr("BUYBACK", false);
        bytes32 salt = vm.envOr("SALT", keccak256(abi.encode(name, block.timestamp)));

        BootrLauncher.LaunchParams memory p = BootrLauncher.LaunchParams({
            name: name,
            symbol: symbol,
            image: vm.envOr("AGENT_IMAGE", string("")),
            metadata: vm.envOr("AGENT_METADATA", string("{}")),
            // the supervisor decodes `tokenContext` as `{"interface":"Bootr","platform":"bootr.fun","id":"<uuid>"}`
            context: vm.envOr("AGENT_CONTEXT", string('{"interface":"Bootr","platform":"bootr.fun"}')),
            salt: salt,
            buybackBurn: buyback,
            fuelUsdc: fuel,
            devBuyWei: devBuy,
            workerHash: vm.envOr("WORKER_HASH", bytes32(0)),
            model: vm.envOr("AGENT_MODEL", string("claude-sonnet-4-5")),
            agentURI: vm.envOr("AGENT_URI", string("https://bootr.fun/agents/test.json")),
            supervisorSessionKey: vm.envOr("SUPERVISOR_KEY", address(0))
        });

        vm.startBroadcast(pk);
        if (fuel > 0) {
            launcher.usdc().approve(address(launcher), fuel);
        }
        (address token, address kernel, address burner, uint256 agentId) = launcher.launch{value: devBuy}(p);
        vm.stopBroadcast();

        console2.log("token  ", token);
        console2.log("kernel ", kernel);
        console2.log("burner ", burner);
        console2.log("agentId", agentId);
    }
}
