/**
 * EntryPoint v0.7 helpers for self-bundled userOps (`ENABLE_MODE_SELF_BUNDLE`): the fixed gas budget the
 * supervisor uses instead of bundler estimation, and decoding of the `FailedOp` / `FailedOpWithRevert`
 * errors a `handleOps` simulation surfaces.
 */
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, parseAbi, type Hex } from 'viem';

/**
 * Conservative fixed gas budget for a self-bundled enable-mode op. Enable mode runs every policy's `onInstall`
 * (storage writes, events) plus the guardian hook during validation; a regular session op validates in well
 * under 500k. Unused gas is refunded to the kernel's EntryPoint deposit, so overestimating only raises the
 * prefund (`(verification + call + preVerification) * maxFeePerGas`, ~4.2M gas units).
 */
export const SELF_BUNDLE_GAS = {
  verificationGasLimit: 3_000_000n,
  callGasLimit: 1_000_000n,
  preVerificationGas: 200_000n,
} as const;

/** Headroom on the estimated `maxFeePerGas` so the op still prices in if the base fee rises before inclusion (bps). */
export const SELF_BUNDLE_MAX_FEE_HEADROOM_BPS = 2_000n;

/**
 * Errors the EntryPoint wraps in `FailedOpWithRevert(_, "AA23 reverted", inner)` or that the account's
 * execution emits in `UserOperationRevertReason`: Kernel v3.1, AgentGuardian and BootrCallPolicy.
 */
export const innerErrorsAbi = parseAbi([
  // Kernel v3.1 (+ PermissionManager)
  'error PolicyFailed(uint256 i)',
  'error InvalidValidator()',
  'error InvalidSignature()',
  'error InvalidNonce()',
  'error InvalidCaller()',
  'error InvalidSelector()',
  'error InvalidMode()',
  'error InvalidValidationType()',
  'error InvalidModuleType()',
  'error EnableNotApproved()',
  'error NotSupportedCallType()',
  'error OnlyExecuteUserOp()',
  'error RootValidatorCannotBeRemoved()',
  'error PolicySignatureOrderError()',
  'error SignerPrefixNotPresent()',
  'error PermissionNotAlllowedForUserOp()',
  'error PermissionNotAlllowedForSignature()',
  'error PermissionDataLengthMismatch()',
  // AgentGuardian
  'error NotRegistered()',
  'error AgentIsPaused()',
  'error NotRootCall()',
  'error UnauthorizedCaller(address sender)',
  'error GuardianNotRootValidator()',
  // BootrCallPolicy
  'error AlreadyInstalled(bytes32 id, address kernel)',
  'error NotInstalled(bytes32 id, address kernel)',
  'error InvalidInstallData()',
  'error NoRules()',
  'error InvalidOp(uint8 op)',
  'error TooManyRules(uint256 count, uint256 max)',
  'error TooManyArgs(uint256 ruleIndex, uint256 count, uint256 max)',
]);

function formatArgs(args: readonly unknown[] | undefined): string {
  return (args ?? []).map((a) => (typeof a === 'string' ? JSON.stringify(a) : String(a))).join(', ');
}

/** `PolicyFailed(0)`, `Error("...")`, or the raw hex when the revert data is unknown. */
export function describeRevertData(data: Hex): string {
  if (!data || data === '0x') return '0x';
  try {
    const decoded = decodeErrorResult({ abi: innerErrorsAbi, data });
    return `${decoded.errorName}(${formatArgs(decoded.args)})`;
  } catch {
    return data;
  }
}

/**
 * Human-readable EntryPoint revert from a viem contract error: `FailedOp(0, "AA21 didn't pay prefund")`,
 * `FailedOpWithRevert(0, "AA23 reverted", PolicyFailed(0))`, ... `null` when `err` is not a decoded revert.
 */
export function describeEntryPointError(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!reverted) return null;
  const data = reverted.data;
  if (!data) return reverted.reason ?? reverted.signature ?? null;
  if (data.errorName === 'FailedOp') {
    const [index, reason] = data.args as readonly [bigint, string];
    return `FailedOp(${index}, ${JSON.stringify(reason)})`;
  }
  if (data.errorName === 'FailedOpWithRevert') {
    const [index, reason, inner] = data.args as readonly [bigint, string, Hex];
    return `FailedOpWithRevert(${index}, ${JSON.stringify(reason)}, ${describeRevertData(inner)})`;
  }
  return `${data.errorName}(${formatArgs(data.args)})`;
}

/** Wraps a failed `handleOps` simulation/send so the EntryPoint reason is in the message. */
export function handleOpsError(err: unknown): Error {
  const described = describeEntryPointError(err);
  const detail = described ?? (err instanceof Error ? err.message : String(err));
  return new Error(`EntryPoint.handleOps failed: ${detail}`, { cause: err });
}
