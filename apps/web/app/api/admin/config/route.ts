import { NextResponse, type NextRequest } from 'next/server';
import { readConfig, validateConfig, writeConfig } from '@/lib/server/admin-config';
import { adminConfigReadKey, isAllowedOrigin } from '@/lib/server/env';
import { verifyAdminSession } from '@/lib/server/session';
import { ADMIN_COOKIE, hmacHex, safeEqual } from '@/lib/server/session-core';

/**
 * Platform config.
 *   GET  — admin session cookie, OR service HMAC from the indexer:
 *          x-bootr-timestamp: unix seconds (±300 s)
 *          x-bootr-signature: hex HMAC-SHA256(INDEXER_SERVICE_KEY, `${timestamp}.GET./api/admin/config`)
 *          (SENDER_SERVICE_KEY is accepted only while INDEXER_SERVICE_KEY is unset; see lib/server/env.ts)
 *   POST — admin session cookie + an Origin equal to the configured site origin.
 */
const PATH = '/api/admin/config';

async function serviceAuthorized(req: NextRequest): Promise<boolean> {
  const read = adminConfigReadKey();
  const ts = req.headers.get('x-bootr-timestamp') ?? '';
  const sig = (req.headers.get('x-bootr-signature') ?? '').toLowerCase();
  if (!read || !/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  return safeEqual(await hmacHex(read.key, `${ts}.GET.${PATH}`), sig);
}

/** CSRF: the Origin must be the canonical site origin (never derived from Host / X-Forwarded-Host). */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  return !!origin && isAllowedOrigin(origin);
}

export async function GET(req: NextRequest) {
  const admin = await verifyAdminSession(req.cookies.get(ADMIN_COOKIE)?.value);
  if (!admin && !(await serviceAuthorized(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await readConfig(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const admin = await verifyAdminSession(req.cookies.get(ADMIN_COOKIE)?.value);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > 64 * 1024) return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  try {
    const saved = await writeConfig(validateConfig(input), admin.a);
    return NextResponse.json(saved, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
