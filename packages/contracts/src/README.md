# Bootr contracts

Solidity 0.8.26 / Foundry. Targets Base (Sepolia first). Everything is built on live third-party
infrastructure: Clanker v4, Uniswap v4, ZeroDev Kernel v3.1, ERC-4337 EntryPoint v0.7, ERC-8004.

| Contract | Role |
| --- | --- |
| `BootrLauncher` | One-tx launch: Kernel treasury -> optional `BuybackBurner` clone -> Clanker token + v4 pool -> ERC-8004 identity -> USDC fuel -> guardian registration. `Ownable2Step`, `Pausable`, `ReentrancyGuard`. |
| `AgentGuardian` | ERC-7579 root **validator + hook** of every agent Kernel. Tracks activity, enforces creator pause, approves session-key installs, sweeps dormant treasuries. `Ownable2Step` (platform admin). |
| `BuybackBurner` | EIP-1167 clone per buyback-enabled coin. LP-fee recipient; `burn()` claims and burns (anyone), `swapAndBurn(minOut)` handles stray WETH (launcher owner only: there is no on-chain price for a fresh coin, so a caller-chosen `minOut` was a griefing primitive, BOOTR-03). No owner of its own. |
| `BootrCallPolicy` | ERC-7579 **policy** (module type 5) for Kernel v3.1 session permissions: call allow-list over `Kernel.execute` (target, selector, static-arg rules; `<=` rules are summed per batch; `SUM_PER_WINDOW` rules are capped cumulatively per rolling window on-chain), understands the `executeUserOp` wrapper. No owner, no external calls. |
| `BootrSwapHelper` | Immutable WETH -> USDC helper: pulls `amountIn` from `msg.sender`, swaps through Uniswap v3 `SwapRouter02` on a fixed fee tier with a floor derived on-chain from Chainlink ETH/USD (max 3% below, feed at most 1 h old) and pays all output to `msg.sender`. The only WETH sink a session key may use. Closes C-02. |

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

Policies the supervisor installs (addresses in `packages/shared/src/addresses.ts`), in order (the index is
what a policy-signature slot of a userOp signature addresses):
[0] `BootrCallPolicy` (ours, `NOT_FOR_VALIDATE_SIG`; allow-list `FeeLocker.claim(kernel, *)`,
`WETH.approve(swapHelper, *)`, `swapHelper.swapWethToUsdc(*, *)`, `USDC.transfer(spender, SUM_PER_WINDOW <= cap)`),
[1] ZeroDev GasPolicy (cumulative gas cap) and [2] RateLimitPolicy (calls per interval), both
`NOT_FOR_VALIDATE_SIG`, [3] TimestampPolicy (validity window), then the ECDSASigner flagged
**SKIP_SIGNATURE (0x0002)**. Never SudoPolicy in production (used only in tests). The former
`UniversalRouter.execute` / `WETH.transfer(router)` rules, the `USDC.transfer(payTo, …)` rule and ZeroDev's
SignatureCallerPolicy are gone (C-02 / C-01).

### The ERC-1271 path is closed (C-01 / BOOTR-01)

`Kernel.isValidSignature` for a permission runs only the policies not flagged `NOT_FOR_VALIDATE_SIG`, with the
RAW hash, then the signer; nothing inspects what is signed, and USDC on Base settles
`transferWithAuthorization` through exactly that call. A content policy on this path is **not possible on the
deployed Kernel v3.1** (impl `0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D`): `ValidationManager._checkSignaturePolicy`
calls `_checkPermissionPolicy(mSig, state, sig)` and then checks `sig[0] == 0xff` on its own, unchanged `sig`
slice (the inner `sig = sig[9 + len:]` never propagates), so any policy-signature slot reverts
`SignerPrefixNotPresent()`; policy slots only work on the userOp path (`_checkUserOpPolicy` advances its own
slice). `test/security/RevocationFork.t.sol::test_kernelRejectsAnyPolicySlotOnSignaturePath` proves it live.

