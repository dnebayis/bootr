import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { CHAT_MAX_CHARS, sendAgentChat } from '@/lib/server/supervisor';
import { authorizeReview, fail, ok, readBody, relay } from '../../approvals/review';

/**
 * POST /api/agent/:kernel/chat/send {message, signature | token, text} -> {reply, pending, token}
 * One message to the agent, which answers in its own voice; paid from its fuel, nothing is published. The supervisor
 * decides whether it may spend: 409 `chat_fuel_low` and the like, 429 `chat_rate_limited`. `pending` means the answer's
 * outcome is not known yet: read it back from `/chat/list`, where it never costs a second payment.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/chat/send'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown; text?: unknown }>(req);
  if (body instanceof Response) return body;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > CHAT_MAX_CHARS) return fail(400, 'invalid_request', `A message is 1 to ${CHAT_MAX_CHARS} characters.`);
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) {
    const r = mock.sendAgentChat(kernel, text);
    if (!r.ok) return fail(r.status, r.error, r.message);
    return ok({ reply: r.reply, pending: false, token: auth.token });
  }
  try {
    return ok({ ...(await sendAgentChat(auth.agentId, { by: auth.address, text })), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
