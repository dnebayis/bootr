import { type NextRequest } from 'next/server';
import { runRoute } from '@/lib/server/own-agent';

/**
 * POST /api/agent/run/status {} -> AgentStatus
 * Which coin this client is connected to, who runs its agent, the powers that are on and what is left of today's
 * posts, reads, pictures and turns outside the schedule. A coin run by Bootr is answered too, with `runner: 'hosted'`.
 * For a connected AI client: `Authorization: Bearer <credential>`, 120 requests a minute per client over all run
 * routes, and no `Origin` header (a web page is refused). `lib/server/own-agent.ts` holds the checks.
 */
export async function POST(req: NextRequest) {
  return runRoute(req, 'status');
}
