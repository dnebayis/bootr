/**
 * Self-funded gas. Without a paymaster (`PAYMASTER_URL` unset) every userOp's prefund is paid by the kernel itself:
 * the EntryPoint takes it from the kernel's EntryPoint deposit, then from the kernel's ETH balance
 * (`Kernel.validateUserOp` forwards `missingAccountFunds`). Both are "gas" here: ETH on a kernel can only ever leave
 * as prefund, because no session-key rule carries value and the root validator is the guardian.
 *
 * Where the gas comes from:
 *  - the platform seeds `GAS_BOOTSTRAP_WEI` from the admin EOA when the session key is installed (`bootstrapGas`);
 *  - afterwards the agent pays from its own fee share: the fee policy unwraps the kernel's WETH into ETH
 *    (`WETH.withdraw`, allow-listed since rule layout 3) whenever gas drops under `GAS_MIN_WEI`, up to `GAS_TARGET_WEI`;
 *  - anyone may top a kernel up with `EntryPoint.depositTo(kernel)` (the web app's "Add gas"; the console's admin top-up
 *    goes through `POST /internal/agents/:id/gas/top-up`).
 */
import { encodeFunctionData, formatEther, parseAbi, type Address } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';
import type { Config } from './config.js';
import type { AgentRow, SupervisorContext } from './context.js';
import type { KernelCall } from './kernel.js';
import { deserializeSessionPolicy, hasGasRule, type SerializedSessionPolicy } from './session-key.js';

export const wethAbi = parseAbi(['function withdraw(uint256 wad)', 'function deposit() payable']);

/** `sponsored` = a paymaster pays (no self-funding); otherwise relative to `GAS_MIN_WEI`. */
export type GasStatus = 'sponsored' | 'ok' | 'low' | 'empty';

/** Below `GAS_MIN_WEI / GAS_EMPTY_DIVISOR` the kernel is treated as unable to pay even one op. */
export const GAS_EMPTY_DIVISOR = 5n;

export interface GasReading {
  /** EntryPoint deposit + kernel ETH balance (wei). */
  total: bigint;
  deposit: bigint;
  balance: bigint;
  status: GasStatus;
}

/** Human form for snapshots, the model and the admin API. */
export interface GasView {
  eth: string;
  deposit: string;
  balance: string;
  status: GasStatus;
}

export function gasSelfFunded(config: Pick<Config, 'PAYMASTER_URL'>): boolean {
  return !config.PAYMASTER_URL;
}

export function gasStatusOf(total: bigint, minWei: bigint, selfFunded: boolean): GasStatus {
  if (!selfFunded) return 'sponsored';
  if (total >= minWei) return 'ok';
  if (total >= minWei / GAS_EMPTY_DIVISOR) return 'low';
  return 'empty';
}

export function gasReading(args: { deposit: bigint; balance: bigint; minWei: bigint; selfFunded: boolean }): GasReading {
  const total = args.deposit + args.balance;
  return { total, deposit: args.deposit, balance: args.balance, status: gasStatusOf(total, args.minWei, args.selfFunded) };
}

export function gasView(g: GasReading): GasView {
  return { eth: formatEther(g.total), deposit: formatEther(g.deposit), balance: formatEther(g.balance), status: g.status };
}

export async function readEntryPointDeposit(ctx: SupervisorContext, kernel: Address): Promise<bigint> {
  return ctx.chain.publicClient.readContract({ address: entryPoint07Address, abi: entryPoint07Abi, functionName: 'balanceOf', args: [kernel] });
}

export async function readGas(ctx: SupervisorContext, kernel: Address): Promise<GasReading> {
  const [deposit, balance] = await Promise.all([readEntryPointDeposit(ctx, kernel), ctx.chain.publicClient.getBalance({ address: kernel })]);
  return gasReading({ deposit, balance, minWei: BigInt(ctx.config.GAS_MIN_WEI), selfFunded: gasSelfFunded(ctx.config) });
}

/** `WETH.withdraw(amount)`: WETH9 sends the ETH to `msg.sender`, the kernel. */
export function encodeUnwrapCall(weth: Address, amount: bigint): KernelCall {
  if (amount <= 0n) throw new Error('unwrap amount must be positive');
  return { to: weth, value: 0n, data: encodeFunctionData({ abi: wethAbi, functionName: 'withdraw', args: [amount] }) };
}

/**
 * WETH to unwrap now: nothing while gas is at or above `minWei`; otherwise what is missing up to `targetWei`,
 * bounded by the kernel's WETH.
 */
export function gasTopUp(args: { total: bigint; minWei: bigint; targetWei: bigint; wethBalance: bigint }): bigint {
  if (args.total >= args.minWei) return 0n;
  const want = args.targetWei > args.total ? args.targetWei - args.total : 0n;
  const amount = want < args.wethBalance ? want : args.wethBalance;
  return amount > 0n ? amount : 0n;
}

/** Whether this agent's installed session key may unwrap WETH (rule layout >= 3; no stored policy = the current layout). */
export function agentHasGasRule(agent: Pick<AgentRow, 'sessionPolicy'>): boolean {
  if (!agent.sessionPolicy) return true;
  return hasGasRule(deserializeSessionPolicy(agent.sessionPolicy as unknown as SerializedSessionPolicy));
}

/**
 * Seeds a kernel's gas from the admin EOA up to `GAS_BOOTSTRAP_WEI` (idempotent: reads the chain first, deposits only
 * the shortfall). Null when nothing was deposited: sponsored gas, no admin signer, or already funded.
 */
export async function bootstrapGas(ctx: SupervisorContext, agent: Pick<AgentRow, 'agentId' | 'kernel'>): Promise<{ txHash: `0x${string}`; wei: bigint } | null> {
  if (!gasSelfFunded(ctx.config) || !ctx.adminSigner) return null;
  const kernel = agent.kernel as Address;
  const target = BigInt(ctx.config.GAS_BOOTSTRAP_WEI);
  const gas = await readGas(ctx, kernel);
  if (gas.total >= target) return null;
  const wei = target - gas.total;
  const { txHash } = await ctx.adminSigner.depositGas(kernel, wei);
  ctx.log.info({ agentId: agent.agentId, kernel, wei: wei.toString(), txHash }, 'gas bootstrapped from the admin wallet');
  return { txHash, wei };
}
