/**
 * Paid inference through apps/inference (x402). One idempotency key per (agent, cycle); the relay
 * replays stored results for a known key without charging again. The agent's spender EOA pays with a
 * plain EIP-712 EIP-3009 authorization (spender.ts); the kernel only funds the spender and signs nothing.
 * "Never buy a replacement": a request whose outcome is unknown is reconciled by key, never re-paid.
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
  type ToolDefinition,
} from '@bootr/agent-core';
import { createX402Payer, paymentProofHeaders, readReceipt, X402PaymentRefusedError, type BootrReceipt } from '@bootr/inference/client';
import type { PaymentPayload } from '@x402/core/types';
import type { Address } from 'viem';
import { eq } from 'drizzle-orm';
import type { AgentRow, SupervisorContext } from './context.js';
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
  | { kind: 'failed'; key: string; error: string };

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

export function buildRequest(config: AgentConfig, messages: readonly ChatMessage[], tools: readonly ToolDefinition[], maxOutputTokens: number): InferenceRequest {
  const request = buildInferenceRequest(messages, tools, { model: config.model, maxOutputTokens });
  if (!contextFits(request)) throw new PolicyError('context_too_large');
  return request;
}

export async function runInference(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, cycle: number, request: InferenceRequest): Promise<InferenceResult> {
  const key = inferenceIdempotencyKey(agent.agentId, cycle);
  const requestHash = digest(request);
  const now = () => new Date(ctx.now());

  const existing = await ctx.db.query.inference.findFirst({ where: eq(inference.idempotencyKey, key) });
  if (existing) {
    if (existing.status === 'succeeded' && existing.response) {
      const parsed = parseAssistant(existing.response);
      return { kind: 'ok', key, ...parsed, receipt: (existing.receipt as BootrReceipt | null) ?? null, replayed: true };
    }
    if (existing.status === 'failed') return { kind: 'failed', key, error: existing.error ?? 'failed' };
    // pending (crashed mid-flight) or unknown: reconcile by key, never pay again.
    return reconcileInference(ctx, key);
  }

  await ctx.db.insert(inference).values({ idempotencyKey: key, agentId: agent.agentId, cycle, requestHash, request: request as unknown as Record<string, unknown>, status: 'pending', createdAt: now(), updatedAt: now() });
  const maxQuote = BigInt(maxQuoteFor(config.model));
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

async function recordResponse(ctx: SupervisorContext, key: string, res: Response): Promise<InferenceResult> {
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
    const parsed = parseAssistant(body as Record<string, unknown>);
    return { kind: 'ok', key, ...parsed, receipt, replayed: res.headers.get('x-bootr-idempotent-replay') === 'true' };
  }
  const code = errorCode(res.status, body);
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
 * without a stored payment was never paid for and is simply failed.
 */
export async function reconcileInference(ctx: SupervisorContext, key: string): Promise<InferenceResult> {
  const row = await ctx.db.query.inference.findFirst({ where: eq(inference.idempotencyKey, key) });
  if (!row) return { kind: 'failed', key, error: 'unknown_key' };
  if (row.status === 'succeeded' && row.response) {
    const parsed = parseAssistant(row.response);
    return { kind: 'ok', key, ...parsed, receipt: (row.receipt as { relay?: BootrReceipt } | null)?.relay ?? null, replayed: true };
  }
  if (row.status === 'failed') return { kind: 'failed', key, error: row.error ?? 'failed' };
  const payment = storedPayment(row);
  if (!payment) {
    // nothing was signed for this key: the relay cannot hold anything of ours
    await ctx.db.update(inference).set({ status: 'failed', error: 'no_payment_signed', updatedAt: new Date(ctx.now()) }).where(eq(inference.idempotencyKey, key));
    return { kind: 'failed', key, error: 'no_payment_signed' };
  }
  const proof = paymentProofHeaders(payment);
  let status: { status?: string; retrySafe?: boolean; refundDue?: boolean; statusReason?: string | null } | null = null;
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
    if (status.refundDue) ctx.log.error({ key, agentId: row.agentId, reason: status.statusReason ?? null }, 'paid inference failed at the relay: refund due to the agent');
    await ctx.db.update(inference).set({ status: 'failed', error, updatedAt: new Date(ctx.now()) }).where(eq(inference.idempotencyKey, key));
    return { kind: 'failed', key, error };
  }
  return { kind: 'unknown', key, error: `relay_${status.status ?? 'unknown'}` };
}
