import { CLIENT_ID_PREFIX } from '@bootr/shared/own-agent';
import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mockOwn } from '@/lib/mock-own';
import { askOwn, ownError } from '@/lib/server/own-agent';
import { authorizeReview, ok, readBody } from '../../approvals/review';

const CLIENT_ID_RE = new RegExp(`^${CLIENT_ID_PREFIX}[0-9a-f]{16}$`);

/**
 * POST /api/agent/:kernel/clients/revoke {clientId} | {all: true}, with {message, signature} | {token} -> ClientsResponse and {token}
 * Disconnects one AI client from this coin's agent, or all of them: the credential is refused on its next call and a
 * turn it had open is closed. Inside the console's signed session. Never refused because own agents are switched off:
 * disconnecting must always work.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/clients/revoke'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown; clientId?: unknown; all?: unknown }>(req);
  if (body instanceof Response) return body;
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  const all = body.all === true;
  if (!all && (typeof body.clientId !== 'string' || !CLIENT_ID_RE.test(body.clientId))) return ownError('invalid_request', { field: 'clientId', detail: 'Send the clientId of one client, or all: true.' });
  const which = all ? { all: true as const } : { clientId: body.clientId as string };
  if (env.useMock) {
    const left = mockOwn.revoke(kernel, which);
    return left.ok ? ok({ ...left.data, token: auth.token }) : ownError(left.error);
  }
  const answer = await askOwn('POST', `/internal/agents/${encodeURIComponent(auth.agentId)}/clients/revoke`, { by: auth.address, ...which });
  if (!answer.ok) return answer.response;
  return ok({ ...(answer.data as object), token: auth.token });
}
