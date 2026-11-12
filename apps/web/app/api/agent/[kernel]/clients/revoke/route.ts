import { CLIENT_ID_PREFIX, USER_CODE_RE } from '@bootr/shared/own-agent';
import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mockOwn } from '@/lib/mock-own';
import { askOwn, ownError } from '@/lib/server/own-agent';
import { authorizeReview, ok, readBody } from '../../approvals/review';

const CLIENT_ID_RE = new RegExp(`^${CLIENT_ID_PREFIX}[0-9a-f]{16}$`);

/**
 * POST /api/agent/:kernel/clients/revoke {clientId} | {userCode} | {all: true}, with {message, signature} | {token} -> ClientsResponse and {token}
 * Disconnects one AI client from this coin's agent (`clientId`), cancels one approval no client has collected yet
 * (`userCode`, from the list's `waiting`), or does both for all of them (`all`): a credential is refused on its next
 * call and a turn it had open is closed, and after `all` no approval is left that a client could still collect.
 * Inside the console's signed session. Never refused because own agents are switched off: disconnecting must always work.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/clients/revoke'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown; clientId?: unknown; userCode?: unknown; all?: unknown }>(req);
  if (body instanceof Response) return body;
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  const all = body.all === true;
  const approval = !all && typeof body.userCode === 'string' && USER_CODE_RE.test(body.userCode) ? body.userCode : null;
  if (!all && body.userCode !== undefined && !approval) return ownError('invalid_request', { field: 'userCode', detail: 'userCode must be the code of an approval the list shows as waiting, like BCDF-GHJK.' });
  if (!all && !approval && (typeof body.clientId !== 'string' || !CLIENT_ID_RE.test(body.clientId))) return ownError('invalid_request', { field: 'clientId', detail: 'Send the clientId of one client, the userCode of one waiting approval, or all: true.' });
  const which = all ? { all: true as const } : approval ? { userCode: approval } : { clientId: body.clientId as string };
  if (env.useMock) {
    const left = mockOwn.revoke(kernel, which);
    return left.ok ? ok({ ...left.data, token: auth.token }) : ownError(left.error);
  }
  const answer = await askOwn('POST', `/internal/agents/${encodeURIComponent(auth.agentId)}/clients/revoke`, { by: auth.address, ...which });
  if (!answer.ok) return answer.response;
  return ok({ ...(answer.data as object), token: auth.token });
}
