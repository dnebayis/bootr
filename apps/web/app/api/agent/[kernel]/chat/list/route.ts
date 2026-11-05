import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { getAgentChat } from '@/lib/server/supervisor';
import { authorizeReview, ok, readBody, relay } from '../../approvals/review';

/**
 * POST /api/agent/:kernel/chat/list {message, signature} | {token} -> {messages, quote, token}
 * The creator's private conversation with the agent, what a message costs and whether one may be sent now. Same
 * signature rules as the review queue.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/chat/list'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown }>(req);
  if (body instanceof Response) return body;
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) return ok({ ...mock.agentChat(kernel), token: auth.token });
  try {
    return ok({ ...(await getAgentChat(auth.agentId)), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
