/**
 * Paid inference through apps/inference (x402). One idempotency key per (agent, cycle); the relay
 * replays stored results for a known key without charging again. The agent's spender EOA pays with a
 * plain EIP-712 EIP-3009 authorization (spender.ts); the kernel only funds the spender and signs nothing.
 * "Never buy a replacement": a request whose outcome is unknown is reconciled by key, never re-paid.
 * With direct mode on (blockrun.ts) the same key pays BlockRun instead, under the same rule.
 */
import {
  buildInferenceRequest,
  contextFits,
  digest,
  inferenceIdempotencyKey,
  maxQuoteFor,
  PolicyError,
  type AgentConfig,
  type ChatMessage,
  type InferenceRequest,
  type ModelTool,
} from '@bootr/agent-core';
import { createX402Payer, paymentProofHeaders, readReceipt, X402PaymentRefusedError, type BootrReceipt } from '@bootr/inference/client';
import type { PaymentPayload } from '@x402/core/types';
import type { Address } from 'viem';
import { and, desc, eq, gte, notLike, or, sql } from 'drizzle-orm';
import type { AgentRow, SupervisorContext } from './context.js';
import { DIRECT_PAID_LOST, DIRECT_ROUTE, directAllowed, directRequest, reconcileDirect } from './blockrun.js';
import { inference } from './db/schema.js';

export interface ModelToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments (or the raw string when unparsable). */
  input: unknown;
  raw: string;
}

export type InferenceResult =
  | { kind: 'ok'; key: string; message: ChatMessage; toolCall: ModelToolCall | null; receipt: BootrReceipt | null; replayed: boolean }
  | { kind: 'unknown'; key: string; error: string }
  /** The relay holds the payment for this key (`status: 'credit'`): retry this key, a new one would pay again. */
  | { kind: 'credit'; key: string; error: string }
  | { kind: 'failed'; key: string; error: string };

/** One paid relay call (a thought or an image), before the response body is interpreted. */
export type RelayResult =
  | { kind: 'ok'; key: string; body: Record<string, unknown>; receipt: BootrReceipt | null; replayed: boolean }
  | { kind: 'unknown'; key: string; error: string }
  | { kind: 'credit'; key: string; error: string }
  | { kind: 'failed'; key: string; error: string };

export interface RelayCall {
  /** Idempotency key at the relay and primary key of `sv_inference`; the same key is never paid for twice. */
  key: string;
  /** Runtime cycle the call belongs to (bookkeeping only). */
  cycle: number;
  request: Record<string, unknown>;
  /** The most this call may cost (`X-Max-Quote-Micro-USDC` and the payer's hard cap). */
  maxQuoteMicroUsdc: bigint;
}

function withAssistant(res: RelayResult): InferenceResult {
  return res.kind === 'ok' ? { kind: 'ok', key: res.key, ...parseAssistant(res.body), receipt: res.receipt, replayed: res.replayed } : res;
}

type RelayError = { error?: { code?: string; message?: string } | string; code?: string };

function errorCode(status: number, body: unknown): string {
  const b = body as RelayError | null;
  if (b && typeof b.error === 'object' && b.error?.code) return b.error.code;
  if (b && typeof b.error === 'string') return b.error;
  if (b && typeof b.code === 'string') return b.code;
  return `http_${status}`;
}

export function parseAssistant(body: Record<string, unknown>): { message: ChatMessage; toolCall: ModelToolCall | null } {
  const choice = (body.choices as { message?: Record<string, unknown> }[] | undefined)?.[0];
  const msg = choice?.message ?? {};
  const toolCalls = (msg.tool_calls as { id: string; type: 'function'; function: { name: string; arguments: string } }[] | undefined) ?? [];
  const first = toolCalls[0];
  const message: ChatMessage = {
    role: 'assistant',
    content: typeof msg.content === 'string' ? msg.content : null,
    ...(first ? { tool_calls: [first] } : {}),
  };
  if (!first) return { message, toolCall: null };
  let input: unknown = first.function.arguments;
  try {
    input = JSON.parse(first.function.arguments || '{}');
  } catch {
    /* keep raw string; parseAction will reject it */
  }
  return { message, toolCall: { id: first.id, name: first.function.name, input, raw: first.function.arguments } };
}

