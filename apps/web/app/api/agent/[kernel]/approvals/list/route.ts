import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { getAgentApprovals } from '@/lib/server/supervisor';
import { authorizeReview, ok, readBody, relay } from '../review';

/**
 * POST /api/agent/:kernel/approvals/list {message, signature} | {token} -> {items, pending, token}
 * The creator's review queue (texts, image previews, decided items): a SIWE message whose statement is
 * `Open the console of Bootr coin $SYMBOL (#agentId, kernel).` (nonce from `POST /api/agent/nonce`), or the
 * review token an earlier call returned. `status=all` in the query lists decided items too.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/approvals/list'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown }>(req);
  if (body instanceof Response) return body;
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  const status = req.nextUrl.searchParams.get('status') === 'all' ? 'all' : 'pending';
  if (env.useMock) return ok({ ...mock.agentApprovals(kernel, status), token: auth.token });
  try {
    const list = await getAgentApprovals(auth.agentId, status);
    return ok({ ...list, token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
