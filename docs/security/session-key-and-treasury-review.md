# Bootr agent-wallet layer: session key and treasury security review

> **Historical (2026-10-27).** Written against the Clanker v4 fee locker. Fee claims now go through the RWAGMI v3
> locker (`settleAndClaim` / `claimQuote`, `to` = kernel); see `docs/rwagmi-migration.md`.
>
> **Status update (2026-10-29).** The findings are kept as written. Facts that moved since: the session key's call
> allow-list is now five `BootrCallPolicy` rules (RWAGMI `settleAndClaim` and `claimQuote` with `to == kernel`, WETH
> approve to the swap helper, `swapWethToUsdc`, windowed `USDC.transfer(spender, ...)`; layout version 2 in
> `apps/supervisor/src/session-key.ts`), the signer is installed with `SKIP_SIGNATURE` so there is no ERC-1271 path
> (C-01), and `addresses.ts` has the mainnet ZeroDev modules, ERC-8004 registries and Bootr contracts (the `null`
> mainnet entries mentioned under "Open questions" are filled). Session keys installed before this release keep the
> Clanker-era rule layout until they are rotated.

- Scope: `apps/supervisor` (session-key construction, onboarding, kernel client, treasury, inference, broker, runtime, tick, web reader, admin API, HMAC, admin signer, entrypoint helpers), `packages/agent-core` (tools, types, prompt, broker, checkpoint, eligibility), `apps/inference/src/client/x402-payer.ts` plus the relay side it talks to (`apps/inference/src/{app,x402,reconcile,request}.ts`), `packages/shared/src/addresses.ts`, and the on-chain modules the supervisor depends on (`packages/contracts/src/{AgentGuardian,BootrCallPolicy}.sol`, `packages/contracts/src/README.md`).
- Reviewed at commit `f0b2f4c` (branch `main`), 2026-10-27. Static review only; no code was changed, no keys were read. While this review was being written the working tree gained uncommitted changes (X-account draft-id onboarding in `onboarding.ts`, `sender-client.ts`, `abi.ts`, `db/schema.ts`, and sender/web files); they touch the X-connect flow, not the session-key, treasury or inference paths, and were not reviewed.
- Kernel v3.1 and the ZeroDev policy contracts are not vendored in the repository. Statements about their behaviour are from the published sources as I know them and are marked "verify" where the conclusion depends on them. Every such point is listed again under "Open questions".
- Loss figures are formulas plus one illustrative fleet (100 agents, 20 USDC fuel + 0.02 WETH each, ETH at 3,000 USD). Substitute real balances; the shape of the result does not change.

## 1. Summary

| Severity | Count | Ids |
| --- | --- | --- |
| Critical | 3 | C-01, C-02, C-03 |
| High | 2 | H-01, H-02 |
| Medium | 7 | M-01 .. M-07 |
| Low | 8 | L-01 .. L-08 |
| Informational | 5 | I-01 .. I-05 |

The on-chain policy set is well built for its stated purpose (model-driven treasury actions cannot leave the kernel's economic perimeter; see "Verified sound"), but it was designed against a misbehaving *model*, not against a compromised *supervisor host*. Against the host-compromise threat the two policies that matter most are absent:

1. The ERC-1271 path has no content policy at all. With `SESSION_1271_CALLERS=any` the session signer can produce a valid kernel signature for any EIP-712 message, and USDC on Base accepts ERC-1271 for `transferWithAuthorization` / `receiveWithAuthorization`. One transaction per kernel, submitted by anyone, moves the entire USDC balance to any address, with no rate limit, no gas policy and no userOp (C-01).
2. `UniversalRouter.execute(bytes,bytes[],uint256)` is allow-listed with no argument rules, and `WETH.transfer(universalRouter, *)` is allow-listed. A single paymaster-sponsored userOp moves the entire WETH balance to any address (C-02).

Both are fixable without giving up x402 or the Universal Router (section 4). The third Critical is organisational: the guardian owner key (`ADMIN_PRIVATE_KEY`), which can install a sudo session on any kernel, lives in the same process and the same `.env` as the session key, so "session key compromise" and "root compromise of every treasury" are the same event today (C-03).

## 2. System as reviewed

```
creator ──launch──> BootrLauncher ──> Kernel v3.1 (root validator + hook = AgentGuardian)
                                         │  USDC (fuel), WETH + own coin (LP fees), a little ETH
                                         │
   supervisor host (one process, one .env) ─────────────────────────────────────────────────
   │  SESSION_SIGNER_PRIVATE_KEY  (one EOA, installed on EVERY kernel as a permission)
   │  ADMIN_PRIVATE_KEY           (guardian owner: approveSessionKey / revoke* / handleOps)
   │  SENDER_SERVICE_KEY          (HMAC to sender + indexer; also the supervisor admin API key)
   │
   ├─ userOps  ──> CDP bundler + paymaster ──> EntryPoint ──> Kernel.executeUserOp
   │     policies (userOp path): BootrCallPolicy(4 rules) · GasPolicy(0.1 ETH) · RateLimit(60/h) · Timestamp(30 d)
   ├─ ERC-1271 ──> x402 relay ──> facilitator (off-chain verify via ERC-6492) ──> USDC.transferWithAuthorization
   │     policies (signature path): Timestamp(30 d) only   [SignatureCallerPolicy disabled]
   └─ admin txs ──> AgentGuardian (approve / revoke / claimDormant) and EntryPoint.handleOps (self-bundle)
```

Permission layout per kernel (`session-key.ts`): `BootrCallPolicy` (NOT_FOR_VALIDATE_SIG), `GasPolicy` (NOT_FOR_VALIDATE_SIG), `RateLimitPolicy` (NOT_FOR_VALIDATE_SIG), `TimestampPolicy` (FOR_ALL_VALIDATION), optional `SignatureCallerPolicy` (NOT_FOR_VALIDATE_USEROP, omitted in production), `ECDSASigner` (FOR_ALL_VALIDATION). The call rules are exactly `FeeLocker.claim(kernel,*)`, `UniversalRouter.execute(bytes,bytes[],uint256)` (no arg rules), `USDC.transfer(INFERENCE_PAYTO, <= 50 USDC)`, `WETH.transfer(universalRouter,*)`; every call must carry zero value; delegatecall is rejected.

## 3. Findings

Severity reflects impact under the stated threat model (host or key compromise is in scope), not likelihood alone.

### Critical

#### C-01 — Session signer compromise drains all USDC of every kernel through EIP-3009 + ERC-1271 (no signature policy)

- **Status: Fixed** with option (b), the per-agent spender. Option (a) is impossible on the deployed Kernel v3.1: `_checkSignaturePolicy` re-reads the original signature slice after the policies, so any policy-signature slot on the ERC-1271 path reverts `SignerPrefixNotPresent` (proven live in `packages/contracts/test/security/RevocationFork.t.sol`). Instead the session permission's signer is installed with `SKIP_SIGNATURE` (0x0002 becomes the permission's `permissionFlag`), so `Kernel.isValidSignature` reverts `PermissionNotAlllowedForSignature` for it: the kernel has no ERC-1271 path at all (`session-key.ts`, `kernel.ts` refuses `signTypedData`/`signMessage`). x402 payments are signed by a per-agent spender EOA derived from `SPENDER_MASTER_KEY` (`apps/supervisor/src/spender.ts`, `sv_agents.spender`), which the session key may only fund through `USDC.transfer(spender, SUM_PER_WINDOW <= SESSION_USDC_TRANSFER_CAP per SESSION_USDC_WINDOW_SECONDS)` enforced on-chain by `BootrCallPolicy` (`WindowedCapFork.t.sol`). Exposure of a leaked session key: the window cap into an account it does not control; of a leaked spender key: that agent's float.

