# @bootr/contracts

Foundry project (Solidity 0.8.26, `via_ir`, `evm_version = cancun`) with the Bootr contracts: `BootrLauncher`,
`AgentGuardian`, `BuybackBurner`, `BootrCallPolicy` and `BootrSwapHelper`. What each does, the launch flow through
the RWAGMI v3 launcher, the fee path and the session-key design are in [`src/README.md`](src/README.md); the
design decision for the RWAGMI backend is [`docs/rwagmi-migration.md`](../../docs/rwagmi-migration.md).

Current Base mainnet deployment (source of truth: [`packages/shared/src/addresses.ts`](../shared/src/addresses.ts)):

| Contract | Address |
| --- | --- |
| `BootrLauncher` (RWAGMI v3, block 53219209) | `0xD3CE024ddC37465510E6c9a1D7942f003338B1F3` |
| `AgentGuardian` | `0x799Ab875294E37839883D12084aB4BE3f7633630` |
| `BuybackBurner` implementation | `0x7539bF645960Fc47556ECd449370BCc3A7D96Ed7` |
| `BootrCallPolicy` | `0x8586BdE0339b85bb9c0f0612954CCdF7fDCF9cE8` |
| `BootrSwapHelper` | `0x5723152f21ed7E305312fd90a2Bb94864BA9D80d` |

## Setup and build

```sh
pnpm --filter @bootr/contracts setup   # installs forge-std and OpenZeppelin v5.7.0 into lib/ (no git submodules)
pnpm --filter @bootr/contracts build   # forge build
```

## Tests

Launches go through the live RWAGMI v3 stack and Base's B20 precompiles, and RWAGMI has no Base Sepolia deployment.
The fork tests therefore run on a **Base mainnet fork** with `base-forge` (Base's Foundry fork, which ships the B20
precompiles); stock `forge` cannot launch a coin. From this directory:

```sh
BASE_RPC_URL=https://mainnet.base.org base-forge test              # everything
base-forge test --match-path 'test/unit/*'                          # unit tests, no RPC
base-forge test --match-path 'test/fork/*' -vv                      # launches, fee path, session keys, swap helper
base-forge test --match-path 'test/security/*' -vv                  # regression tests for the audit findings
```

`BASE_RPC_URL` falls back to `https://mainnet.base.org` in the fork tests (no archive state is needed); a CDP
Node URL avoids public rate limits. Actors in fork tests use namespaced `makeAddr("bootr.fork.*")` labels: generic
labels and `vm.addr(0xC0FFEE)` resolve to ETH-forwarding contracts on mainnet. Layout: `test/unit` (mocks, no fork),
`test/fork` (`BootrFork`, `SwapHelperFork`), `test/security` (`RevocationFork`, `WindowedCapFork`,
`SessionKeySignaturePath`, `GuardianArbitrarySessionPolicy`), `test/mocks`.

## Scripts

All scripts live in `script/` and read their configuration from the environment (headers document each variable;
`.env.mainnet.example` lists the mainnet values). Base mainnet only: `Deploy.s.sol` reverts on Base Sepolia.

| Script | Purpose |
| --- | --- |
| `Deploy.s.sol` | guardian + burner implementation + launcher, wires `setLauncher` / `setPlatformTreasury`, hands ownership to `PLATFORM_ADMIN` |
| `DeployLauncher.s.sol` | redeploys only the launcher against the live guardian (presets copied from `OLD_LAUNCHER`, optional `LAUNCH_FEE_WEI`), re-points the guardian, pauses the old launcher |
| `DeployCallPolicy.s.sol` | deploys `BootrCallPolicy` (stateless) |
| `DeploySwapHelper.s.sol` | deploys `BootrSwapHelper` (WETH/USDC pool fee `SWAP_POOL_FEE`, default 500) |
| `Launch.s.sol` | example launch from `CREATOR_PRIVATE_KEY` (the planned $BOOTR launch) |

Run them with `forge script ... --rpc-url base --broadcast` (the `base` RPC alias reads `BASE_RPC_URL` from
`foundry.toml`); the deployer key is exported for the command only. The step-by-step cutover and redeploy
procedures, with the read-back checks, are in [`docs/deploy/mainnet.md`](../../docs/deploy/mainnet.md).
TODO(verify): whether broadcasting with `base-forge script` instead of stock `forge script` is required or only
tested; the repository does not pin which binary the deploy used.
