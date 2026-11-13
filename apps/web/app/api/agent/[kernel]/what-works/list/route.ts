import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { getWhatWorks } from '@/lib/server/what-works';
import { authorizeReview, ok, readBody, relay } from '../../approvals/review';

/**
 * POST /api/agent/:kernel/what-works/list {message, signature} | {token} -> AgentWhatWorks and {token}
 * The agent's note on what works for its coin and the versions before it, newest first, each with the measured facts
 * it was written from. Inside the console's signed session, like the review queue: the note is the agent's private
 * advice to itself and is shown to its creator only.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/what-works/list'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown }>(req);
  if (body instanceof Response) return body;
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) return ok({ ...mock.whatWorks(kernel), token: auth.token });
  try {
    return ok({ ...(await getWhatWorks(auth.agentId)), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
