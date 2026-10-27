# Bootr contracts

Solidity 0.8.26 / Foundry. Targets Base (Sepolia first). Everything is built on live third-party
infrastructure: Clanker v4, Uniswap v4, ZeroDev Kernel v3.1, ERC-4337 EntryPoint v0.7, ERC-8004.

| Contract | Role |
| --- | --- |
| `BootrLauncher` | One-tx launch: Kernel treasury -> optional `BuybackBurner` clone -> Clanker token + v4 pool -> ERC-8004 identity -> USDC fuel -> guardian registration. `Ownable2Step`, `Pausable`, `ReentrancyGuard`. |
| `AgentGuardian` | ERC-7579 root **validator + hook** of every agent Kernel. Tracks activity, enforces creator pause, approves session-key installs, sweeps dormant treasuries. `Ownable2Step` (platform admin). |
| `BuybackBurner` | EIP-1167 clone per buyback-enabled coin. LP-fee recipient; `burn()` claims and burns, `swapAndBurn(minOut)` handles stray WETH. No owner. |
| `BootrCallPolicy` | ERC-7579 **policy** (module type 5) for Kernel v3.1 session permissions: call allow-list over `Kernel.execute` (target, selector, static-arg rules), understands the `executeUserOp` wrapper. No owner, no external calls. |

## Launch flow (`BootrLauncher.launch`)

1. `kernelFactory.createAccount(initialize(rootValidator = 0x01‖guardian, hook = guardian, "", 0x00, []), keccak(creator, salt))`
2. if `buybackBurn`: `MinimalClones.cloneDeterministic(burnerImplementation, keccak(creator, salt))`
3. `clanker.deployToken{value: devBuyWei}(config)` with:
   * `tokenAdmin = launcher` (no metadata-mutating function exists on the launcher, so image/metadata/admin are frozen)
   * `tokenConfig.salt = keccak(creator, params.salt)` (Clanker derives the CREATE2 salt from `(tokenAdmin, salt)`, so this namespaces salts per creator; vanity-address mining must use this derivation)
   * pool: `ClankerHookStaticFeeV2`, paired = WETH, `tickIfToken0IsClanker = -230400`, `tickSpacing = 200`,
     `poolData = abi.encode(PoolInitializationData{extension: 0, extensionData: "", feeData: abi.encode(PoolStaticConfigVars{lpFeeBps, lpFeeBps})})`
   * one LP position `[-230400, -120000]`, 100% of the pool supply (clanker.world "Standard" preset: launch at ~10 ETH FDV for the 100B supply, liquidity up to ~62,000x)
   * locker: `ClankerLpLockerFeeConversion` (the locker Clanker enables for the V2 hooks). `rewardRecipients = [kernel, creator, (burner), platformRecipient]`, `rewardBps = [agent, creator, (burn), platform]`, **every `rewardAdmins[i] = launcher`**, `lockerData = abi.encode(LpFeeConversionInfo{[Both, Both, (Clanker), Both]})`. The launcher has no function calling `updateRewardRecipient`, `updateRewardAdmin` or `updateFeePreference`, so the split is immutable.
   * MEV module `ClankerMevBlockDelay` (data `""`), extension `ClankerUniv4EthDevBuy` with `msg.value = devBuyWei`, recipient = creator (only when `devBuyWei > 0`).
4. `identityRegistry.register(agentURI)` (mints to the launcher) then `transferFrom(launcher, kernel, agentId)`
5. `usdc.transferFrom(creator, kernel, fuelUsdc)` (`fuelUsdc >= minFuelUsdc`)
6. `guardian.registerAgent(kernel, token, creator, dormancyPeriod)`
7. `AgentLaunched(...)` with a snapshot of the `LaunchDefaults` used; excess ETH refunded.

Fee path: the hook keeps 20% of every LP fee (protocol fee, swept to the Clanker factory); the
remaining 80% is distributed by the locker into `ClankerFeeLocker` per recipient on the next swap
or on `lpLocker.collectRewards(token)` (anyone). Recipients pull with `feeLocker.claim(recipient, token)`
(anyone may trigger; funds always go to the recipient).

