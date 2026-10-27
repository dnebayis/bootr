/**
 * Kernel client for an EXISTING agent Kernel (deployed by BootrLauncher, root validator = AgentGuardian).
 *
 * `@zerodev/sdk`'s `createKernelAccount` cannot drive this account: its enable-mode wrapper appends an
 * action address and init data to `selectorData`, while the guardian pre-approves a digest computed over
 * the bare 4-byte `execute` selector. The account is therefore implemented on viem's `toSmartAccount`
 * with the exact Kernel v3.1 encodings from `session-key.ts`:
 *
 *  - callData      = executeUserOp.selector ‖ execute(mode, executionCalldata)   (hooked validation)
 *  - nonce         = mode ‖ 0x02 ‖ permissionId ‖ 16 zero bytes ‖ 2-byte key ‖ 8-byte seq
 *  - signature     = 0xff ‖ ecdsa(userOpHash)        (regular)
 *                  = guardian ‖ abi.encode(validatorData, 0x00, 0xe9ae5c53, "", 0xff ‖ ecdsa)   (enable mode)
 *  - ERC-1271      = 0x02 ‖ permissionId(4) ‖ 0xff ‖ ecdsa(EIP-712 Kernel(bytes32 hash) wrap)   (5-byte prefix)
 *
 * With a `builderCode`, every userOp's callData is `encodeKernelCalls(calls) ‖ ERC-8021 suffix` (Base
 * Builder Codes attribution). The Kernel, BootrCallPolicy and the guardian hook decode from the head and
 * ignore the trailing bytes; the ERC-1271 signature path is untouched.
 *
 * With a `selfBundle` sender (the admin signer, `ENABLE_MODE_SELF_BUNDLE`), enable-mode ops skip the bundler
 * entirely: gas limits are the fixed `SELF_BUNDLE_GAS` budget, fees come from `estimateFeesPerGas`, the op is
 * signed exactly as usual, packed (`accountGasLimits` / `gasFees` as bytes32) and sent through
 * `EntryPoint.handleOps([op], admin)`; the `UserOperationEvent` of the mined tx becomes the receipt.
 */
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  hashMessage,
  hashTypedData,
  http,
  keccak256,
  pad,
  parseAbiParameters,
  parseEventLogs,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
} from 'viem';
import {
  createBundlerClient,
  createPaymasterClient,
  entryPoint07Abi,
  entryPoint07Address,
  getUserOperationHash,
  toPackedUserOperation,
  toSmartAccount,
  type BundlerClient,
  type SmartAccount,
  type UserOperation,
  type UserOperationReceipt,
} from 'viem/account-abstraction';
import { kernelAbi, KERNEL_EXECUTE_USER_OP_SELECTOR } from './abi.js';
import type { AdminSigner } from './admin-signer.js';
import { attributionSuffix } from './builder-codes.js';
import { describeRevertData, SELF_BUNDLE_GAS, SELF_BUNDLE_MAX_FEE_HEADROOM_BPS } from './entrypoint.js';
import {
  KERNEL_VERSION,
  NONCE_MODE_DEFAULT,
  NONCE_MODE_ENABLE,
  encodeEnableSignature,
  encodeErc1271Signature,
  encodeSessionSignature,
  nonceKey,
  validationId,
} from './session-key.js';

export interface KernelCall {
  to: Address;
  value?: bigint;
  data?: Hex;
}

/** Constant hash signed once per signer to build well-formed stub signatures for gas estimation. */
export const STUB_HASH: Hex = keccak256(toHex('bootr.kernel.stub-signature'));

export const EXEC_MODE_SINGLE: Hex = `0x${'00'.repeat(32)}`;
export const EXEC_MODE_BATCH: Hex = `0x01${'00'.repeat(31)}`;

/** `execute(mode, executionCalldata)` wrapped in `executeUserOp` (required for hooked validations). */
export function encodeKernelCalls(calls: readonly KernelCall[]): Hex {
  if (calls.length === 0) throw new Error('no calls to encode');
  let mode: Hex;
  let executionCalldata: Hex;
  if (calls.length === 1) {
    const [c] = calls as [KernelCall];
    mode = EXEC_MODE_SINGLE;
    executionCalldata = concatHex([c.to, pad(toHex(c.value ?? 0n), { size: 32 }), c.data ?? '0x']);
  } else {
    mode = EXEC_MODE_BATCH;
    executionCalldata = encodeAbiParameters(parseAbiParameters('(address target, uint256 value, bytes callData)[]'), [
      calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data ?? '0x' })),
    ]);
  }
  const inner = encodeFunctionData({ abi: kernelAbi, functionName: 'execute', args: [mode, executionCalldata] });
  return concatHex([KERNEL_EXECUTE_USER_OP_SELECTOR, inner]);
}