- Location: `apps/supervisor/src/session-key.ts` (`buildPolicies`: `signatureCallers === null` -> no caller policy; `BootrCallPolicy` flagged `NOT_FOR_VALIDATE_SIG`), `apps/supervisor/src/kernel.ts` (`wrapAndSign` signs any hash), `apps/supervisor/src/config.ts` (`SESSION_1271_CALLERS`), `.env.example` (`SESSION_1271_CALLERS=any`), `apps/supervisor/README.md`.
- Description: the only policy that runs on the ERC-1271 path is `TimestampPolicy`. The kernel wraps the hash (`Kernel(bytes32 hash)`) and the `ECDSASigner` checks the session EOA's signature over the wrapped hash; nothing inspects what the hash is. The off-chain payee check in `x402-payer.ts` (`allowedPayTo`) only constrains the supervisor's own code path. USDC on Base (FiatTokenV2_2) validates `transferWithAuthorization` / `receiveWithAuthorization` / `cancelAuthorization` with `SignatureChecker`, i.e. it calls `kernel.isValidSignature` for a contract `from`. The `SignatureCallerPolicy` that would restrict `msg.sender` of `isValidSignature` to USDC is deliberately disabled because the facilitator verifies through ERC-6492 off-chain (README), and even if it were enabled it would not restrict the `to` or `value` of the authorization: USDC itself is the caller at settlement.
- Attack path:
  1. Attacker obtains `SESSION_SIGNER_PRIVATE_KEY` (host compromise, leaked `.env`, backup, CI log, insider).
  2. For each kernel `K` (addresses are public: `AgentLaunched` events, `GET /internal/agents`): build the USDC EIP-712 `TransferWithAuthorization{from: K, to: attacker, value: USDC.balanceOf(K), validAfter: 0, validBefore: now + 1h, nonce: random}` digest, wrap it as `hashTypedData(Kernel domain of K, Kernel(bytes32 hash))`, sign with the session EOA, encode `0x02 ‖ permissionId ‖ 0xff ‖ sig` (`encodeErc1271Signature`; the permissionId is on-chain in `SessionKeyApproved` events and in `GET /internal/agents`).
  3. Call `USDC.transferWithAuthorization(K, attacker, value, ..., sig)` from any EOA. One multicall contract can do every kernel in one transaction. Nothing goes through the EntryPoint, so `RateLimitPolicy`, `GasPolicy`, `BootrCallPolicy` and the guardian hook (`preCheck`, pause) never run. A creator's `pauseAgent` does not block this either.
- Impact: per agent `L_usdc = USDC.balanceOf(kernel)`; across the fleet `sum(L_usdc)`. Time to drain: one block. Attacker cost: ~50k gas per kernel. Illustrative fleet: 100 x 20 USDC = 2,000 USDC in one transaction. The fee policy refuels USDC from WETH every tick (`FUEL_TARGET_USDC`), so with a persisting key the attacker also harvests future refuels until the permission expires or is uninstalled (see H-01 for why `revokeAllSessionKeys` may not stop this).
- Fix (pick one; (a) is the strongest, (b) the quickest):
  - (a) On-chain content policy for signatures: a `BootrAuthorizationPolicy` (ERC-7579 policy, `checkSignaturePolicy` only, flagged `NOT_FOR_VALIDATE_USEROP`). The signature's policy-data slot (Kernel's `policySigs` prefix before `0xff`) carries the pre-image fields `(to, value, validAfter, validBefore, nonce)`; the policy recomputes the USDC `TransferWithAuthorization` struct hash, the USDC domain separator (name "USD Coin", version "2", chainid, USDC address; all constants or `block.chainid`, which is allowed on the signature path), then the kernel wrapper `Kernel(bytes32)` over the kernel domain (`msg.sender`, version "0.3.1"), and requires equality with the hash it is given. Rules: `to == INFERENCE_PAYTO`, `value <= cap`, `validBefore - validAfter <= maxWindow`. Any other message fails. This makes the signature path as constrained as the userOp path and keeps x402/ERC-6492 untouched (the facilitator still just calls `isValidSignature`).
  - (b) Separate x402 spender: per agent, a plain EOA (or a second kernel without the WETH/router rules) that signs EIP-3009 as the payer. The treasury kernel tops it up with the already allow-listed `USDC.transfer(spender, <= cap)` rule (replace `INFERENCE_PAYTO` with the spender address in the rule; the payer then pays the relay from the spender). The 1271 vector disappears entirely (the kernel never signs anything), and the bearer-instrument exposure of M-05 is bounded by the spender's float (e.g. 5-10 USDC). Cost: one extra sponsored userOp per top-up, a small amount of float per agent, and per-agent spender keys (which, if derived in an HSM/Turnkey-style signer with an EIP-712 policy "domain == USDC && to == payTo && value <= cap", are themselves safe against host compromise).
  - (c) If neither can ship before mainnet: keep the USDC fuel per kernel at the minimum (`FUEL_TARGET_USDC` low, no large creator top-ups), which caps `L_usdc`, and treat C-01 as accepted risk in writing.

#### C-02 — Session signer compromise drains all WETH (and claimable fees) through the unconstrained Universal Router rule

- **Status: Fixed** in `packages/contracts/src/BootrSwapHelper.sol` (option (a): immutable helper, output to `msg.sender` only, Chainlink floor with a 3% cap and 1 h staleness) and `apps/supervisor/src/session-key.ts` / `treasury.ts` (rules are now `WETH.approve(helper, *)` + `helper.swapWethToUsdc(*, *)`; the router and `WETH.transfer` rules are gone). Proof: `test/fork/SwapHelperFork.t.sol`, `test/fork/BootrFork.t.sol`. Requires deploying the helper (`bootr.swapHelper`) and rotating every session key.

