import { NextResponse, type NextRequest } from 'next/server';
import { readConfig, validateConfig, writeConfig } from '@/lib/server/admin-config';
import { ADMIN_COOKIE, hmacHex, safeEqual, verifyAdminCookie } from '@/lib/server/session-core';

/**
 * Platform config.
 *   GET  — admin session cookie, OR service HMAC for the indexer/supervisor:
 *          x-bootr-timestamp: unix seconds (±300 s)
 *          x-bootr-signature: hex HMAC-SHA256(SENDER_SERVICE_KEY, `${timestamp}.GET./api/admin/config`)
 *   POST — admin session cookie + same-origin request only.
 */
const PATH = '/api/admin/config';

async function serviceAuthorized(req: NextRequest): Promise<boolean> {
  const key = process.env.SENDER_SERVICE_KEY ?? '';
  const ts = req.headers.get('x-bootr-timestamp') ?? '';
  const sig = (req.headers.get('x-bootr-signature') ?? '').toLowerCase();
  if (key.length < 16 || !/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  return safeEqual(await hmacHex(key, `${ts}.GET.${PATH}`), sig);
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const admin = await verifyAdminCookie(req.cookies.get(ADMIN_COOKIE)?.value);
  if (!admin && !(await serviceAuthorized(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await readConfig(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const admin = await verifyAdminCookie(req.cookies.get(ADMIN_COOKIE)?.value);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
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
