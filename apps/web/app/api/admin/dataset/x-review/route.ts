import { NextResponse, type NextRequest } from 'next/server';
import { askDatasetXReview, X_SOURCE_ID_RE } from '@/lib/server/dataset';
import { isAllowedOrigin } from '@/lib/server/env';
import { verifyAdminSession } from '@/lib/server/session';
import { ADMIN_COOKIE } from '@/lib/server/session-core';
import { SupervisorError, SupervisorUnavailable } from '@/lib/server/supervisor';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/admin/dataset/x-review `{id}`: the owner's "look again" on an X account the dataset suspended (a handle
 * that changed, followers that collapsed, a stranger under a known name). It only marks the account; the dataset
 * process reads it once more (one user read, 0.01 USD) and pins it only if it passes the first lookup's checks against
 * the note's row. Admin session cookie and an Origin equal to the site's, as on `/api/admin/config`.
 */
export async function POST(req: NextRequest) {
  const admin = await verifyAdminSession(req.cookies.get(ADMIN_COOKIE)?.value);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  const origin = req.headers.get('origin');
  if (!origin || !isAllowedOrigin(origin)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403, headers: NO_STORE });
  if (Number(req.headers.get('content-length') ?? 0) > 1024) return NextResponse.json({ error: 'Payload too large' }, { status: 413, headers: NO_STORE });
  let id: unknown;
  try {
    id = ((await req.json()) as { id?: unknown }).id;
  } catch {
    return NextResponse.json({ error: 'invalid_request', message: 'body is not JSON' }, { status: 400, headers: NO_STORE });
  }
  if (typeof id !== 'string' || !X_SOURCE_ID_RE.test(id)) return NextResponse.json({ error: 'invalid_request', message: 'id must be an X account of the dataset' }, { status: 400, headers: NO_STORE });
  try {
    await askDatasetXReview(id);
    return NextResponse.json({ ok: true, id }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof SupervisorError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status === 404 ? 404 : err.status === 400 ? 400 : 502, headers: NO_STORE });
    if (err instanceof SupervisorUnavailable) return NextResponse.json({ error: 'supervisor_unavailable', message: 'The agent service is unavailable right now.' }, { status: 503, headers: NO_STORE });
    console.warn('admin dataset x-review: failed', (err as Error).message);
    return NextResponse.json({ error: 'upstream_failed', message: 'Could not ask for another look.' }, { status: 502, headers: NO_STORE });
  }
}