/** One request on `model` (the agent's own model unless economy mode routes the step to its decide model; routing.ts). */
export function buildRequest(config: AgentConfig, messages: readonly ChatMessage[], tools: readonly ModelTool[], maxOutputTokens: number, model: string = config.model): InferenceRequest {
  const request = buildInferenceRequest(messages, tools, { model, maxOutputTokens });
  if (!contextFits(request)) throw new PolicyError('context_too_large');
  return request;
}

/** The quote cap follows the model the request names, so a cheap decide step is capped like a cheap model. */
export async function runInference(ctx: SupervisorContext, agent: AgentRow, _config: AgentConfig, cycle: number, request: InferenceRequest): Promise<InferenceResult> {
  const key = inferenceIdempotencyKey(agent.agentId, cycle);
  return withAssistant(await relayRequest(ctx, agent, { key, cycle, request: request as unknown as Record<string, unknown>, maxQuoteMicroUsdc: BigInt(maxQuoteFor(request.model)) }));
}

export interface ThoughtTotals {
  /** Relay model id as the request named it (`request.model`); images show under their image model. */
  model: string;
  /** Relay calls the agent paid for: the ones that succeeded and the ones that failed after the money moved. */
  thoughts: number;
  /** What those calls cost in micro-USDC, as a decimal string. */
  chargedMicroUsdc: string;
  /** How many of `thoughts` were charged and returned nothing; absent when none were. */
  paidFailures?: number;
  /** How many of `thoughts` paid BlockRun directly instead of the relay; absent when none did. */
  directThoughts?: number;
  /** How many direct thoughts BlockRun answered with another model than the one asked for; absent when none. */
  fallbackModels?: number;
}

/**
 * A failed row whose payment still settled. On the settle-first `exact` scheme the relay takes the money before it
 * calls the model, so a model refusal (`upstream_rejected`) leaves the payment spent; `upto` settles after the model
 * answers, so a refusal there costs nothing. A credit the relay gave up on is spent until someone refunds it.
 */
const PAID_FAILURE = sql`(${inference.status} = 'failed' and (${inference.error} in ('credit_exhausted', 'relay_failed_refund_due', ${DIRECT_PAID_LOST}) or (${inference.error} = 'upstream_rejected' and ${inference.receipt}->'payment'->'accepted'->>'scheme' = 'exact')))`;
/** Every call that took money: filtering on `succeeded` alone hid paid failures from the metering. */
const PAID_CALL = or(eq(inference.status, 'succeeded'), PAID_FAILURE)!;
/** The receipt when there is one; a paid failure has none, so the amount it signed for (`exact` charges exactly that, for `upto` it is the most it can have cost). */
const CHARGED_MICRO_USDC = sql`coalesce(${inference.receipt}->'relay'->>'chargedMicroUsdc', case when ${PAID_FAILURE} then ${inference.receipt}->'payment'->'accepted'->>'amount' end)::numeric`;

/**
 * Metering for the creator: paid relay calls since `since`, grouped by the model each one ran on, most thoughts
 * first, and when the earliest of them happened (what a spending rate divides by; null when there were none). With
 * economy mode on this is where the split between the decide model and the writer shows.
 */
