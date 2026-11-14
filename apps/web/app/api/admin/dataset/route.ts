import { NextResponse, type NextRequest } from 'next/server';
import { datasetDay, getDatasetDay } from '@/lib/server/dataset';
import { verifyAdminSession } from '@/lib/server/session';
import { ADMIN_COOKIE } from '@/lib/server/session-core';
import { SupervisorError, SupervisorUnavailable } from '@/lib/server/supervisor';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/admin/dataset?day=YYYY-MM-DD: one UTC day of Bootr's own dataset (records with grade, sources and counts,
 * and the state of every source), for the admin console. Admin session cookie only; read-only. Without `day` it is
 * today's.
 */
export async function GET(req: NextRequest) {
  const admin = await verifyAdminSession(req.cookies.get(ADMIN_COOKIE)?.value);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  const asked = req.nextUrl.searchParams.get('day');
  const day = asked === null ? new Date().toISOString().slice(0, 10) : datasetDay(asked);
  if (!day) return NextResponse.json({ error: 'invalid_request', message: 'day must be YYYY-MM-DD' }, { status: 400, headers: NO_STORE });
  try {
    return NextResponse.json(await getDatasetDay(day), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof SupervisorError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status === 404 ? 404 : 502, headers: NO_STORE });
    if (err instanceof SupervisorUnavailable) return NextResponse.json({ error: 'supervisor_unavailable', message: 'The agent service is unavailable right now.' }, { status: 503, headers: NO_STORE });
    console.warn('admin dataset: failed', (err as Error).message);
    return NextResponse.json({ error: 'upstream_failed', message: 'Could not read the dataset.' }, { status: 502, headers: NO_STORE });
  }
}
