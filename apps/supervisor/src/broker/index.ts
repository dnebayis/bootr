/**
 * Action broker: maps every agent-core tool to an executor and turns what happened into an
 * `ActionOutcome` for the agent-core broker state machine. Idempotency keys are the deterministic
 * `PendingAction.id` (sender publishes) and `sv_treasury_ops.op_id` (money).
 */
import {
  PolicyError,
  TOOLS,
  checkpoint,
  isPolicyError,
  replyEligibility,
  toolsFor,
  type Action,
  type ActionOutcome,
  type AgentConfig,
  type PendingAction,
  type ToolDefinition,
  type ToolName,
} from '@bootr/agent-core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { formatUnits, getAddress, isAddress, parseAbiItem, parseUnits, type Address, type Hex } from 'viem';
import type { AgentRow, SupervisorContext } from '../context.js';
import { actions, treasuryOps } from '../db/schema.js';
import { SenderError, type SenderInboxItem } from '../sender-client.js';
import { encodeSwapCalls, executeOp, minUsdcOut, opView, openOps, parseSwapRoute, prepareOp, readTreasuryOnChain, recentOps } from '../treasury.js';
import { readUrl, searchWeb } from '../web-reader.js';
import { encodeFunctionData, erc20Abi } from 'viem';

/** Tools the supervisor can actually execute right now (search needs an API key; images are not wired). */
export function availableTools(ctx: Pick<SupervisorContext, 'config'>, config: AgentConfig): ToolDefinition[] {
  return toolsFor(config).filter((t) => {
    if (t.name === 'generate_image') return false;
    if (t.name === 'search_web') return !!(ctx.config.SEARCH_API_URL && ctx.config.SEARCH_API_KEY);
    return true;
  });
}

export interface BrokerEnv {
  /** Inbox snapshot of this turn: postId -> item (for replyAuthorId resolution and eligibility). */
  inbox: Map<string, SenderInboxItem>;
}

export interface InboxView {
  postId: string;
  authorId: string;
  conversationId: string;
  eligible: boolean;
  reason?: string;
  post: SenderInboxItem['post'];
  observedAt: string | number;
}

export function inboxViews(config: AgentConfig, items: readonly SenderInboxItem[], now: number): InboxView[] {
  return items.map((item) => {
    const e = replyEligibility(item.post, {
      ownUserId: config.xUserId,
      ownHandle: config.xHandle,
      replyAuthorIds: config.replyAuthorIds,
      blockedAuthorIds: config.blockedAuthorIds,
      seenAt: typeof item.seenAt === 'number' ? item.seenAt : item.seenAt ? Date.parse(item.seenAt) : null,
      deferredUntil: typeof item.deferredUntil === 'number' ? item.deferredUntil : item.deferredUntil ? Date.parse(item.deferredUntil) : null,
      now,
    });
    return { postId: item.postId, authorId: item.authorId, conversationId: item.conversationId, eligible: e.eligible, ...(e.reason ? { reason: e.reason } : {}), post: item.post, observedAt: item.observedAt };
  });
}

function failed(error: string, retryAt?: number): ActionOutcome {
  return { kind: 'failed', error, ...(retryAt ? { retryAt } : {}) };
}

function errorText(err: unknown): string {
  if (isPolicyError(err)) return err.message;
  if (err instanceof Error) return `${err.name}: ${err.message.split('\n')[0]}`;
  return String(err);
}

/** Execute a bound action. Throws nothing: every failure becomes an outcome. */
export async function executeAction(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, pending: PendingAction, env: BrokerEnv): Promise<ActionOutcome> {
  const action = pending.action;
  try {
    return await dispatch(ctx, agent, config, pending, action, env);
  } catch (err) {
    if (err instanceof SenderError) {
      if (err.code === 'storage_unavailable_after_send') return { kind: 'unknown', error: err.code };
      return failed(`sender:${err.code}`, err.retryAt);
    }
    if (isPolicyError(err)) return failed(err.message, err.retryAt);
    const text = errorText(err);
    const transport = err instanceof Error && /abort|timeout|fetch failed|ECONN|network/i.test(text);
    if (transport && TOOLS[action.tool].effect !== 'read') return { kind: 'unknown', error: text };
    return failed(text);
  }
}