The fix therefore removes the path instead of bounding it: `_installPermission` stores the **signer entry's
2-byte flags as the permission's `permissionFlag`**, and `isValidSignature` reverts
`PermissionNotAlllowedForSignature()` when that flag has `SKIP_SIGNATURE` set, before any policy or signer runs.
The supervisor installs the ECDSASigner with `0x0002`, so a Bootr session key cannot produce any ERC-1271
signature for the kernel (`test_productionLayoutHasNoSignaturePath`). x402 payments are signed by a per-agent
**spender EOA** (`apps/supervisor/src/spender.ts`), which the session key may only fund through the windowed
`USDC.transfer(spender, …)` rule below. The pause and the dormancy clock never covered signature-based
settlement; there is none to cover now.

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
* **Batch sums (M-02).** `LESS_THAN_OR_EQUAL` and `SUM_PER_WINDOW` bounds are cumulative per userOp: in a batch
  the words of every call that matched the same rule are summed per argument rule (`uint256[MAX_RULES *
  MAX_ARGS]` in memory, a wrap-around is detected and fails) and the sum must stay `<= value`. `k >= 2` calls
  `USDC.transfer(spender, cap)` in one op therefore fail; a call is accounted against the first rule it matches.
* **`SUM_PER_WINDOW` (op 3): cumulative cap per rolling window.** `Rule` gained `uint32 windowSeconds`
  (`Rule = (address target, bytes4 selector, uint32 windowSeconds, ArgRule[] args)`); an op-3 argument needs
  `windowSeconds > 0` and a cap that fits `uint128` (`WindowRequired` / `CapTooLarge` at install). Per
  `(id, kernel, rule, arg)` the policy keeps `uint48 windowEnd` and `uint128 spent` packed into the argument's
  first slot (`StoredArg = index(1) ‖ op(1) ‖ windowEnd(6) ‖ spent(16)` + `value`), so the struct is still 2 slots
  per argument and **73 slots** in total (`test_constantsAndSlotCount`). Windows are a fixed grid anchored at
  install (`windowEnd = install + windowSeconds`). Validation may not read `block.timestamp`, so, like ZeroDev's
  RateLimitPolicy, the policy relies on the EntryPoint's time check of the returned `validAfter` /
  `validUntil`: the session signer puts its claim of the current time in the policy's signature slot
  (`[0 ‖ uint64(32) ‖ abi.encode(now)]` before `0xff ‖ sig`; Kernel hands it over as `userOp.signature`). If
  `now >= windowEnd` the grid is advanced to the window containing `now` and `spent` resets (no catch-up
  burst after idle periods); then `spent + v > cap` fails `PolicyFailed`, else `spent += v` and the policy
  returns `validAfter = windowEnd - windowSeconds`, `validUntil = windowEnd` (packed ERC-4337 style; the Kernel
  intersects it with the TimestampPolicy). Claiming the future yields a `validAfter` the EntryPoint rejects
  ("AA22 not due") and the failed validation rolls the state back; claiming the past, or sending no slot after
  the window lapsed, keeps a window whose `validUntil` it rejects as expired. Only calls that spend (`v > 0`)
  touch a window: claims, swaps and zero transfers carry no time bound. `windowOf(id, kernel, rule, arg)`
  exposes `(windowEnd, spent, windowSeconds, cap)` so the supervisor can compute the remaining budget.
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

### BootrAuthorizationPolicy (the ERC-1271 path)

`Kernel.isValidSignature` for a permission runs only the policies not flagged `NOT_FOR_VALIDATE_SIG`, with the
RAW hash (`_checkPermissionPolicy`; the `Kernel(bytes32 hash)` wrapper is applied only for the signer), then the
signer. Without a content policy the session EOA could sign anything for the kernel: USDC on Base settles
`transferWithAuthorization` through `isValidSignature` (C-01 / BOOTR-01). `BootrAuthorizationPolicy` is that
content policy:

