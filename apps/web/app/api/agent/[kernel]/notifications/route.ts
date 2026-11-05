import { type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { fetchTokenCreator } from '@/lib/server/sender';
import { getAgentNotificationCount } from '@/lib/server/supervisor';
import { fail, ok, relay } from '../approvals/review';

/**
 * GET /api/agent/:kernel/notifications -> {active: n}
 * How many notifications are open for this agent (the console's badge). The items themselves need the creator's
 * signature: `POST /api/agent/:kernel/notifications/list`. Unknown agents count 0.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/notifications'>) {
  const { kernel } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', 'kernel must be an address');
  if (env.useMock) return ok({ active: mock.agentNotifications(kernel).active });
  try {
    const token = await fetchTokenCreator(kernel);
    if (!token) return ok({ active: 0 });
    return ok({ active: await getAgentNotificationCount(token.agentId) });
  } catch (err) {
    return relay(err);
  }
}