- Location: `apps/supervisor/src/session-key.ts` (`callPolicyRules`: rule 2 `UniversalRouter.execute(bytes,bytes[],uint256)` with `args: []`; rule 4 `WETH.transfer(universalRouter, *)`), `apps/supervisor/src/treasury.ts` (`encodeSwapCalls`, the only honest producer of these calls; "route encoding is validated off-chain by treasury.ts").
- Description: the router rule allows any `commands`/`inputs`. The Universal Router is a generic executor: `V3_SWAP_EXACT_IN(recipient, …)` pays the output to any `recipient`; `SWEEP(token, recipient, 0)`, `TRANSFER(token, recipient, amount)`, `PAY_PORTION`, `UNWRAP_WETH(recipient, 0)`, `V4_SWAP` with a `TAKE(currency, recipient, amount)` action, and `EXECUTE_SUB_PLAN` all move whatever the router holds to an arbitrary address. The WETH rule lets the session key put the kernel's WETH into the router first. Both calls fit in one batched userOp, and the CDP paymaster sponsors it.
- Attack path: one userOp per kernel: `[WETH.transfer(router, WETH.balanceOf(K)), router.execute(0x04 /*SWEEP*/, [abi.encode(WETH, attacker, 0)], deadline)]`. Optionally preceded by `FeeLocker.claim(K, WETH)` in the same batch to harvest unclaimed fees. The op passes `BootrCallPolicy` (both targets/selectors/args allowed, zero value), `GasPolicy` (first op of the permission), `RateLimitPolicy` (1 of 60), `TimestampPolicy`, and the guardian hook stamps activity. Sent through any bundler; sponsored by the paymaster if configured.
- Impact: per agent `L_weth = WETH.balanceOf(kernel) + FeeLocker.availableFees(kernel, WETH)`; fleet `sum(L_weth)`. Time: one block per kernel (60 kernels per hour per permission is irrelevant: it is one op per kernel). Illustrative fleet: 100 x 0.02 WETH = 2 WETH ≈ 6,000 USD. Not reachable through this rule: the agent's own coin (no transfer/approve rule, Permit2 has no allowance), ETH (value must be 0, no `WETH.deposit`), the ERC-8004 identity NFT.
- Fix (design options, in order of preference):
  - (a) Bootr-owned swap helper: a small immutable contract `TreasurySwapHelper.swapWethToUsdc(uint256 amountIn, uint256 minOut, uint256 deadline)` that pulls nothing (the kernel transfers WETH to it first, exactly like today with the router), swaps WETH->USDC through the router or the v4 PoolManager with `recipient = msg.sender`, sweeps any leftover WETH/USDC back to `msg.sender`, and reverts if `minOut < oracleFloor(amountIn)` where the floor is derived on-chain from Chainlink ETH/USD with a bounded slippage (e.g. 97%) and a staleness check. Replace rules 2 and 4 by `WETH.transfer(helper, *)` and `helper.swapWethToUsdc(*)`. With this, a compromised session key can only ever convert WETH into USDC inside the kernel, and the oracle floor removes the "set minOut=0 and sandwich yourself" extraction (bounded to ~3% per swap, once, since USDC cannot be swapped back).
  - (b) If the router must stay: add argument rules that are actually enforceable. `BootrCallPolicy` only checks static words, and `execute`'s arguments are all dynamic, so this requires a new rule type (e.g. a `bytes32 keccak(commands)` equality plus a check that the v3 input's `recipient` word equals the kernel). That is a policy change with more surface than (a); I would not recommend it.
  - (c) Interim: lower `FUEL_TARGET_USDC` does not help here; instead, claim fees less eagerly (WETH sits in the FeeLocker, where only `claim(kernel, *)` can move it, always to the kernel) and swap promptly after claiming so the kernel's WETH float is small. This reduces `L_weth` but not the exposure class.

#### C-03 — Guardian owner key is hot, co-located with the session key, and can install an unrestricted session on every kernel

- **Status: Open** (excluded from this batch by decision: no template-restricted `approveSessionKey`, no multisig / timelock change).

- Location: `apps/supervisor/src/admin-signer.ts` (`createLocalAdminSigner`, `privateKeyToAccount(ADMIN_PRIVATE_KEY)`), `apps/supervisor/src/service.ts`, `apps/supervisor/src/config.ts`, `packages/contracts/src/AgentGuardian.sol` (`approveSessionKey` accepts arbitrary `validatorData`; `onlyOwner` setters `setPlatformTreasury`, `setLauncher`; `claimDormant`).
- Description: `approveSessionKey(kernel, pid, validatorData)` approves whatever `validatorData` the owner passes. A `validatorData` of `[SudoPolicy, ECDSASigner(attacker)]` yields a session that may call anything on the kernel (`execute` with any target, including `USDC.transfer`, `token.transfer`, `identityRegistry.transferFrom`, ETH value transfers), and the enable-mode op can be self-bundled from the attacker's own EOA. The README notes the signer can be "swapped for KMS later", but today the key is a hex string in the same `.env` as `SESSION_SIGNER_PRIVATE_KEY`, loaded by the same process, and it is needed routinely (every onboarding, every rotation, every self-bundled enable op), so it cannot be cold.
- Attack path: host compromise -> read both keys -> for each kernel: `approveSessionKey(K, pid', sudoValidatorData)`, self-bundle the enable op (`EntryPoint.handleOps`, prefund from the kernel's ETH or the attacker's deposit), then `execute` arbitrary batches. Alternatively `setPlatformTreasury(attacker)` and wait for `claimDormant` eligibility, or simply never stamp activity and claim after `dormancyPeriod`.
- Impact: total loss of every asset of every kernel (USDC, WETH, own coin, ETH, identity NFT), plus the platform treasury redirect. Fleet-wide, bounded only by total TVL. This is strictly larger than C-01 + C-02.
- Fix:
  - Separate the roles on-chain. Add an `installer` role to `AgentGuardian` that can only approve digests built by the guardian itself from an owner-registered template: `approveSessionKeyFromTemplate(kernel, pid, sessionSigner)` where the guardian stores (owner-set, event-logged) the ordered policy module list and the `BootrCallPolicy` rule template with placeholders for `kernel` and `sessionSigner`, assembles `validatorData` in Solidity, and approves that digest. The hot supervisor key then holds only `installer`; the owner (a multisig, ideally behind a timelock) changes templates, treasuries and revocations. The supervisor already verifies the digest locally (`enableDigest`), so the client change is small.
  - Until then: move `ADMIN_PRIVATE_KEY` to a KMS/HSM signer (the `AdminSigner` interface already isolates it), run approvals from a separate process/host from the session signer, require an operator step (or a second signature) per approval, and alert on every `SessionKeyApproved` whose `validatorData` does not match the expected template (an indexer check is cheap: decode the entries, compare module addresses and `rulesOf`).
  - `claimDormant` and `setPlatformTreasury` should be timelocked or require a two-step owner (`Ownable2Step` already exists for ownership itself).

### High

#### H-01 — Revocation does not reliably close the signature path, and revoked permissions may be re-installable

- **Status: Fixed.** Fork tests (`test/security/RevocationFork.t.sol`) answer the open questions: (1) Kernel v3.1 `isValidSignature` ignores `validNonceFrom`, so a nonce bump alone does not close the signature path of a legacy permission; production permissions have no signature path (signer `SKIP_SIGNATURE`), so for them `revokeAllSessionKeys` is complete; legacy permissions need `revokeSessionKey`. (2) Kernel rejects re-enabling an uninstalled ValidationId (`InvalidNonce`); as defence in depth `AgentGuardian.revokeSessionKey` now withdraws the digest approved for that permission (`approvedDigestOf`). (3) `AgentGuardian.revokeAllSessionKeysBatch(address[])` plus `POST /internal/agents/panic-revoke` (nonce bump per 40 kernels, then uninstall per agent, runtimes paused) and the runbook in `apps/supervisor/README.md`. Requires redeploying guardian + launcher.

