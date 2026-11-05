import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { postTelegramAction } from '@/lib/server/supervisor';
import { authorizeReview, fail, ok, readBody, relay } from '../../approvals/review';

/**
 * POST /api/agent/:kernel/notifications/telegram {message, signature | token, action: 'link'|'unlink'} -> {url, token}
 * `link` answers a one-time deep link to the bot, good for 15 minutes; pressing Start there binds that chat to the
 * creator's wallet, for all of its coins. `unlink` removes the chat. 503 `telegram_unavailable` without a bot.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/notifications/telegram'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown; action?: unknown }>(req);
  if (body instanceof Response) return body;
  const action = body.action;
  if (action !== 'link' && action !== 'unlink') return fail(400, 'invalid_request', 'action must be link or unlink');
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) return ok({ ...mock.telegramAction(kernel, action), token: auth.token });
  try {
    return ok({ ...(await postTelegramAction(auth.agentId, { by: auth.address, action })), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
