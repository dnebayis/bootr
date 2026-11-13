import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { cancelScheduledPost, EMPTY_SCHEDULED, SCHEDULED_ID_RE } from '@/lib/server/scheduled';
import { authorizeReview, fail, ok, readBody, relay } from '../../approvals/review';

/**
 * POST /api/agent/:kernel/scheduled/cancel {message, signature | token, id} -> {items, mayQueue, token}
 * Takes one scheduled post that has not gone out from the queue; the list after it comes back. A post that is already
 * on its way cannot be cancelled (404 `scheduled_not_found`). Same signature rules as `/scheduled/list`.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/scheduled/cancel'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown; id?: unknown }>(req);
  if (body instanceof Response) return body;
  const id = typeof body.id === 'string' && SCHEDULED_ID_RE.test(body.id) ? body.id : null;
  if (!id) return fail(400, 'invalid_request', 'id must be the id of a scheduled post');
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) return ok({ ...EMPTY_SCHEDULED, token: auth.token });
  try {
    return ok({ ...(await cancelScheduledPost(auth.agentId, id, auth.address)), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
