# Bootr contracts — security review

Scope: `packages/contracts/src/{BootrLauncher,AgentGuardian,BootrCallPolicy,BuybackBurner}.sol`,
`src/lib/MinimalClones.sol`, `src/interfaces/*`, `script/*.s.sol`, and the trust model in `src/README.md`.
Toolchain: Foundry, solc 0.8.26, via-IR, optimizer 200. Live checks on Base Sepolia
(`https://sepolia.base.org`) against the deployed instances listed in the brief and against the
vendored Kernel v3.1 / Clanker v4 sources (fetched for cross-reference).

Reviewer stance: the launcher/clone/fee-split mechanics and the `BootrCallPolicy` parser are carefully
built and, as far as the *userOp* path is concerned, hold up well (see "What I verified and found
sound"). The two material findings are both about authority that sits *outside* the userOp path — the
ERC-1271 signature path and the platform admin's session-approval power — where the protections the
README advertises (the USDC cap, the creator pause, the 90-day dormancy gate) do not actually reach.

## Findings

| id | severity | title | location |
| --- | --- | --- | --- |
| BOOTR-01 | High | ERC-1271 / EIP-3009 signature path bypasses the BootrCallPolicy cap+recipient, the creator pause, and activity/dormancy stamping | `AgentGuardian.sol:328-360`, `BootrCallPolicy.sol:231-233`, `session-key.ts` |
| BOOTR-02 | High | `approveSessionKey` does not constrain `validatorData`: the platform admin can install an unrestricted (e.g. SudoPolicy) session and seize any treasury at will | `AgentGuardian.sol:181-194` |
| BOOTR-03 | Low | `BuybackBurner.swapAndBurn` is permissionless with a caller-supplied `minOut` (griefable / MEV value-loss on stray WETH) | `BuybackBurner.sol:87-93,111-142` |
| BOOTR-04 | Low | `claimDormant` sweeps only USDC/WETH/ETH/own-coin; any other ERC-20 (and the ERC-8004 NFT) is stranded forever, and a reverting `platformTreasury` bricks the sweep | `AgentGuardian.sol:236-262` |
| BOOTR-05 | Low | Dev-buy is executed with `pairedTokenAmountOutMinimum = 0` (no slippage floor on the creator's launch buy) | `BootrLauncher.sol:414-427` |
| BOOTR-06 | Info | `BuybackBurner` clone is deployed and left uninitialized across the `clanker.deployToken` external-call window; a misbehaving pool/extension could grief the launch by front-running `initialize` | `BootrLauncher.sol:252-260` |
| BOOTR-07 | Info | Enable digests never expire and `revokeSessionKeyApproval` only blocks *future* enables; the approval is bound to `currentNonce` at approve time (liveness race) | `AgentGuardian.sol:181-199` |
| BOOTR-08 | Info | `script/Deploy.s.sol` carries unverified Base-mainnet addresses and leaves the deployer as owner until the admin accepts (Ownable2Step) | `script/Deploy.s.sol:57-78,139-150` |

Counts: Critical 0, High 2, Medium 0, Low 3, Informational 3.

---

### BOOTR-01 — ERC-1271 / EIP-3009 signature path bypasses the session allow-list, the pause, and activity stamping (High)

**Location:** `AgentGuardian.sol:328-360`, `BootrCallPolicy.sol:231-233`; driven by
`apps/supervisor/src/{session-key.ts,kernel.ts,inference.ts}` and `apps/supervisor/src/api.ts:122-140`.

**Description.** A Bootr session permission is installed with two "signer-reachable" surfaces:

1. the **userOp path** — `Kernel.validateUserOp` → policies → signer. Here `BootrCallPolicy`
   (`checkUserOpPolicy`) enforces target/selector/arg rules, `value == 0`, and in particular the
   `USDC.transfer(inferencePayTo, <= cap)` rule. The guardian hook (`preCheck`) also runs, enforcing
   the creator pause and stamping `lastActivity`.
2. the **ERC-1271 signature path** — `Kernel.isValidSignature`. For a *permission* validation this
   resolves `_checkPermissionSignature` → runs only the policies **not** flagged `NOT_FOR_VALIDATE_SIG`
   → the ECDSA signer. It never calls the root validator and never calls the hook's `preCheck`.

`session-key.ts` installs `BootrCallPolicy` with `PolicyFlags.NOT_FOR_VALIDATE_SIG` (it is userOp-only,
and `checkSignaturePolicy` returns success unconditionally, `BootrCallPolicy.sol:231-233`), and installs
the ECDSA signer with `FOR_ALL_VALIDATION`. Consequently **the signature path is gated by neither
`BootrCallPolicy` (no cap, no recipient allow-list, no `value==0`) nor the guardian (no pause, no
activity stamp).** The supervisor uses exactly this path for x402: `kernel.ts` signs the Kernel-wrapped
hash of a USDC **EIP-3009** `transferWithAuthorization`, and USDC settles it by calling
`kernel.isValidSignature` (confirmed intended in `inference.ts:1-5`, `api.ts:136`).

So a signature produced by the session key authorizes moving USDC **to any recipient, in any amount up
to the full balance, in a single settlement, while the agent is paused, and without refreshing the
dormancy clock** — none of which the userOp path permits. The session key is a hot key held by the
supervisor; the cap/recipient rules exist precisely to bound its blast radius on compromise, and this
path removes that bound for USDC.

Production narrows (does not close) the exposure with two ZeroDev policies that *are* signature-active:
`TimestampPolicy` (validity window) and, by default (`SESSION_1271_CALLERS=usdc`),
`SignatureCallerPolicy` restricting `msg.sender` of `isValidSignature` to USDC. That confines the vector
to "USDC EIP-3009 settlement within the validity window", but the recipient and amount are still
whatever the session key signed — bounded only off-chain by the supervisor (`inference.ts` `payTo` /
`maxQuoteFor`), not on-chain. If `SESSION_1271_CALLERS` is ever set to `any`, the exposure widens to
every 1271-consuming protocol (Permit2, other EIP-3009/EIP-2612 tokens, DEX meta-txs).

**Impact.** Defeats the on-chain USDC spend cap and recipient allow-list and the creator pause for the
USDC balance: a compromised session key (or a bug in the off-chain payer) can drain all USDC regardless
of `usdcTransferCap`, `inferencePayTo`, and `pauseAgent`. The dormancy clock is also unaware of such
spends.

**Proof.** `test/security/SessionKeySignaturePath.t.sol` (Base Sepolia fork, kept):
`test_userOpPathEnforcesCapAndRecipient` shows the userOp path rejects an over-cap / wrong-recipient
USDC transfer with `PolicyFailed(0)`; `test_signaturePathUngatedByPolicyAndPauseAndActivity` shows that
after `creator.pauseAgent`, `kernel.isValidSignature(arbitraryDigest, sessionKeySig)` still returns the
ERC-1271 magic value `0x1626ba7e` and `lastActivity` is unchanged, while a non-session signer is
rejected. (The test asserts the ungated-signature property only; it does not move funds. Reading
`Kernel.isValidSignature` + `ValidationManager._checkPermissionSignature`/`_checkSignaturePolicy`
confirms the root validator/hook are never consulted on this path, and `session-key.ts` confirms the
`NOT_FOR_VALIDATE_SIG` / `FOR_ALL_VALIDATION` flags.)

**Recommended fix (concrete).**
- Treat the x402/EIP-3009 authorization as what it is — an unbounded USDC spend — and gate it on-chain
  rather than relying on the off-chain payer. Options, in order of strength:
  - Do **not** fund the kernel with USDC and pay x402 from the session via the userOp path (the capped
    `USDC.transfer(payTo, <=cap)` rule), eliminating the need for the 1271/EIP-3009 settlement path
    entirely; or
  - Add a signature-active policy to the permission that bounds EIP-3009: a dedicated policy that only
    passes `isValidSignature` for digests whose decoded `to == inferencePayTo` and `value <= cap`
    (mirroring the call-policy rule). A generic `checkSignaturePolicy` cannot see the USDC struct, so
    this must be an EIP-3009-aware policy, or the payee must be pinned via `SignatureCallerPolicy` +
    `receiveWithAuthorization` (whose `msg.sender` must equal the payee) instead of
    `transferWithAuthorization`.
- Hard-pin `SESSION_1271_CALLERS` to the USDC address in code (reject `any`) and document that the
  on-chain cap does **not** cover the 1271 path.
- Make the guardian's role explicit in `src/README.md`: pause and the dormancy clock do not cover
  signature-based settlement.

---

### BOOTR-02 — `approveSessionKey` does not constrain the session policy set; the platform admin can seize any treasury at will (High, trust/centralization)

**Location:** `AgentGuardian.sol:181-194` (`approveSessionKey`), with escalation via
`Kernel.changeRootValidator` / `upgradeTo`.

**Description.** `approveSessionKey(kernel, permissionId, validatorData)` is `onlyOwner`. It fixes the
`hook`, `hookData` and `selectorData` (so every session userOp is routed through `executeUserOp` →
`preCheck`), computes the enable digest and marks it approved. **It performs no validation of the
contents of `validatorData`** — it does not require that the session include `BootrCallPolicy`, a spend
cap, a rate limit, or any restriction at all. The owner may therefore approve a session whose only
policy is ZeroDev's `SudoPolicy` (passes every call) with a signer the admin controls, then — with
`ENABLE_MODE_SELF_BUNDLE` the admin signer itself submits `EntryPoint.handleOps`
(`admin-signer.ts:handleOps`, `onboarding.ts:245-246`) — install and drive it. The hook still runs on
such a session, but `preCheck` only checks pause and stamps activity; it does not restrict *what* the
call does. So an unrestricted session = full control of the kernel's funds, available immediately,
entirely independent of the 90-day dormancy gate.

Worse, because `selectorData` is fixed to `execute`, a sudo session can issue
`execute(callTo = kernel, changeRootValidator(...))` (a self-call: `msg.sender == address(this)` passes
`onlyEntryPointOrSelfOrRoot`) and **replace the guardian as root validator**, permanently removing the
creator pause and the dormancy sweep. (The *production* `BootrCallPolicy` session cannot do this: its
rules allow only `feeLocker/router/USDC/WETH` targets with `value==0`, so `target == kernel` is
rejected — this escalation is unlocked solely by the admin's unconstrained `validatorData`.)

This contradicts the trust model as written. `src/README.md` and the brief present admin power as
"approve session keys" + "`claimDormant` after 90 days of inactivity", and present the creator pause and
the immutable fee split as the agent's protections. In reality the admin is full custodian of every
agent treasury from the moment of launch; "dormancy" and "pause" are not meaningful constraints against
a malicious or compromised admin key (the single guardian owner, currently an EOA on Base Sepolia:
`owner() == 0x2C97…D9b3`). The USDC held as "fuel" and any claimed LP fees sitting in the kernel are at
the admin's disposal.

**Impact.** A compromised or malicious `ADMIN` (guardian owner) key drains every agent treasury
immediately, and can permanently de-fang the guardian per-kernel. The dormancy delay provides no
protection against the party that holds this key.

**Proof.** `test/security/GuardianArbitrarySessionPolicy.t.sol` (fork, kept):
`test_ownerCanApproveUnrestrictedSudoSessionDigest` shows the owner (and only the owner) can
`approveSessionKey` a `validatorData` whose sole policy is `SudoPolicy` — the call succeeds, the digest
is marked approved, and `enableDigest(...)` reproduces it, with the guardian performing no inspection of
the policy set. The subsequent install/drain is the standard enable-mode flow already exercised by the
repo's own `test/fork/BootrFork.t.sol::test_sessionKeyEnableActivityPauseRevoke` (which installs a
`SudoPolicy` session and moves state), so the test deliberately stops at the approval property.

**Recommended fix (concrete).**
- Constrain `validatorData` in `approveSessionKey`: require the first policy entry to be the known
  `BootrCallPolicy` address (compare `address(bytes20(permissionEnableData[0][2:22]))`), and reject
  `SudoPolicy` / any unknown policy module. Even a minimal "first entry must be callPolicy, last entry
  must be the ecdsaSigner, length within [N,M]" check closes the sudo path.
- Move the guardian owner behind a timelock and/or multisig, and emit the full policy set in
  `SessionKeyApproved` (it already emits `validatorData`) so installs are externally auditable.
- If platform custody is intended, say so plainly in `src/README.md` and drop the "dormancy protects the
  creator" framing; if it is not intended, the `validatorData` whitelist above is required.

---

### BOOTR-03 — `BuybackBurner.swapAndBurn` is permissionless with a caller-chosen `minOut` (Low)

**Location:** `BuybackBurner.sol:87-93` and `_swapWethForToken` `111-142`.

**Description.** `swapAndBurn(uint256 minTokenOut)` is external and unauthenticated; `minTokenOut` is
passed straight through to the Universal Router as `amountOutMinimum`. Anyone can call it with
`minTokenOut = 1`, so a sandwich bot can move the pool price, let the burner buy at the worst price, and
restore it — destroying value (the burned amount is smaller than it should be) rather than stealing it
directly. Normal operation uses `FeeIn.Clanker`, so the locker converts the burner's WETH share to the
token before it ever reaches the burner; `swapAndBurn` only touches **stray** WETH sent directly to the
clone, which is expected to be ~0. Hence Low, but the function is a standing griefing primitive.

**Impact.** Value-destruction / MEV on any WETH that happens to sit in a burner clone; no theft (proceeds
are burned to `0x…dEaD`).

**Proof.** Source reading: `minTokenOut` is the only slippage control and is caller-supplied;
`_swapWethForToken` has no oracle or pool-state-derived floor. The repo's own
`test/fork/BootrFork.t.sol::test_burnerSwapAndBurnFallback` exercises `swapAndBurn(1)` successfully from
an arbitrary caller.

**Recommended fix.** Either restrict `swapAndBurn` to a keeper/owner, or derive a minimum-out on-chain
from the pool's current `sqrtPrice` (TWAP/quote) and `max(minTokenOut, derivedFloor)`, so a caller
cannot force a 100%-slippage swap.

---

### BOOTR-04 — `claimDormant` only sweeps USDC/WETH/ETH/own-coin; other assets stranded; reverting treasury bricks the sweep (Low)

**Location:** `AgentGuardian.sol:236-262`.

**Description.** The dormant sweep enumerates exactly four assets (USDC, WETH, native ETH, and the
agent's own Clanker coin → burned). Any other ERC-20 the agent accumulated (e.g. a token it swapped
into, or an airdrop) is **not** swept and, once the session keys are revoked, is unreachable forever
(the admin has no generic root-exec function — `_rootCall` is internal and only used by
`claimDormant`/`revoke*`). The ERC-8004 identity NFT is likewise never recovered. Additionally, the ETH
leg is `Execution(treasury, ethAmount, "")` (`:253`): if `platformTreasury` is a contract that reverts
on receiving ETH, the whole batch (and thus the entire sweep) reverts. `platformTreasury` is
admin-controlled, so this is a self-inflicted footgun rather than an attacker lever.

**Impact.** Permanent loss of non-enumerated assets in dormant kernels; a misconfigured treasury blocks
all sweeps.

**Recommended fix.** Accept an admin-supplied `address[] extraTokens` (or a generic
`execFromDormant(Execution[])` guarded by the dormancy check) so arbitrary assets and the identity NFT
can be rescued; send ETH via a low-level call that tolerates failure (or require `treasury` be an EOA /
known receiver). Document the enumeration limit.

---

### BOOTR-05 — Dev-buy executes with zero minimum-out (Low)

**Location:** `BootrLauncher.sol:414-427` (`pairedTokenAmountOutMinimum: 0`), consumed by
`ClankerUniv4EthDevBuy._performDevBuy` (which also swaps with `amountOutMinimum: 1`).

**Description.** When `devBuyWei > 0`, the launch buys the new coin for the creator with no slippage
floor. The buy is atomic with pool creation and the `ClankerMevBlockDelay` module is active, so
same-block sandwiching is blocked; still, it is the creator's funds being spent with `minOut = 0`.

**Impact.** The creator can receive fewer tokens than expected for their dev buy; low given the MEV
module and that it is the creator's own money/choice.

**Recommended fix.** Thread a creator-supplied `devBuyMinOut` into
`Univ4EthDevBuyExtensionData.pairedTokenAmountOutMinimum` (and document that the final token-leg minimum
is fixed at 1 by Clanker's extension).

---

### BOOTR-06 — Burner clone left uninitialized across Clanker's external-call window (Info)

**Location:** `BootrLauncher.sol:252-260`.

**Description.** `launch` clones the burner (`:253`), then calls `clanker.deployToken` (`:257`, which
triggers hooks, the dev-buy extension and MEV module — all external calls), then initializes the burner
(`:259`). The clone's deterministic address is predictable, and during the `deployToken` window it is
deployed but uninitialized, with a public one-shot `initialize`. `launch` is `nonReentrant`, which stops
re-entry into the launcher but not a *third* contract calling `burner.initialize` first; such a call
would make the launcher's own `initialize` revert `AlreadyInitialized`, reverting the whole launch (a
griefing DoS, not a fund theft). This requires a misbehaving Clanker-side contract, which is trusted
infrastructure, so Info.

**Recommended fix.** Initialize the burner from the clone's own constructor/initcode (pass the params
via the clone), or compute the pool key and initialize before `deployToken` where possible, so the clone
is never observable in an uninitialized state. At minimum, note the trust assumption on Clanker.

---

### BOOTR-07 — Enable-digest approval lifetime and revocation semantics (Info)

**Location:** `AgentGuardian.sol:181-199`.

**Description.** `approveSessionKey` binds the digest to `kernel.currentNonce()` at approve time. Any
intervening validation install bumps `currentNonce` (Kernel `_installValidation`), after which the
approved digest no longer matches and the enable userOp fails — a liveness race the supervisor must
sequence carefully (it does: `onboarding.ts` approves then immediately enables). An approved digest never
expires; `revokeSessionKeyApproval` only prevents *future* enables of that digest and does **not** touch
an already-installed session (that needs `revokeSessionKey` / `revokeAllSessionKeys`). Replay is
adequately prevented: the digest commits to `chainId` and the kernel (verifyingContract) and is stored in
`approvedEnableDigests[kernel][...]`, so it is neither cross-chain nor cross-kernel reusable, and because
each successful enable advances `currentNonce` the same digest cannot be re-enabled.

**Recommended fix.** None required; consider auto-expiring approvals (store approve timestamp, reject
enable after N blocks) and documenting that `revokeSessionKeyApproval` is not a revocation of a live
session.

---

### BOOTR-08 — Deploy script footguns (Info)

**Location:** `script/Deploy.s.sol:57-78` (Base-mainnet address block marked "RE-VERIFY ON-CHAIN"),
`:139-150` (ownership handoff).

**Description.** The mainnet `ChainDeps` are copied from the Clanker README and flagged for on-chain
re-verification; `packages/shared/src/addresses.ts` carries the same `TODO(verify …)` markers for the
mainnet fee-conversion locker and Uniswap addresses. A wrong locker/hook/router address on mainnet would
silently misroute funds or fees. Ownership is transferred to `PLATFORM_ADMIN` via `transferOwnership`
(Ownable2Step), so the deployer remains owner until the admin calls `acceptOwnership` on **both**
contracts — a window in which the deployer key holds full BOOTR-02 power. `setLauncher` /
`setPlatformTreasury` are correctly performed by the deployer before the handoff. `ERC8004_IDENTITY` is
correctly required on mainnet (`:76-78`).

**Recommended fix.** Add on-chain assertions in the script (e.g. `clanker.enabledLockers(lpLocker,
hook) == true`, `IClankerHookV2(hook).MAX_LP_FEE()` sane, token/symbol of USDC/WETH) before broadcasting
on mainnet; have the script print and then verify `acceptOwnership` was completed (or use a dedicated
accept step), and minimise the deployer-is-owner window.

---

## What I verified and found sound

- **`BootrCallPolicy` call parsing (userOp path).** The `executeUserOp` wrapper strip, the
  `execute(bytes32,bytes)` ABI offset/length bounds (`:271-282`), single (`target‖value‖data`) and batch
  (`abi.decode(Execution[])`) decoding, `value == 0` and `>=4-byte selector` enforcement, delegatecall
  (`0xff`) and all non-`0x00/0x01` call types rejected, the per-arg `EQUAL`/`LTE` word matching with
  out-of-bounds args failing, and trailing-bytes/ERC-8021 suffix being ignored, all match the Kernel's
  own `ExecLib` decoding. I re-derived the offset arithmetic by hand (no under/overflow given
  `length >= 68`); the policy's view of `executionCalldata` coincides with the Kernel's for any ABI
  offset. The repo's `test/unit/BootrCallPolicy.t.sol` (26 tests) and the fork call-policy session tests
  pass; `test_userOpPathEnforcesCapAndRecipient` (added) re-confirms cap+recipient on the live path.
- **ERC-7562 associated-storage property.** `Config` is a fixed-size 73-slot struct under
  `mapping(bytes32 id => mapping(address kernel => Config))`; the base
  `keccak(kernel ‖ keccak(id ‖ 0)) + n (n<73<128)` is valid associated storage for the sender (kernel),
  and `checkUserOpPolicy` reads nothing else and uses no banned opcodes. `onUninstall` idempotency and
  `installedCount` isolation hold. (`test_validationReadsOnlyAssociatedStorage`,
  `test_installMaxRulesAndArgsUsesExactlyConfigSlots` pass.)
- **Guardian root-path gating.** `preCheck` allows the direct path only while `_rootCall` is in flight
  for that exact kernel (`_rootCallKernel == msg.sender && sender == address(this)`), rejects the
  EntryPoint path when paused and stamps activity otherwise, and rejects all other direct callers
  (`UnauthorizedCaller`). `validateUserOp` always fails (no root userOps). The enable-mode
  `isValidSignatureWithSender` honours only pre-approved digests for the asking kernel and only when
  unpaused, and rejects the ERC-1271-shaped call (sender != kernel). I reproduced the `Enable` typehash
  (`0xb17a…c505`) and the EIP-712 domain typehash on-chain; the digest construction matches Kernel v3.1
  `_enableDigest` exactly (and `session-key.ts`'s two independent encoders). Cross-kernel/cross-chain
  replay is prevented.
- **Dormancy timing & reentrancy.** `claimDormant` is `onlyOwner nonReentrant`, correctly gates on
  `lastActivity + dormancyPeriod`, snapshots balances, and the root-path execute neither stamps activity
  nor (for the admin's own calls) resets the clock. Pause never moves funds or resets the clock, and
  paused agents can still be swept. Activity is stamped only on the genuine EntryPoint `executeUserOp`
  path.
- **Fee-split immutability.** Every `rewardAdmins[i]` is the launcher and the launcher exposes no
  pass-through to `updateRewardRecipient/Admin/FeePreference` or the token's `updateAdmin/Image/Metadata`;
  `tokenAdmin` is the launcher. Confirmed by the locker's `onlyRewardAdmin` checks and the fork test
  `test_launcherOwnerCannotChangeRewards`.
- **Launch integrity.** Salt namespacing `keccak(creator, p.salt)` (creator in both the kernel salt and
  the Clanker token salt, `tokenAdmin` constant) prevents cross-creator collisions and makes replays
  revert atomically; `registerAgent` requires `rootValidator() == validatorId(guardian)`; excess ETH is
  refunded last under `nonReentrant`; param checks precede external calls; `onERC721Received` is
  implemented for the identity mint. Bps invariants (`_setDefaults`) are exhaustively fuzzed.
- **Clone pattern.** `MinimalClones` is the standard EIP-1167 CREATE2 bytecode; the implementation is
  locked (`BuybackBurner` constructor sets `initialized = true`); `predictBurner` matches.
- **MockKernel fidelity.** The unit `MockKernel` faithfully mirrors the Kernel v3.1
  `onlyEntryPointOrSelfOrRoot` hook wrapping I read in the vendored source.

## Open questions

1. **x402 / EIP-3009 bound (BOOTR-01).** Is the on-chain unboundedness of the signature path a conscious
   decision (trusting the off-chain payer and `SignatureCallerPolicy`), or was the USDC cap intended to
   bound *all* USDC movement? If the former, `src/README.md` should say so; if the latter, BOOTR-01's fix
   is required. Also: is `receiveWithAuthorization` (payee == `msg.sender`) usable instead of
   `transferWithAuthorization` to pin the payee on-chain?
2. **Custody model (BOOTR-02).** Is platform custody of agent treasuries intended? If yes, the
   "dormancy/pause protects the creator" language is misleading; if no, `approveSessionKey` must whitelist
   the policy set. What is the production guardian owner (EOA vs multisig/timelock)? On Base Sepolia it is
   an EOA.
3. **Mainnet addresses (BOOTR-08).** Have the Base-mainnet Clanker fee-conversion locker, hooks, dev-buy
   extension, MEV module, Universal Router and the ERC-8004 registry been verified on-chain? Several are
   still `TODO(verify)` in `addresses.ts`.
4. **ERC-8004 identity recovery.** Is it acceptable that the identity NFT and `agentURI` are frozen
   post-launch (no session rule or admin path can `setAgentURI` or transfer it), including in a dormant
   sweep?

## Tests added (kept)

All under `packages/contracts/test/security/` (Base Sepolia fork; `BASE_SEPOLIA_RPC_URL` or
`https://sepolia.base.org`). All pass; the full suite is 51 passing / 0 failing.

- `SecurityForkBase.sol` — shared fixture (deploys the stack, launches one agent, installs the four
  production `BootrCallPolicy` rules via the guardian enable-mode path, ERC-1271 signing helpers). *Note:
  I fixed a memory-aliasing bug in this fixture's `setUp` where `LaunchDefaults memory b = d;` aliased
  `d` and corrupted the standard preset — it now builds the buyback preset as an independent literal.*
- `SessionKeySignaturePath.t.sol` — proof for BOOTR-01 (userOp path enforces cap+recipient; signature
  path does not, and is ungated by pause/activity). Useful as a regression test.
- `GuardianArbitrarySessionPolicy.t.sol` — proof for BOOTR-02 (owner can approve an unrestricted
  SudoPolicy session digest; guardian performs no policy-shape check). Useful as a regression test.
