import { NextResponse, type NextRequest } from 'next/server';
import { isAllowedOrigin } from '@/lib/server/env';
import {
  MAX_IDENTITY_CHARS,
  MIN_IDENTITY_CHARS,
  OWNER_COOKIE,
  OWNER_COOKIE_PATH,
  OWNER_TTL_S,
  isDraftId,
  normalizeCoin,
  normalizeIdentity,
  normalizeSource,
  normalizeWorker,
  ownerCookieValue,
  ownerTagFromCookie,
  saveDraftIdentity,
} from '@/lib/server/launch-drafts';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/launch/draft {draftId: <launch draft uuid>, identity: <20..600 chars>, coin?: {name, symbol, image, imageIpfs, xHandle, links?: {website, x, telegram, discord}},
 *   worker?: {kind: 'trader' | 'researcher' | 'community'} | {kind: 'custom', preset: {capabilities, postIntervalMs, identity: jobLines}},
 *   launchThrough?: 'bootr' | 'clanker'}
 * Stores the creator's Instructions text under the draft id so the hosted agent card (`/agents/<draftId>.json`)
 * can publish it and the supervisor can give the agent that persona (lib/server/launch-drafts.ts). `coin`
 * backs the token's ERC-7572 contract URI (`/tokens/<draftId>.json`); a custom `worker` is published in the
 * agent card as `bootr.worker`, where the supervisor recomputes the hash the launch wrote on-chain.
 * Same-origin only. The first write owns the draft id (HttpOnly cookie); a write without the owner's
 * cookie for an id that already has a text answers 409.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  // Same-origin: the configured site origin, or the host this request was served from (same scheme-less host
  // as the Origin header, so a preview or e2e server on another port qualifies while evil.com never does).
  if (!origin || !(isAllowedOrigin(origin) || sameHost(origin, req.headers.get('host')))) {
    return NextResponse.json({ error: 'forbidden', message: 'cross-origin request rejected' }, { status: 403, headers: NO_STORE });
  }
  if (Number(req.headers.get('content-length') ?? 0) > 8192) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  let body: { draftId?: unknown; identity?: unknown; coin?: unknown; worker?: unknown; launchThrough?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* handled below */
  }
  if (!isDraftId(body.draftId)) {
    return NextResponse.json({ error: 'invalid_request', message: 'draftId must be a draft uuid' }, { status: 400, headers: NO_STORE });
  }
  const identity = normalizeIdentity(body.identity);
  if (identity === null) {
    return NextResponse.json(
      { error: 'invalid_request', message: `identity must be plain text of ${MIN_IDENTITY_CHARS} to ${MAX_IDENTITY_CHARS} characters` },
      { status: 400, headers: NO_STORE },
    );
  }
  const coin = body.coin === undefined ? null : normalizeCoin(body.coin);
  if (body.coin !== undefined && coin === null) {
    return NextResponse.json({ error: 'invalid_request', message: 'coin must carry a valid name, symbol and image URL, and only https links' }, { status: 400, headers: NO_STORE });
  }
  const worker = body.worker === undefined ? null : normalizeWorker(body.worker);
  if (body.worker !== undefined && worker === null) {
    return NextResponse.json({ error: 'invalid_request', message: 'worker must be a template id or a custom preset within bounds' }, { status: 400, headers: NO_STORE });
  }
  const source = normalizeSource(body.launchThrough);
  if (source === null) {
    return NextResponse.json({ error: 'invalid_request', message: 'launchThrough must be bootr or clanker' }, { status: 400, headers: NO_STORE });
  }
  const cookie = req.cookies.get(OWNER_COOKIE)?.value;
  let saved;
  try {
    saved = await saveDraftIdentity(body.draftId, identity, ownerTagFromCookie(cookie, body.draftId), { coin, worker, source });
  } catch {
    return NextResponse.json({ error: 'store_unavailable', message: 'The launch draft store is not writable.' }, { status: 503, headers: NO_STORE });
  }
  if (!saved.ok) {
    return NextResponse.json({ error: 'draft_owned', message: 'This draft id already has an identity saved by another browser.' }, { status: 409, headers: NO_STORE });
  }
  const res = NextResponse.json({ ok: true, identity }, { headers: NO_STORE });
  res.cookies.set(OWNER_COOKIE, ownerCookieValue(cookie, body.draftId, saved.ownerTag), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: OWNER_COOKIE_PATH,
    maxAge: OWNER_TTL_S,
  });
  return res;
}

function sameHost(origin: string, host: string | null): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