export function nonceMode(nonce: bigint): Hex {
  return toHex((nonce >> 248n) & 0xffn, { size: 1 });
}

/** Sends packed userOps straight to `EntryPoint.handleOps` (the admin signer) and gets paid as beneficiary. */
export type SelfBundler = Pick<AdminSigner, 'address' | 'handleOps'>;

export interface KernelClientOptions {
  publicClient: PublicClient<Transport, Chain>;
  chain: Chain;
  kernel: Address;
  guardian: Address;
  permissionId: Hex;
  /** Needed only while the permission is not installed yet (enable mode). */
  validatorData?: Hex;
  sessionSigner: LocalAccount;
  bundlerUrl: string;
  paymasterUrl?: string;
  entryPoint?: Address;
  /** Base Builder Code of this kernel; when set, every userOp callData carries its ERC-8021 suffix. */
  builderCode?: string | null;
  /**
   * When set, enable-mode ops (permission not installed yet) are self-bundled through this sender instead of
   * `bundlerUrl`: fixed gas budget, no paymaster, `handleOps` from the admin EOA. Regular ops are unaffected.
   */
  selfBundle?: SelfBundler;
}

export interface PreparedUserOp {
  userOp: UserOperation<'0.7'>;
  hash: Hex;
  enableMode: boolean;
  /** True when `submitUserOp` will send it through `EntryPoint.handleOps` (fixed gas, no bundler). */
  selfBundled: boolean;
}

export interface KernelClient {
  address: Address;
  permissionId: Hex;
  chainId: number;
  /** The ERC-8021 suffix appended to every userOp callData (null without a builder code). */
  callDataSuffix: Hex | null;
  account: SmartAccount;
  bundler: BundlerClient;
  /** Is the permission validator installed on the kernel (validationConfig.hook != 0)? */
  isSessionInstalled(): Promise<boolean>;
  /** Builds, estimates and signs a userOp WITHOUT sending it, so the caller can persist the hash first. */
  prepareUserOp(calls: readonly KernelCall[]): Promise<PreparedUserOp>;
  /**
   * Submits a prepared op; returns the bundler's hash (equal to `prepared.hash`). A self-bundled op is mined
   * before this resolves and its receipt is served by `waitForReceipt` / `getReceipt`.
   */
  submitUserOp(prepared: PreparedUserOp): Promise<Hex>;
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<UserOperationReceipt | null>;
  getReceipt(hash: Hex): Promise<UserOperationReceipt | null>;
  /** ERC-1271 signature over EIP-712 typed data (the x402 EIP-3009 authorization). */
  signTypedData(typedData: Parameters<typeof hashTypedData>[0]): Promise<Hex>;
  signMessage(message: Parameters<typeof hashMessage>[0]): Promise<Hex>;
  /**
   * Asks the kernel on-chain whether it accepts a signature (`isValidSignature`). `caller` is the
   * `msg.sender` of the eth_call; SignatureCallerPolicy (if installed) only passes for allow-listed callers.
   */
  verifySignature(hash: Hex, signature: Hex, caller?: Address): Promise<boolean>;
}

