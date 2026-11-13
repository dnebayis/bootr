import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { clearWhatWorks } from '@/lib/server/what-works';
import { authorizeReview, ok, readBody, relay } from '../../approvals/review';

/**
 * POST /api/agent/:kernel/what-works/clear {message, signature} | {token} -> AgentWhatWorks and {token}
 * The creator clears the note in force: the agent reads none from its next turn on and writes a new one when its own
 * weekly revision is due. The versions before stay listed. Inside the console's signed session; the agent service
 * checks again that the signer created the coin.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/what-works/clear'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown }>(req);
  if (body instanceof Response) return body;
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) return ok({ ...mock.clearWhatWorks(kernel), token: auth.token });
  try {
    return ok({ ...(await clearWhatWorks(auth.agentId, auth.address)), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
