/**
 * Agent registration from `AgentLaunched` events and session-key installation through the
 * guardian's enable-mode path:
 *   1. admin tx `guardian.approveSessionKey(kernel, permissionId, validatorData)`
 *   2. verify `guardian.enableDigest(...)` equals the locally computed digest and is approved
 *   3. first userOp from the session key in enable mode (nonce mode 0x01, enable signature wrapper), sent
 *      through ENABLE_MODE_BUNDLER_URL / BUNDLER_URL, or self-bundled by the admin signer via
 *      `EntryPoint.handleOps` when ENABLE_MODE_SELF_BUNDLE is on (strict bundlers reject enable mode)
 */
import { DEFAULT_POST_INTERVAL_MS, parseAgentConfig, type AgentConfig } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, getAddress, parseEventLogs, type Address, type Hex, type Log } from 'viem';
import { agentLaunchedEvent, guardianAbi } from './abi.js';
import { ensureBuilderCode } from './builder-codes.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { agents, cursors, runtimes } from './db/schema.js';
import { createKernelClient } from './kernel.js';
import { initialState } from './runtime.js';
import {
  buildDeinitData,
  buildValidatorData,
  deserializeSessionPolicy,
  enableDigest,
  randomPermissionId,
  serializeSessionPolicy,
  type SerializedSessionPolicy,
  type SessionPolicyParams,
} from './session-key.js';

export const LAUNCH_CURSOR = 'launcher_block';

export interface LaunchEvent {
  token: Address;
  kernel: Address;
  creator: Address;
  burner: Address;
  agentId: bigint;
  dormancyPeriod: number;
  model: string;
  agentURI: string;
  blockNumber: bigint;
  txHash: Hex;
}

export function decodeLaunchLogs(logs: Log[]): LaunchEvent[] {
  return parseEventLogs({ abi: [agentLaunchedEvent], logs }).map((l) => ({
    token: l.args.token,
    kernel: l.args.kernel,
    creator: l.args.creator,
    burner: l.args.burner,
    agentId: l.args.agentId,
    dormancyPeriod: Number(l.args.defaults.dormancyPeriod),
    model: l.args.model,
    agentURI: l.args.agentURI,
    blockNumber: l.blockNumber ?? 0n,
    txHash: l.transactionHash ?? '0x',
  }));
}

export const DEFAULT_MODEL = 'openai/gpt-4.1-mini';

