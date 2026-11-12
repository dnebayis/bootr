import { type NextRequest } from 'next/server';
import { runRoute } from '@/lib/server/own-agent';

/**
 * POST /api/agent/run/due {} -> DueView
 * What is due now, per role (social, treasury, judge), the turn that is open, the holds in force and when to look
 * again. Reading it may read the agent's mentions on X, so it also takes one call per 20 seconds per client.
 * For a connected AI client: `Authorization: Bearer <credential>`, 120 requests a minute per client over all run
 * routes, and no `Origin` header (a web page is refused). `lib/server/own-agent.ts` holds the checks.
 */
export async function POST(req: NextRequest) {
  return runRoute(req, 'due');
}
