import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { getAgentNotifications } from '@/lib/server/supervisor';
import { authorizeReview, ok, readBody, relay } from '../../approvals/review';

/**
 * POST /api/agent/:kernel/notifications/list {message, signature} | {token} -> {items, active, events, telegram, token}
 * The creator's inbox, per-event switches and Telegram state. Same signature rules as the review queue.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/notifications/list'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown }>(req);
  if (body instanceof Response) return body;
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) return ok({ ...mock.agentNotifications(kernel), token: auth.token });
  try {
    return ok({ ...(await getAgentNotifications(auth.agentId)), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