export async function fuelReport(ctx: SupervisorContext, agentId: string, since: Date): Promise<{ byModel: ThoughtTotals[]; firstAt: Date | null }> {
  const rows = await ctx.db
    .select({
      model: sql<string>`coalesce(${inference.request}->>'model', '')`,
      thoughts: sql<number>`count(*)::int`,
      charged: sql<string>`coalesce(sum(${CHARGED_MICRO_USDC}), 0)::text`,
      paidFailures: sql<number>`count(*) filter (where ${inference.status} <> 'succeeded')::int`,
      directThoughts: sql<number>`count(*) filter (where ${inference.receipt}->>'route' = ${DIRECT_ROUTE})::int`,
      fallbackModels: sql<number>`count(*) filter (where ${inference.receipt}->'direct'->>'fallback' = 'true')::int`,
      firstAtSec: sql<number>`extract(epoch from min(${inference.createdAt}))::float8`,
    })
    .from(inference)
    .where(and(eq(inference.agentId, agentId), PAID_CALL, gte(inference.createdAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`2 desc, 1`);
  const byModel = rows.map((r) => {
    const paidFailures = Number(r.paidFailures);
    const directThoughts = Number(r.directThoughts);
    const fallbackModels = Number(r.fallbackModels);
    return { model: r.model, thoughts: Number(r.thoughts), chargedMicroUsdc: String(r.charged).replace(/\.0+$/, ''), ...(paidFailures > 0 ? { paidFailures } : {}), ...(directThoughts > 0 ? { directThoughts } : {}), ...(fallbackModels > 0 ? { fallbackModels } : {}) };
  });
  const firstSec = rows.reduce<number | null>((min, r) => (min === null || Number(r.firstAtSec) < min ? Number(r.firstAtSec) : min), null);
  return { byModel, firstAt: firstSec === null ? null : new Date(firstSec * 1000) };
}

export async function thoughtsByModel(ctx: SupervisorContext, agentId: string, since: Date): Promise<ThoughtTotals[]> {
  return (await fuelReport(ctx, agentId, since)).byModel;
}

/** The latest paid thoughts (images excluded), so the average follows the model the agent runs on now. */
export const RECENT_THOUGHTS = 40;

/** What the agent's latest paid thoughts cost: one indexed read, for the turn's `fuel` section (fuel.ts). A chat message (`chat:` key, chat.ts) is no thought: far smaller, it would flatter the estimate. */
export async function recentThoughtCost(ctx: Pick<SupervisorContext, 'db'>, agentId: string): Promise<{ thoughts: number; spentMicroUsdc: number }> {
  const rows = await ctx.db
    .select({ charged: sql<string>`${CHARGED_MICRO_USDC}::text` })
    .from(inference)
    .where(and(eq(inference.agentId, agentId), PAID_CALL, sql`${inference.request}->'modalities' is null`, sql`${CHARGED_MICRO_USDC} is not null`, notLike(inference.idempotencyKey, 'chat:%')))
    .orderBy(desc(inference.createdAt))
    .limit(RECENT_THOUGHTS);
  return { thoughts: rows.length, spentMicroUsdc: rows.reduce((sum, r) => sum + Number(r.charged), 0) };
}

/**
 * Pays the relay for one request from the agent's spender, idempotently per `call.key`: a key already paid for
 * is replayed from `sv_inference` (or reconciled at the relay when its outcome is unknown) and never paid again.
 * Thoughts (`runInference`), chat (`chat.ts`) and images (`images.ts`) share this path; direct mode only ever takes
 * a call before any signature exists, so one key is never paid on both routes.
 */
export async function relayRequest(ctx: SupervisorContext, agent: AgentRow, call: RelayCall): Promise<RelayResult> {
  const { key, request } = call;
  const requestHash = digest(request);
  const now = () => new Date(ctx.now());

  const existing = await ctx.db.query.inference.findFirst({ where: eq(inference.idempotencyKey, key) });
  if (existing) {
    if (existing.status === 'succeeded' && existing.response) {
      return { kind: 'ok', key, body: existing.response, receipt: (existing.receipt as { relay?: BootrReceipt } | null)?.relay ?? null, replayed: true };
    }
    if (existing.status === 'failed') return { kind: 'failed', key, error: existing.error ?? 'failed' };
    // pending (crashed mid-flight) or unknown: reconcile by key, never pay again.
    return reconcileRelay(ctx, key);
  }

  await ctx.db.insert(inference).values({ idempotencyKey: key, agentId: agent.agentId, cycle: call.cycle, requestHash, request, status: 'pending', createdAt: now(), updatedAt: now() });
  if (await directAllowed(ctx, agent, request)) {
    const direct = await directRequest(ctx, agent, call);
    if (direct.kind !== 'failover') return direct;
    // No signature exists for this key, so the relay can take it without any risk of a second payment.
    ctx.log.info({ key, agentId: agent.agentId, reason: direct.reason }, 'direct mode passed this thought to the relay');
  }
  const maxQuote = call.maxQuoteMicroUsdc;
  const spender = ctx.spenderFor(agent);
  let paymentSigned = false;
  const payer = createX402Payer({
    signer: spender,
    maxPaymentMicroUsdc: maxQuote,
    networks: [`eip155:${ctx.chain.chainId}` as `eip155:${string}`],
    payTo: ctx.config.INFERENCE_PAYTO_ADDRESS as Address,
    fetch: ctx.fetch,
    onPayment: async ({ payload }) => {
      paymentSigned = true;
      await ctx.db.update(inference).set({ receipt: { payment: payload as unknown as Record<string, unknown> }, updatedAt: now() }).where(eq(inference.idempotencyKey, key));
    },
  });

  let res: Response;
  try {
    res = await payer.fetch(new URL('/v1/chat/completions', ctx.config.INFERENCE_PROVIDER_URL).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key, 'X-Max-Quote-Micro-USDC': maxQuote.toString() },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(ctx.config.INFERENCE_TIMEOUT_MS),
    });
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (err instanceof X402PaymentRefusedError || !paymentSigned) {
      await ctx.db.update(inference).set({ status: 'failed', error, updatedAt: now() }).where(eq(inference.idempotencyKey, key));
      return { kind: 'failed', key, error };
    }
    await ctx.db.update(inference).set({ status: 'unknown', error, updatedAt: now() }).where(eq(inference.idempotencyKey, key));
    return { kind: 'unknown', key, error };
  }
  return recordResponse(ctx, key, res);
}