async function dispatch(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, pending: PendingAction, action: Action, env: BrokerEnv): Promise<ActionOutcome> {
  const agentId = agent.agentId;
  switch (action.tool) {
    case 'read_mentions': {
      const res = await ctx.sender.readMentions(agentId);
      for (const item of res.items) env.inbox.set(item.postId, item);
      const items = inboxViews(config, res.items, ctx.now());
      return { kind: 'completed', result: { throttled: res.throttled, nextReadAt: res.nextReadAt ?? null, items, instructionAuthority: false } };
    }
    case 'read_x_thread': {
      const res = await ctx.sender.readThread(agentId, action.input.postId);
      return { kind: 'completed', result: { ...res, instructionAuthority: false } };
    }
    case 'read_x_account': {
      const res = await ctx.sender.readAccount(agentId, action.input.username);
      return { kind: 'completed', result: { ...res, instructionAuthority: false } };
    }
    case 'recall_conversation': {
      const rows = await ctx.db
        .select()
        .from(actions)
        .where(and(eq(actions.agentId, agentId), eq(actions.status, 'completed')))
        .orderBy(desc(actions.createdAt))
        .limit(200);
      const mine = rows
        .filter((r) => {
          const a = r.action as unknown as Action;
          const res = (r.result ?? {}) as { replyAuthorId?: string };
          return (a.tool === 'publish_reply' || a.tool === 'publish_post') && res.replyAuthorId === action.input.authorId;
        })
        .filter((r) => !action.input.beforePostId || BigInt(((r.result ?? {}) as { postId?: string }).postId ?? '0') < BigInt(action.input.beforePostId))
        .slice(0, 20)
        .map((r) => ({ actionId: r.actionId, at: r.createdAt.toISOString(), input: (r.action as unknown as Action).input, result: r.result }));
      const notes = await ctx.memories.recall(agentId, { query: `${action.input.authorId} ${action.input.query ?? ''}` });
      return { kind: 'completed', result: { authorId: action.input.authorId, replies: mine, notes: notes.items, nextBeforePostId: null } };
    }
    case 'publish_reply': {
      const item = env.inbox.get(action.input.postId);
      const res = await ctx.sender.publish({
        agentId,
        actionId: pending.id,
        text: action.input.text,
        replyTo: action.input.postId,
        ...(item ? { replyAuthorId: item.authorId } : {}),
        ...(action.input.attributions ? { attributions: action.input.attributions } : {}),
      });
      return publishOutcome(res, item?.authorId);
    }
    case 'publish_post': {
      const res = await ctx.sender.publish({ agentId, actionId: pending.id, text: action.input.text, ...(action.input.attributions ? { attributions: action.input.attributions } : {}) });
      return publishOutcome(res);
    }
    case 'resolve_mention': {
      const res = await ctx.sender.resolve({ agentId, postId: action.input.postId, outcome: action.input.outcome, reason: action.input.reason, ...(action.input.reviewAt ? { reviewAt: action.input.reviewAt } : {}) });
      env.inbox.delete(action.input.postId);
      return { kind: 'completed', result: { postId: action.input.postId, outcome: action.input.outcome, ...res } };
    }
    case 'remember': {
      const rec = await ctx.memories.remember(agentId, { text: action.input.text, ...(action.input.sources ? { sources: action.input.sources } : {}), ...(action.input.tags ? { tags: action.input.tags } : {}) });
      return { kind: 'completed', result: { id: rec.id, createdAt: rec.createdAt } };
    }
    case 'recall': {
      const res = await ctx.memories.recall(agentId, action.input);
      return { kind: 'completed', result: res };
    }
    case 'finish': {
      const cp = checkpoint(action.input as unknown as Record<string, unknown>, ctx.now());
      return { kind: 'completed', result: { checkpointed: true, nextAt: cp.nextAt } };
    }
    case 'read_url': {
      const res = await readUrl(action.input.url, { fetch: ctx.fetch });
      return { kind: 'completed', result: res };
    }
    case 'search_web': {
      if (!ctx.config.SEARCH_API_URL || !ctx.config.SEARCH_API_KEY) return failed('search_unavailable');
      const res = await searchWeb(action.input.query, { url: ctx.config.SEARCH_API_URL, key: ctx.config.SEARCH_API_KEY }, ctx.fetch);
      return { kind: 'completed', result: res };
    }
    case 'read_market': {
      const token = action.input.tokenAddress ?? agent.token;
      const snapshot = await ctx.indexer.market(token);
      if (!snapshot) return failed('market_unavailable');
      return { kind: 'completed', result: { token, snapshot, observedAt: new Date(ctx.now()).toISOString(), untrusted: true } };
    }
    case 'read_chain':
      return readChain(ctx, action.input);
    case 'treasury_read': {
      const [onchain, indexed, open, recent] = await Promise.all([readTreasuryOnChain(ctx, agent), ctx.indexer.treasury(agent.kernel), openOps(ctx, agentId), recentOps(ctx, agentId, 10)]);
      return {
        kind: 'completed',
        result: {
          ...onchain,
          indexed,
          pending: open.map(opView),
          recent: recent.map(opView),
          policy: {
            allowedOperations: ['swap (WETH -> USDC via Universal Router)', `transfer (USDC -> inference payTo ${ctx.config.INFERENCE_PAYTO_ADDRESS}, at most ${formatUnits(BigInt(ctx.config.SESSION_USDC_TRANSFER_CAP), 6)} USDC per op)`],
            automatic: `LP fees are claimed automatically above $${ctx.config.CLAIM_THRESHOLD_USD}; WETH is swapped to keep >= ${ctx.config.FUEL_TARGET_USDC} USDC of fuel.`,
            note: 'Only a confirmed transaction hash from treasury_execute proves execution.',
          },
        },
      };
    }
    case 'treasury_prepare':
      return treasuryPrepare(ctx, agent, action.input);
    case 'treasury_execute': {
      const res = await executeOp(ctx, agent, action.input.preparedId, action.input.expectedHash as Hex);
      if (res.status === 'confirmed') return { kind: 'completed', result: { opId: res.opId, txHash: res.txHash, userOpHash: res.userOpHash }, receipt: { txHash: res.txHash, userOpHash: res.userOpHash, opId: res.opId } };
      if (res.status === 'unknown') return { kind: 'unknown', error: `treasury_outcome_unknown:${res.opId}:${res.userOpHash}` };
      return failed(`treasury_failed: ${res.error}`);
    }
    case 'generate_image':
      return failed('images_unavailable');
    default: {
      const never: never = action;
      return failed(`unsupported_tool:${(never as { tool: string }).tool}`);
    }
  }
}

