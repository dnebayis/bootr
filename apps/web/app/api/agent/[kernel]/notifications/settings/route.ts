import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { putNotificationSettings } from '@/lib/server/supervisor';
import { authorizeReview, fail, ok, readBody, relay } from '../../approvals/review';

const EVENT_RE = /^[a-z_]{1,40}$/;
const MAX_EVENTS = 32;

/**
 * POST /api/agent/:kernel/notifications/settings {message, signature | token, optOut: string[]} -> the inbox
 * The events the creator turned off, all of them each time. The supervisor checks the names.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/notifications/settings'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown; optOut?: unknown }>(req);
  if (body instanceof Response) return body;
  const optOut = body.optOut;
  if (!Array.isArray(optOut) || optOut.length > MAX_EVENTS || optOut.some((e) => typeof e !== 'string' || !EVENT_RE.test(e))) return fail(400, 'invalid_request', 'optOut must be a list of event names');
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) return ok({ ...mock.setNotificationOptOut(kernel, optOut as string[]), token: auth.token });
  try {
    return ok({ ...(await putNotificationSettings(auth.agentId, { by: auth.address, optOut: optOut as string[] })), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
