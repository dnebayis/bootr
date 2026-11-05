import { NextResponse, type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { ipfsGatewayUrl, UPLOAD_MAX_BYTES } from '@/lib/ipfs';
import { clearCoinImage, setCoinImage } from '@/lib/server/coin-images';
import { isAllowedOrigin, pinataEnv } from '@/lib/server/env';
import { checkImageFile, clientIp, PinError, pinFile, RateLimiter, sha256Hex } from '@/lib/server/ipfs';
import { linksOriginRefusal, NEW_NONCE, rateLimitMessage, readJsonObject } from '@/lib/server/refusals';
import { fetchCoinCreator } from '@/lib/server/sender';
import { verifySiwe } from '@/lib/server/siwe-verify';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MULTIPART_OVERHEAD = 64 * 1024;
const limiter = new RateLimiter(10, 60_000);

/** The statement the coin page asks the creator to sign; the coin is read back from it. */
export const IMAGE_STATEMENT = /^Update the image of Bootr coin \$([A-Za-z0-9_]{1,16}) \((0x[0-9a-fA-F]{40})\)\.$/;
const STATEMENT_TEXT = 'Update the image of Bootr coin $<SYMBOL> (<coin>).';

function fail(status: number, error: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
}

function sameHost(origin: string, host: string | null): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** What both methods check before reading a body: `Origin` (none = a program), the limit and the coin's address. */
async function guard(req: NextRequest, ctx: RouteContext<'/api/coin/[id]/image'>): Promise<{ token: string } | { refused: NextResponse }> {
  const origin = req.headers.get('origin');
  if (origin !== null && !(isAllowedOrigin(origin) || sameHost(origin, req.headers.get('host')))) return { refused: fail(403, 'forbidden', linksOriginRefusal(origin)) };
  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) return { refused: fail(429, 'rate_limited', rateLimitMessage(10, retryAfter), {}, { 'Retry-After': String(retryAfter) }) };
  const { id } = await ctx.params;
  if (!isAddress(id, { strict: false })) return { refused: fail(400, 'invalid_request', 'The URL must name the coin’s 0x address.', { field: 'id' }) };
  return { token: id.toLowerCase() };
}

/** The signature, then the indexer: the signer must be the wallet that launched this coin. A refused answer, or who signed. */
async function authorize(body: { message?: unknown; signature?: unknown }, token: string): Promise<{ signer: string } | { refused: NextResponse }> {
  const v = await verifySiwe(body, { statement: IMAGE_STATEMENT, statementText: STATEMENT_TEXT });
  if (!v.ok) return { refused: fail(v.status, 'siwe_rejected', v.error, { reason: v.reason }) };
  const [, , signed] = IMAGE_STATEMENT.exec(v.msg.statement ?? '')!;
  if (signed!.toLowerCase() !== token) return { refused: fail(400, 'invalid_request', `The signed statement names coin ${signed}, but the URL names ${token}: sign the statement for ${token}. ${NEW_NONCE}`, { field: 'statement' }) };
  let coin: Awaited<ReturnType<typeof fetchCoinCreator>>;
  try {
    coin = await fetchCoinCreator(token);
  } catch (err) {
    console.warn('coin image: indexer failed', (err as Error).message);
    return { refused: fail(502, 'upstream_failed', `Could not reach the indexer. Try again in a moment. ${NEW_NONCE}`) };
  }
  if (!coin) return { refused: fail(404, 'unknown_coin', `No indexed coin has address ${token}; a coin launched a moment ago appears once the indexer catches up. ${NEW_NONCE}`) };
  if (coin.creator.toLowerCase() !== v.address.toLowerCase()) {
    return { refused: fail(403, 'not_creator', `The message was signed by ${v.address}, but this coin’s creator is ${coin.creator}. Only the wallet that launched the coin can change its image: sign with ${coin.creator}. ${NEW_NONCE}`) };
  }
  return { signer: v.address };
}

