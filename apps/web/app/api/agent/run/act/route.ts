import { type NextRequest } from 'next/server';
import { runRoute } from '@/lib/server/own-agent';

/**
 * POST /api/agent/run/act ActRequest -> ActResult
 * One tool call inside an open turn. A refused post, a failed read or an empty balance is an `ActResult` with
 * `status: 'failed'` and HTTP 200; an HTTP error means the call itself was not taken. The same call repeated returns
 * the same action: nothing is published or paid twice.
 * For a connected AI client: `Authorization: Bearer <credential>`, 120 requests a minute per client over all run
 * routes, and no `Origin` header (a web page is refused). `lib/server/own-agent.ts` holds the checks.
 */
export async function POST(req: NextRequest) {
  return runRoute(req, 'act');
}
