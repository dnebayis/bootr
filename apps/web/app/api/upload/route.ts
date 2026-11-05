import { NextResponse, type NextRequest } from 'next/server';
import { ipfsGatewayUrl, UPLOAD_MAX_BYTES, type UploadResult } from '@/lib/ipfs';
import { isAllowedOrigin, pinataEnv } from '@/lib/server/env';
import { checkImageFile, clientIp, PinError, pinFile, RateLimiter, sha256Hex, type ImageKind } from '@/lib/server/ipfs';
import { isDraftId } from '@/lib/server/sender';

/**
 * POST /api/upload                          multipart: file (png/jpg/webp/svg, ≤ 2 MB), draftId (launch draft uuid)
 * POST /api/upload?kind=json&draftId=<uuid> body: a JSON object (≤ 64 kB), e.g. an ERC-8004 registration file
 *   -> 200 { cid, ipfsUri: "ipfs://<cid>", url: "<NEXT_PUBLIC_IPFS_GATEWAY>/ipfs/<cid>" } (+ mock: true)
 *
 * Pins to public IPFS through Pinata (lib/server/ipfs.ts) as `bootr/<draftId>/<sha256 prefix>`.
 * Same-origin only, 10 requests per minute per IP, 503 when PINATA_JWT is unset. The file type comes
 * from its magic bytes; SVGs with scripts, event handlers or external references are refused.
 * Mock mode (PINATA_MOCK=1, or app mock mode without a JWT) returns a deterministic CID and pins nothing.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };
const MULTIPART_OVERHEAD = 64 * 1024;
const JSON_MAX_BYTES = 64 * 1024;
const limiter = new RateLimiter(10, 60_000);

function fail(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message }, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * CSRF guard: the canonical site origin (same check as the admin and X-connect POSTs), or a browser
 * request the browser itself marks as same-origin (`Sec-Fetch-Site` cannot be set by page scripts).
 */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (origin && isAllowedOrigin(origin)) return true;
  return req.headers.get('sec-fetch-site') === 'same-origin';
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return fail(403, 'forbidden', 'cross-origin request rejected');

  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) return fail(429, 'rate_limited', 'Too many uploads. Try again in a minute.', { 'Retry-After': String(retryAfter) });

  const pinata = pinataEnv();
  if (!pinata.jwt && !pinata.mock) return fail(503, 'upload_unavailable', 'Image uploads are not configured (PINATA_JWT).');

  const kind = req.nextUrl.searchParams.get('kind') ?? 'image';
  const length = Number(req.headers.get('content-length') ?? 0);

  let bytes: Uint8Array;
  let type: ImageKind | 'application/json';
  let draftId: string;

  if (kind === 'json') {
    draftId = req.nextUrl.searchParams.get('draftId') ?? '';
    if (!isDraftId(draftId)) return fail(400, 'invalid_request', 'draftId must be a launch draft uuid');
    if (length > JSON_MAX_BYTES) return fail(413, 'payload_too_large', 'JSON must be at most 64 kB.');
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > JSON_MAX_BYTES) return fail(413, 'payload_too_large', 'JSON must be at most 64 kB.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail(400, 'invalid_json', 'Body is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(400, 'invalid_json', 'Body must be a JSON object.');
    bytes = new TextEncoder().encode(JSON.stringify(parsed));
    type = 'application/json';
  } else if (kind === 'image') {
    if (length > UPLOAD_MAX_BYTES + MULTIPART_OVERHEAD) return fail(413, 'payload_too_large', 'Image must be at most 2 MB.');
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail(400, 'invalid_request', 'Expected multipart/form-data with a "file" field.');
    }
    const file = form.get('file');
    draftId = String(form.get('draftId') ?? '');
    if (!(file instanceof File) || file.size === 0) return fail(400, 'invalid_request', 'Expected multipart/form-data with a "file" field.');
    if (!isDraftId(draftId)) return fail(400, 'invalid_request', 'draftId must be a launch draft uuid');
    const checked = await checkImageFile(file);
    if (!checked.ok) return fail(checked.status, checked.error, checked.message);
    bytes = checked.bytes;
    type = checked.type;
  } else {
    return fail(400, 'invalid_request', 'kind must be "image" or "json"');
  }

  const sha = await sha256Hex(bytes);
  const name = `bootr/${draftId}/${sha.slice(0, 16)}`;
  try {
    const { cid, mock } = await pinFile(bytes, type, name, { app: 'bootr', draftId, kind, sha256: sha });
    const body: UploadResult = { cid, ipfsUri: `ipfs://${cid}`, url: ipfsGatewayUrl(cid), ...(mock ? { mock: true as const } : {}) };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (e) {
    console.error('[upload] pin failed:', e instanceof PinError ? e.message : (e as Error).name);
    return fail(502, 'pin_failed', 'Could not pin the file to IPFS. Try again.');
  }
}
