import { NextResponse } from 'next/server';
import { readConfig } from '@/lib/server/admin-config';
import { ownAgentEnabled } from '@/lib/server/env';

/**
 * GET /api/platform -> {launchesPaused, allowedModels, ownAgent}
 * The public subset of the admin platform config that the launch form enforces (M-7). Launching is an
 * on-chain transaction from the creator's wallet, so this is a UI guard; the binding switch is the
 * launcher's on-chain `pause()`. `ownAgent` is the own-agent flag (OWN_AGENT_ENABLED): whether a creator may run a
 * coin's agent in their own AI client on this deployment. The MCP server lists its agent tools only when it reads true.
 */
export async function GET() {
  const cfg = await readConfig();
  return NextResponse.json(
    { launchesPaused: cfg.launchesPaused, allowedModels: cfg.allowedModels, ownAgent: ownAgentEnabled() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