* `onInstall(bytes32 id ‖ abi.encode(address usdc, address payTo, uint256 maxValue, uint256 maxWindowSeconds))`,
  stored per `(id, kernel)` in a 4-slot fixed struct (same associated-storage layout as `BootrCallPolicy`);
  it also records `kernel.currentNonce()` (= the permission's `ValidationConfig.nonce`).
* `checkSignaturePolicy(id, caller, hash, policySig)` with
  `policySig = abi.encode(uint256 kind, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)`
  (`kind` 0 = `TransferWithAuthorization`, 1 = `ReceiveWithAuthorization`; exactly 160 bytes, anything else
  returns 1) recomputes the EIP-3009 struct hash with `from = msg.sender` (the kernel) and `to = payTo`, the
  USDC digest with the token's live `DOMAIN_SEPARATOR()`, and returns 0 only if that digest equals `hash`,
  `value <= maxValue`, `validBefore - validAfter <= maxWindowSeconds` and `kernel.validNonceFrom() <=
  installNonce`. Expiry is left to USDC; `caller` is ignored (facilitators verify off-chain). Permit2, other
  recipients, other tokens and arbitrary EIP-712 messages fail with `PolicyFailed(4)`.
* Signature layout: `0x02 ‖ permissionId ‖ 0x04 ‖ uint64(160) ‖ policySig ‖ 0xff ‖ ecdsa(wrapped hash)`.
* `checkUserOpPolicy` passes (the module is installed `NOT_FOR_VALIDATE_USEROP`; the call allow-list is
  `BootrCallPolicy`). Deploy with `script/DeployAuthorizationPolicy.s.sol`; record under
  `bootr.authorizationPolicy`; rotate every session key afterwards.

### BootrSwapHelper (the only WETH sink)

`swapWethToUsdc(uint256 amountIn, uint256 maxSlippageBps)`: `transferFrom(msg.sender, amountIn)` WETH,
`SwapRouter02.exactInputSingle` on the fixed `poolFee` WETH/USDC pool with `recipient = msg.sender` and
`amountOutMinimum = amountIn * ethUsd * (10000 - bps) / 10000` from Chainlink ETH/USD (`bps <= 300`, answer
> 0, `updatedAt` at most 1 h old, `answeredInRound >= roundId`, else revert). Approve + `transferFrom` rather
than transfer + sweep so that WETH never sits in the helper where a third party could swap it to themselves.
No owner, no fee, no parameters after deployment. Base Sepolia: SwapRouter02
`0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4`, ETH/USD `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`, pool fee 500
(the testnet pool is thin, ~0.05 WETH, and drifts about 1% from Chainlink, so the fork tests swap 0.0005 WETH at
2%). Deploy with `script/DeploySwapHelper.s.sol`; record under `bootr.swapHelper`; rotate every session key
afterwards.

Revocation (verified on a Base Sepolia fork, `test/security/RevocationFork.t.sol`):

* `revokeAllSessionKeys(kernel)` (root `invalidateNonce(currentNonce + 1)`) kills the userOp path of every
  non-root validation (Kernel compares `ValidationConfig.nonce` with `validNonceFrom` in `validateUserOp`).
  **Kernel's `isValidSignature` does not compare nonces**, so for a legacy permission whose signer was installed
  without `SKIP_SIGNATURE` the nonce bump leaves x402 settlements alive; only `revokeSessionKey` closes those.
  Production permissions have no signature path, so the bump is complete for them.
  `revokeAllSessionKeysBatch(address[] kernels)` does it for a whole fleet in one transaction.
* `revokeSessionKey(kernel, pid, deinitData)` (root `uninstallValidation`; `deinitData =
  abi.encode(bytes[](policies + 1))`, entries may be empty) sets the permission's hook to 0
  (`isValidSignature` reverts `InvalidValidator`), runs every module's `onUninstall`, and withdraws the enable
  digest approved for that permission (`approvedDigestOf`), so the old approval cannot re-enable it. Even a
  fresh identical approval cannot: Kernel's `_installValidation` rejects a re-used ValidationId with
  `InvalidNonce`. A new permission id installs normally at the bumped nonce.
* `revokeSessionKeyApproval(kernel, digest)` only blocks a future enable.

### Dormancy

`claimDormant(kernel, address[] extraTokens)` (admin): requires `block.timestamp >= lastActivity + dormancyPeriod`;
root `execute(batch)`: USDC and WETH -> `platformTreasury` (100%), the agent's own coin -> `0x…dEaD` (revert
mode); then every `extraTokens` entry (full balance -> treasury) and the ETH balance in Kernel **try** mode
(`EXEC_MODE_BATCH_TRY`), so a reverting token or a treasury that rejects ETH never blocks the sweep (BOOTR-04);
what failed stays on the kernel and emits `TryExecuteUnsuccessful`, and a later call retries it. The ERC-8004
identity NFT is still not recoverable. Creator `pauseAgent`/`unpauseAgent` blocks the session path only; it
neither moves funds nor resets the clock.

