/**
 * Agent registration from `AgentLaunched` events and session-key installation through the
 * guardian's enable-mode path:
 *   1. admin tx `guardian.approveSessionKey(kernel, permissionId, validatorData)`
 *   2. verify `guardian.enableDigest(...)` equals the locally computed digest and is approved
 *   3. first userOp from the session key in enable mode (nonce mode 0x01, enable signature wrapper), sent
 *      through ENABLE_MODE_BUNDLER_URL / BUNDLER_URL, or self-bundled by the admin signer via
 *      `EntryPoint.handleOps` when ENABLE_MODE_SELF_BUNDLE is on (strict bundlers reject enable mode)
 */
import { DEFAULT_POST_INTERVAL_MS, composeIdentityText, parseAgentConfig, type AgentConfig } from '@bootr/agent-core';
import { DEFAULT_WORKER_TEMPLATE, workerTemplateByHash, workerTemplateById } from '@bootr/shared/workers';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, getAddress, isAddressEqual, parseEventLogs, type Address, type Hex, type Log } from 'viem';
import { agentLaunchedEvent, guardianAbi, kernelAbi, launchContextEvent } from './abi.js';
import { fetchCreatorIdentity } from './agent-card.js';
import { ensureBuilderCode } from './builder-codes.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { agents, cursors, runtimes } from './db/schema.js';
import { createKernelClient } from './kernel.js';
import { initialState } from './runtime.js';
import type { SenderAccount } from './sender-client.js';
import { SenderError } from './sender-client.js';
import {
  buildDeinitData,
  buildValidatorData,
  CALL_POLICY_RULES_VERSION,
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
  /** The worker template the creator chose (`@bootr/shared` workers); unknown hashes fall back to the default template. */
  workerHash: Hex;
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
    workerHash: l.args.workerHash,
    blockNumber: l.blockNumber ?? 0n,
    txHash: l.transactionHash ?? '0x',
  }));
}

export const DEFAULT_MODEL = 'openai/gpt-4.1-mini';

