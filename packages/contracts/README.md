# @bootr/contracts

Foundry project (Solidity 0.8.26, `via_ir`, `evm_version = cancun`) with the Bootr contracts: `BootrLauncher`
(RWAGMI v3 path), `BootrClankerLauncher` (Clanker v4 path), `BootrClankerLauncherV5` (Clanker v5 path), `BootrLaunchGate`, `AgentGuardian`, `BuybackBurner`,
`BootrCallPolicy` and `BootrSwapHelper`. What each does, the launch flow through the RWAGMI v3 launcher, the fee path
and the session-key design are in [`src/README.md`](src/README.md); the design decisions are
[`docs/rwagmi-migration.md`](../../docs/rwagmi-migration.md) (RWAGMI backend) and
[`docs/design/clanker-launch.md`](../../docs/design/clanker-launch.md) (Clanker path, gate, v3.1) and
[`docs/design/clanker-v5-migration.md`](../../docs/design/clanker-v5-migration.md) (Clanker v5: a buy and sell tax
instead of the LP fee, fee slots paid in the quote through Clanker's `FeeEscrow`, Clanker's own burn share, token
addresses ending in `cccc` from a salt the web mines; the runbook is its section 8) and
[`docs/design/clanker-v5-token-settings.md`](../../docs/design/clanker-v5-token-settings.md) (the v5 launcher as built:
`launch(LaunchParams, TokenSettings)` with the creator's paired asset from an allow-list, buy and sell tax, burn,
holder dividends, up to five reward rows behind the locked agent and platform slots, sniper switch, and creator-only
image and metadata edits with a lock; the final ABI and events are its section 8).

Current Base mainnet deployment (source of truth: [`packages/shared/src/addresses.ts`](../shared/src/addresses.ts)):

| Contract | Address |
| --- | --- |
| `BootrLauncher` (RWAGMI v3, block 53503025) | `0x62c038dA8A409ad1CD811df980A6F9867cd453fd` |
| `BootrLaunchGate` | `0x7ddaf2A1FC0861B288c7b0BDfA8314621C47c3a5` |
| `BootrClankerLauncher` (Clanker v4, block 53503025) | `0x387f1B0aC128D534E822c344D829645336BDAbbB` |
| `BootrClankerLauncherV5` (Clanker v5) | not deployed yet (`script/DeployClankerLauncherV5.s.sol`; the owner signs: deploy, `acceptOwnership` from the admin, read back `owner() == admin`, and only then `gate.addLauncher`; migration note section 8) |
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
`SessionKeySignaturePath`, `GuardianArbitrarySessionPolicy`, `ClankerV5LauncherReview`), `test/mocks`. Clanker v5:
`test/unit/ClankerLauncherV5.t.sol` (42 tests: agent defaults and their bounds, the allow-list per launch kind, tax
bounds per side, share sums and the dividend minimum, reward rows (count, sums, admins), slot weights with the agent
rounded up and the platform down (one fuzz test), the Clanker parameters built from the settings, the creator-only
image and metadata edits and the lock, and the security-review fixes: the dev-buy minimum and the route bound to the
Uniswap v3 factory, the creator's config version passed to Clanker, the pinned shares and launch fee with the fee
cap, the stored tick spacing, `rescue`, the platform floor against the current share, `renounceOwnership` disabled,
the string caps; through a harness and mock factories), `test/fork/ClankerV5Fork.t.sol` (32 tests through the
live v5 factory: ETH and USDC launches with dev buys of one and two hops, every slot's exact share of buys and sells
with four extra rows, burn and dividends as Clanker credits them (redirected to Clanker until a holder qualifies,
then claimed by the holder), `claimFor(kernel, USDC)` landing fuel on the kernel, the sniper tax on and off, image
and metadata edits by the creator only, the lock, locked agent and platform slots and row admins, a quote off the
agent list refused, the live policy, events, prediction, the gate, the dev-buy minimum on both routes, a stale
config version, signed shares and fee against the owner, the pool key across a Clanker tick-spacing change, a
launch with every string at its cap, a stray transfer rescued) and `test/security/ClankerV5LauncherReview.t.sol`
(8 tests: the proofs of the security review of 2026-11-11 turned into regressions that show each attack
failing, among them a run of `DeployClankerLauncherV5` against the live v4 launcher, gate and guardian that walks
the deploy order). Stock `forge` runs them: `forge test --match-path 'test/fork/ClankerV5Fork.t.sol' -vv` and
`forge test --match-path 'test/security/ClankerV5LauncherReview.t.sol' -vv` (about 75 s each on the public RPC,
2026-11-11). `BootrClankerLauncherV5` is 19,395 bytes of runtime code (limit 24,576).