- Location: `packages/contracts/src/AgentGuardian.sol` (`revokeAllSessionKeys` = `invalidateNonce`, `revokeSessionKey` = `uninstallValidation`, `revokeSessionKeyApproval` exists but is never called by the supervisor), `apps/supervisor/src/onboarding.ts` (`rotateSessionKey`: installs the new permission, then best-effort `revokeSessionKey`; never revokes the old enable digest; same signer EOA), `apps/supervisor/README.md` ("revokeAllSessionKeys … kills every non-root validation").
- Description (three parts):
  1. `invalidateNonce` is checked by Kernel on the userOp path (`validateUserOp` compares `validationConfig[vId].nonce` with `currentNonce`). From my reading of Kernel v3.1, `isValidSignature` does not perform that comparison: it decodes the permission id and runs `_checkPermissionSignature` against the still-installed policies and signer. If that is right, `revokeAllSessionKeys` leaves C-01 fully open; only `revokeSessionKey` (which uninstalls the policies and the `ECDSASigner`, clearing its stored signer) closes it. **Verify with a fork test**: sign a USDC authorization, call `revokeAllSessionKeys`, then `eth_call isValidSignature`.
  2. `approvedEnableDigests[kernel][digest]` is set on approval and never cleared on use or on revocation. The digest binds `(vId, kernel nonce, hook, validatorData)`. After `revokeSessionKey` (nonce unchanged), the holder of the session EOA (the same EOA for every permission ever installed) can re-submit an enable-mode userOp with the old `validatorData` and the old digest and re-install the revoked permission. **Verify**: whether Kernel's `_installValidation` rejects re-enabling a `vId` whose config was cleared by `uninstallValidation` while `currentNonce` is unchanged. Even if Kernel rejects it, the approval should be revoked on uninstall as defence in depth.
  3. Rotation (`rotateExpiringSessionKeys`) changes the permission id and validity window but not the signer. It therefore bounds the lifetime of a permission (and of its approved digest) but provides zero protection against a leaked key. "To rotate the signer EOA itself, change `SESSION_SIGNER_PRIVATE_KEY` and rotate every agent" means: for `N` kernels, `N` admin approvals + `N` enable ops + `N` uninstalls, sequential, in the tick loop, with `MAX_AGENTS_PER_TICK` and 60 s ticks, while the attacker needs one block. There is no "panic" path and no admin endpoint that revokes everything.
- Attack path: attacker drains (C-01/C-02) within seconds of key exposure; operator notices, runs `revokeAllSessionKeys` per kernel; USDC authorizations keep settling (part 1); or operator runs `revokeSessionKey` per kernel, attacker re-enables (part 2).
- Impact: extends the window of C-01/C-02 from "until the operator reacts" to "until every kernel's permission is uninstalled and every old digest is revoked, or 30 days". With the fleet example and a one-hour response, the extra exposure is every refuel and fee claim in that hour per kernel.
- Fix: (1) make `revokeSessionKey` also call the equivalent of `revokeSessionKeyApproval` for the digest it was installed with (store the digest per `(kernel, vId)` at approval time); (2) add `revokeAllSessionKeysBatch(address[] kernels)` and an admin API endpoint that revokes every active permission by `uninstallValidation` (not just the nonce bump) from a pre-signed or KMS-held key, with a tested runbook and a target of minutes for the whole fleet; (3) after the C-01 fix the signature path is bounded anyway, but keep (1) and (2); (4) document that the TimestampPolicy expiry is the only guaranteed backstop today.

#### H-02 — One hot session EOA for every kernel; no key isolation per agent

- **Status: Open** (not in this batch).

- Location: `apps/supervisor/src/service.ts` (`privateKeyToAccount(config.SESSION_SIGNER_PRIVATE_KEY)` shared by every `KernelClient`), `apps/supervisor/src/onboarding.ts` (`sessionSigner: ctx.sessionSigner.address` in every policy), `packages/contracts/src/BootrLauncher.sol` (`supervisorSessionKey` is an informational launch parameter, so the address is public by design).
- Description: the blast radius of any leak is the whole fleet, the key is in process memory of a long-running Node service that also executes model-driven network fetches (`read_url`, `search_web`, bundler/paymaster/relay/indexer/sender clients) and parses untrusted HTML, and it signs raw hashes (`sessionSigner.sign({hash})`) on request. The public address makes targeting trivial. Rotation (H-01 part 3) is not a mitigation.
- Impact: converts any single RCE, SSRF-to-metadata, dependency compromise or operator mistake into C-01 + C-02 across all agents.
- Fix: per-agent signers that never leave a policy-enforcing signer service: Turnkey/Privy/Fireblocks-style or CDP Server Wallets with policies ("may sign userOps whose `sender` is kernel K; may sign EIP-712 only for domain USDC with `to == payTo && value <= cap`"), or AWS KMS keys per agent (one `KeyId` per kernel; the supervisor holds only an IAM role). The `KernelClient` takes a `LocalAccount`; replacing it with a remote signer that implements `sign`/`signTypedData` is a contained change. Until then, at minimum run the signer in a separate process with a narrow IPC API (`signUserOp(kernel, hash)`, `signAuthorization(kernel, to, value, …)` with the policy checks in that process), so that the main supervisor process never holds the key.

### Medium

#### M-01 — Whoever controls the model output controls every agent's treasury actions within policy (relay, upstream provider, prompt injection)

- Location: `apps/supervisor/src/runtime.ts` (`parseAction` executes the first tool call returned by the relay), `apps/supervisor/src/inference.ts`, `apps/supervisor/src/broker/index.ts` (`treasuryPrepare`), `packages/agent-core/src/prompt/system-prompt.ts` (rules are advisory).
- Description: the relay returns the assistant message; the supervisor executes the tool it names. A compromised relay, a compromised upstream provider account, or a successful prompt injection (through mentions from verified accounts, `read_x_thread`/`read_x_account` of any public post, `read_url`, `search_web`, `read_market` strings from the indexer) has the same power. What that power can do on-chain is bounded by the policies: swap WETH->USDC into the kernel with `maxSlippageBps` up to 500 (`treasuryPrepare` clamps at 500), and transfer USDC to `INFERENCE_PAYTO` at 50 USDC per op. There is no cumulative cap per hour/day on either.
- Attack path (prompt injection, worst case): a verified account mentions the agent with text that steers it into `treasury_prepare{transfer, 50}` + `treasury_execute` repeatedly: 4 transfers per turn (8 steps), `finish` with `nextAt = now + 60 s`, repeat; or into swapping all WETH at 5% slippage while the attacker sandwiches the pool.
- Impact: USDC flows to the operator's `INFERENCE_PAYTO` (recoverable by the operator but a forced-spend/denial that puts the agent to sleep at < 1 USDC); up to ~5% of the WETH balance extractable once by sandwich (USDC cannot be swapped back). Socially: harmful posts, disclosure of private notes (`remember`/`recall` content is included in observations). The relay additionally sees every prompt (identity, owner rules, memory, agenda, observations, treasury balances).
- Fix: (1) a cumulative USDC spend rule in `BootrCallPolicy` (per `(id, kernel)`: `spentInWindow`, `windowStart`, writes to associated storage are allowed in validation; `block.timestamp` is not, so use the EntryPoint-provided `validUntil`/`validAfter` pattern or a block-number window) so that `fund_model` is bounded per period, not per call; (2) an on-chain min-out floor in the swap helper (C-02 fix) so slippage is not model-controlled; (3) off-chain, a per-agent daily budget for `fund_model` in `treasuryPrepare` and a rate limit on `swap` ops of model origin; (4) treat "verified badge" as what it is (an 8 USD purchase), not as a trust signal; (5) note in the threat model that the relay/upstream is a full-control dependency.

