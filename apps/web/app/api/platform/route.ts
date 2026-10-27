import { NextResponse } from 'next/server';
import { readConfig } from '@/lib/server/admin-config';

/**
 * GET /api/platform -> {launchesPaused, allowedModels}
 * The public subset of the admin platform config that the launch form enforces (M-7). Launching is an
 * on-chain transaction from the creator's wallet, so this is a UI guard; the binding switch is the
 * launcher's on-chain `pause()`.
 */
export async function GET() {
  const cfg = await readConfig();
  return NextResponse.json(
    { launchesPaused: cfg.launchesPaused, allowedModels: cfg.allowedModels },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
