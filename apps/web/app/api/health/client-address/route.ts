import { NextResponse, type NextRequest } from 'next/server';
import { clientIpSource } from '@/lib/server/ipfs';

/**
 * GET /api/health/client-address -> {trustedProxy, cloudflare, realIp, forwardedFor, countedBy}
 * Says which of the headers that can name a visitor reached this server, and which one the per-address limits count
 * by. It never returns an address. It exists so the owner can see from outside that Cloudflare's `CF-Connecting-IP`
 * arrives before setting `TRUSTED_PROXY=cloudflare` (docs/deploy/coolify.md, "Cloudflare in front"): on 2026-11-13 the
 * variable was set while the header did not arrive, and every visitor shared one limit until it was taken back.
 */
export function GET(req: NextRequest) {
  return NextResponse.json(clientIpSource(req.headers), { headers: { 'Cache-Control': 'no-store' } });
}
