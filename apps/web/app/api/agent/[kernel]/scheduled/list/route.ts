import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { EMPTY_SCHEDULED, getScheduledPosts } from '@/lib/server/scheduled';
import { authorizeReview, ok, readBody, relay } from '../../approvals/review';

/**
 * POST /api/agent/:kernel/scheduled/list {message, signature} | {token} -> {items, mayQueue, token}
 * The posts the agent scheduled that have not gone out yet, with their texts and times: the creator's own view, inside
 * the console session (the same signature or token as `/approvals/list`). Nothing here is public.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/scheduled/list'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown }>(req);
  if (body instanceof Response) return body;
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  // The mock world keeps no schedule: an empty list, so the console renders its empty state.
  if (env.useMock) return ok({ ...EMPTY_SCHEDULED, token: auth.token });
  try {
    return ok({ ...(await getScheduledPosts(auth.agentId)), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