/** The one line an operator refunds from: that a refund is due, to whom and how much (the signed amount if the relay named none). */
function logRefundDue(ctx: SupervisorContext, key: string, row: { agentId: string; receipt: Record<string, unknown> | null } | undefined, charged: unknown, detail: Record<string, unknown>): void {
  const signed = (row?.receipt as { payment?: { payload?: { authorization?: { value?: unknown } } } } | null)?.payment?.payload?.authorization?.value;
  const chargedMicroUsdc = String(charged ?? signed ?? 'unknown');
  ctx.log.error({ key, agentId: row?.agentId, chargedMicroUsdc, ...detail }, `paid inference failed at the relay: refund due to the agent: ${chargedMicroUsdc} micro-USDC`);
}

async function recordResponse(ctx: SupervisorContext, key: string, res: Response): Promise<RelayResult> {
  const now = new Date(ctx.now());
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body && typeof body === 'object') {
    const receipt = readReceipt(res);
    const existing = await ctx.db.query.inference.findFirst({ where: eq(inference.idempotencyKey, key) });
    const mergedReceipt = { ...(existing?.receipt ?? {}), ...(receipt ? { relay: receipt as unknown as Record<string, unknown> } : {}) };
    await ctx.db.update(inference).set({ status: 'succeeded', response: body as Record<string, unknown>, receipt: mergedReceipt, error: null, updatedAt: now }).where(eq(inference.idempotencyKey, key));
    return { kind: 'ok', key, body: body as Record<string, unknown>, receipt, replayed: res.headers.get('x-bootr-idempotent-replay') === 'true' };
  }
  const code = errorCode(res.status, body);
  const relay = body as { status?: unknown; refundDue?: unknown; requestId?: unknown; chargedMicroUsdc?: unknown } | null;
  // Paid and kept as a credit (`upstream_rejected` or `upstream_failed_credited`): the row stays open, so only this key is retried.
  if (relay?.status === 'credit') {
    await ctx.db.update(inference).set({ status: 'unknown', error: code, updatedAt: now }).where(eq(inference.idempotencyKey, key));
    return { kind: 'credit', key, error: code };
  }
  // Paid and the attempts are spent (`credit_exhausted`): final for this key, and the operator owes the agent.
  if (relay?.refundDue === true) {
    const row = await ctx.db.query.inference.findFirst({ where: eq(inference.idempotencyKey, key) });
    logRefundDue(ctx, key, row, relay.chargedMicroUsdc, { code, requestId: relay.requestId });
    await ctx.db.update(inference).set({ status: 'failed', error: code, updatedAt: now }).where(eq(inference.idempotencyKey, key));
    return { kind: 'failed', key, error: code };
  }
  const unknown = /unknown|in_progress/.test(code) || res.status >= 500 && !/facilitator_unavailable|upstream_rejected/.test(code);
  if (unknown) {
    await ctx.db.update(inference).set({ status: 'unknown', error: code, updatedAt: now }).where(eq(inference.idempotencyKey, key));
    return { kind: 'unknown', key, error: code };
  }
  await ctx.db.update(inference).set({ status: 'failed', error: code, updatedAt: now }).where(eq(inference.idempotencyKey, key));
  return { kind: 'failed', key, error: code };
}