#### M-02 — `USDC.transfer` cap is per call, not per userOp or per period

- **Status: Fixed** in `packages/contracts/src/BootrCallPolicy.sol`: bounds are summed across every call of a batch that matches the same rule, and the USDC rule is now `SUM_PER_WINDOW` (op 3): a cumulative cap per rolling window kept on-chain (`windowEnd`/`spent` per argument, fixed grid anchored at install, rolled with the signer's time claim in the policy-signature slot and the EntryPoint's `validAfter`/`validUntil` check). The recipient is the agent's spender, never an operator address. This also provides the per-period cap asked for in M-01 (1). Unit + fuzz + `WindowedCapFork.t.sol`.

- Location: `apps/supervisor/src/session-key.ts` (rule 3, `lteUint(1, usdcTransferCap)`), `packages/contracts/src/BootrCallPolicy.sol` (`_checkCallData` batch loop: every call must match a rule; no aggregation), `apps/supervisor/README.md` ("at most 50 USDC per op" is not what the chain enforces).
- Description: a batch userOp with `k` calls `USDC.transfer(payTo, 50 USDC)` passes the policy; `k` is bounded only by gas (`GasPolicy` allowance and the bundler). With the session key an attacker can push an entire USDC balance to `INFERENCE_PAYTO` in one op (not to themselves, so this is griefing/forced spend, and the operator can refund). The model-driven path cannot batch (one call per prepared op), so this is a key-compromise finding only.
- Impact: per kernel, full USDC balance to the operator address per op, 60 ops/h; moot while C-01 exists, relevant after C-01 is fixed.
- Fix: in `BootrCallPolicy`, either reject batches that contain more than one call matching a rule flagged "single per op", or implement the cumulative-spend rule from M-01. Fix the README wording until then.

#### M-03 — Admin API: shared HMAC key, 5-minute replay window, no nonce, no rate limit

- Location: `apps/supervisor/src/hmac.ts` (`MAX_SKEW_SEC = 300`, no nonce/jti), `apps/supervisor/src/config.ts` (`SUPERVISOR_SERVICE_KEY ?? SENDER_SERVICE_KEY`), `apps/supervisor/src/api.ts`, `apps/supervisor/src/service.ts` (`IndexerClient` and `SenderClient` both use `SENDER_SERVICE_KEY`).
- Description: with the default, every service that holds `SENDER_SERVICE_KEY` (sender, indexer, and whatever else signs to them) can call the supervisor's `/internal/*`. A captured request (TLS termination, logs, proxies) can be replayed for 5 minutes. The endpoints can: pause/resume runtimes, force ticks, force reconciliation, `session/install` and `session/rotate` (each costs an admin transaction, a kernel prefund when self-bundling, and accumulates approved digests; see H-01), and read full agent rows (config, memory/agenda/summary in `runtime.state`, pending actions, treasury ops). There is no rate limit.
- Impact: lateral movement from any sibling service to supervisor admin; gas/prefund burn by replaying `rotate`; availability (pause); disclosure of agent private state.
- Fix: require a distinct `SUPERVISOR_SERVICE_KEY` (fail closed if equal to `SENDER_SERVICE_KEY`); add a nonce (`jti`) with a short replay cache or make the signed string include a per-request UUID header and reject duplicates within the skew window; rate limit `session/*`; keep `session/*` behind a separate, higher-privilege key or remove them from the HTTP surface in favour of a CLI run by an operator.

#### M-04 — `read_url` is subject to DNS rebinding and has minor private-range gaps; recalled notes are not marked untrusted

- Location: `apps/supervisor/src/web-reader.ts` (`assertPublicHost` resolves, then `doFetch(current.toString())` resolves again; `isPrivateIp` v6 list), `apps/supervisor/src/memories.ts`, `apps/supervisor/src/broker/index.ts` (`recall` result has no `untrusted` flag; `read_url`/`search_web` do).
- Description: (1) The host is resolved once for the check and again by undici for the fetch (TOCTOU). An attacker-controlled domain with a 0-TTL record answering public first and `169.254.169.254` / `10.x` second reaches internal metadata or services (the supervisor runs where the RPC/bundler/paymaster/DB credentials live). (2) `isPrivateIp` misses NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16` embedding a private v4), `::ffff:` in uppercase/compressed forms are handled but Teredo (`2001::/32`) and unique local in uppercase (`FC`/`FD` are lower-cased, fine). (3) Content read from the web can be stored verbatim with `remember` and comes back in every observation (`recentNotes`) and `recall` without any provenance flag, which turns a one-time injection into a persistent one.
- Attack path: injected `read_url` to `https://rebind.attacker.tld/` -> second resolution hits `169.254.169.254` (cloud metadata) or an internal admin UI; 4,000 chars of the response return to the model and, via `remember`, persist.
- Impact: SSRF read of 4,000 chars per call from internal HTTP(S) endpoints (only `https:` is allowed, which blocks most metadata services but not internal TLS services); persistent prompt injection.
- Fix: pin the resolved address (undici `Agent({ connect: { lookup } })` returning the checked record, or connect by IP with `Host`/SNI set), re-check after each redirect (already done), add the missing v6 ranges; attach `untrusted: true` and `sources` to recalled notes and to `recentNotes` in the observation, and consider quarantining notes written in turns that consumed external content.

#### M-05 — x402 authorizations are bearer instruments: no bound on `maxTimeoutSeconds`, failure classification trusts the relay, no client-side on-chain reconciliation

