import { type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { fetchTokenCreator } from '@/lib/server/sender';
import { getAgentApprovals } from '@/lib/server/supervisor';
import { fail, ok, relay } from './review';

/**
 * GET /api/agent/:kernel/approvals -> {pending: n}
 * Public read of how many posts wait for the creator's review (the "n pending" badge). The texts themselves need
 * the creator's signature: `POST /api/agent/:kernel/approvals/list`. Unknown agents count 0.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/approvals'>) {
  const { kernel } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', 'kernel must be an address');
  if (env.useMock) return ok({ pending: mock.agentApprovals(kernel).pending });
  try {
    const token = await fetchTokenCreator(kernel);
    if (!token) return ok({ pending: 0 });
    const { pending } = await getAgentApprovals(token.agentId, 'pending');
    return ok({ pending });
  } catch (err) {
    return relay(err);
  }
}