/** The x402 payment persisted by `onPayment` (`receipt.payment`), or null when nothing was ever signed. */
export function storedPayment(row: { receipt: Record<string, unknown> | null }): PaymentPayload | null {
  const payment = (row.receipt as { payment?: unknown } | null)?.payment;
  return payment && typeof payment === 'object' ? (payment as PaymentPayload) : null;
}

/**
 * Reconciles a `pending` / `unknown` inference by its key. The relay scopes keys per payer and only reveals or
 * replays a request to whoever presents the payment that opened it, so every call carries the persisted payload
 * as `PAYMENT-SIGNATURE` (`paymentProofHeaders`). `succeeded` and `credit` (payment collected, completion still
 * owed) both replay the POST with the same key, body and proof: the relay serves them without a new payment.
 * `failed` with `refundDue` means the operator owes the agent a refund and is logged at error level. A row
 * without a stored payment was never paid for and is simply failed. The stored request is what goes out, so the
 * relay's request hash always matches the key whatever the turn looks like by now.
 */
export async function reconcileInference(ctx: SupervisorContext, key: string): Promise<InferenceResult> {
  return withAssistant(await reconcileRelay(ctx, key));
}

/** `reconcileInference` for any relay call (thought or image); the body is returned uninterpreted. */
export async function reconcileRelay(ctx: SupervisorContext, key: string): Promise<RelayResult> {
  const row = await ctx.db.query.inference.findFirst({ where: eq(inference.idempotencyKey, key) });
  if (!row) return { kind: 'failed', key, error: 'unknown_key' };
  if (row.status === 'succeeded' && row.response) {
    return { kind: 'ok', key, body: row.response, receipt: (row.receipt as { relay?: BootrReceipt } | null)?.relay ?? null, replayed: true };
  }
  if (row.status === 'failed') return { kind: 'failed', key, error: row.error ?? 'failed' };
  const payment = storedPayment(row);
  if (!payment) {
    // nothing was signed for this key: the relay cannot hold anything of ours
    await ctx.db.update(inference).set({ status: 'failed', error: 'no_payment_signed', updatedAt: new Date(ctx.now()) }).where(eq(inference.idempotencyKey, key));
    return { kind: 'failed', key, error: 'no_payment_signed' };
  }
  if ((row.receipt as { route?: unknown } | null)?.route === DIRECT_ROUTE) return reconcileDirect(ctx, row);
  const proof = paymentProofHeaders(payment);
  let status: { status?: string; retrySafe?: boolean; refundDue?: boolean; statusReason?: string | null; chargedMicroUsdc?: string | null } | null = null;
  try {
    const res = await ctx.fetch(new URL(`/v1/requests/${encodeURIComponent(key)}`, ctx.config.INFERENCE_PROVIDER_URL).toString(), { headers: proof, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) status = { status: 'failed', retrySafe: true };
    else if (res.ok) status = (await res.json()) as typeof status;
    else ctx.log.warn({ key, status: res.status }, 'relay refused the reconcile read');
  } catch {
    status = null;
  }
  if (!status) return { kind: 'unknown', key, error: row.error ?? 'relay_unreachable' };
  if (status.status === 'succeeded' || status.status === 'credit') {
    try {
      const res = await ctx.fetch(new URL('/v1/chat/completions', ctx.config.INFERENCE_PROVIDER_URL).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': key, 'X-Max-Quote-Micro-USDC': '0', ...proof },
        body: JSON.stringify(row.request),
        signal: AbortSignal.timeout(ctx.config.INFERENCE_TIMEOUT_MS),
      });
      return recordResponse(ctx, key, res);
    } catch (err) {
      return { kind: 'unknown', key, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (status.status === 'failed' || status.retrySafe === true) {
    const error = status.refundDue ? 'relay_failed_refund_due' : `relay_${status.status ?? 'failed'}`;
    if (status.refundDue) logRefundDue(ctx, key, row, status.chargedMicroUsdc, { reason: status.statusReason ?? null });
    await ctx.db.update(inference).set({ status: 'failed', error, updatedAt: new Date(ctx.now()) }).where(eq(inference.idempotencyKey, key));
    return { kind: 'failed', key, error };
  }
  return { kind: 'unknown', key, error: `relay_${status.status ?? 'unknown'}` };
}