function publishOutcome(res: { status: string; providerPostId?: string | null; receipt: { error?: string | null; status: string } }, replyAuthorId?: string): ActionOutcome {
  if (res.status === 'sent') {
    const postId = res.providerPostId ?? undefined;
    return { kind: 'completed', result: { postId, ...(replyAuthorId ? { replyAuthorId } : {}) }, receipt: { ...(postId ? { postId } : {}) } };
  }
  if (res.status === 'rejected') return failed(`sender_rejected:${res.receipt.error ?? 'rejected'}`);
  // held or pending: maybe published; never resend. The runtime holds until the receipt settles.
  return { kind: 'unknown', error: `sender_${res.status}` };
}

async function readChain(ctx: SupervisorContext, input: Action & { tool: 'read_chain' } extends { input: infer I } ? I : never): Promise<ActionOutcome> {
  const { publicClient } = ctx.chain;
  switch (input.method) {
    case 'balance': {
      if (!input.address) return failed('address_required');
      const [eth, usdc, weth] = await Promise.all([
        publicClient.getBalance({ address: input.address as Address }),
        publicClient.readContract({ address: ctx.chain.addresses.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [input.address as Address] }),
        publicClient.readContract({ address: ctx.chain.addresses.weth, abi: erc20Abi, functionName: 'balanceOf', args: [input.address as Address] }),
      ]);
      return { kind: 'completed', result: { address: input.address, eth: formatUnits(eth, 18), usdc: formatUnits(usdc, 6), weth: formatUnits(weth, 18) } };
    }
    case 'contract_call': {
      if (!input.address || !input.signature) return failed('address_and_signature_required');
      const item = parseAbiItem(input.signature.startsWith('function ') ? input.signature : `function ${input.signature}`);
      if (item.type !== 'function' || (item.stateMutability !== 'view' && item.stateMutability !== 'pure')) return failed('read_only_calls_only');
      const args = (input.args ?? []).map((a, i) => coerceArg(a, item.inputs[i]?.type ?? 'string'));
      const value = await publicClient.readContract({ address: input.address as Address, abi: [item], functionName: item.name, args: args as never });
      return { kind: 'completed', result: { address: input.address, signature: input.signature, value: jsonSafe(value) } };
    }
    case 'transaction': {
      if (!input.txHash) return failed('txHash_required');
      const [tx, receipt] = await Promise.all([publicClient.getTransaction({ hash: input.txHash as Hex }).catch(() => null), publicClient.getTransactionReceipt({ hash: input.txHash as Hex }).catch(() => null)]);
      if (!tx) return failed('transaction_not_found');
      return { kind: 'completed', result: jsonSafe({ hash: tx.hash, from: tx.from, to: tx.to, value: tx.value, blockNumber: tx.blockNumber, status: receipt?.status ?? 'pending', gasUsed: receipt?.gasUsed, logs: receipt?.logs.length }) };
    }
    case 'block': {
      const block = await publicClient.getBlock(input.blockNumber !== undefined ? { blockNumber: BigInt(input.blockNumber) } : {});
      return { kind: 'completed', result: jsonSafe({ number: block.number, hash: block.hash, timestamp: block.timestamp, transactions: block.transactions.length, baseFeePerGas: block.baseFeePerGas }) };
    }
  }
}

