/**
 * The only module that holds the guardian owner's key. It signs exactly four kinds of transactions:
 * approveSessionKey, revokeSessionKey/revokeAllSessionKeys(Batch), `EntryPoint.depositTo(kernel)` (a kernel's
 * starting gas, gas.ts) and (with ENABLE_MODE_SELF_BUNDLE) `EntryPoint.handleOps` for enable-mode userOps that
 * strict bundlers refuse. Swap the
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
  /** `EntryPoint.depositTo(kernel){value: wei}` from the admin EOA: gas the kernel can only spend as userOp prefund. */
  depositGas(kernel: Address, wei: bigint): Promise<{ txHash: Hex }>;
}

export function createLocalAdminSigner(args: {
  privateKey: Hex;
  chain: Chain;
  rpcUrl: string;
  guardian: Address;
  publicClient: PublicClient<Transport, Chain>;
  entryPoint?: Address;
  /** Max ETH (wei) deposited into the EntryPoint for a sender before a self-bundled op. Default 0.005 ETH. */
  maxPrefundWei?: bigint;
}): AdminSigner {
  const account = privateKeyToAccount(args.privateKey);
  const wallet = createWalletClient({ account, chain: args.chain, transport: http(args.rpcUrl) });
  const { publicClient, guardian, chain } = args;
  const entryPoint = args.entryPoint ?? entryPoint07Address;
  const maxPrefundWei = args.maxPrefundWei ?? 5_000_000_000_000_000n;
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
    async depositGas(kernel, wei) {
      if (wei <= 0n) throw new Error('depositGas: amount must be positive');
      const txHash = await wallet.writeContract({ account, address: entryPoint, abi: entryPoint07Abi, functionName: 'depositTo', args: [kernel], value: wei, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error(`EntryPoint.depositTo transaction ${txHash} reverted on-chain`);
      return { txHash };
    },
    async handleOps(ops, beneficiary) {
      // Self-bundled ops have no paymaster: the sender pays its prefund from its EntryPoint deposit or ETH
      // balance. Fresh kernels hold neither, so top up the deposit (bounded by maxPrefundWei) before sending.
      for (const op of ops) {
        const verification = BigInt(`0x${op.accountGasLimits.slice(2, 34)}`);
        const call = BigInt(`0x${op.accountGasLimits.slice(34, 66)}`);
        const maxFee = BigInt(`0x${op.gasFees.slice(34, 66)}`);
        const required = (verification + call + op.preVerificationGas) * maxFee;
        const [deposit, balance] = await Promise.all([
          publicClient.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [op.sender] }),
          publicClient.getBalance({ address: op.sender }),
        ]);
        const shortfall = required - deposit - balance;
        if (shortfall <= 0n) continue;
        const topUp = (shortfall * 11n) / 10n;
        if (topUp > maxPrefundWei) throw new Error(`self-bundle prefund ${topUp} wei for ${op.sender} exceeds ENABLE_MODE_MAX_PREFUND_WEI (${maxPrefundWei})`);
        const depositHash = await wallet.writeContract({ account, address: entryPoint, abi: entryPoint07Abi, functionName: 'depositTo', args: [op.sender], value: topUp, chain });
        await publicClient.waitForTransactionReceipt({ hash: depositHash });
      }
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
