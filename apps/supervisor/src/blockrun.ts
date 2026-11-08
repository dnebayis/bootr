/**
 * Direct mode: the agent's spender pays BlockRun (x402 on Base) for a thought, a chat message or a picture instead of
 * paying the relay. Off by default; `relayRequest` (inference.ts) calls in here for agents the config names. Its point is
 * that no OpenRouter credit is needed: each agent pays from its own wallet.
 *
 * Money rules. A key is paid on one route only.
 *  - **No fallback unless the relay is funded (BLOCKRUN_RELAY_FALLBACK).** A relay without OpenRouter credit takes the
 *    agent's money and cannot answer: the 2026-11-04 outage. So by default a BlockRun that cannot serve a call ends it
 *    with `direct_unavailable`: nothing signed, nothing paid, the runtime's backoff decides when to try again.
 *  - **With the fallback on, the relay takes over only while no signature exists.** Everything BlockRun answers before
 *    we sign (a model it does not offer, a quote above the cap, another recipient, an outage) sends this key to the relay.
 *  - **Once a signature exists the key never leaves BlockRun.** Whatever comes back other than a real answer, the row
 *    stays `unknown` and only the chain closes it: the payment's nonce used means the money moved and no answer came
 *    (`direct_paid_no_response`: lost, BlockRun has no refund path and no chat replay); the signature's deadline passed
 *    with the nonce unused means nobody can ever settle it (`direct_failed_unpaid`: nothing lost). BlockRun documents
 *    that failed calls release the authorization, but we do not pay a second time on its word.
 *  - **A failure holds the agent** for BLOCKRUN_HOLD_MS: on the relay with the fallback on, and with it off, after money
 *    was lost, no signature at all (`direct_hold_after_paid_loss`). An unpaid failure costs nothing, so without the relay
 *    the runtime's `inferenceRetryAt` backoff alone paces the retries.
 *  - **The most one call can cost is `maxQuoteMicroUsdc`**, the same cap as the relay (`maxQuoteFor`), and only
 *    BLOCKRUN_PAYTO_ADDRESS can be paid. BlockRun documents that `upto` settles the real cost; measured on 2026-11-06 it
 *    settled the whole ceiling, which is still below the relay's charge. Non-Claude models offer `exact` only.
 *
 * Pictures stay on the relay (OpenRouter) unless BLOCKRUN_IMAGE_ROUTE says `direct`: then they use BlockRun's image API
 * (`exact`, a fixed price), translated here into the chat shape `images.ts` reads. The owner's decision of 2026-11-08:
 * thoughts and chat pay BlockRun, pictures keep paying the relay, so OpenRouter stays funded for pictures alone.
 */
import { catalogModel, retiredModelIds } from '@bootr/agent-core';
import { createX402Payer, X402PaymentRefusedError, type BootrReceipt, type PayerScheme } from '@bootr/inference/client';
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { decodeEventLog, erc20Abi, getAddress, isAddressEqual, type Address, type Hex, type LocalAccount } from 'viem';
import type { ChainContext } from './chain.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { inference } from './db/schema.js';
import type { RelayCall, RelayResult } from './inference.js';
import { assertPublicHost } from './web-reader.js';

export const DIRECT_ROUTE = 'blockrun';
/** The signature expired unused: the agent lost nothing. */
export const DIRECT_UNPAID = 'direct_failed_unpaid';
/** The nonce was used and no answer reached us: the agent paid and got nothing. */
export const DIRECT_PAID_LOST = 'direct_paid_no_response';
export const INSUFFICIENT_FLOAT = 'insufficient_float';
/** BlockRun could not serve this call and no relay is funded to take it: nothing signed, nothing paid. */
export const DIRECT_UNAVAILABLE = 'direct_unavailable';
/** Money was lost at BlockRun within the hold, and no relay is funded: no new signature until the hold ends. */
export const DIRECT_HOLD = 'direct_hold_after_paid_loss';
/** The chain enforces a signature's deadline; this covers an RPC a little behind the head. */
export const DEADLINE_GRACE_SECONDS = 30;

