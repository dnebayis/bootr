# @bootr/contracts

Foundry project (Solidity 0.8.26, `via_ir`, `evm_version = cancun`) with the Bootr contracts: `BootrLauncher`
(RWAGMI v3 path), `BootrClankerLauncher` (Clanker v4 path), `BootrClankerLauncherV5` (Clanker v5 path), `BootrLaunchGate`, `AgentGuardian`, `BuybackBurner`,
`BootrCallPolicy` and `BootrSwapHelper`. What each does, the launch flow through the RWAGMI v3 launcher, the fee path
and the session-key design are in [`src/README.md`](src/README.md); the design decisions are
[`docs/rwagmi-migration.md`](../../docs/rwagmi-migration.md) (RWAGMI backend) and
[`docs/design/clanker-launch.md`](../../docs/design/clanker-launch.md) (Clanker path, gate, v3.1) and
[`docs/design/clanker-v5-migration.md`](../../docs/design/clanker-v5-migration.md) (Clanker v5: a buy and sell tax
instead of the LP fee, three fee slots paid in native ETH through Clanker's `FeeEscrow`, Clanker's own burn share,
token addresses ending in `cccc` from a salt the web mines; the runbook is its section 8).

Current Base mainnet deployment (source of truth: [`packages/shared/src/addresses.ts`](../shared/src/addresses.ts)):

| Contract | Address |
| --- | --- |
| `BootrLauncher` (RWAGMI v3, block 53503025) | `0x62c038dA8A409ad1CD811df980A6F9867cd453fd` |
| `BootrLaunchGate` | `0x7ddaf2A1FC0861B288c7b0BDfA8314621C47c3a5` |
| `BootrClankerLauncher` (Clanker v4, block 53503025) | `0x387f1B0aC128D534E822c344D829645336BDAbbB` |
| `BootrClankerLauncherV5` (Clanker v5) | not deployed yet (`script/DeployClankerLauncherV5.s.sol`; the owner signs, then `gate.addLauncher`; design note section 8) |
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
labels and `vm.addr(0xC0FFEE)` resolve to ETH-forwarding contracts on mainnet. Layout: `test/unit` (mocks, no fork;
`BootrLaunchGate`, `ClankerLauncher` presets and admin surface included), `test/fork` (`BootrFork`, `SwapHelperFork`,
`ClankerFork`: launches through the live Clanker v4 factory, the fee path through its locker and fee locker, the
burn slot at `0xdEaD`, the gate, the day-of allowlist reads and the v3.1 launcher through the gate; stock `forge`
runs everything in it except the one v3.1 RWAGMI launch), `test/security` (`RevocationFork`, `WindowedCapFork`,
`SessionKeySignaturePath`, `GuardianArbitrarySessionPolicy`), `test/mocks`. Clanker v5: `test/unit/ClankerLauncherV5.t.sol`
(presets, slot weights, tax configuration, admin surface) and `test/fork/ClankerV5Fork.t.sol` (launches through the
live v5 factory with and without a dev buy, the live policy against the launcher's assumptions, the anti-snipe window,
the tax accruing in the escrow and `claimFor(kernel, 0x0)` landing native ETH on the kernel, the sell-side split of the
buyback preset to the wei, locked slots and metadata, an unmined salt reverting, the gate allowlist). Stock `forge` runs
it: `forge test --match-path 'test/fork/ClankerV5Fork.t.sol' -vv` (17 tests, about 40 s on the public RPC, 2026-11-10).

## Scripts

All scripts live in `script/` and read their configuration from the environment (headers document each variable;
`.env.mainnet.example` lists the mainnet values). Base mainnet only: `Deploy.s.sol` reverts on Base Sepolia.

| Script | Purpose |
| --- | --- |
| `Deploy.s.sol` | guardian + gate + burner implementation + launcher v3.1, wires `guardian.setLauncher(gate)` / `gate.addLauncher` / `setPlatformTreasury`, hands ownership to `PLATFORM_ADMIN` |
| `DeployLauncher.s.sol` | redeploys only the launcher (v3.1+) against the live guardian and gate (presets copied from `OLD_LAUNCHER`, `GATE`, optional `LAUNCH_FEE_WEI`), swaps it in the gate's allowlist, pauses the old launcher |
| `DeployClankerLauncher.s.sol` | the Clanker path: gate + launcher v3.1 + `BootrClankerLauncher` against the live guardian (presets, fee and burner implementation from `OLD_LAUNCHER`; `MEV_MODULE`, `PLATFORM_LP_FEE_BPS`), prints the admin's `guardian.setLauncher(gate)` / `pause()` steps unless the broadcaster is the guardian owner |
| `DeployClankerLauncherV5.s.sol` | the Clanker v5 path: `BootrClankerLauncherV5` against the live guardian, gate, identity registry and kernel factory read from `OLD_CLANKER_LAUNCHER` (presets, `minPlatformBps` and the launch fee copied; each preset's fee replaced by `TAX_BPS`, default 15000 = 1.5%; `PLATFORM_TAX_BPS`, `QUOTE_TOKEN` default native ETH, `ANTI_SNIPE`), checks the live v5 policy admits the tax and quote, hands ownership to `PLATFORM_ADMIN`; never touches the gate (`gate.addLauncher(v5)` is the admin's own transaction) |
| `DeployCallPolicy.s.sol` | deploys `BootrCallPolicy` (stateless) |
| `DeploySwapHelper.s.sol` | deploys `BootrSwapHelper` (WETH/USDC pool fee `SWAP_POOL_FEE`, default 500) |
| `Launch.s.sol` | example launch from `CREATOR_PRIVATE_KEY` (the planned $BOOTR launch) |

Run them with `forge script ... --rpc-url base --broadcast` (the `base` RPC alias reads `BASE_RPC_URL` from
`foundry.toml`); the deployer key is exported for the command only. The step-by-step cutover and redeploy
procedures, with the read-back checks, are in [`docs/deploy/mainnet.md`](../../docs/deploy/mainnet.md).
TODO(verify): whether broadcasting with `base-forge script` instead of stock `forge script` is required or only
tested; the repository does not pin which binary the deploy used.