- Location: `apps/inference/src/client/x402-payer.ts` (`registerPolicy` filters only scheme/amount/payTo; `maxTimeoutSeconds` from the relay's requirements becomes `validBefore`), `apps/supervisor/src/inference.ts` (`recordResponse`: `facilitator_unavailable`/`upstream_rejected` -> `failed`; `reconcileInference`: 404 or `retrySafe` -> `failed` -> cycle bump -> new payment), `apps/inference/src/app.ts` (settles after upstream; `requestView.retrySafe`).
- Description: once the supervisor has sent `PAYMENT-SIGNATURE`, the relay (and its facilitator) holds a signed authorization that anyone can settle until `validBefore`. The client accepts whatever `maxTimeoutSeconds` the relay advertises (bounded on-chain only by the 30-day TimestampPolicy). The client then believes the relay about whether money moved: a `502 facilitator_unavailable` ("nothing was charged"), a `404` on `/v1/requests/:key`, or `retrySafe: true` each lead to a new paid request with a new key. The relay's own reconciler checks `authorizationState` on-chain; the supervisor never does.
- Attack path (malicious or compromised relay): settle, then answer `failed`/`retrySafe` -> client pays again next cycle; repeat every cycle. Or advertise `maxTimeoutSeconds = 30 days`, answer `facilitator_unavailable`, and settle all accumulated authorizations later.
- Impact: bounded per request by `maxQuoteFor(model)` (0.3 USDC for `gpt-4.1-mini`, up to 3 USDC for `claude-opus`), unbounded over time except by the treasury (and by the fee policy's WETH->USDC refuel, which keeps feeding it). Illustrative: 8 steps/turn, 1 turn/min, 0.3 USDC -> 2.4 USDC/min until the 20 USDC fuel is gone, then one refuel swap per tick.
- Fix: in the payer policy, reject requirements with `maxTimeoutSeconds > 600` (or whatever the relay legitimately needs; today `INFERENCE_X402_MAX_TIMEOUT` on the relay); on the supervisor, before marking an inference `failed` after `paymentSigned`, read `USDC.authorizationState(kernel, nonce)` yourself (the nonce is persisted by `onPayment`) and keep the row `unknown` if it is used or still valid; prefer the `upto` scheme (settles actual usage) once the facilitator supports it; and the structural fix is C-01 option (b): a spender float makes the whole exposure equal to the float.

#### M-06 — Sponsored-gas and prefund griefing with the session key

- Location: `apps/supervisor/src/session-key.ts` (`GasPolicy allowed = 1e17 wei`, `enforcePaymaster = false`), `apps/supervisor/src/config.ts` (`SESSION_GAS_ALLOWANCE_WEI`, `SESSION_RATE_LIMIT_PER_HOUR`), `apps/supervisor/src/entrypoint.ts` (`SELF_BUNDLE_GAS` 4.2M units, kernel pays the prefund).
- Description: the GasPolicy counts `maxFeePerGas x gas limits` cumulatively per permission regardless of who pays. With a sponsoring paymaster, a session-key holder can submit allow-listed no-ops (e.g. `USDC.transfer(payTo, 0)`) at 60/h per kernel until 0.1 ETH of *quoted* gas per kernel is consumed, charged to the CDP paymaster budget. Across `N` kernels that is `N x 0.1 ETH` of sponsor budget per 30-day permission (illustrative: 100 kernels -> 10 ETH ≈ 30,000 USD at 3,000 USD/ETH, if the sponsor does not cap it elsewhere). Without a paymaster the same ops burn the kernel's ETH/deposit. Separately, self-bundled enable ops take their prefund from the kernel's ETH; a kernel with no ETH cannot complete onboarding or rotation (availability, not loss).
- Fix: `enforcePaymaster = true` with `allowedPaymaster` set to the CDP paymaster (so the allowance is explicitly about sponsored gas and cannot be redirected), lower `SESSION_GAS_ALLOWANCE_WEI` to what 30 days of honest use needs (measure: a swap is ~0.5-1M gas at Base fees), set a per-kernel policy in the CDP paymaster dashboard, and alert on `UserOperationEvent` bursts per sender.

#### M-07 — Error objects logged with `err` can carry RPC/bundler/paymaster URLs that embed API keys

- **Status: Fixed** in `apps/supervisor/src/log.ts`: custom `err` / `error` serializer (`serializeError`) that reduces every URL in `url`, `details`, `metaMessages`, `message`, `stack` and nested `cause`s to its origin, plus redact paths for `err.url` / `err.cause.url` / bodies. `SUPERVISOR_SERVICE_KEY` is now required, 32+ characters and distinct from the sender / indexer keys (part of M-03).

- Location: `apps/supervisor/src/log.ts` (`redact` only `*.privateKey`, `*.token`, `*.authorization`, `*.secret`, `*.key`, one level deep), every `log.warn/error({ err })` site (`tick.ts`, `onboarding.ts`, `treasury.ts`, `builder-codes.ts`, …), `apps/supervisor/src/chain.ts` / `kernel.ts` (`http(config.RPC_URL)`, `http(opts.bundlerUrl)`, `http(opts.paymasterUrl)`).
- Description: viem's `HttpRequestError`/`RpcRequestError` serialise the transport URL (`url`, and in `details`/`metaMessages`) into the error. CDP RPC, bundler and paymaster URLs typically carry the API key in the path. pino's `err` serializer includes those fields, so a failed RPC call writes the key to the log stream. The redact list does not cover `err.url`, `err.cause.url` or `metaMessages`.
- Impact: credential disclosure to whoever reads logs (log aggregators, CI, support tickets). The bundler/paymaster key enables sponsored-gas abuse (M-06) from anywhere.
- Fix: redact `err.url`, `err.cause.url`, `err.metaMessages`, `err.details`, `*.url` and `*.cause.*.url` (pino supports `paths` with nesting), or wrap transports so errors carry a URL with the key replaced; prefer header-based auth for CDP where available; rotate the keys after reviewing existing logs.

### Low

#### L-01 — Chainlink price used without staleness or round checks

- **Status: Fixed**: `treasury.ts` `ethUsdPrice` checks `answer > 0`, `updatedAt` within `CHAINLINK_MAX_AGE_SECONDS` (default 3600) and `answeredInRound >= roundId`, returning `null` (no swap) otherwise; `BootrSwapHelper` applies the same rule on-chain.

- Location: `apps/supervisor/src/treasury.ts` (`ethUsdPrice`: `latestRoundData` -> `answer` only; feeds `minUsdcOut` and the model-facing USD figures).
- Impact: a stale/high price lowers `minOut` relative to reality? No: a stale *high* price raises `minOut` (swap reverts, safe); a stale *low* price lowers `minOut` and widens the sandwich window beyond `SWAP_SLIPPAGE_BPS`. Small on Base (feed heartbeat is short), but trivial to fix.
- Fix: check `updatedAt >= now - heartbeat` and `answeredInRound >= roundId`; refuse to swap on a stale feed; same check inside the swap helper (C-02).

#### L-02 — Money-op state transitions are not conditional; lease shorter than one inference timeout

- Location: `apps/supervisor/src/treasury.ts` (`executeOp`: `update … set status='sent' where opId` without `and status='prepared'`; `openOps` check is a separate read), `apps/supervisor/src/runtime.ts` (`LEASE_MS = 60_000`, renewed once per step), `apps/supervisor/src/config.ts` (`INFERENCE_TIMEOUT_MS = 150_000`).
- Impact: with two supervisor instances, a lease can expire during a 150 s inference; the second instance resumes the persisted turn and both can reach `executeOp` for the same prepared op; both prepare userOps with the same nonce; the chain executes at most one, but the DB can record the loser's hash and the op then reconciles as `unknown`/`failed` while the winner moved funds. Single-instance deployments are unaffected.
- Fix: `update … where opId = ? and status = 'prepared'` and treat 0 rows as "someone else took it"; renew the lease on a timer during inference or make the lease longer than the inference timeout; or document "exactly one supervisor instance per database".

#### L-03 — Configuration and example inconsistencies around the signature path

- **Status: Fixed** (code side): `SESSION_1271_CALLERS` is removed (there is no signature path to gate); `check-1271` is replaced by `check-spender`. The `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY` rename in `.env.example` is left to the operator.

- Location: `apps/supervisor/src/config.ts` (`SESSION_1271_CALLERS` default `usdc`), `.env.example` (`SESSION_1271_CALLERS=any`), `apps/supervisor/src/api.ts` (`check-1271` verifies with `caller = USDC`, which passes in both modes and does not exercise the facilitator's actual caller), `.env.example` (`NEXT_PUBLIC_SUPERVISOR_SESSION_KEY` is the session *address*, exposed to the browser bundle by its `NEXT_PUBLIC_` prefix; the name invites someone to paste the private key).
- Fix: make the code default equal to the documented production value or fail when `usdc` is set with an off-chain facilitator; rename to `NEXT_PUBLIC_SUPERVISOR_SESSION_ADDRESS`; have `check-1271` also probe with `caller = 0x0` (what an ERC-6492 off-chain verifier effectively uses) and report both.

#### L-04 — Dependency pinning and supply chain

- Location: `apps/supervisor/package.json` (`@zerodev/permissions ^5.6.4`, `@zerodev/sdk ^5.5.11`, `@zerodev/ecdsa-validator ^5.4.9`, `@x402/* ~2.28.0`, `viem ^2.35.0`, `ox 0.14.57` exact), `apps/inference/package.json` (`@coinbase/x402 ^2.1.0`), `pnpm-lock.yaml` (resolved: `@zerodev/permissions 5.6.4`, `@zerodev/sdk 5.5.11`, `@x402/* 2.28.0`, `viem 2.57.10`, `ox 0.14.57` plus `ox 0.9.3`/`0.6.9` transitively).
- Description: the lockfile pins resolutions, but ranges allow silent minor/patch bumps on `pnpm update`; the ZeroDev SDK produces the policy init data that ends up in on-chain `validatorData` (the tests cross-check `getEnableData`, which is good), and the x402 client constructs the authorization that the kernel signs. A malicious patch in either could alter what is signed. Two `ox` majors coexist.
- Fix: exact versions for `@zerodev/*`, `@x402/*`, `viem`, `ox`; `pnpm install --frozen-lockfile` in CI; `minimumReleaseAge` (pnpm >= 10.16) of several days for production installs; verify provenance/attestations where published; keep the existing cross-check tests and add one that re-derives the EIP-3009 digest the payer signs from the raw fields (so a library change that alters the typed data is caught).

#### L-05 — Database holds every prompt, completion and private note in clear

- Location: `apps/supervisor/src/db/schema.ts` (`sv_inference.request/response`, `sv_runtimes.turn/state`, `sv_memories`), `apps/supervisor/src/api.ts` (`GET /internal/agents/:id` returns runtime state and pending actions).
- Description: no secrets are stored (the session key and admin key never touch the DB; `validatorData`/`sessionPolicy` are public on-chain data). But the shared Postgres (sender, relay, indexer use the same database) contains the agents' full conversational context, including anything the model stored with `remember`. Any sibling service's DB credentials read it.
- Fix: separate DB roles per service (the `sv_` prefix makes `GRANT` by table easy), retention/pruning for `sv_inference.request/response` after settlement, and keep the admin API's state dump behind the stronger key from M-03.

#### L-06 — GasPolicy exhaustion halts an agent until the next rotation

- Location: `apps/supervisor/src/session-key.ts`, `apps/supervisor/src/onboarding.ts` (`rotateExpiringSessionKeys` rotates on time only, not on allowance).
- Description: the 0.1 ETH allowance is per permission; a gas spike or a long run of ops exhausts it and every op fails with `PolicyFailed` until the 27-day rotation.
- Fix: read the GasPolicy's remaining allowance per tick and rotate early when it drops below a threshold; alert.

#### L-07 — `read_chain contract_call` and `read_market` accept arbitrary targets

- Location: `apps/supervisor/src/broker/index.ts` (`readChain`: any `view`/`pure` call on any address through the supervisor's RPC key; `read_market` any token).
- Impact: RPC quota consumption (8 steps per turn, 1 turn/min minimum), and view calls into attacker contracts that revert with crafted data that reaches the model as `error` text (another injection channel). No funds at risk.
- Fix: cap `read_chain` per turn, strip revert data from errors returned to the model, and keep the RPC key for the supervisor separate from the indexer's (already recommended in `.env.example`).

#### L-08 — Fee policy and model swaps share one in-flight slot and a 1-hour failure backoff without jitter

- Location: `apps/supervisor/src/treasury.ts` (`runFeePolicy`: `recent_failure_backoff` on any failed policy op; `openOps` gate).
- Impact: a single failing claim (e.g. a FeeLocker asset that reverts) blocks refuels for an hour at a time; an attacker who can make the claim revert (unlikely with ClankerFeeLocker, but any non-standard reward token could) keeps the agent asleep. Availability only.
- Fix: back off per op kind; exclude assets whose `availableFees` read fails.

### Informational

- I-01 — `STUB_HASH` signature (`kernel.ts`): a real ECDSA signature by the session EOA over the constant `keccak("bootr.kernel.stub-signature")` is sent to bundlers for estimation. Nothing accepts a raw signature over that hash, and the kernel wraps all 1271 hashes, so it is harmless, but it is a public, reusable signature of the fleet key; a `sign` policy in a remote signer should still allow it (or use the SDK's dummy signature if the signer contract tolerates it).
- I-02 — Trust flags are inconsistent across tool results: `read_mentions`/`read_x_thread`/`read_x_account` set `instructionAuthority: false`, `read_url`/`search_web`/`read_market` set `untrusted: true`, `recall`/`recall_conversation`/`read_chain`/`treasury_read` set neither. One flag, everywhere, is easier for the prompt to reference.
- I-03 — `approvedEnableDigests` are never consumed. Even if Kernel rejects re-enabling (H-01 part 2), approvals accumulate forever; clearing on successful install (the guardian sees the enable call in `isValidSignatureWithSender`, but it is a `view`; so clear from the supervisor via `revokeSessionKeyApproval` once `isSessionInstalled()` is true) keeps the approved set equal to the installed set.
- I-04 — Policy-origin ops left in `prepared` (crash between `prepareOp` and `executeOp`) are visible to the model through `treasury_read.recent` and executable by `treasury_execute` with the shown `callHash`. They are allow-listed claims/swaps, so this is not a loss path, but a swap prepared with an old `minOut` could execute within its 20-minute deadline at a worse price; mark policy ops older than a few minutes `failed`.
- I-05 — `treasury_prepare` advertises `operation: burn | buyback` in its schema; the broker rejects them ("handled by the on-chain burner"). Removing them from the schema avoids wasted paid inference steps.

## 4. Consolidated design recommendations

Ordered by how much of the Critical/High exposure each removes.

1. **Bound the signature path on-chain** (closes C-01 outright): either a `BootrAuthorizationPolicy` that checks the EIP-3009 pre-image (to/value/validity window) against rules, or move x402 payments to a per-agent spender account funded by capped transfers. The spender variant is the smaller contract change (none) and also bounds M-05; the policy variant keeps a single account per agent.
2. **Replace the raw Universal Router rule with a Bootr swap helper that only pays `msg.sender` and enforces an oracle floor** (closes C-02, removes the sandwich extraction in M-01).
3. **Split guardian authority** (closes C-03): owner = multisig/timelock; `installer` role approves only template-derived digests; the supervisor holds `installer` in a KMS/HSM; watch `SessionKeyApproved` for non-template `validatorData`.
4. **Per-agent signers in a policy-enforcing signer service** (closes H-02): the `LocalAccount` injection point in `service.ts` is the seam; the signer's own policy ("sender == kernel K", "EIP-712 domain == USDC, to == payTo, value <= cap") is the last line of defence when the host is compromised.
5. **Real revocation** (closes H-01): uninstall-based fleet revoke in one admin action, revoke approvals on uninstall, verified by fork tests that the 1271 path is dead afterwards.
6. **Cumulative caps in `BootrCallPolicy`** (M-01/M-02): per-period USDC spend rule stored in associated storage; one money call per op.
7. **Client-side on-chain reconciliation and a `maxTimeoutSeconds` cap in the payer** (M-05).
8. **Operational hygiene**: distinct admin API key with replay protection (M-03), pinned DNS for `read_url` and provenance on notes (M-04), paymaster enforcement and lower gas allowance (M-06), log redaction of transport URLs (M-07), exact dependency pins (L-04).

## 5. Verified sound

- `BootrCallPolicy` parsing: strips `executeUserOp`, requires the `execute` selector, bounds-checks the ABI offsets, rejects delegatecall and non-zero value, applies every arg rule, and ignores the ERC-8021 suffix; storage is fixed-size associated storage (73 slots) so strict bundlers accept it. Rule encoding in `session-key.ts` (`eqAddress` padding, `lteUint` word compare, selectors) matches the contract's semantics; tests decode it back and cross-check the ZeroDev entries against `getEnableData`.
- Model-driven treasury actions cannot leave the kernel's economic perimeter: `treasuryPrepare` builds only WETH->USDC swaps that pay the kernel (`recipient = kernel`, `payerIsUser = false`, v4 `TAKE_ALL` to the router caller) and USDC transfers to `INFERENCE_PAYTO` <= cap; `treasury_execute` requires the `expectedHash` of the stored calls and re-simulates; ops are persisted before sending and never resent (`unknown` -> reconcile by hash); one op in flight per agent.
- Enable-mode install: the guardian recomputes the digest from `(vId, kernel.currentNonce, hook = guardian, validatorData, hookData 0x00, selectorData execute)`; the supervisor verifies the local digest against `guardian.enableDigest` and `approvedEnableDigests` before sending; `isValidSignatureWithSender` only honours `sender == kernel` (the enable path) and rejects paused/unregistered kernels; `validateUserOp` on root always fails, so nobody can act as root through the EntryPoint.
- Guardian hook: `preCheck` allows the EntryPoint (stamps activity, blocks when paused) and the guardian's own `_rootCall`; everything else reverts `UnauthorizedCaller`; `onUninstall` reverts (`CannotUninstall`), and `RootValidatorCannotBeRemoved` protects the root.
- The ERC-1271 encoding (`0x02 ‖ permissionId ‖ 0xff ‖ sig` with the `Kernel(bytes32 hash)` wrapper) prevents cross-context replay of the session EOA's signatures as plain EOA signatures.
- x402 payer: refuses to pay without an `Idempotency-Key`, pays at most once per call, filters requirements by scheme/network/amount <= min(cap, header)/payee, persists the payload (nonce) before sending (`onPayment`), and returns 402s without `PAYMENT-REQUIRED` untouched. The supervisor keys inference by `(agentId, cycle)`, replays stored results, never pays while a key is `unknown`, and the reconcile replay uses a plain fetch with `X-Max-Quote-Micro-USDC: 0` so it cannot be coaxed into a new payment.
- Relay side (for context): claims the idempotency key before upstream, persists the completion and `settlementAttempted` before settling, classifies ambiguous settlement as `unknown`, reconciles against `authorizationState` on-chain, and rejects key reuse with a different body (`idempotency_key_conflict`).
- Admin API: `timingSafeEqual` on the HMAC, canonical string includes method, path+query and body hash, `/health` leaks nothing sensitive, `validatorData` is truncated in responses; `session/install` only accepts a `permissionId`.
- Runtime: tool allow-list is derived from `capabilities` and owner rules (`toolsFor`), unknown tools and malformed inputs are rejected by zod (`.strict()`), `read_url` is https-only with credentials in the URL rejected, redirects re-checked, bodies capped (1 MB / 4,000 chars); `finish` is bounded and the persisted state is capped at 12 KB; the system prompt and observation carry `instructionAuthority: false`.
- Secrets handling in code: private keys are only ever passed to `privateKeyToAccount`; no log site prints a key; `GET /internal/agents` exposes addresses and permission ids only (both public on-chain).

## 6. Open questions

1. Kernel v3.1 `isValidSignature` after `invalidateNonce`: does it compare `validationConfig[vId].nonce` with `currentNonce`? If not, `revokeAllSessionKeys` does not stop EIP-3009 settlements (H-01). A fork test against the deployed kernel implementation (`0xBAC849bB…`) settles this in minutes.
2. Can a permission uninstalled by `uninstallValidation` be re-enabled through enable mode with the same still-approved digest while `currentNonce` is unchanged (H-01 part 2)?
3. How exactly does the x402 facilitator in use (x402.org for Sepolia, CDP for mainnet) call `isValidSignature` for an already-deployed account: directly via `eth_call` with `from = 0x0`, or through the ERC-6492 universal validator? This determines whether `SignatureCallerPolicy` could ever be used and what `check-1271` should probe.
4. Does the ZeroDev `GasPolicy` deployed on Base (`0xaeFC…` on Sepolia; mainnet address still `null` in `addresses.ts`) count paymaster-sponsored gas with `enforcePaymaster = false`, and does the deployed `RateLimitPolicy` v1 interpret `startAt = 0` as "from install" (M-06, L-06)?
5. Which services hold `SENDER_SERVICE_KEY` in production (sender, indexer, web)? Each of them is currently a supervisor admin (M-03).
6. Are the mainnet ZeroDev policy/signer addresses (`gasPolicy`, `rateLimitPolicy`, `timestampPolicy`, `signaturePolicy`, `ecdsaSigner` are `null` for 8453) going to be the same deterministic deployments as on Sepolia, and will their bytecode be verified before `addresses.ts` is filled?
7. What is the intended creator funding (`fuelUsdc`, ETH top-ups) per kernel? The loss figures in C-01/C-02 scale linearly with it; if treasuries are expected to hold more than tens of dollars, C-01/C-02 should block mainnet.
8. Is there, or will there be, any other system that authenticates the kernel through ERC-1271 (e.g. SIWE for an agent dashboard, Permit2 approvals granted by a future rule)? Each one is another consumer of the unbounded signature path until C-01 is fixed.