function coerceArg(value: string | number | boolean, type: string): unknown {
  if (/^u?int/.test(type)) return BigInt(value as string | number);
  if (type === 'bool') return value === true || value === 'true';
  return value;
}

export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as T;
}

async function treasuryPrepare(ctx: SupervisorContext, agent: AgentRow, input: { operation: string; asset?: string; amount: string; to?: string; maxSlippageBps?: number; memo?: string }): Promise<ActionOutcome> {
  const { addresses } = ctx.chain;
  const kernel = agent.kernel as Address;
  if (input.operation === 'swap') {
    // The treasury's ether arrives as WETH (LP fees), so 'ETH' is accepted as an alias for WETH here.
    const asset = input.asset && input.asset !== 'ETH' ? getAddress(input.asset) : addresses.weth;
    if (asset !== addresses.weth) return failed('treasury_operation_not_allowed: only WETH -> USDC swaps are allowed');
    const amountIn = parseUnits(input.amount, 18);
    const snap = await readTreasuryOnChain(ctx, agent);
    if (amountIn <= 0n || amountIn > parseUnits(snap.balances.weth, 18)) return failed(`treasury_insufficient_balance: WETH balance ${snap.balances.weth}`);
    if (!snap.ethUsd) return failed('price_feed_unavailable');
    const slippage = Math.min(input.maxSlippageBps ?? ctx.config.SWAP_SLIPPAGE_BPS, 500);
    const minOut = minUsdcOut(amountIn, snap.ethUsd, slippage);
    const calls = encodeSwapCalls({ route: parseSwapRoute(ctx.config.SWAP_ROUTE), weth: addresses.weth, usdc: addresses.usdc, universalRouter: addresses.uniswap.universalRouter, kernel, amountIn, minOut, deadline: BigInt(Math.floor(ctx.now() / 1000) + 20 * 60) });
    const op = await prepareOp(ctx, agent, { kind: 'swap', calls, description: `swap ${input.amount} WETH -> >= ${formatUnits(minOut, 6)} USDC${input.memo ? ` (${input.memo})` : ''}`, origin: 'model' });
    return { kind: 'completed', result: { preparedId: op.opId, expectedHash: op.callHash, description: op.description, simulated: true, note: 'Nothing moved. Call treasury_execute with preparedId and expectedHash to execute.' } };
  }
  if (input.operation === 'transfer') {
    const payTo = getAddress(ctx.config.INFERENCE_PAYTO_ADDRESS);
    if (!input.to || !isAddress(input.to) || getAddress(input.to) !== payTo) return failed(`treasury_operation_not_allowed: transfers may only fund the model at ${payTo}`);
    if (input.asset && input.asset !== 'ETH' && getAddress(input.asset) !== addresses.usdc) return failed('treasury_operation_not_allowed: only USDC transfers are allowed');
    if (input.asset === 'ETH') return failed('treasury_operation_not_allowed: only USDC transfers are allowed');
    const amount = parseUnits(input.amount, 6);
    if (amount <= 0n || amount > BigInt(ctx.config.SESSION_USDC_TRANSFER_CAP)) return failed(`treasury_policy_limit: at most ${formatUnits(BigInt(ctx.config.SESSION_USDC_TRANSFER_CAP), 6)} USDC per transfer`);
    const calls = [{ to: addresses.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [payTo, amount] }) }];
    const op = await prepareOp(ctx, agent, { kind: 'fund_model', calls, description: `transfer ${input.amount} USDC to the inference payTo${input.memo ? ` (${input.memo})` : ''}`, origin: 'model' });
    return { kind: 'completed', result: { preparedId: op.opId, expectedHash: op.callHash, description: op.description, simulated: true, note: 'Nothing moved. Call treasury_execute with preparedId and expectedHash to execute.' } };
  }
  return failed(`treasury_operation_not_allowed: ${input.operation} is handled by the on-chain burner, not the agent`);
}