## Scripts

* `script/Deploy.s.sol` - deploys guardian, burner implementation, launcher; wires `setLauncher`,
  `setPlatformTreasury`, defaults from env; `transferOwnership(PLATFORM_ADMIN)` (admin must `acceptOwnership`).
  Chain config by `block.chainid` (84532 verified; 8453 verified on-chain and against clanker-sdk (see packages/shared/src/addresses.ts)).
* `script/DeployCallPolicy.s.sol` - deploys `BootrCallPolicy` (stateless, no wiring) and logs the address.
* `script/DeploySwapHelper.s.sol` - deploys `BootrSwapHelper` (WETH, USDC, SwapRouter02, Chainlink ETH/USD per
  chain; `SWAP_POOL_FEE` default 500). Mainnet addresses must be re-verified before deploying.

Dev buy (BOOTR-05): the launcher passes `pairedTokenAmountOutMinimum = 0` to `ClankerUniv4EthDevBuy`. That
field only bounds the ETH -> paired-token leg, which does not exist here (the paired token is WETH, so
`pairedTokenPoolKey` is empty); the token leg's minimum is hard-coded to 1 by Clanker's extension and cannot
be set from the launcher. The MEV block-delay module blocks same-block sandwiching of the launch. Left as is.
* `script/Launch.s.sol` - example launch from `CREATOR_PRIVATE_KEY` (approves USDC first).

## Tests

* `test/unit/*` - no fork: bps/defaults math, guardian logic against a `MockKernel` (incl. extra-token sweep,
  non-blocking ETH leg, approval withdrawal on uninstall, batch revoke), `BootrCallPolicy` parsing and rule
  matching (single/batch, wrapper, arg ops, value, delegatecall, truncation, isolation, batch sums), the
  rule/arg limits, the ERC-7562 associated-storage property (`vm.record` over `checkUserOpPolicy`, reads and
  window writes), the `SUM_PER_WINDOW` accounting (accumulation, grid roll with the time slot, lying about the
  time, no-slot behaviour, batch sums, uninstall clearing, a fuzzed invariant) and `BootrSwapHelper` against a
  mock router and feed (floor math, slippage cap, stale / zero price, diverted output, fuzzed floor).
* `test/security/RevocationFork.t.sol` - Base Sepolia fork with the full production policy set through the
  guardian enable path: the Kernel rejects any policy slot on the signature path (`SignerPrefixNotPresent`),
  the production permission has no signature path (`PermissionNotAlllowedForSignature`, paused or not) while
  userOps work; nonce-bump vs uninstall semantics on the legacy and the production layout; batch revoke;
  re-enable of an uninstalled permission rejected; re-onboarding after a panic revoke.
* `test/security/WindowedCapFork.t.sol` - the windowed funding cap through the live EntryPoint with `vm.warp`:
  cumulative within a day, rolls to the grid window containing `now` without catch-up bursts, future / past /
  missing time claims fail `AA22`, batches over the remaining budget fail as a whole, other recipients fail.
* `test/fork/SwapHelperFork.t.sol` - real SwapRouter02 / pool / Chainlink: floor honoured, stale feed and zero
  answer revert, slippage cap, session key can only turn kernel WETH into kernel USDC.
* `test/fork/BootrFork.t.sol` - Base Sepolia fork (`BASE_SEPOLIA_RPC_URL` or https://sepolia.base.org):
  real Clanker deploy (both presets, with/without dev buy), reward immutability, swap -> fee ratio,
  buyback burn, Kernel access control (direct + userOp), enable-mode session key through the live
  EntryPoint (SudoPolicy fixture and the production `BootrCallPolicy` + ECDSA signer set: allowed
  no-op, rejected calls with `PolicyFailed`, batch, non-zero value, an ERC-8021 builder-code suffix on the
  callData, revoke/uninstall), pause, nonce revocation, dormancy sweep, activity reset.