/** BlockRun's validity window is 300 s; a longer one would keep an unknown outcome open for no reason. */
const MAX_SIGNATURE_SECONDS = 600;
/** The unpaid request only asks for a price. */
const PROBE_TIMEOUT_MS = 15_000;
const IN_FLIGHT_MARGIN_MS = 5_000;
/** How long a call waits for a slow picture before leaving the rest to the reconcile. */
const IMAGE_INLINE_WAIT_MS = 90_000;
const IMAGE_POLL_MS = 3_000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
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

/** Whether this agent's pictures go to BlockRun's image API: direct mode on for it, and BLOCKRUN_IMAGE_ROUTE set to `direct`. */
export function directPictures(config: Pick<DirectConfig, 'BLOCKRUN_DIRECT_MODE' | 'BLOCKRUN_DIRECT_AGENTS' | 'BLOCKRUN_IMAGE_ROUTE'>, agentId: string): boolean {
  return config.BLOCKRUN_IMAGE_ROUTE === 'direct' && directEnabled(config, agentId);
}

/**
 * Retired text-model ids with the catalog model that takes their place (`@bootr/agent-core` MODEL_CATALOG: the same model
 * under BlockRun's name, or the closest model BlockRun serves). Without an entry an agent on such a model could never
 * think once the relay is gone; the migration (model-migration.ts) moves stored configs over the same table.
 */
export const DIRECT_SUBSTITUTES: Readonly<Record<string, string>> = Object.fromEntries(retiredModelIds().filter((r) => catalogModel(r.to)?.role !== 'image').map((r) => [r.from, r.to]));

/** BlockRun's id for the relay's image models, from the same catalog; a picture from any other id waits or uses the relay. */
export const DIRECT_IMAGE_MODELS: Readonly<Record<string, string>> = Object.fromEntries(retiredModelIds().filter((r) => catalogModel(r.to)?.role === 'image').map((r) => [r.from, r.to]));

/** The failover reason when BlockRun does not know the model at all: an agent's own trouble, never a fleet-wide outage. */
export const MODEL_MISSING = 'model_missing';

/**
 * BlockRun's id for any model id: a catalog model's own id (by its id or a retired one), else the id with the few vendor
 * prefixes the two catalogues spell differently renamed. An id BlockRun lacks is refused before any signature.
 */
