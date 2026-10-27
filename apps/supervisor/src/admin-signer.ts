/**
 * The only module that holds the guardian owner's key. It signs exactly three kinds of transactions:
 * approveSessionKey, revokeSessionKey/revokeAllSessionKeys(Batch), and (with ENABLE_MODE_SELF_BUNDLE)
 * `EntryPoint.handleOps` for enable-mode userOps that strict bundlers refuse. Swap the
 * implementation for a KMS/hardware signer without touching the rest of the supervisor.
 */
import { createWalletClient, http, type Address, type Chain, type Hex, type PublicClient, type TransactionReceipt, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi, entryPoint07Address, type PackedUserOperation } from 'viem/account-abstraction';
import { guardianAbi } from './abi.js';
import { handleOpsError } from './entrypoint.js';

export interface AdminSigner {
  readonly address: Address;
  approveSessionKey(kernel: Address, permissionId: Hex, validatorData: Hex): Promise<{ txHash: Hex; digest: Hex; nonce: number }>;
  revokeSessionKey(kernel: Address, permissionId: Hex, deinitData: Hex): Promise<{ txHash: Hex }>;
  revokeAllSessionKeys(kernel: Address): Promise<{ txHash: Hex }>;
  /** `guardian.revokeAllSessionKeysBatch(kernels)`: one transaction bumping every kernel's valid nonce (panic path). */
  revokeAllSessionKeysBatch(kernels: readonly Address[]): Promise<{ txHash: Hex }>;
  /**
   * Self-bundles packed userOps: `EntryPoint.handleOps(ops, beneficiary)` sent from the admin EOA. The call is
   * simulated first and a `FailedOp` / `FailedOpWithRevert` reason is surfaced in the error; resolves once the
   * transaction is mined (the receipt carries the `UserOperationEvent` logs).
   */
  handleOps(ops: readonly PackedUserOperation[], beneficiary: Address): Promise<{ txHash: Hex; receipt: TransactionReceipt }>;
}

export function createLocalAdminSigner(args: {
  privateKey: Hex;
  chain: Chain;
  rpcUrl: string;
  guardian: Address;
  publicClient: PublicClient<Transport, Chain>;
  entryPoint?: Address;
}): AdminSigner {
  const account = privateKeyToAccount(args.privateKey);
  const wallet = createWalletClient({ account, chain: args.chain, transport: http(args.rpcUrl) });
  const { publicClient, guardian } = args;
  const entryPoint = args.entryPoint ?? entryPoint07Address;
  return {
    address: account.address,
    async approveSessionKey(kernel, permissionId, validatorData) {
      const { request, result } = await publicClient.simulateContract({
        account,
        address: guardian,
        abi: guardianAbi,
        functionName: 'approveSessionKey',
        args: [kernel, permissionId, validatorData],
      });
      const txHash = await wallet.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return { txHash, digest: result[0], nonce: result[1] };
    },
    async revokeSessionKey(kernel, permissionId, deinitData) {
      const { request } = await publicClient.simulateContract({ account, address: guardian, abi: guardianAbi, functionName: 'revokeSessionKey', args: [kernel, permissionId, deinitData] });
      const txHash = await wallet.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return { txHash };
    },
    async revokeAllSessionKeys(kernel) {
      const { request } = await publicClient.simulateContract({ account, address: guardian, abi: guardianAbi, functionName: 'revokeAllSessionKeys', args: [kernel] });
      const txHash = await wallet.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return { txHash };
    },
    async revokeAllSessionKeysBatch(kernels) {
      const { request } = await publicClient.simulateContract({ account, address: guardian, abi: guardianAbi, functionName: 'revokeAllSessionKeysBatch', args: [[...kernels]] });
      const txHash = await wallet.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return { txHash };
    },
    async handleOps(ops, beneficiary) {
      let request: Parameters<typeof wallet.writeContract>[0];
      try {
        ({ request } = await publicClient.simulateContract({
          account,
          address: entryPoint,
          abi: entryPoint07Abi,
          functionName: 'handleOps',
          args: [ops as PackedUserOperation[], beneficiary],
        }));
      } catch (err) {
        throw handleOpsError(err);
      }
      const txHash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error(`EntryPoint.handleOps transaction ${txHash} reverted on-chain`);
      return { txHash, receipt };
    },
  };
}
