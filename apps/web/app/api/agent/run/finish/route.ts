import { type NextRequest } from 'next/server';
import { runRoute } from '@/lib/server/own-agent';

/**
 * POST /api/agent/run/finish FinishRequest -> ActResult
 * Checkpoints the agent's memory, agenda and summary and ends the turn (`tool: 'finish'`, `turnEnded: true`).
 * For a connected AI client: `Authorization: Bearer <credential>`, 120 requests a minute per client over all run
 * routes, and no `Origin` header (a web page is refused). `lib/server/own-agent.ts` holds the checks.
 */
export async function POST(req: NextRequest) {
  return runRoute(req, 'finish');
}