## AgentGuardian - how root authority works in Kernel v3.1

`Kernel.sol` lines 79-94 (`onlyEntryPointOrSelfOrRoot`): a caller that is not the EntryPoint and not
the kernel itself may call `execute`/`installValidations`/`uninstallValidation`/`invalidateNonce`/
`installModule`/`uninstallModule`/`changeRootValidator`/`upgradeTo` **only if the root validator is a
hook**; the kernel then calls `rootValidator.preCheck(msg.sender, msg.value, msg.data)` and proceeds
if it does not revert. `AgentGuardian.preCheck`:

* `sender == guardian` -> allowed only while the guardian is executing `_rootCall` on that kernel.
* `sender == EntryPoint` -> this is the `executeUserOp` path (`HookManager._doPreHook` forwards the
  kernel's `msg.sender`); reverts if the creator paused the agent, otherwise stamps `lastActivity`.
* anything else -> `UnauthorizedCaller`. Unregistered kernels -> `NotRegistered`.

`validateUserOp` always returns `SIG_VALIDATION_FAILED`; nobody can send userOps "as root".

### Session keys (supervisor)

Kernel v3.1 only grants `allowedSelectors` to a validation through `installModule` (validator-type
modules) or **enable mode** (`ValidationManager._enableValidationWithSig`, lines 346-366).
`installValidations` installs a permission without any selector, which makes it unusable for
userOps (`Kernel.sol` lines 251-262). Permission-type session keys (ZeroDev policies + signer) are
therefore installed with enable mode, where Kernel asks the root validator
`isValidSignatureWithSender(kernel, enableDigest, enableSig)` (line 378). The guardian honours only
digests pre-approved on-chain by the admin:

```
(digest, nonce) = guardian.approveSessionKey(kernel, permissionId, validatorData)
```

* `permissionId`: `bytes4` chosen by the supervisor SDK; `ValidationId = 0x02 ‖ permissionId ‖ 16 zero bytes`.
* `validatorData = abi.encode(bytes[] permissionEnableData)`; entry `i < last` = `bytes2 flags ‖ address policy ‖ policyInitData`,
  the last entry = `bytes2 flags ‖ address signer ‖ signerInitData` (ECDSASigner: 20-byte session key).
  Kernel passes `bytes32(permissionId) ‖ data` to each module's `onInstall`.
* The guardian fixes `hook = guardian`, `hookData = 0x00`, `selectorData = 0xe9ae5c53` (`execute`),
  `nonce = kernel.currentNonce()` and computes
  `digest = keccak256(0x1901 ‖ domainSeparator(name "Kernel", version "0.3.1", chainId, kernel) ‖ keccak256(abi.encode(ENABLE_TYPE_HASH, vId, nonce, hook, keccak(validatorData), keccak(hookData), keccak(selectorData))))`.

The supervisor then sends the enable userOp:

* `nonce = 0x01 (enable) ‖ 0x02 (permission) ‖ permissionId ‖ 16 zero bytes ‖ 2-byte key ‖ 8-byte seq` (seq from `EntryPoint.getNonce`).
* `callData = executeUserOp.selector ‖ execute(mode, calldata)` (hooked validations must go through `executeUserOp`).
* `signature = abi.encodePacked(address(guardian), abi.encode(validatorData, hex"00", hex"e9ae5c53", enableSig, userOpSig))`;
  `enableSig` may be empty (the guardian ignores it), `userOpSig` = policy signatures + `0xff ‖ signerSig`.
* Later userOps: nonce mode `0x00`, `signature = policySigs ‖ 0xff ‖ signerSig`.

Policies the supervisor installs (addresses in `packages/shared/src/addresses.ts`), in order:
`BootrCallPolicy` (ours, see below; allow-list `FeeLocker.claim(kernel, *)`, Universal Router
`execute(bytes,bytes[],uint256)`, `USDC.transfer(payTo, <= cap)`, `WETH.transfer(universalRouter, *)`),
then ZeroDev's GasPolicy (cumulative gas cap), RateLimitPolicy (calls per interval), TimestampPolicy
(validity window) and SignatureCallerPolicy (ERC-1271 callers), then the ECDSASigner. Never
SudoPolicy in production (used only in tests).

### BootrCallPolicy (why not ZeroDev's CallPolicy)

Because the session permission's hook is the guardian, Kernel v3.1 requires every session userOp's
callData to be `executeUserOp.selector (0x8dd7712f) ‖ execute(bytes32 mode, bytes executionCalldata)`
(plain `execute(...)` callData is rejected with `InvalidValidator()` after the policies). ZeroDev's
CallPolicy v0.0.5 (`0x85770b902D1e503D5f5141d9eaC16d0d08eEaDd2`) does not know the `executeUserOp`
wrapper: its `checkUserOpPolicy` reverts on it, so a Bootr session with that policy can never
execute. The gas, rate-limit, timestamp and signature-caller policies and the ECDSA signer do not
parse callData and work with the wrapper. `BootrCallPolicy` replaces CallPolicy only.

* `onInstall(bytes32 id ‖ abi.encode(Rule[]))`, called by the kernel; `id = bytes32(permissionId)`
  (left-aligned). Rules are stored per `(id, kernel)`; installing twice reverts, an empty rule set
  reverts. `onUninstall(bytes32 id ‖ …)` deletes them (idempotent).
  `Rule = (address target, bytes4 selector, ArgRule[] args)`, `ArgRule = (uint8 index, uint8 op, bytes32 value)`
  on the static word at `4 + 32 * index`; `op` 1 = EQUAL (bytes32), 2 = LESS_THAN_OR_EQUAL (uint256).
* `checkUserOpPolicy(id, userOp)`: strips `0x8dd7712f` if present, requires the `execute` selector,
  decodes `(mode, executionCalldata)`; call type `0x00` single (`target ‖ value ‖ data`) or `0x01`
  batch (`Execution[]`), anything else (delegatecall `0xff`) fails. Every call must have `value == 0`,
  `data.length >= 4` and match at least one rule (target, selector, every arg rule; an arg rule past
  the end of `data` fails). Returns `0` only if every call passes, `1` (`SIG_VALIDATION_FAILED`)
  otherwise - never reverts on a disallowed or truncated call, so the Kernel reports `PolicyFailed(i)`
  and the EntryPoint `FailedOpWithRevert(_, "AA23 reverted", PolicyFailed(i))`. Only a structurally
  invalid batch ABI encoding reverts (in `abi.decode`, exactly as the Kernel would at execution).
* `checkSignaturePolicy` always passes; the supervisor flags the module `NOT_FOR_VALIDATE_SIG`.
* **ERC-7562 associated storage (strict bundlers).** `checkUserOpPolicy` runs in the EntryPoint validation
  phase, where an unstaked sender may only touch its *associated storage*: slots of the form
  `keccak256(A ‖ X) + n` (`A` = the 32-byte-padded sender, `n < 128`). Dynamic arrays / `bytes` add another
  keccak level and count as foreign storage, which strict bundlers (Coinbase CDP, Pimlico/Alto, the reference
  bundler) reject at `eth_sendUserOperation` with "op code validation error … entity stake/unstake delay too
  low" (ZeroDev's bundler tolerates it). The rules are therefore stored in a FIXED-SIZE struct under
  `mapping(bytes32 id => mapping(address kernel => Config))` (slot 0; id outer, kernel inner, so the struct
  starts at `keccak256(kernel ‖ keccak256(id ‖ 0))`): `Config = (uint8 status, uint8 ruleCount,
  StoredRule[8] rules)`, `StoredRule = (address target, bytes4 selector, uint8 argCount, StoredArg[4] args)`,
  `StoredArg = (uint8 index, uint8 op, bytes32 value)` - 1 + 8 x (1 + 4 x 2) = **73 slots** (< 128).
  `MAX_RULES = 8`, `MAX_ARGS = 4`; `onInstall` reverts `TooManyRules` / `TooManyArgs` beyond that (the
  supervisor installs 4 rules with at most 2 args). Validation reads nothing else and uses no banned opcodes
  (no `TIMESTAMP` / `NUMBER` / `GAS` / `BALANCE`, no external calls); `installedCount` (for `isInitialized`)
  is only touched on install/uninstall. `test_validationReadsOnlyAssociatedStorage` asserts with
  `vm.record()` that every slot read during `checkUserOpPolicy` is in `[base, base + 128)`, and
  `test_installMaxRulesAndArgsUsesExactlyConfigSlots` pins the 73-slot span. The external ABI (`Rule[]`
  install data, `rulesOf`, `installed`) is unchanged.
  Note that the first enable-mode userOp (which runs every policy's `onInstall` during validation) is still
  rejected by strict bundlers; the supervisor self-bundles it (`ENABLE_MODE_SELF_BUNDLE`, see
  `apps/supervisor/README.md`).
* **Trailing bytes / ERC-8021 attribution.** Session userOp callData may carry a Base Builder Codes suffix
  (ERC-8021: `ascii(codes) ‖ codesLength ‖ schemaId ‖ 0x80218021…8021`, appended by the supervisor after
  `executeUserOp ‖ execute(...)`). The policy decodes `execute(mode, executionCalldata)` from the head using
  the ABI offset and length words with bounds checks, so anything after `executionCalldata` is ignored; the
  Kernel's own ABI decoder and the guardian hook (`preCheck` never parses callData) ignore it too. A suffix
  never turns a disallowed call into an allowed one (`test_erc8021SuffixIgnored`, `test_fuzzTrailingBytesIgnored`,
  fork `test_callPolicySession_erc8021SuffixExecutesAndStampsActivity`).
* Deploy with `script/DeployCallPolicy.s.sol` (no constructor args) and record the address in
  `addresses.ts` under `bootr.callPolicy`.

Revocation: `revokeAllSessionKeys(kernel)` (root `invalidateNonce(currentNonce + 1)`, kills every
non-root validation; root unaffected), `revokeSessionKey(kernel, pid, deinitData)` (root
`uninstallValidation`), `revokeSessionKeyApproval`.

### Dormancy

`claimDormant(kernel)` (admin): requires `block.timestamp >= lastActivity + dormancyPeriod`; root
`execute(batch)`: USDC, WETH and ETH -> `platformTreasury` (100%), the agent's own coin -> `0x…dEaD`.
Creator `pauseAgent`/`unpauseAgent` blocks the session path only; it neither moves funds nor resets
the clock.

## Scripts

* `script/Deploy.s.sol` - deploys guardian, burner implementation, launcher; wires `setLauncher`,
  `setPlatformTreasury`, defaults from env; `transferOwnership(PLATFORM_ADMIN)` (admin must `acceptOwnership`).
  Chain config by `block.chainid` (84532 verified; 8453 from the Clanker README - re-verify).
* `script/DeployCallPolicy.s.sol` - deploys `BootrCallPolicy` (stateless, no wiring) and logs the address.
* `script/Launch.s.sol` - example launch from `CREATOR_PRIVATE_KEY` (approves USDC first).

## Tests

* `test/unit/*` - no fork: bps/defaults math, guardian logic against a `MockKernel`, `BootrCallPolicy`
  parsing and rule matching (single/batch, wrapper, arg ops, value, delegatecall, truncation, isolation),
  the rule/arg limits and the ERC-7562 associated-storage property (`vm.record` over `checkUserOpPolicy`).
* `test/fork/BootrFork.t.sol` - Base Sepolia fork (`BASE_SEPOLIA_RPC_URL` or https://sepolia.base.org):
  real Clanker deploy (both presets, with/without dev buy), reward immutability, swap -> fee ratio,
  buyback burn, Kernel access control (direct + userOp), enable-mode session key through the live
  EntryPoint (SudoPolicy fixture and the production `BootrCallPolicy` + ECDSA signer set: allowed
  no-op, rejected calls with `PolicyFailed`, batch, non-zero value, an ERC-8021 builder-code suffix on the
  callData, revoke/uninstall), pause, nonce revocation, dormancy sweep, activity reset.
