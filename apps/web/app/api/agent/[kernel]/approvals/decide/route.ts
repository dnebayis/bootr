import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { decideAgentApproval, txHashOf } from '@/lib/server/supervisor';
import { authorizeReview, fail, ok, readBody, relay } from '../review';

const NOTE_MAX = 500;

/**
 * POST /api/agent/:kernel/approvals/decide {message, signature | token, approvalId, decision, note?, txHash?} -> AgentApproval
 * Approve sends the post through the agent's X account now (same path as a direct post, image included); reject
 * marks it and the note reaches the agent on its next turn. A bounty payment is approved with `txHash`, the creator's
 * own transaction that paid the winner (the page never sends that transaction; it only takes the hash). Same
 * signature rules as `/approvals/list`.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/approvals/decide'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown; approvalId?: unknown; decision?: unknown; note?: unknown; txHash?: unknown }>(req);
  if (body instanceof Response) return body;
  const approvalId = typeof body.approvalId === 'string' && /^[\w:-]{1,120}$/.test(body.approvalId) ? body.approvalId : null;
  if (!approvalId) return fail(400, 'invalid_request', 'approvalId is required');
  if (body.decision !== 'approve' && body.decision !== 'reject') return fail(400, 'invalid_request', 'decision must be approve or reject');
  let note: string | undefined;
  if (body.note !== undefined && body.note !== null && body.note !== '') {
    if (typeof body.note !== 'string' || body.note.length > NOTE_MAX) return fail(400, 'invalid_request', `note must be text of at most ${NOTE_MAX} characters`);
    note = body.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() || undefined;
  }
  let txHash: `0x${string}` | undefined;
  if (body.txHash !== undefined && body.txHash !== null && body.txHash !== '') {
    const h = txHashOf(body.txHash);
    if (!h) return fail(400, 'invalid_request', 'txHash must be a transaction hash: 0x followed by 64 hex characters.');
    txHash = h;
  }
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) {
    const r = mock.decideApproval(kernel, approvalId, body.decision, auth.address, note ?? null, txHash ?? null);
    if (!r.ok) return fail(r.status, r.error, r.message);
    return ok(r.approval);
  }
  try {
    return ok(await decideAgentApproval(auth.agentId, approvalId, { decision: body.decision, by: auth.address, ...(note ? { note } : {}), ...(txHash ? { txHash } : {}) }));
  } catch (err) {
    return relay(err);
  }
}