What a v5 launch must carry since the review fixes (`TokenSettings`, after `contractURI`): `minDevBuyOut` (the least
coins a dev buy may deliver; required with a dev buy), `expectedConfigVersion` (Clanker's `factory.configVersion()`
as the creator read it; another version reverts `StaleConfig`), `maxLaunchFeeWei` and `expectedAgentShareBps` /
`expectedPlatformShareBps` (the launcher's own terms as the creator read them; a difference reverts). Strings are
capped in bytes (name 160, symbol 32, image / contract URI / agent URI 512, metadata 4,096, context 512, model 128).

## Scripts

All scripts live in `script/` and read their configuration from the environment (headers document each variable;
`.env.mainnet.example` lists the mainnet values). Base mainnet only: `Deploy.s.sol` reverts on Base Sepolia.

| Script | Purpose |
| --- | --- |
| `Deploy.s.sol` | guardian + gate + burner implementation + launcher v3.1, wires `guardian.setLauncher(gate)` / `gate.addLauncher` / `setPlatformTreasury`, hands ownership to `PLATFORM_ADMIN` |
| `DeployLauncher.s.sol` | redeploys only the launcher (v3.1+) against the live guardian and gate (presets copied from `OLD_LAUNCHER`, `GATE`, optional `LAUNCH_FEE_WEI`), swaps it in the gate's allowlist, pauses the old launcher |
| `DeployClankerLauncher.s.sol` | the Clanker path: gate + launcher v3.1 + `BootrClankerLauncher` against the live guardian (presets, fee and burner implementation from `OLD_LAUNCHER`; `MEV_MODULE`, `PLATFORM_LP_FEE_BPS`), prints the admin's `guardian.setLauncher(gate)` / `pause()` steps unless the broadcaster is the guardian owner |
| `DeployClankerLauncherV5.s.sol` | the Clanker v5 path with creator settings: `BootrClankerLauncherV5` against the live guardian, gate, identity registry and kernel factory read from `OLD_CLANKER_LAUNCHER` (fuel minimum, dormancy, `minPlatformBps` and the launch fee copied), agent defaults 5% / 30% (`AGENT_SHARE_BPS`, `PLATFORM_SHARE_BPS`), tax bounds 1% to 5% (`MIN_TAX_BPS`, `MAX_TAX_BPS`), five reward rows (`MAX_REWARD_ROWS`), the agent allow-list native ETH + Base USDC, the USDC dev-buy hop through Uniswap v3 WETH/USDC 0.05%. **`PLATFORM_ADMIN` and `PLATFORM_RECIPIENT` are required** (no default to the deployer, no recipient copied from v4: the recipient is frozen into every coin's platform slot, so the owner names it; a wallet whose signers can rotate may be passed). Checks that the live v5 policy admits the bounds and both quotes and that the launch-buy adapter uses the same Uniswap v3 factory; starts the two-step handover to `PLATFORM_ADMIN`; never touches the gate. Order afterwards: the admin's `acceptOwnership()`, the read-back (`owner() == admin` and the configuration), and only then `gate.addLauncher(v5)` |
| `DeployCallPolicy.s.sol` | deploys `BootrCallPolicy` (stateless) |
| `DeploySwapHelper.s.sol` | deploys `BootrSwapHelper` (WETH/USDC pool fee `SWAP_POOL_FEE`, default 500) |
| `Launch.s.sol` | example launch from `CREATOR_PRIVATE_KEY` (the planned $BOOTR launch) |

Run them with `forge script ... --rpc-url base --broadcast` (the `base` RPC alias reads `BASE_RPC_URL` from
`foundry.toml`); the deployer key is exported for the command only. The step-by-step cutover and redeploy
procedures, with the read-back checks, are in [`docs/deploy/mainnet.md`](../../docs/deploy/mainnet.md).
TODO(verify): whether broadcasting with `base-forge script` instead of stock `forge script` is required or only
tested; the repository does not pin which binary the deploy used.
