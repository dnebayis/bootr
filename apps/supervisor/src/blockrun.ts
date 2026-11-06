/**
 * Direct mode: the agent's spender pays BlockRun (https://blockrun.ai, x402 on Base) for a thought instead of paying
 * the relay. Off by default; `relayRequest` (inference.ts) calls in here for agents the config names.
 *
 * Money rules. A key is paid on one route only.
 *  - **The relay takes over only while no signature exists.** Everything BlockRun answers before we sign (a model it
 *    does not offer, a quote above the cap, no `upto`, another recipient, an outage) sends this same key to the relay.
 *  - **Once a signature exists the key never leaves BlockRun.** Whatever comes back other than a real answer, the row
 *    stays `unknown` and only the chain closes it: the payment's nonce used means the money moved and no answer came
 *    (`direct_paid_no_response`: lost, BlockRun has no refund path and no chat replay); the signature's deadline passed
 *    with the nonce unused means nobody can ever settle it (`direct_failed_unpaid`: nothing lost). BlockRun documents
 *    that failed calls release the authorization, but we do not pay a second time on its word.
 *  - **A failure moves the agent to the relay** for BLOCKRUN_HOLD_MS, so an outage costs one held thought, not one
 *    signature per retry. The runtime's `inferenceRetryAt` backoff applies on top, as on the relay.
 *  - **The most one call can cost is `maxQuoteMicroUsdc`**, the same cap as the relay (`maxQuoteFor`), and only
 *    BLOCKRUN_PAYTO_ADDRESS can be paid. Under `upto` BlockRun settles the real cost up to that amount.
 *
 * Images stay on the relay: BlockRun's chat endpoint has no image models and its image API has another shape.
 */
import { createX402Payer, X402PaymentRefusedError, type BootrReceipt, type PayerScheme } from '@bootr/inference/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { decodeEventLog, erc20Abi, getAddress, isAddressEqual, type Address, type Hex, type LocalAccount } from 'viem';
import type { ChainContext } from './chain.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { inference } from './db/schema.js';
import type { RelayCall, RelayResult } from './inference.js';

export const DIRECT_ROUTE = 'blockrun';
/** The signature expired unused: the agent lost nothing. */
export const DIRECT_UNPAID = 'direct_failed_unpaid';
/** The nonce was used and no answer reached us: the agent paid and got nothing. */
export const DIRECT_PAID_LOST = 'direct_paid_no_response';
export const INSUFFICIENT_FLOAT = 'insufficient_float';
/** The chain enforces a signature's deadline; this covers an RPC a little behind the head. */
export const DEADLINE_GRACE_SECONDS = 30;

/** BlockRun's validity window is 300 s; a longer one would keep an unknown outcome open for no reason. */
const MAX_SIGNATURE_SECONDS = 600;
/** The unpaid request only asks for a price. */
const PROBE_TIMEOUT_MS = 15_000;
const IN_FLIGHT_MARGIN_MS = 5_000;
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const authorizationStateAbi = [{ type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ name: '', type: 'bool' }] }] as const;
const nonceBitmapAbi = [{ type: 'function', name: 'nonceBitmap', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'wordPos', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] }] as const;

export type DirectOutcome = RelayResult | { kind: 'failover'; reason: string };

export class InsufficientFloatError extends Error {}

type DirectConfig = SupervisorContext['config'];

export function directEnabled(config: Pick<DirectConfig, 'BLOCKRUN_DIRECT_MODE' | 'BLOCKRUN_DIRECT_AGENTS'>, agentId: string): boolean {
  if (config.BLOCKRUN_DIRECT_MODE === 'all') return true;
  if (config.BLOCKRUN_DIRECT_MODE !== 'agents') return false;
  return config.BLOCKRUN_DIRECT_AGENTS.split(',').map((s) => s.trim()).includes(agentId);
}

