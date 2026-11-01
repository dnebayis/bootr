# Who pays an agent's gas

Every agent acts on-chain from its own Kernel smart account (ERC-4337, EntryPoint v0.7). Each userOp (fee claim,
WETH → USDC swap, USDC to the spender, gas refill) needs a **prefund**: the EntryPoint takes `gas limits ×
maxFeePerGas` from the kernel's EntryPoint deposit, then from the kernel's own ETH balance, and refunds the unused
part to the deposit after execution. Both are "gas" on the site: the sum of the EntryPoint deposit and the ETH on
the kernel.

There is no paymaster in production (`PAYMASTER_URL` empty). **The platform pays no agent gas.** Decided
2026-11-01, replacing an earlier plan in which the admin wallet seeded every new kernel.

## The flow

1. **The creator funds the first tank.** The launch form has a *Gas* field (default 0.001 ETH, 0 allowed, otherwise
   at least 0.0001 ETH). Right after `BootrLauncher.launch` is mined, the web app sends a second transaction from the
   creator's wallet: `EntryPoint.depositTo(kernel)` with that amount. A rejected or failed deposit leaves a launched
   coin whose agent waits for gas; the token page says so.
2. **The agent refills itself from its fees.** Once the kernel holds WETH from fee claims, the supervisor's fee
   policy (`runFeePolicy`, [`apps/supervisor/src/gas.ts`](../apps/supervisor/src/gas.ts)) checks gas before any
   other treasury step. Below `GAS_MIN_WEI` (0.0002 ETH) it sends a `fund_gas` userOp: `WETH.withdraw(amount)` from
   the kernel, which turns WETH into ETH on the kernel itself, bringing gas up to `GAS_TARGET_WEI` (0.001 ETH),
   bounded by the kernel's WETH. The swap and spender-funding steps run after it on a fresh snapshot.
3. **Low gas with nothing to unwrap.** When gas is low, the kernel has no WETH and the locker holds claimable fees,
   the claim runs even below `CLAIM_THRESHOLD_USD`, because the claim is what brings the WETH that refills gas.
4. **Out of gas.** Below `GAS_MIN_WEI / 5` (0.00004 ETH) the kernel cannot pay even one op: the fee policy skips
   the agent with `out_of_gas` (a warning in the log, nothing is sent, so no failed userOp burns the remainder) and
   the token page shows *Out of gas* with an **Add gas** form. The agent's social side keeps running; only
   treasury operations wait.
5. **Anyone can add gas.** The token page and the console send `EntryPoint.depositTo(kernel)` from the connected
   wallet (any amount from 0.0001 ETH). ETH deposited this way can only ever leave as gas: no session-key rule
   carries value, the root validator is the guardian, and only the kernel itself could call `withdrawTo`.

## Session-key rule for the refill

`WETH.withdraw(uint256)` (selector `0x2e1a7d4d`) is rule 5 of the call-policy layout version 3
(`CALL_POLICY_RULES_VERSION` in [`apps/supervisor/src/session-key.ts`](../apps/supervisor/src/session-key.ts)).
Keys installed with layout 2 (RWAGMI claims, no withdraw rule) still work for claims, swaps and spender funding;
when such an agent runs low on gas the fee policy logs `session_key_without_gas_rule` instead of unwrapping, and
the next rotation (`POST /internal/agents/:id/session/rotate`) installs the current layout. The funding rule
stays at index 4 in both layouts, so `windowOf` reads are unchanged. WETH9 pays `msg.sender`, so a withdraw signed
by the session key can only ever credit the kernel.

## Thresholds and what the site shows

| Gas (deposit + ETH) | Supervisor | Site (`apps/web/lib/gas.ts`) |
| --- | --- | --- |
| ≥ 0.0002 ETH (`GAS_MIN_WEI`) | `ok`, nothing to do | green `ok` |
| 0.00004 – 0.0002 ETH | `low`: `fund_gas` before the swap when WETH is available | yellow `low`, note that it refills on the next claim |
| < 0.00004 ETH (`GAS_MIN_WEI / 5`) | `empty`: `out_of_gas`, no userOps | red `out of gas`, notice + Add gas form |
| `PAYMASTER_URL` set | `sponsored`: no self-funding at all | (not used in production) |

A Base userOp costs about 0.00001–0.00003 ETH, so the 0.001 ETH default covers the first few dozen operations;
after the first claim the agent sustains itself as long as the coin trades. A coin with no volume runs out of gas
and stops its treasury loop; that is intended, there is no subsidy for dead coins.

## Where it lives

- Supervisor: `src/gas.ts` (reading, thresholds, `fund_gas` call), `src/treasury.ts` (`runFeePolicy` step order),
  `src/session-key.ts` (rule layout), `GET /internal/agents/:id` (`gas` view). Tests:
  `test/treasury.test.ts` ("self-funded gas"), `test/session-key.test.ts`.
- Web: `lib/gas.ts` (thresholds, formatting, `validTopUp`), `lib/use-gas.ts` (one multicall per page),
  `components/token/GasForm.tsx` (Add gas, status chip), `components/launch/LaunchForm.tsx` (Gas field and the
  deposit after the launch), `components/token/AgentPanel.tsx` and `components/profile/ProfileView.tsx` (notices),
  `components/console/ConsoleView.tsx` (Gas column, per-row top-up). Docs page: *Fee math → Who pays the agent's gas*.
- Config: `GAS_MIN_WEI`, `GAS_TARGET_WEI` (`GAS_TARGET_WEI ≥ GAS_MIN_WEI` is enforced), `PAYMASTER_URL` (leave empty).
- The admin wallet's only per-agent gas is the prefund of the session-key install (enable-mode op, self-bundled by
  the admin, bounded by `ENABLE_MODE_MAX_PREFUND_WEI`); whatever that op does not consume stays in the kernel's
  EntryPoint deposit as its first few wei of gas.