export function directModel(model: string): string {
  const known = catalogModel(model);
  if (known) return known.id;
  return model.replace(/^x-ai\//, 'xai/').replace(/^z-ai\//, 'zai/').replace(/^moonshotai\//, 'moonshot/').replace(/^mistralai\//, 'mistral/');
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

/** Where a new call goes: BlockRun, the relay (direct mode off, a picture with pictures on the relay, or a recent failure with the fallback on), or nowhere yet. */
export type DirectRoute = { route: 'direct' } | { route: 'relay' } | { route: 'wait'; error: string };

export async function directRoute(ctx: SupervisorContext, agent: Pick<AgentRow, 'agentId'>, call: { picture?: boolean } = {}): Promise<DirectRoute> {
  // A picture with BLOCKRUN_IMAGE_ROUTE=relay never looks at BlockRun, its holds or the fallback: those are about thoughts.
  if (call.picture && ctx.config.BLOCKRUN_IMAGE_ROUTE !== 'direct') return { route: 'relay' };
  if (!directEnabled(ctx.config, agent.agentId)) return { route: 'relay' };
  const since = new Date(ctx.now() - ctx.config.BLOCKRUN_HOLD_MS);
  const recent = await ctx.db
    .select({ error: inference.error })
    .from(inference)
    .where(and(eq(inference.agentId, agent.agentId), inArray(inference.status, ['unknown', 'failed']), sql`${inference.receipt}->>'route' = ${DIRECT_ROUTE}`, gte(inference.updatedAt, since)))
    .limit(20);
  if (ctx.config.BLOCKRUN_RELAY_FALLBACK) return recent.length ? { route: 'relay' } : { route: 'direct' };
  return recent.some((r) => r.error === DIRECT_PAID_LOST) ? { route: 'wait', error: DIRECT_HOLD } : { route: 'direct' };
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

export function directImageUrl(config: Pick<DirectConfig, 'BLOCKRUN_BASE_URL'>, path: 'generations' | 'image2image'): string {
  return `${config.BLOCKRUN_BASE_URL.replace(/\/+$/, '')}/images/${path}`;
}

/**
 * The request itself: one unpaid POST for the price, at most one signature, one paid POST. `onPayment` runs before the
 * signature leaves this process, so an error thrown there means nothing is out there. Throws what the payer throws.
 */
export function directPost(world: DirectWorld, config: DirectPayConfig, opts: { signer: LocalAccount; key: string; request: Record<string, unknown>; maxQuoteMicroUsdc: bigint; onPayment: (payload: PaymentPayload) => void | Promise<void>; imagePath?: 'generations' | 'image2image' }): Promise<Response> {
  // A picture has one fixed price and BlockRun takes it with `exact` only.
  const schemes: PayerScheme[] = opts.imagePath ? ['exact'] : config.BLOCKRUN_ALLOW_EXACT ? ['upto', 'exact'] : ['upto'];
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
  return payer.fetch(opts.imagePath ? directImageUrl(config, opts.imagePath) : directUrl(config), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': opts.key, 'X-Max-Quote-Micro-USDC': opts.maxQuoteMicroUsdc.toString() },
    body: JSON.stringify(opts.imagePath ? opts.request : directBody(config, opts.request)),
  });
}

/** One direct attempt for a row `relayRequest` just opened. `failover` means no signature exists for this key. */
export async function directRequest(ctx: SupervisorContext, agent: AgentRow, call: RelayCall): Promise<DirectOutcome> {
  if (call.request.modalities !== undefined) return directImageRequest(ctx, agent, call);
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
  if (!out.signed) return { kind: 'failover', reason: await unpaidReason(res, directModel(String(call.request.model))) };
  return recordDirectResponse(ctx, agent, key, res, out.signed, String(call.request.model));
}

/**
 * Why an unpaid answer is no thought. BlockRun answers a model it does not know with a 400 and `Unknown model: <id>`
 * (fixtures/blockrun/error-unknown-model.json): that is `model_missing`, the agent's own problem, which the creator and
 * the owner must hear about (runtime.ts); anything else is the status, which may be an outage.
 */
export async function unpaidReason(res: Response, model: string): Promise<string> {
  if (res.status === 400) {
    const text = await res.clone().text().catch(() => '');
    if (/unknown model/i.test(text)) return `${MODEL_MISSING}: ${model}`;
  }
  return `unpaid_http_${res.status}`;
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
  // A slow picture: the job settles on the first poll that sees it done, so polling is what finishes it.
  const pollUrl = (row.receipt as { imageJob?: { pollUrl?: unknown } } | null)?.imageJob?.pollUrl;
  if (payment && typeof pollUrl === 'string') {
    const finished = await pollImage(ctx, row, payment, pollUrl);
    if (finished) return finished;
  }
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

// ---------------------------------------------------------------------------------------------
// Pictures: BlockRun's image API, read back in the chat shape `images.ts` parses
// ---------------------------------------------------------------------------------------------

/** The body BlockRun's image API takes, from the chat-shaped request `imageRequest` builds; null for a model it lacks. */
export function directImageBody(request: Record<string, unknown>): { body: Record<string, unknown>; reference: string | null } | null {
  const known = catalogModel(String(request.model));
  if (!known || known.role !== 'image') return null;
  const model = known.id;
  const messages = (request.messages ?? []) as { role?: string; content?: unknown }[];
  const parts: string[] = [];
  let reference: string | null = null;
  for (const m of messages) {
    if (typeof m.content === 'string') parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content as { type?: string; text?: string; image_url?: { url?: string } }[]) {
        if (part.type === 'text' && part.text) parts.push(part.text);
        if (part.type === 'image_url' && part.image_url?.url) reference = part.image_url.url;
      }
    }
  }
  return { body: { model, prompt: parts.join('\n\n'), size: '1024x1024', n: 1 }, reference };
}

/** Downloads a picture over https from a public host, as a data URI; null when it is not one or too large. */
async function pictureAsDataUri(ctx: Pick<SupervisorContext, 'fetch' | 'resolveHost'>, url: string): Promise<string | null> {
  if (url.startsWith('data:image/')) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    await assertPublicHost(parsed.hostname, ctx.resolveHost);
    const res = await ctx.fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!type.startsWith('image/')) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

/** A finished job or response as the chat shape `parseImageResponse` reads; null when the picture cannot be had. */
export async function imageAnswer(ctx: Pick<SupervisorContext, 'fetch' | 'resolveHost'>, body: { id?: unknown; data?: { url?: unknown }[]; price?: unknown }): Promise<Record<string, unknown> | null> {
  const url = body.data?.[0]?.url;
  if (typeof url !== 'string') return null;
  const dataUri = (await pictureAsDataUri(ctx, url)) ?? (await pictureAsDataUri(ctx, url));
  if (!dataUri) return null;
  return { id: body.id ?? null, price: body.price ?? null, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, images: [{ image_url: { url: dataUri } }] } }] };
}