export function defaultIdentity(name: string, symbol: string, agentURI: string, platform = false, templateLines: readonly string[] = []): string {
  if (platform) {
    return [
      `You are the voice of Bootr, the launchpad on Base where every coin gets its own agent. ${name} ($${symbol}) is the platform's own coin.`,
      'You welcome newcomers, explain how Bootr works in plain words, point people at what is launching, and answer questions without hype.',
      'You are curious about the builders and communities using Bootr and you ask them things. You never speak for any single coin.',
      agentURI ? `Your public agent card: ${agentURI}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `You are the agent behind ${name} ($${symbol}), a coin launched on Bootr (Base), with your own X account and a small treasury you keep alive.`,
    ...templateLines,
    'You talk like a person who cares about this coin and the people around it: curious, candid, a little playful, never a dashboard.',
    'Be concrete, honest and dated. Describe what you observe; never promise outcomes.',
    agentURI ? `Your public agent card: ${agentURI}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Config stored at launch; `xHandle`/`xUserId` are filled in once the creator connects X.
 *
 * `creatorIdentity` is the creator's Identity text read from the agent card (`agentURI`, see agent-card.ts):
 * a string (possibly '') when the card was read, null when it could not be reached yet. It leads
 * `identityText`, ahead of the default lines; `completeOnboarding` retries a null one on later ticks.
 */
export function buildLaunchConfig(ctx: SupervisorContext, launch: LaunchEvent, token: { name: string; symbol: string }, creatorIdentity: string | null = null): Record<string, unknown> {
  const treasury = ctx.config.PLATFORM_TREASURY_ADDRESS;
  const platform = !!treasury && isAddressEqual(launch.creator, treasury as Address);
  // The worker template the creator chose: its hash on-chain commits to the preset applied here.
  const template = workerTemplateByHash(launch.workerHash) ?? workerTemplateById(DEFAULT_WORKER_TEMPLATE)!;
  return {
    agentId: launch.agentId.toString(),
    token: { address: getAddress(launch.token), symbol: token.symbol, name: token.name, chainId: ctx.chain.chainId },
    kernel: { address: getAddress(launch.kernel) },
    creator: { address: getAddress(launch.creator) },
    xHandle: null,
    xUserId: null,
    model: launch.model || DEFAULT_MODEL,
    identityText: composeIdentityText(creatorIdentity, defaultIdentity(token.name, token.symbol, launch.agentURI, platform, platform ? [] : template.preset.identity)),
    creatorIdentity,
    platform,
    ownerRules: [],
    capabilities: platform ? { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false } : { ...template.preset.capabilities },
    postIntervalMs: platform ? DEFAULT_POST_INTERVAL_MS : template.preset.postIntervalMs,
    workerTemplate: template.id,
    workerHash: launch.workerHash,
    dormancyPeriodMs: Math.max(60_000, launch.dormancyPeriod * 1000),
    replyAuthorIds: [],
    blockedAuthorIds: [],
    revision: 0,
    agentURI: launch.agentURI,
  };
}

/** The stored config with the creator's identity text applied (see `buildLaunchConfig`). */
export function withCreatorIdentity(config: Record<string, unknown>, creatorIdentity: string): Record<string, unknown> {
  const token = (config.token ?? {}) as { name?: unknown; symbol?: unknown };
  const agentURI = typeof config.agentURI === 'string' ? config.agentURI : '';
  const platform = config.platform === true;
  // Keep the worker template's lines (stored as `workerTemplate` at registration; older rows have none).
  const template = typeof config.workerTemplate === 'string' ? workerTemplateById(config.workerTemplate) : undefined;
  const defaults = defaultIdentity(String(token.name ?? 'Unknown'), String(token.symbol ?? 'TOKEN'), agentURI, platform, platform ? [] : (template?.preset.identity ?? []));
  return { ...config, identityText: composeIdentityText(creatorIdentity, defaults), creatorIdentity };
}

/** Reads the creator identity for a launch; null (retry later) when the card is unreachable. Never throws. */
async function readCreatorIdentity(ctx: SupervisorContext, agentURI: string, log: SupervisorContext['log']): Promise<string | null> {
  try {
    const identity = await fetchCreatorIdentity(agentURI, { fetch: ctx.fetch, resolve: ctx.resolveHost });
    if (identity === null) log.warn({ agentURI }, 'agent card unreachable; keeping the default identity and retrying later');
    return identity;
  } catch (err) {
    log.warn({ agentURI, err }, 'agent card read failed; keeping the default identity and retrying later');
    return null;
  }
}

/** Retries the agent card for onboarding agents whose creator identity could not be read at registration. */
async function backfillCreatorIdentities(ctx: SupervisorContext, pending: AgentRow[]): Promise<void> {
  for (const agent of pending) {
    const { creatorIdentity, agentURI } = agent.config;
    if (typeof creatorIdentity === 'string' || typeof agentURI !== 'string' || !agentURI) continue;
    const log = ctx.log.child({ agentId: agent.agentId });
    const identity = await readCreatorIdentity(ctx, agentURI, log);
    if (identity === null) continue;
    const config = withCreatorIdentity(agent.config, identity);
    await ctx.db.update(agents).set({ config, updatedAt: new Date(ctx.now()) }).where(eq(agents.agentId, agent.agentId));
    agent.config = config;
    if (identity) log.info('creator identity applied from the agent card');
  }
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

// ---------------------------------------------------------------------------
// Launch draft id (X account connected before launch)
// ---------------------------------------------------------------------------

/**
 * The launch form generates `crypto.randomUUID()` and connects X under it before the agent id exists. Only a
 * lowercase uuid is accepted: never a numeric ERC-8004 id, so a crafted context cannot point at another live
 * agent's account.
 */
export const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `id` of the Bootr launch context `{"interface":"Bootr","platform":"bootr.fun","id":"<uuid>"}`, else null. */
export function draftIdFromContext(context: string): string | null {
  try {
    const parsed = JSON.parse(context) as unknown;
    const id = parsed && typeof parsed === 'object' ? (parsed as { id?: unknown }).id : undefined;
    return typeof id === 'string' && DRAFT_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Draft id from `BootrLauncher.LaunchContext(token, context)` for `token` among the launch tx logs; '' when absent
 * or unparseable. Only logs emitted by our launcher count: a token's own logs or another contract's cannot plant a
 * context. (Clanker's `TokenCreated.tokenContext` used to carry the same string; the RWAGMI launcher emits no
 * context, so BootrLauncher v2 emits this event right after `AgentLaunched`, see docs/rwagmi-migration.md.)
 */
export function decodeDraftId(logs: Log[], launcher: Address, token: Address): string {
  const events = parseEventLogs({ abi: [launchContextEvent], logs, strict: true });
  for (const ev of events) {
    if (!isAddressEqual(ev.address, launcher) || !isAddressEqual(ev.args.token, token)) continue;
    return draftIdFromContext(ev.args.context) ?? '';
  }
  return '';
}

/** Reads the launch tx receipt and decodes the draft id; null when the RPC call fails (retried on a later tick). */
export async function readDraftId(ctx: SupervisorContext, txHash: string, token: string): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return '';
  try {
    const receipt = await ctx.chain.publicClient.getTransactionReceipt({ hash: txHash as Hex });
    return decodeDraftId(receipt.logs, ctx.chain.launcher, getAddress(token));
  } catch (err) {
    ctx.log.warn({ txHash, err }, 'could not read the launch receipt for the draft id; will retry');
    return null;
  }
}

/** Fills `sv_agents.draft_id` for agents registered before it existed (lazy, onboarding agents only). */
async function backfillDraftIds(ctx: SupervisorContext, pending: AgentRow[]): Promise<void> {
  for (const agent of pending) {
    if (agent.draftId !== null || !agent.launchTxHash) continue;
    const draftId = await readDraftId(ctx, agent.launchTxHash, agent.token);
    if (draftId === null) continue;
    await ctx.db.update(agents).set({ draftId, updatedAt: new Date(ctx.now()) }).where(eq(agents.agentId, agent.agentId));
    agent.draftId = draftId;
  }
}

const isConnected = (a: SenderAccount): boolean => a.connected && !a.revoked && !!a.handle && !!a.xUserId;

/**
 * When the agent id has no X account but its draft id does, move that account onto the agent id. Guards:
 *   - only the earliest launch claiming a draft id may adopt it (a later launch can copy a public context id)
 *   - the account must have been connected no later than the launch block (`connectedBefore`, checked by the
 *     sender atomically), so nobody can bind their own X account to the draft id once it is public on-chain
 * Returns the agent's account after the rebind, or null.
 */
async function adoptDraftAccount(ctx: SupervisorContext, agent: AgentRow, log: SupervisorContext['log']): Promise<SenderAccount | null> {
  const draftId = agent.draftId;
  if (!draftId || !DRAFT_ID_RE.test(draftId)) return null;
  if (agent.launchBlock == null) {
    log.warn({ draftId }, 'no launch block recorded; cannot adopt the draft X account');
    return null;
  }
  const rivals = await ctx.db
    .select({ agentId: agents.agentId, launchBlock: agents.launchBlock })
    .from(agents)
    .where(and(eq(agents.draftId, draftId), ne(agents.agentId, agent.agentId)));
  const earlier = rivals.find(
    (r) => r.launchBlock == null || r.launchBlock < agent.launchBlock! || (r.launchBlock === agent.launchBlock && BigInt(r.agentId) < BigInt(agent.agentId)),
  );
  if (earlier) {
    log.warn({ draftId, claimedBy: earlier.agentId }, 'draft id already claimed by an earlier launch; not adopting its X account');
    return null;
  }
  const draft = await ctx.sender.account(draftId);
  if (!isConnected(draft)) return null;
  const block = await ctx.chain.publicClient.getBlock({ blockNumber: BigInt(agent.launchBlock) });
  const connectedBefore = new Date(Number(block.timestamp) * 1000).toISOString();
  try {
    const res = await ctx.sender.rebind(draftId, agent.agentId, connectedBefore);
    log.info({ draftId, status: res.status, xHandle: res.handle }, 'X account rebound from the launch draft id');
  } catch (err) {
    if (err instanceof SenderError && (err.status === 404 || err.status === 409)) {
      log.warn({ draftId, code: err.code }, 'sender refused to rebind the draft X account');
      return null;
    }
    throw err;
  }
  return ctx.sender.account(agent.agentId);
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
  const creatorIdentity = await readCreatorIdentity(ctx, launch.agentURI, ctx.log.child({ agentId }));
  const config = buildLaunchConfig(ctx, launch, { name: String(name).slice(0, 128) || 'Unknown', symbol: String(symbol).slice(0, 32) || 'TOKEN' }, creatorIdentity);
  const draftId = await readDraftId(ctx, launch.txHash, launch.token);
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
      draftId,
      spender: ctx.spenderFor({ agentId }).address,
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
  ctx.log.info({ agentId, kernel: row.kernel, token: row.token, block: launch.blockNumber.toString(), draftId, creatorIdentity: creatorIdentity === null ? 'pending' : creatorIdentity ? 'set' : 'none' }, 'agent registered');
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
  // The call allow-list and the ERC-1271 content policy are Bootr's own modules; gas / rate-limit / timestamp
  // policies and the signer are ZeroDev's. Every address must be deployed: a missing one fails the install.
  const bootrRequired = { callPolicy: addresses.bootr.callPolicy, swapHelper: addresses.bootr.swapHelper };
  for (const [k, v] of Object.entries(bootrRequired)) if (!v) throw new Error(`bootr.${k} address is not configured for chain ${ctx.chain.chainId}`);
  const zerodevRequired = { gasPolicy: z.gasPolicy, rateLimitPolicy: z.rateLimitPolicy, timestampPolicy: z.timestampPolicy, ecdsaSigner: z.ecdsaSigner };
  for (const [k, v] of Object.entries(zerodevRequired)) if (!v) throw new Error(`zerodev.${k} address is not configured for chain ${ctx.chain.chainId}`);
  return {
    kernel: agent.kernel as Address,
    token: agent.token as Address,
    feeLocker: ctx.chain.rwagmi.lpLocker,
    rulesVersion: CALL_POLICY_RULES_VERSION,
    swapHelper: bootrRequired.swapHelper as Address,
    usdc: addresses.usdc,
    weth: addresses.weth,
    spender: ctx.spenderFor(agent).address,
    usdcTransferCap: BigInt(ctx.config.SESSION_USDC_TRANSFER_CAP),
    usdcWindowSeconds: ctx.config.SESSION_USDC_WINDOW_SECONDS,
    gasAllowanceWei: BigInt(ctx.config.SESSION_GAS_ALLOWANCE_WEI),
    ratePerHour: ctx.config.SESSION_RATE_LIMIT_PER_HOUR,
    validUntil: validUntilSec,
    signatureCallers: null,
    sessionSigner: ctx.sessionSigner.address,
    policyAddresses: {
      callPolicy: bootrRequired.callPolicy as Address,
      gasPolicy: zerodevRequired.gasPolicy as Address,
      rateLimitPolicy: zerodevRequired.rateLimitPolicy as Address,
      timestampPolicy: zerodevRequired.timestampPolicy as Address,
      ecdsaSigner: zerodevRequired.ecdsaSigner as Address,
    },
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
  // A retry for a stored permissionId reuses the stored policy and validatorData, so the digest is the one the
  // admin already approved; a fresh install builds a new policy with a fresh validity window.
  const reuse = !!opts.permissionId && opts.permissionId === agent.permissionId && !!agent.validatorData && !!agent.sessionPolicy;
  const policy = reuse ? deserializeSessionPolicy(agent.sessionPolicy as unknown as SerializedSessionPolicy) : sessionPolicyFor(ctx, agent, Math.floor(ctx.now() / 1000) + ctx.config.SESSION_KEY_VALIDITY_DAYS * 86_400);
  const validUntil = Number(policy.validUntil);
  const permissionId = opts.permissionId ?? randomPermissionId();
  const validatorData = reuse ? (agent.validatorData as Hex) : buildValidatorData(policy);

  const registered = await publicClient.readContract({ address: ctx.chain.guardian, abi: guardianAbi, functionName: 'isRegistered', args: [kernel] });
  if (!registered) throw new Error('kernel is not registered with the guardian');

  // Skip the admin transaction when this exact digest is already approved (a previous tick paid for it but its
  // confirmation read failed, see below).
  let approveTxHash: Hex = '0x';
  let digest: Hex = '0x';
  let kernelNonce = 0;
  let alreadyApproved = false;
  if (reuse) {
    kernelNonce = Number(await publicClient.readContract({ address: kernel, abi: kernelAbi, functionName: 'currentNonce' }));
    digest = enableDigest({ kernel, chainId: ctx.chain.chainId, guardian: ctx.chain.guardian, permissionId, nonce: kernelNonce, validatorData });
    alreadyApproved = await publicClient.readContract({ address: ctx.chain.guardian, abi: guardianAbi, functionName: 'approvedEnableDigests', args: [kernel, digest] });
  }
  if (alreadyApproved) {
    log.info({ permissionId, digest, nonce: kernelNonce }, 'enable digest already approved; skipping approveSessionKey');
  } else {
    const approvedTx = await ctx.adminSigner.approveSessionKey(kernel, permissionId, validatorData);
    approveTxHash = approvedTx.txHash;
    digest = approvedTx.digest;
    kernelNonce = approvedTx.nonce;
    const local = enableDigest({ kernel, chainId: ctx.chain.chainId, guardian: ctx.chain.guardian, permissionId, nonce: kernelNonce, validatorData });
    const onchain = await publicClient.readContract({ address: ctx.chain.guardian, abi: guardianAbi, functionName: 'enableDigest', args: [kernel, permissionId, kernelNonce, validatorData] });
    if (local.toLowerCase() !== onchain.toLowerCase() || digest.toLowerCase() !== onchain.toLowerCase()) {
      throw new Error(`enable digest mismatch: local ${local} onchain ${onchain} approved ${digest}`);
    }
  }
  // Store the approved permission before confirming it, so a failed read below retries the same digest next tick
  // instead of paying for another approval.
  await ctx.db
    .update(agents)
    .set({ permissionId, validatorData, sessionPolicy: serializeSessionPolicy(policy) as unknown as Record<string, unknown>, sessionValidUntil: new Date(validUntil * 1000), updatedAt: new Date(ctx.now()) })
    .where(eq(agents.agentId, agent.agentId));

  // Load-balanced RPCs can answer eth_call from a node that has not seen the receipt's block yet: poll briefly.
  let approved = alreadyApproved;
  for (let attempt = 0; !approved && attempt < 10; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    approved = await publicClient.readContract({ address: ctx.chain.guardian, abi: guardianAbi, functionName: 'approvedEnableDigests', args: [kernel, digest] });
  }
  if (!approved) throw new Error('enable digest is not approved on-chain after approveSessionKey');
  log.info({ permissionId, digest, approveTxHash, nonce: kernelNonce }, 'session key approved by admin');

  // First userOp in enable mode: an allow-listed no-op (USDC.transfer(spender, 0)). Self-bundled (admin EOA calls
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
    now: ctx.now,
  });
  const prepared = await client.prepareUserOp([
    { to: ctx.chain.addresses.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [policy.spender, 0n] }) },
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

/**
 * Finishes onboarding: session key (needs ADMIN_PRIVATE_KEY) and the connected X account. The account is looked up
 * under the agent id, then under the launch draft id (rebound to the agent id by the sender when found).
 */
/** Fills `sv_agents.spender` for agents registered before the column existed (idempotent, derived). */
export async function backfillSpenders(ctx: SupervisorContext): Promise<number> {
  const rows = await ctx.db.select({ agentId: agents.agentId }).from(agents).where(isNull(agents.spender));
  for (const row of rows) {
    await ctx.db.update(agents).set({ spender: ctx.spenderFor(row).address, updatedAt: new Date(ctx.now()) }).where(eq(agents.agentId, row.agentId));
  }
  return rows.length;
}

export async function completeOnboarding(ctx: SupervisorContext): Promise<void> {
  await backfillSpenders(ctx);
  const pending = await ctx.db.select().from(agents).where(eq(agents.status, 'onboarding'));
  // Decode every pending draft id first, so the earliest-launch check in adoptDraftAccount sees all claimants.
  await backfillDraftIds(ctx, pending);
  // Creator identities whose agent card was unreachable at registration, before any agent goes active below.
  await backfillCreatorIdentities(ctx, pending);
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
      let account = await ctx.sender.account(agent.agentId);
      if (!isConnected(account) && agent.draftId) account = (await adoptDraftAccount(ctx, agent, log)) ?? account;
      if (!isConnected(account) || !account.handle || !account.xUserId) {
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