// ---------------------------------------------------------------------------
// Reconciliation of a pending action (sent / held) without re-sending anything
// ---------------------------------------------------------------------------

export type PendingResolution = { resolved: true; outcome: Exclude<ActionOutcome, { kind: 'unknown' }>; receipt?: Record<string, unknown> } | { resolved: false; reason: string };

export async function resolvePending(ctx: SupervisorContext, agent: AgentRow, pending: PendingAction): Promise<PendingResolution> {
  const tool: ToolName = pending.action.tool;
  if (tool === 'publish_post' || tool === 'publish_reply') {
    try {
      const receipt = await ctx.sender.receipt(pending.id);
      if (receipt.status === 'sent') {
        const postId = receipt.providerPostId ?? undefined;
        return { resolved: true, outcome: { kind: 'completed', result: { postId }, ...(postId ? { receipt: { postId } } : {}) }, ...(postId ? { receipt: { postId } } : {}) };
      }
      if (receipt.status === 'rejected') return { resolved: true, outcome: { kind: 'failed', error: `sender_rejected:${receipt.error ?? 'rejected'}` } };
      return { resolved: false, reason: `sender_${receipt.status}` };
    } catch (err) {
      if (err instanceof SenderError && err.status === 404) return { resolved: true, outcome: { kind: 'failed', error: 'sender_receipt_missing' } };
      return { resolved: false, reason: errorText(err) };
    }
  }
  if (tool === 'treasury_execute') {
    const opId = (pending.action as Action & { tool: 'treasury_execute' }).input.preparedId;
    const op = await ctx.db.query.treasuryOps.findFirst({ where: and(eq(treasuryOps.opId, opId), eq(treasuryOps.agentId, agent.agentId)) });
    if (!op) return { resolved: true, outcome: { kind: 'failed', error: 'treasury_op_not_found' } };
    if (op.status === 'confirmed') {
      const receipt = { txHash: op.txHash as string, userOpHash: op.userOpHash as string, opId };
      return { resolved: true, outcome: { kind: 'completed', result: { opId, txHash: op.txHash, userOpHash: op.userOpHash }, receipt }, receipt };
    }
    if (op.status === 'failed') return { resolved: true, outcome: { kind: 'failed', error: `treasury_failed: ${op.error ?? 'failed'}` } };
    return { resolved: false, reason: `op_${op.status}` };
  }
  return { resolved: false, reason: 'not_reconcilable' };
}

export async function hasOpenOps(ctx: SupervisorContext, agentId: string): Promise<boolean> {
  const rows = await ctx.db.select({ opId: treasuryOps.opId }).from(treasuryOps).where(and(eq(treasuryOps.agentId, agentId), inArray(treasuryOps.status, ['sent', 'unknown']))).limit(1);
  return rows.length > 0;
}

export { PolicyError };