async function recordImage(ctx: SupervisorContext, key: string, answer: Record<string, unknown>, payment: PaymentPayload, tx: string | null): Promise<RelayResult> {
  const charged = payment.accepted.amount;
  const receipt: BootrReceipt = { requestId: String(answer.id ?? key), quoteMicroUsdc: charged, chargedMicroUsdc: charged, paymentTxOrId: tx, network: payment.accepted.network, usage: null };
  const merged = { route: DIRECT_ROUTE, payment: payment as unknown as Record<string, unknown>, relay: receipt as unknown as Record<string, unknown>, direct: { scheme: payment.accepted.scheme, servedModel: null, fallback: false, settled: true, contextTruncated: false } };
  await ctx.db.update(inference).set({ status: 'succeeded', response: answer, receipt: merged, error: null, updatedAt: new Date(ctx.now()) }).where(eq(inference.idempotencyKey, key));
  return { kind: 'ok', key, body: answer, receipt, replayed: false };
}

/** A poll address BlockRun gave, only if it is on BlockRun's own origin: the poll carries the payment. */
export function pollAddress(config: Pick<DirectConfig, 'BLOCKRUN_BASE_URL'>, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const base = new URL(config.BLOCKRUN_BASE_URL);
    const url = new URL(value, base);
    return url.origin === base.origin ? url.toString() : null;
  } catch {
    return null;
  }
}

export type ImageJob = { state: 'done'; answer: Record<string, unknown>; tx: string | null } | { state: 'failed' } | { state: 'pending' };

/** One poll of a slow picture. `pending` while it runs or cannot be read: the chain and the deadline decide then. */
export async function readImageJob(world: Pick<SupervisorContext, 'fetch' | 'resolveHost'>, payment: PaymentPayload, url: string): Promise<ImageJob> {
  let res: Response;
  let body: { id?: unknown; status?: unknown; data?: { url?: unknown }[]; price?: unknown; payment?: { tx_hash?: unknown } } | null;
  try {
    res = await world.fetch(url, { headers: { 'X-Payment': encodePaymentSignatureHeader(payment) }, signal: AbortSignal.timeout(15_000) });
    body = (await res.json()) as typeof body;
  } catch {
    return { state: 'pending' };
  }
  if (body?.status === 'failed') return { state: 'failed' };
  if (res.ok && body?.status !== 'queued' && body?.status !== 'in_progress' && Array.isArray(body?.data)) {
    const answer = await imageAnswer(world, body);
    return answer ? { state: 'done', answer, tx: typeof body.payment?.tx_hash === 'string' ? body.payment.tx_hash : null } : { state: 'pending' };
  }
  return { state: 'pending' };
}