/**
 * PUT /api/coin/:id/image, multipart: file (png/jpg/webp/svg, at most 2 MB), message, signature -> {image, url}
 * The creator changes the image Bootr shows for the coin: a SIWE message whose statement is `Update the image of Bootr coin $SYMBOL (coin).`
 * (nonce from `POST /api/agent/nonce`, single use), the indexer confirms the signer created the coin, the file is pinned to IPFS and
 * becomes what the site shows. The on-chain image and the documents wallets read do not change. The type comes from the file's
 * bytes, checked like the launch form's upload, before the nonce is spent. `Origin` only keeps other sites' pages out, as on
 * `PUT /api/agent/:kernel/links`. 10 requests per minute per IP, shared with DELETE. In mock mode nothing is signed or pinned and
 * the image is kept as a data URL, so the page can show it.
 */
export async function PUT(req: NextRequest, ctx: RouteContext<'/api/coin/[id]/image'>) {
  const g = await guard(req, ctx);
  if ('refused' in g) return g.refused;
  if (Number(req.headers.get('content-length') ?? 0) > UPLOAD_MAX_BYTES + MULTIPART_OVERHEAD) return fail(413, 'payload_too_large', 'Image must be at most 2 MB.');
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, 'invalid_request', 'Expected multipart/form-data with file, message and signature.');
  }
  const checked = await checkImageFile(form.get('file'));
  if (!checked.ok) return fail(checked.status, checked.error, checked.message, checked.error === 'invalid_request' ? { field: 'file' } : {});

  if (env.useMock) {
    if (!mock.coinOfId(g.token)) return fail(404, 'unknown_coin', `No indexed coin has address ${g.token}.`);
    const image = `data:${checked.type};base64,${Buffer.from(checked.bytes).toString('base64')}`;
    mock.setCoinImage(g.token, image);
    return NextResponse.json({ image, url: image, mock: true }, { headers: NO_STORE });
  }

  const pinata = pinataEnv();
  if (!pinata.jwt && !pinata.mock) return fail(503, 'upload_unavailable', 'Image uploads are not configured on this deployment, so the image cannot be changed right now.');
  const auth = await authorize({ message: form.get('message') ?? undefined, signature: form.get('signature') ?? undefined }, g.token);
  if ('refused' in auth) return auth.refused;
  const sha = await sha256Hex(checked.bytes);
  try {
    const { cid } = await pinFile(checked.bytes, checked.type, `bootr/coin-image/${g.token}/${sha.slice(0, 16)}`, { app: 'bootr', kind: 'coin-image', token: g.token, sha256: sha });
    const image = `ipfs://${cid}`;
    await setCoinImage(g.token, image, auth.signer);
    return NextResponse.json({ image, url: ipfsGatewayUrl(cid) }, { headers: NO_STORE });
  } catch (e) {
    console.error('[coin image] failed:', e instanceof PinError ? e.message : (e as Error).name);
    return fail(502, 'pin_failed', `Could not save the image. Try again. ${NEW_NONCE}`);
  }
}

/** DELETE /api/coin/:id/image {message, signature} -> {image: null}: back to the on-chain image. Same statement, same checks. */
export async function DELETE(req: NextRequest, ctx: RouteContext<'/api/coin/[id]/image'>) {
  const g = await guard(req, ctx);
  if ('refused' in g) return g.refused;
  const body = await readJsonObject<{ message?: unknown; signature?: unknown }>(req);
  if (!body) return fail(400, 'invalid_json', 'Body must be a JSON object: {message, signature}.');
  if (env.useMock) {
    if (!mock.coinOfId(g.token)) return fail(404, 'unknown_coin', `No indexed coin has address ${g.token}.`);
    mock.setCoinImage(g.token, null);
    return NextResponse.json({ image: null }, { headers: NO_STORE });
  }
  const auth = await authorize(body, g.token);
  if ('refused' in auth) return auth.refused;
  await clearCoinImage(g.token);
  return NextResponse.json({ image: null }, { headers: NO_STORE });
}