export async function createKernelClient(opts: KernelClientOptions): Promise<KernelClient> {
  const entryPoint = opts.entryPoint ?? entryPoint07Address;
  const chainId = opts.chain.id;
  const { publicClient, kernel, guardian, permissionId, sessionSigner } = opts;
  const callDataSuffix: Hex | null = opts.builderCode ? attributionSuffix(opts.builderCode) : null;
  const selfBundle = opts.selfBundle ?? null;
  /** Receipts of self-bundled ops (never known to the bundler), by userOp hash. */
  const selfBundledReceipts = new Map<Hex, UserOperationReceipt>();
  let installed: boolean | null = null;

  const isSessionInstalled = async (): Promise<boolean> => {
    if (installed === true) return true;
    const cfg = await publicClient.readContract({ address: kernel, abi: kernelAbi, functionName: 'validationConfig', args: [validationId(permissionId)] });
    installed = cfg.hook !== '0x0000000000000000000000000000000000000000';
    return installed;
  };

  const kernelDomain = { name: 'Kernel', version: KERNEL_VERSION, chainId, verifyingContract: kernel } as const;
  const wrapAndSign = async (hash: Hex): Promise<Hex> => {
    const sig = await sessionSigner.signTypedData({
      domain: kernelDomain,
      types: { Kernel: [{ name: 'hash', type: 'bytes32' }] },
      primaryType: 'Kernel',
      message: { hash },
    });
    return encodeErc1271Signature(permissionId, sig);
  };

  let stubSig: Hex | null = null;
  const stubSignerSig = async (): Promise<Hex> => {
    stubSig ??= await sessionSigner.sign!({ hash: STUB_HASH });
    return stubSig;
  };

  const signUserOpHash = (hash: Hex, userOpNonce: bigint, signerSig: Hex): Hex => {
    const session = encodeSessionSignature(signerSig);
    if (nonceMode(userOpNonce) === NONCE_MODE_ENABLE) {
      if (!opts.validatorData) throw new Error('validatorData is required for an enable-mode userOp');
      return encodeEnableSignature(guardian, opts.validatorData, session);
    }
    return session;
  };

  const account = await toSmartAccount({
    client: publicClient,
    entryPoint: { abi: entryPoint07Abi, address: entryPoint, version: '0.7' },
    async getAddress() {
      return kernel;
    },
    async getFactoryArgs() {
      return {};
    },
    async encodeCalls(calls) {
      const callData = encodeKernelCalls(calls.map((c) => ({ to: c.to, value: c.value, data: c.data })));
      return callDataSuffix ? concatHex([callData, callDataSuffix]) : callData;
    },
    async getNonce() {
      const mode = (await isSessionInstalled()) ? NONCE_MODE_DEFAULT : NONCE_MODE_ENABLE;
      return publicClient.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'getNonce', args: [kernel, nonceKey(permissionId, mode)] });
    },
    async getStubSignature(params) {
      const nonce = (params?.nonce ?? 0n) as bigint;
      // ZeroDev's ECDSASigner reverts (`InvalidSignature`) on the SDK's malformed DUMMY_ECDSA_SIG, which
      // makes bundler gas estimation fail with AA23. A well-formed signature over a constant hash recovers
      // to a different address, so the signer returns SIG_VALIDATION_FAILED instead, which estimation accepts.
      return signUserOpHash('0x', nonce, await stubSignerSig());
    },
    async signUserOperation(params) {
      const { chainId: cid = chainId, ...rest } = params;
      const userOperation = { ...rest, sender: kernel, signature: '0x' } as UserOperation<'0.7'>;
      const hash = getUserOperationHash({ chainId: cid, entryPointAddress: entryPoint, entryPointVersion: '0.7', userOperation });
      const signerSig = await sessionSigner.sign!({ hash });
      return signUserOpHash(hash, userOperation.nonce, signerSig);
    },
    async signMessage({ message }) {
      return wrapAndSign(hashMessage(message));
    },
    async signTypedData(typedData) {
      return wrapAndSign(hashTypedData(typedData as Parameters<typeof hashTypedData>[0]));
    },
  });

  const paymaster = opts.paymasterUrl ? createPaymasterClient({ transport: http(opts.paymasterUrl) }) : undefined;
  const bundler = createBundlerClient({
    account,
    chain: opts.chain,
    client: publicClient,
    transport: http(opts.bundlerUrl),
    ...(paymaster ? { paymaster } : {}),
  });

  const userOpHashOf = (userOp: UserOperation<'0.7'>): Hex => getUserOperationHash({ chainId, entryPointAddress: entryPoint, entryPointVersion: '0.7', userOperation: userOp });

  /** Enable-mode op for `handleOps`: no bundler estimation, fixed gas budget, fees from the node. */
  const prepareSelfBundled = async (calls: readonly KernelCall[]): Promise<PreparedUserOp> => {
    const [nonce, fees, callData] = await Promise.all([
      account.getNonce(),
      publicClient.estimateFeesPerGas(),
      account.encodeCalls(calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? '0x' }))),
    ]);
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
    const maxFeePerGas = (fees.maxFeePerGas * (10_000n + SELF_BUNDLE_MAX_FEE_HEADROOM_BPS)) / 10_000n;
    const request: UserOperation<'0.7'> = { sender: kernel, nonce, callData, ...SELF_BUNDLE_GAS, maxFeePerGas, maxPriorityFeePerGas, signature: '0x' };
    const signature = await account.signUserOperation({ ...request, chainId });
    const userOp: UserOperation<'0.7'> = { ...request, signature };
    return { userOp, hash: userOpHashOf(userOp), enableMode: true, selfBundled: true };
  };

  /** `handleOps([op], admin)`, then the op's `UserOperationEvent` from the mined tx as a bundler-shaped receipt. */
  const sendSelfBundled = async (prepared: PreparedUserOp, sender: SelfBundler): Promise<UserOperationReceipt> => {
    const packed = toPackedUserOperation(prepared.userOp);
    const { txHash, receipt } = await sender.handleOps([packed], sender.address);
    const isOurs = (h: Hex) => h.toLowerCase() === prepared.hash.toLowerCase();
    const event = parseEventLogs({ abi: entryPoint07Abi, eventName: 'UserOperationEvent', logs: receipt.logs }).find((e) => isOurs(e.args.userOpHash));
    if (!event) throw new Error(`EntryPoint.handleOps tx ${txHash} has no UserOperationEvent for userOp ${prepared.hash}`);
    const revert = parseEventLogs({ abi: entryPoint07Abi, eventName: 'UserOperationRevertReason', logs: receipt.logs }).find((e) => isOurs(e.args.userOpHash));
    return {
      userOpHash: prepared.hash,
      sender: kernel,
      nonce: event.args.nonce,
      success: event.args.success,
      actualGasCost: event.args.actualGasCost,
      actualGasUsed: event.args.actualGasUsed,
      entryPoint,
      logs: receipt.logs,
      receipt,
      ...(revert ? { reason: describeRevertData(revert.args.revertReason) } : {}),
    };
  };

  return {
    address: kernel,
    permissionId,
    chainId,
    callDataSuffix,
    account,
    bundler,
    isSessionInstalled,
    async prepareUserOp(calls) {
      const enableMode = !(await isSessionInstalled());
      if (enableMode && selfBundle) return prepareSelfBundled(calls);
      const request = (await bundler.prepareUserOperation({ account, calls: calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? '0x' })) })) as unknown as UserOperation<'0.7'>;
      const signature = await account.signUserOperation({ ...request, chainId });
      const userOp = { ...request, signature } as UserOperation<'0.7'>;
      return { userOp, hash: userOpHashOf(userOp), enableMode, selfBundled: false };
    },
    async submitUserOp(prepared) {
      if (prepared.selfBundled) {
        if (!selfBundle) throw new Error('prepared op is self-bundled but this client has no selfBundle sender');
        const receipt = await sendSelfBundled(prepared, selfBundle);
        selfBundledReceipts.set(prepared.hash, receipt);
        if (prepared.enableMode) installed = null; // re-read validationConfig now that the enable op is mined
        return prepared.hash;
      }
      const hash = await bundler.sendUserOperation({ ...(prepared.userOp as unknown as Record<string, unknown>), account } as unknown as Parameters<typeof bundler.sendUserOperation>[0]);
      if (prepared.enableMode) installed = null; // re-read validationConfig after the enable op lands
      return hash;
    },
    async waitForReceipt(hash, timeoutMs) {
      const own = selfBundledReceipts.get(hash);
      if (own) return own;
      try {
        return await bundler.waitForUserOperationReceipt({ hash, timeout: timeoutMs });
      } catch {
        return null;
      }
    },
    async getReceipt(hash) {
      const own = selfBundledReceipts.get(hash);
      if (own) return own;
      try {
        return await bundler.getUserOperationReceipt({ hash });
      } catch {
        return null;
      }
    },
    signTypedData: (typedData) => wrapAndSign(hashTypedData(typedData)),
    signMessage: (message) => wrapAndSign(hashMessage(message)),
    async verifySignature(hash, signature, caller) {
      try {
        const magic = await publicClient.readContract({ address: kernel, abi: kernelAbi, functionName: 'isValidSignature', args: [hash, signature], ...(caller ? { account: caller } : {}) });
        return magic === '0x1626ba7e';
      } catch {
        return false;
      }
    },
  };
}
