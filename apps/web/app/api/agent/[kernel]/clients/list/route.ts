import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mockOwn } from '@/lib/mock-own';
import { askOwn } from '@/lib/server/own-agent';
import { authorizeReview, ok, readBody } from '../../approvals/review';

/**
 * POST /api/agent/:kernel/clients/list {message, signature} | {token} -> ClientsResponse and {token}
 * The AI clients connected to this coin's agent (label, connected, last used, expiry) and how many it may have, for
 * the creator's console. Inside the console's signed session, like the review queue. It answers with own agents
 * switched off too: a creator can always see what is connected.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/clients/list'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown }>(req);
  if (body instanceof Response) return body;
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) return ok({ ...mockOwn.clients(kernel), token: auth.token });
  const answer = await askOwn('GET', `/internal/agents/${encodeURIComponent(auth.agentId)}/clients`);
  if (!answer.ok) return answer.response;
  return ok({ ...(answer.data as object), token: auth.token });
}
