import { type NextRequest } from 'next/server';
import { runRoute } from '@/lib/server/own-agent';

/**
 * POST /api/agent/run/turn TurnRequest -> TurnOpen
 * Opens a turn in one role, or returns the open one of that role: the brief, the first observation, the tools the
 * turn may call and its step budget. Refused when nothing is due (`not_due`) or another role's turn is open.
 * For a connected AI client: `Authorization: Bearer <credential>`, 120 requests a minute per client over all run
 * routes, and no `Origin` header (a web page is refused). `lib/server/own-agent.ts` holds the checks.
 */
export async function POST(req: NextRequest) {
  return runRoute(req, 'turn');
}