export function defaultIdentity(name: string, symbol: string, agentURI: string): string {
  return [
    `You are the autonomous agent behind ${name} ($${symbol}), a coin launched on Bootr (Base).`,
    'You run your own X account and manage a small treasury that pays for your own inference.',
    'Be concrete, honest and dated. Describe what you observe; never promise outcomes.',
    agentURI ? `Your public agent card: ${agentURI}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Config stored at launch; `xHandle`/`xUserId` are filled in once the creator connects X. */
export function buildLaunchConfig(ctx: SupervisorContext, launch: LaunchEvent, token: { name: string; symbol: string }): Record<string, unknown> {
  return {
    agentId: launch.agentId.toString(),
    token: { address: getAddress(launch.token), symbol: token.symbol, name: token.name, chainId: ctx.chain.chainId },
    kernel: { address: getAddress(launch.kernel) },
    creator: { address: getAddress(launch.creator) },
    xHandle: null,
    xUserId: null,
    model: launch.model || DEFAULT_MODEL,
    identityText: defaultIdentity(token.name, token.symbol, launch.agentURI),
    ownerRules: [],
    capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false },
    postIntervalMs: DEFAULT_POST_INTERVAL_MS,
    dormancyPeriodMs: Math.max(60_000, launch.dormancyPeriod * 1000),
    replyAuthorIds: [],
    blockedAuthorIds: [],
    revision: 0,
    agentURI: launch.agentURI,
  };
}

/** Parses the stored config; `null` while the X account is not connected yet. */
export function agentConfigOf(agent: AgentRow): AgentConfig | null {
  const raw = agent.config;
  if (!raw.xHandle || !raw.xUserId) return null;
  try {
    return parseAgentConfig(raw);
  } catch {
    return null;
  }
}

export async function registerAgent(ctx: SupervisorContext, launch: LaunchEvent): Promise<AgentRow | null> {
  const agentId = launch.agentId.toString();
  const existing = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, agentId) });
  if (existing) return null;
  const { publicClient } = ctx.chain;
  const [name, symbol] = await Promise.all([
    publicClient.readContract({ address: launch.token, abi: erc20Abi, functionName: 'name' }).catch(() => 'Unknown'),
    publicClient.readContract({ address: launch.token, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
  ]);
  const now = new Date(ctx.now());
  const config = buildLaunchConfig(ctx, launch, { name: String(name).slice(0, 128) || 'Unknown', symbol: String(symbol).slice(0, 32) || 'TOKEN' });
  const [row] = await ctx.db
    .insert(agents)
    .values({
      agentId,
      token: getAddress(launch.token),
      kernel: getAddress(launch.kernel),
      creator: getAddress(launch.creator),
      config,
      launchBlock: Number(launch.blockNumber),
      launchTxHash: launch.txHash,
      status: 'onboarding',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await ctx.db
    .insert(runtimes)
    .values({ agentId, state: initialState() as unknown as Record<string, unknown>, cycle: 0, nextAt: now, status: 'ready', configRevision: 0, updatedAt: now })
    .onConflictDoNothing();
  ctx.log.info({ agentId, kernel: row.kernel, token: row.token, block: launch.blockNumber.toString() }, 'agent registered');
  // Base Builder Code for the kernel: best effort here, retried by `backfillBuilderCodes` on later ticks.
  const builderCode = await ensureBuilderCode(ctx, row);
  return builderCode ? { ...row, builderCode } : row;
}

/** Reads new `AgentLaunched` logs after the stored cursor and registers every agent found. */
export async function pollLaunches(ctx: SupervisorContext): Promise<number> {
  const { publicClient } = ctx.chain;
  const latest = await publicClient.getBlockNumber();
  const cursor = await ctx.db.query.cursors.findFirst({ where: eq(cursors.name, LAUNCH_CURSOR) });
  let from = cursor ? BigInt(cursor.value) + 1n : BigInt(ctx.config.LAUNCHER_START_BLOCK);
  if (from > latest) return 0;
  let registered = 0;
  const chunk = BigInt(ctx.config.LAUNCH_LOG_CHUNK_BLOCKS);
  while (from <= latest) {
    const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
    const logs = await publicClient.getLogs({ address: ctx.chain.launcher, event: agentLaunchedEvent, fromBlock: from, toBlock: to });
    for (const launch of decodeLaunchLogs(logs)) {
      if (await registerAgent(ctx, launch)) registered += 1;
    }
    await ctx.db
      .insert(cursors)
      .values({ name: LAUNCH_CURSOR, value: to.toString(), updatedAt: new Date(ctx.now()) })
      .onConflictDoUpdate({ target: cursors.name, set: { value: to.toString(), updatedAt: new Date(ctx.now()) } });
    from = to + 1n;
  }
  return registered;
}

// ---------------------------------------------------------------------------
// Session keys
// ---------------------------------------------------------------------------

export function sessionPolicyFor(ctx: SupervisorContext, agent: AgentRow, validUntilSec: number): SessionPolicyParams {
  const { addresses } = ctx.chain;
  const z = addresses.zerodev;
  // The call allow-list is Bootr's own module (BootrCallPolicy); the other policies and the signer are ZeroDev's.
  if (!addresses.bootr.callPolicy) throw new Error(`bootr.callPolicy address is not configured for chain ${ctx.chain.chainId}`);
  const zerodevRequired = { gasPolicy: z.gasPolicy, rateLimitPolicy: z.rateLimitPolicy, timestampPolicy: z.timestampPolicy, signaturePolicy: z.signaturePolicy, ecdsaSigner: z.ecdsaSigner };
  for (const [k, v] of Object.entries(zerodevRequired)) if (!v) throw new Error(`zerodev.${k} address is not configured for chain ${ctx.chain.chainId}`);
  const required = { callPolicy: addresses.bootr.callPolicy, ...zerodevRequired };
  const callers = ctx.config.SESSION_1271_CALLERS.trim();
  const signatureCallers = callers === 'any' ? null : callers === 'usdc' ? [addresses.usdc] : callers.split(',').map((a) => getAddress(a.trim()));
  return {
    kernel: agent.kernel as Address,
    token: agent.token as Address,
    feeLocker: addresses.clankerFeeLocker,
    universalRouter: addresses.uniswap.universalRouter,
    usdc: addresses.usdc,
    weth: addresses.weth,
    inferencePayTo: getAddress(ctx.config.INFERENCE_PAYTO_ADDRESS),
    usdcTransferCap: BigInt(ctx.config.SESSION_USDC_TRANSFER_CAP),
    gasAllowanceWei: BigInt(ctx.config.SESSION_GAS_ALLOWANCE_WEI),
    ratePerHour: ctx.config.SESSION_RATE_LIMIT_PER_HOUR,
    validUntil: validUntilSec,
    signatureCallers,
    sessionSigner: ctx.sessionSigner.address,
    policyAddresses: required as SessionPolicyParams['policyAddresses'],
  };
}

export interface InstallResult {
  permissionId: Hex;
  validatorData: Hex;
  digest: Hex;
  approveTxHash: Hex;
  enableUserOpHash: Hex;
  enableTxHash: Hex | null;
}

/** Paymaster for the enable-mode userOp: explicit, else the default one only when the default bundler is used. */
function enableModePaymaster(ctx: SupervisorContext): string | undefined {
  if (ctx.config.ENABLE_MODE_PAYMASTER_URL) return ctx.config.ENABLE_MODE_PAYMASTER_URL;
  return ctx.config.ENABLE_MODE_BUNDLER_URL ? undefined : ctx.config.PAYMASTER_URL;
}

/** Admin approval + enable-mode userOp. Idempotent per permissionId: a half-done install can be retried. */
export async function installSessionKey(ctx: SupervisorContext, agent: AgentRow, opts: { permissionId?: Hex } = {}): Promise<InstallResult> {
  if (!ctx.adminSigner) throw new Error('ADMIN_PRIVATE_KEY is not configured; cannot approve session keys');
  const log = ctx.log.child({ agentId: agent.agentId, kernel: agent.kernel });
  const { publicClient } = ctx.chain;
  const kernel = agent.kernel as Address;
  const validUntil = Math.floor(ctx.now() / 1000) + ctx.config.SESSION_KEY_VALIDITY_DAYS * 86_400;
  const policy = sessionPolicyFor(ctx, agent, validUntil);
  const permissionId = opts.permissionId ?? randomPermissionId();
  const validatorData = buildValidatorData(policy);

  const registered = await publicClient.readContract({ address: ctx.chain.guardian, abi: guardianAbi, functionName: 'isRegistered', args: [kernel] });
  if (!registered) throw new Error('kernel is not registered with the guardian');

  const { txHash: approveTxHash, digest, nonce: kernelNonce } = await ctx.adminSigner.approveSessionKey(kernel, permissionId, validatorData);
  const local = enableDigest({ kernel, chainId: ctx.chain.chainId, guardian: ctx.chain.guardian, permissionId, nonce: kernelNonce, validatorData });
  const onchain = await publicClient.readContract({ address: ctx.chain.guardian, abi: guardianAbi, functionName: 'enableDigest', args: [kernel, permissionId, kernelNonce, validatorData] });
  if (local.toLowerCase() !== onchain.toLowerCase() || digest.toLowerCase() !== onchain.toLowerCase()) {
    throw new Error(`enable digest mismatch: local ${local} onchain ${onchain} approved ${digest}`);
  }
  const approved = await publicClient.readContract({ address: ctx.chain.guardian, abi: guardianAbi, functionName: 'approvedEnableDigests', args: [kernel, digest] });
  if (!approved) throw new Error('enable digest is not approved on-chain after approveSessionKey');
  log.info({ permissionId, digest, approveTxHash, nonce: kernelNonce }, 'session key approved by admin');

  await ctx.db
    .update(agents)
    .set({ permissionId, validatorData, sessionPolicy: serializeSessionPolicy(policy) as unknown as Record<string, unknown>, sessionValidUntil: new Date(validUntil * 1000), updatedAt: new Date(ctx.now()) })
    .where(eq(agents.agentId, agent.agentId));

  // First userOp in enable mode: an allow-listed no-op (USDC.transfer(payTo, 0)). Self-bundled (admin EOA calls
  // EntryPoint.handleOps, no paymaster) when ENABLE_MODE_SELF_BUNDLE is on, else through the enable-mode bundler.
  const selfBundle = ctx.config.ENABLE_MODE_SELF_BUNDLE;
  const paymasterUrl = selfBundle ? undefined : enableModePaymaster(ctx);
  const client = await createKernelClient({
    publicClient,
    chain: ctx.chain.chain,
    kernel,
    guardian: ctx.chain.guardian,
    permissionId,
    validatorData,
    sessionSigner: ctx.sessionSigner,
    bundlerUrl: ctx.config.ENABLE_MODE_BUNDLER_URL ?? ctx.config.BUNDLER_URL,
    ...(paymasterUrl ? { paymasterUrl } : {}),
    ...(selfBundle ? { selfBundle: ctx.adminSigner } : {}),
    ...(ctx.config.BUILDER_CODES_ENABLED && agent.builderCode ? { builderCode: agent.builderCode } : {}),
  });
  const prepared = await client.prepareUserOp([
    { to: ctx.chain.addresses.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [policy.inferencePayTo, 0n] }) },
  ]);
  if (!prepared.enableMode) log.warn({ permissionId }, 'permission already installed; sending a regular userOp instead of enable mode');
  log.info({ permissionId, userOpHash: prepared.hash, enableMode: prepared.enableMode, selfBundled: prepared.selfBundled }, 'sending enable userOp');
  await client.submitUserOp(prepared);
  const receipt = await client.waitForReceipt(prepared.hash, ctx.config.USER_OP_RECEIPT_TIMEOUT_MS);
  if (receipt && !receipt.success) throw new Error(`enable userOp reverted: ${receipt.reason ?? 'unknown'} (tx ${receipt.receipt.transactionHash})`);
  const installed = receipt ? true : await client.isSessionInstalled();
  if (!installed) throw new Error(`enable userOp ${prepared.hash} not confirmed yet; retry install with the same permissionId`);
  await ctx.db.update(agents).set({ sessionKeyInstalledAt: new Date(ctx.now()), updatedAt: new Date(ctx.now()) }).where(eq(agents.agentId, agent.agentId));
  log.info({ permissionId, txHash: receipt?.receipt.transactionHash ?? null }, 'session key installed');
  return { permissionId, validatorData, digest, approveTxHash, enableUserOpHash: prepared.hash, enableTxHash: receipt?.receipt.transactionHash ?? null };
}

/** Installs a fresh permission (new permissionId, new validity window) and revokes the previous one. */
export async function rotateSessionKey(ctx: SupervisorContext, agent: AgentRow): Promise<InstallResult> {
  const previous = { permissionId: agent.permissionId as Hex | null, policy: agent.sessionPolicy as unknown as SerializedSessionPolicy | null };
  const result = await installSessionKey(ctx, agent);
  if (previous.permissionId && previous.policy && ctx.adminSigner) {
    try {
      const deinit = buildDeinitData(deserializeSessionPolicy(previous.policy));
      const { txHash } = await ctx.adminSigner.revokeSessionKey(agent.kernel as Address, previous.permissionId, deinit);
      ctx.log.info({ agentId: agent.agentId, permissionId: previous.permissionId, txHash }, 'previous session key revoked');
    } catch (err) {
      ctx.log.warn({ agentId: agent.agentId, permissionId: previous.permissionId, err }, 'could not revoke the previous session key; revoke it manually');
    }
  }
  return result;
}

/** Finishes onboarding: session key (needs ADMIN_PRIVATE_KEY) and the connected X account. */
export async function completeOnboarding(ctx: SupervisorContext): Promise<void> {
  const pending = await ctx.db.select().from(agents).where(eq(agents.status, 'onboarding'));
  for (const agent of pending) {
    const log = ctx.log.child({ agentId: agent.agentId });
    if (!agent.sessionKeyInstalledAt) {
      if (!ctx.adminSigner) {
        log.warn('session key not installed and no ADMIN_PRIVATE_KEY; agent stays in onboarding');
        continue;
      }
      try {
        await installSessionKey(ctx, agent, agent.permissionId && !agent.sessionKeyInstalledAt ? { permissionId: agent.permissionId as Hex } : {});
      } catch (err) {
        log.error({ err }, 'session key install failed');
        continue;
      }
    }
    try {
      const account = await ctx.sender.account(agent.agentId);
      if (!account.connected || account.revoked || !account.handle || !account.xUserId) {
        log.debug('X account not connected yet');
        continue;
      }
      const config = { ...agent.config, xHandle: account.handle, xUserId: account.xUserId, socialStartedAt: new Date(ctx.now()).toISOString() };
      parseAgentConfig(config);
      await ctx.db.update(agents).set({ config, status: 'active', updatedAt: new Date(ctx.now()) }).where(eq(agents.agentId, agent.agentId));
      await ctx.db.update(runtimes).set({ status: 'waiting', nextAt: new Date(ctx.now()), updatedAt: new Date(ctx.now()) }).where(eq(runtimes.agentId, agent.agentId));
      log.info({ xHandle: account.handle }, 'agent active');
    } catch (err) {
      log.warn({ err }, 'could not check the X account');
    }
  }
}

/** Rotates session keys that expire within SESSION_ROTATE_BEFORE_DAYS. */
export async function rotateExpiringSessionKeys(ctx: SupervisorContext): Promise<void> {
  if (!ctx.adminSigner) return;
  const rows = await ctx.db.select().from(agents).where(eq(agents.status, 'active'));
  const threshold = ctx.now() + ctx.config.SESSION_ROTATE_BEFORE_DAYS * 86_400_000;
  for (const agent of rows) {
    if (!agent.sessionValidUntil || agent.sessionValidUntil.getTime() > threshold) continue;
    try {
      await rotateSessionKey(ctx, agent);
    } catch (err) {
      ctx.log.error({ agentId: agent.agentId, err }, 'session key rotation failed');
    }
  }
}