/** BlockRun's id for a relay model id; the two catalogues differ on a few vendor prefixes. An id it lacks is refused before any signature. */
export function directModel(model: string): string {
  if (model === 'google/gemini-3.1-pro-preview') return 'google/gemini-3.1-pro';
  return model.replace(/^x-ai\//, 'xai/').replace(/^z-ai\//, 'zai/').replace(/^moonshotai\//, 'moonshot/');
}

/**
 * The body BlockRun gets. `store` means nothing there. `parallel_tool_calls` is an OpenAI parameter BlockRun forwards
 * only to OpenAI-compatible upstreams and does not document, and a rejection caused by the input still settles, so it
 * goes to OpenAI models only; `parseAssistant` reads the first tool call whatever comes back.
 */
export function directBody(config: Pick<DirectConfig, 'BLOCKRUN_PROMPT_CACHE'>, request: Record<string, unknown>): Record<string, unknown> {
  const { parallel_tool_calls: parallel, tools, tool_choice: toolChoice, ...rest } = request;
  delete rest.store;
  const model = directModel(String(request.model));
  return {
    ...rest,
    model,
    // No tools (a chat with every capability off): no tool fields, for the same reason.
    ...(Array.isArray(tools) && tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
    ...(parallel !== undefined && model.startsWith('openai/') ? { parallel_tool_calls: parallel } : {}),
    ...(config.BLOCKRUN_PROMPT_CACHE && model.startsWith('anthropic/') ? { prompt_cache: true } : {}),
  };
}

/** True when this call may try BlockRun: the agent is switched on, it is no image, and no direct failure is recent. */
export async function directAllowed(ctx: SupervisorContext, agent: Pick<AgentRow, 'agentId'>, request: Record<string, unknown>): Promise<boolean> {
  if (!directEnabled(ctx.config, agent.agentId) || request.modalities !== undefined) return false;
  const since = new Date(ctx.now() - ctx.config.BLOCKRUN_HOLD_MS);
  const [recent] = await ctx.db
    .select({ key: inference.idempotencyKey })
    .from(inference)
    .where(and(eq(inference.agentId, agent.agentId), inArray(inference.status, ['unknown', 'failed']), sql`${inference.receipt}->>'route' = ${DIRECT_ROUTE}`, gte(inference.updatedAt, since)))
    .limit(1);
  return !recent;
}

/**
 * What a paid direct request needs from the world. The supervisor's context provides it, and so does the owner's live
 * check (`scripts/blockrun-live-check.ts`), so that command proves this path rather than a copy of it.
 */
export interface DirectWorld {
  chain: Pick<ChainContext, 'chainId' | 'publicClient' | 'addresses'>;
  fetch: typeof fetch;
}

export type DirectPayConfig = Pick<DirectConfig, 'BLOCKRUN_BASE_URL' | 'BLOCKRUN_PAYTO_ADDRESS' | 'BLOCKRUN_ALLOW_EXACT' | 'BLOCKRUN_PROMPT_CACHE' | 'BLOCKRUN_TIMEOUT_MS'>;

export function directUrl(config: Pick<DirectConfig, 'BLOCKRUN_BASE_URL'>): string {
  return `${config.BLOCKRUN_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * The request itself: one unpaid POST for the price, at most one signature, one paid POST. `onPayment` runs before the
 * signature leaves this process, so an error thrown there means nothing is out there. Throws what the payer throws.
 */
export function directPost(world: DirectWorld, config: DirectPayConfig, opts: { signer: LocalAccount; key: string; request: Record<string, unknown>; maxQuoteMicroUsdc: bigint; onPayment: (payload: PaymentPayload) => void | Promise<void> }): Promise<Response> {
  const schemes: PayerScheme[] = config.BLOCKRUN_ALLOW_EXACT ? ['upto', 'exact'] : ['upto'];
  const payer = createX402Payer({
    signer: opts.signer,
    maxPaymentMicroUsdc: opts.maxQuoteMicroUsdc,
    networks: [`eip155:${world.chain.chainId}` as `eip155:${string}`],
    payTo: config.BLOCKRUN_PAYTO_ADDRESS as Address,
    asset: world.chain.addresses.usdc,
    schemes,
    maxTimeoutSeconds: MAX_SIGNATURE_SECONDS,
    readContract: (args) => world.chain.publicClient.readContract(args as never),
    // Our headers stay here: BlockRun has no use for them and the timeout differs between asking and paying.
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const headers = new Headers(req.headers);
      headers.delete('Idempotency-Key');
      headers.delete('X-Max-Quote-Micro-USDC');
      return world.fetch(req.url, { method: req.method, headers, body: await req.text(), signal: AbortSignal.timeout(headers.has('PAYMENT-SIGNATURE') ? config.BLOCKRUN_TIMEOUT_MS : PROBE_TIMEOUT_MS) });
    }) as typeof fetch,
    onPayment: ({ payload }) => opts.onPayment(payload),
  });
  return payer.fetch(directUrl(config), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': opts.key, 'X-Max-Quote-Micro-USDC': opts.maxQuoteMicroUsdc.toString() },
    body: JSON.stringify(directBody(config, opts.request)),
  });
}

/** One direct attempt for a row `relayRequest` just opened. `failover` means no signature exists for this key. */
export async function directRequest(ctx: SupervisorContext, agent: AgentRow, call: RelayCall): Promise<DirectOutcome> {
  const { key } = call;
  const now = () => new Date(ctx.now());
  const spender = ctx.spenderFor(agent);
  const out: { signed: PaymentPayload | null } = { signed: null };

  let res: Response;
  try {
    res = await directPost(ctx, ctx.config, {
      signer: spender,
      key,
      request: call.request,
      maxQuoteMicroUsdc: call.maxQuoteMicroUsdc,
      onPayment: async (payload) => {
        await requireFloat(ctx, spender.address, BigInt(payload.accepted.amount));
        await ctx.db.update(inference).set({ receipt: { route: DIRECT_ROUTE, payment: payload as unknown as Record<string, unknown> }, updatedAt: now() }).where(eq(inference.idempotencyKey, key));
        out.signed = payload;
      },
    });
  } catch (err) {
    if (err instanceof InsufficientFloatError) {
      await ctx.db.update(inference).set({ status: 'failed', error: INSUFFICIENT_FLOAT, updatedAt: now() }).where(eq(inference.idempotencyKey, key));
      return { kind: 'failed', key, error: INSUFFICIENT_FLOAT };
    }
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (!out.signed) return { kind: 'failover', reason: err instanceof X402PaymentRefusedError ? `refused: ${error}` : `unreachable: ${error}` };
    return holdForChain(ctx, key, `direct_transport: ${error}`);
  }
  // Answered without asking for money: an error, or a free model standing in for the paid one. Neither is the thought.
  if (!out.signed) return { kind: 'failover', reason: `unpaid_http_${res.status}` };
  return recordDirectResponse(ctx, agent, key, res, out.signed, String(call.request.model));
}

/** Reads the spender's USDC before signing. A failed read lets the payment go: BlockRun's own check refuses it at no cost. */
export async function requireFloat(world: Pick<DirectWorld, 'chain'>, spender: Address, amount: bigint): Promise<void> {
  let balance: bigint;
  try {
    balance = await world.chain.publicClient.readContract({ address: world.chain.addresses.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [spender] });
  } catch {
    return;
  }
  if (balance < amount) throw new InsufficientFloatError(`spender holds ${balance}, the call may cost ${amount}`);
}

async function holdForChain(ctx: SupervisorContext, key: string, error: string): Promise<RelayResult> {
  await ctx.db.update(inference).set({ status: 'unknown', error, updatedAt: new Date(ctx.now()) }).where(eq(inference.idempotencyKey, key));
  return { kind: 'unknown', key, error };
}

function codeOf(body: unknown): string | null {
  const b = body as { code?: unknown; error?: { code?: unknown } | unknown } | null;
  if (typeof b?.code === 'string') return b.code;
  const inner = (b?.error as { code?: unknown } | undefined)?.code;
  return typeof inner === 'string' ? inner : null;
}

/** A tool-call turn comes back with `content: ""` where OpenRouter sends null; the agent must see the same message on both routes. */
function normalized(body: Record<string, unknown>): Record<string, unknown> {
  const choices = (body.choices as { message?: Record<string, unknown> }[]).map((choice) => {
    const m = choice.message;
    return m && m.content === '' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 ? { ...choice, message: { ...m, content: null } } : choice;
  });
  return { ...body, choices };
}

/** A paid response read: either a real answer (`answer`, normalised) or the reason it is not one. */
export interface DirectResponse {
  status: number;
  /** The normalised body when this is the answer that was paid for; null otherwise. */
  answer: Record<string, unknown> | null;
  /** Why it is no answer, in the form `sv_inference.error` keeps it. */
  error: string | null;
  fallback: boolean;
  servedModel: unknown;
  settled: boolean;
  contextTruncated: boolean;
  removedMessages: string | null;
  gatewayId: string | null;
}

export async function readDirectResponse(res: Response): Promise<DirectResponse> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const answered = res.ok && !!body && Array.isArray((body as { choices?: unknown }).choices) && (body as { choices: unknown[] }).choices.length > 0;
  // BlockRun can swap a paid model for a free one when a wallet cannot pay (changelog 2026-04-27). The agent did not ask for that model.
  const freeStandIn = res.headers.get('x-free-model') === 'true' || res.headers.get('x-health-reroute') === 'true';
  const code = codeOf(body);
  const ok = answered && !freeStandIn;
  return {
    status: res.status,
    answer: ok ? normalized(body as Record<string, unknown>) : null,
    error: ok ? null : freeStandIn ? 'direct_free_model_substituted' : `direct_http_${res.status}${code ? `_${code}` : ''}`,
    fallback: res.headers.get('x-fallback-used') === 'true',
    servedModel: res.headers.get('x-fallback-model') ?? res.headers.get('x-served-model') ?? (body as { model?: unknown } | null)?.model ?? null,
    settled: res.headers.get('x-payment-settled') !== 'false',
    contextTruncated: res.headers.get('x-context-truncated') === 'true',
    removedMessages: res.headers.get('x-messages-removed'),
    gatewayId: res.headers.get('x-blockrun-gateway-request-id'),
  };
}

async function recordDirectResponse(ctx: SupervisorContext, agent: AgentRow, key: string, res: Response, payment: PaymentPayload, requested: string): Promise<RelayResult> {
  const read = await readDirectResponse(res);
  if (!read.answer) return holdForChain(ctx, key, read.error ?? `direct_http_${res.status}`);
  const { fallback, servedModel, settled, contextTruncated } = read;
  const receipt = await directReceipt(ctx, agent, key, res, payment, read);
  if (fallback) ctx.log.warn({ key, agentId: agent.agentId, requested, servedModel }, 'BlockRun answered with a fallback model');
  if (!settled) ctx.log.warn({ key, agentId: agent.agentId, chargedMicroUsdc: receipt.chargedMicroUsdc }, 'BlockRun served the call and has not settled it; the signed amount stays counted');
  if (contextTruncated) ctx.log.warn({ key, agentId: agent.agentId, removed: read.removedMessages }, 'BlockRun trimmed the prompt to fit');
  const merged = {
    route: DIRECT_ROUTE,
    payment: payment as unknown as Record<string, unknown>,
    relay: receipt as unknown as Record<string, unknown>,
    direct: { scheme: payment.accepted.scheme, servedModel, fallback, settled, contextTruncated },
  };
  await ctx.db.update(inference).set({ status: 'succeeded', response: read.answer, receipt: merged, error: null, updatedAt: new Date(ctx.now()) }).where(eq(inference.idempotencyKey, key));
  return { kind: 'ok', key, body: read.answer, receipt, replayed: false };
}

/** What a paid response says about its settlement: the transaction and BlockRun's own claim of the amount, either possibly absent. */
export function settlementClaim(res: Response): { tx: Hex | null; claimed: bigint | null } {
  let settle: { transaction?: string; amount?: string } | null = null;
  const header = res.headers.get('payment-response');
  if (header) {
    try {
      settle = decodePaymentResponseHeader(header);
    } catch {
      settle = null;
    }
  }
  return { tx: ((settle?.transaction || res.headers.get('x-payment-receipt')) as Hex | undefined) ?? null, claimed: /^\d+$/.test(settle?.amount ?? '') ? BigInt(settle!.amount!) : null };
}

/** The relay's receipt shape, so `/fuel`, the average thought cost and the chat charges read a direct call like any other. */
async function directReceipt(ctx: SupervisorContext, agent: AgentRow, key: string, res: Response, payment: PaymentPayload, read: DirectResponse): Promise<BootrReceipt> {
  const { tx, claimed } = settlementClaim(res);
  const signed = BigInt(payment.accepted.amount);
  let charged = signed;
  // `exact` settles the signed amount. `upto` settles less: the chain says how much, then BlockRun's header; failing both, the signed amount stays counted.
  if (payment.accepted.scheme !== 'exact') {
    const onChain = tx ? await settledOnChain(ctx, tx, ctx.spenderFor(agent).address, payment.accepted.payTo as Address) : null;
    const known = onChain ?? claimed;
    if (known !== null && known <= signed) charged = known;
    if (known !== null && known > signed) ctx.log.error({ key, agentId: agent.agentId, known: known.toString(), signed: signed.toString() }, 'BlockRun settled above the signed amount');
  }
  return {
    requestId: read.gatewayId ?? String(read.answer?.id ?? key),
    quoteMicroUsdc: signed.toString(),
    chargedMicroUsdc: charged.toString(),
    paymentTxOrId: tx,
    network: payment.accepted.network,
    usage: (read.answer?.usage as Record<string, unknown> | undefined) ?? null,
  };
}

/** USDC moved from the spender to BlockRun in this transaction, or null when it cannot be read yet. */
export async function settledOnChain(world: Pick<DirectWorld, 'chain'>, tx: Hex, from: Address, to: Address): Promise<bigint | null> {
  try {
    const { logs } = await world.chain.publicClient.getTransactionReceipt({ hash: tx });
    let total: bigint | null = null;
    for (const log of logs) {
      if (!isAddressEqual(log.address, world.chain.addresses.usdc)) continue;
      try {
        const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics });
        if (isAddressEqual(event.args.from, from) && isAddressEqual(event.args.to, to)) total = (total ?? 0n) + event.args.value;
      } catch {
        /* another event of the token */
      }
    }
    return total;
  } catch {
    return null;
  }
}

/** What a stored payment lets the chain decide: who signed, which nonce, and until when it can be settled. */
export function paymentAuthorization(payment: PaymentPayload): { scheme: 'exact' | 'upto'; from: Address; nonce: Hex | bigint; deadline: number } | null {
  const payload = payment.payload as { authorization?: { from?: string; nonce?: string; validBefore?: string }; permit2Authorization?: { from?: string; nonce?: string; deadline?: string } };
  if (payment.accepted.scheme === 'exact' && payload.authorization?.from && payload.authorization.nonce && payload.authorization.validBefore) {
    return { scheme: 'exact', from: getAddress(payload.authorization.from), nonce: payload.authorization.nonce as Hex, deadline: Number(payload.authorization.validBefore) };
  }
  if (payment.accepted.scheme === 'upto' && payload.permit2Authorization?.from && payload.permit2Authorization.nonce && payload.permit2Authorization.deadline) {
    return { scheme: 'upto', from: getAddress(payload.permit2Authorization.from), nonce: BigInt(payload.permit2Authorization.nonce), deadline: Number(payload.permit2Authorization.deadline) };
  }
  return null;
}

/** Whether the payment's nonce has been spent on chain: USDC's EIP-3009 state for `exact`, Permit2's nonce bitmap for `upto`. */
export async function paymentSettled(ctx: Pick<DirectWorld, 'chain'>, auth: NonNullable<ReturnType<typeof paymentAuthorization>>): Promise<boolean> {
  if (auth.scheme === 'exact') {
    return ctx.chain.publicClient.readContract({ address: ctx.chain.addresses.usdc, abi: authorizationStateAbi, functionName: 'authorizationState', args: [auth.from, auth.nonce as Hex] });
  }
  const nonce = auth.nonce as bigint;
  const word = await ctx.chain.publicClient.readContract({ address: PERMIT2, abi: nonceBitmapAbi, functionName: 'nonceBitmap', args: [auth.from, nonce >> 8n] });
  return ((word >> (nonce & 0xffn)) & 1n) === 1n;
}

/**
 * Closes an open direct row from the chain alone (see the file header). A row stays `unknown` until the signature has
 * expired or its nonce is spent; there is nothing to replay at BlockRun.
 */
export async function reconcileDirect(ctx: SupervisorContext, row: typeof inference.$inferSelect): Promise<RelayResult> {
  const key = row.idempotencyKey;
  // A `pending` row this young may still be in flight in another process (a lease can lapse during a slow call).
  if (row.status === 'pending' && ctx.now() - row.updatedAt.getTime() < ctx.config.BLOCKRUN_TIMEOUT_MS + IN_FLIGHT_MARGIN_MS) return { kind: 'unknown', key, error: 'direct_in_flight' };
  const payment = (row.receipt as { payment?: PaymentPayload } | null)?.payment;
  const auth = payment ? paymentAuthorization(payment) : null;
  if (!payment || !auth) {
    ctx.log.error({ key, agentId: row.agentId }, 'direct payment on this row cannot be read; it stays open for an operator');
    return { kind: 'unknown', key, error: row.error ?? 'direct_unreadable_payment' };
  }
  let used: boolean;
  try {
    used = await paymentSettled(ctx, auth);
  } catch (err) {
    ctx.log.warn({ key, err }, 'direct reconcile: the chain read failed');
    return { kind: 'unknown', key, error: row.error ?? 'direct_chain_unreadable' };
  }
  const updatedAt = new Date(ctx.now());
  if (used) {
    ctx.log.error({ key, agentId: row.agentId, atMostMicroUsdc: payment.accepted.amount, scheme: auth.scheme, cause: row.error }, 'direct payment settled and no answer arrived: the agent lost this thought; BlockRun has no refund path');
    await ctx.db.update(inference).set({ status: 'failed', error: DIRECT_PAID_LOST, updatedAt }).where(eq(inference.idempotencyKey, key));
    return { kind: 'failed', key, error: DIRECT_PAID_LOST };
  }
  if (ctx.now() / 1000 > auth.deadline + DEADLINE_GRACE_SECONDS) {
    ctx.log.warn({ key, agentId: row.agentId, cause: row.error }, 'direct payment expired unused: nothing was charged');
    await ctx.db.update(inference).set({ status: 'failed', error: DIRECT_UNPAID, updatedAt }).where(eq(inference.idempotencyKey, key));
    return { kind: 'failed', key, error: DIRECT_UNPAID };
  }
  return { kind: 'unknown', key, error: row.error ?? 'direct_pending' };
}