async function pollImage(ctx: SupervisorContext, row: Pick<typeof inference.$inferSelect, 'idempotencyKey' | 'agentId'>, payment: PaymentPayload, url: string): Promise<RelayResult | null> {
  const key = row.idempotencyKey;
  const job = await readImageJob(ctx, payment, url);
  if (job.state === 'done') return recordImage(ctx, key, job.answer, payment, job.tx);
  if (job.state === 'failed') {
    ctx.log.warn({ key, agentId: row.agentId }, 'BlockRun could not make the picture: nothing was charged');
    await ctx.db.update(inference).set({ status: 'failed', error: DIRECT_UNPAID, updatedAt: new Date(ctx.now()) }).where(eq(inference.idempotencyKey, key));
    return { kind: 'failed', key, error: DIRECT_UNPAID };
  }
  return null;
}

async function directImageRequest(ctx: SupervisorContext, agent: AgentRow, call: RelayCall): Promise<DirectOutcome> {
  const { key } = call;
  const now = () => new Date(ctx.now());
  const translated = directImageBody(call.request);
  if (!translated) return { kind: 'failover', reason: `${MODEL_MISSING}: ${String(call.request.model)}` };
  const { body, reference } = translated;
  // BlockRun takes the reference as a data URI. A coin picture that cannot be fetched only costs the likeness.
  const image = reference ? await pictureAsDataUri(ctx, reference) : null;
  if (reference && !image) ctx.log.warn({ key, agentId: agent.agentId }, 'could not read the reference picture; generating without it');
  const spender = ctx.spenderFor(agent);
  const out: { signed: PaymentPayload | null } = { signed: null };
  let res: Response;
  try {
    res = await directPost(ctx, ctx.config, {
      signer: spender,
      key,
      request: { ...body, ...(image ? { image } : {}) },
      maxQuoteMicroUsdc: call.maxQuoteMicroUsdc,
      imagePath: image ? 'image2image' : 'generations',
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
  if (!out.signed) return { kind: 'failover', reason: await unpaidReason(res, body.model as string) };
  const payment: PaymentPayload = out.signed;

  const parsed = (await res.json().catch(() => null)) as { id?: unknown; poll_url?: unknown; data?: { url?: unknown }[]; price?: unknown; code?: unknown; error?: unknown } | null;
  if (res.status === 202) {
    const pollUrl = pollAddress(ctx.config, parsed?.poll_url);
    if (!pollUrl) return holdForChain(ctx, key, 'direct_image_no_poll_address');
    await ctx.db.update(inference).set({ receipt: { route: DIRECT_ROUTE, payment: payment as unknown as Record<string, unknown>, imageJob: { pollUrl } }, status: 'unknown', error: 'direct_image_in_progress', updatedAt: now() }).where(eq(inference.idempotencyKey, key));
    const until = ctx.now() + IMAGE_INLINE_WAIT_MS;
    while (ctx.now() < until) {
      await new Promise((r) => setTimeout(r, ctx.config.BLOCKRUN_IMAGE_POLL_MS ?? IMAGE_POLL_MS));
      const finished = await pollImage(ctx, { idempotencyKey: key, agentId: agent.agentId }, payment, pollUrl);
      if (finished) return finished;
      if (ctx.config.BLOCKRUN_IMAGE_POLL_MS === 0) break;
    }
    return { kind: 'unknown', key, error: 'direct_image_in_progress' };
  }
  if (res.ok && parsed && Array.isArray(parsed.data)) {
    const answer = await imageAnswer(ctx, parsed);
    if (answer) return recordImage(ctx, key, answer, payment, settlementClaim(res).tx);
    return holdForChain(ctx, key, 'direct_image_unreadable');
  }
  const code = codeOf(parsed);
  return holdForChain(ctx, key, `direct_http_${res.status}${code ? `_${code}` : ''}`);
}
