import { NextResponse, type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { isLaunchId } from '@/lib/agent-card';
import { AGENT_OWN_X_ERROR, checkLinks, isAgentsOwnX, type CoinLinks } from '@/lib/coin-link-rules';
import { ownContractUri } from '@/lib/coin-links';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { isAllowedOrigin } from '@/lib/server/env';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { updateLaunchDraftLinks } from '@/lib/server/launch-drafts';
import { fetchTokenCreator } from '@/lib/server/sender';
import { verifySiwe } from '@/lib/server/siwe-verify';

const NO_STORE = { 'Cache-Control': 'no-store' };
const limiter = new RateLimiter(10, 60_000);

/** The statement the coin page asks the creator to sign; the agent id and the kernel are read back from it. */
export const LINKS_STATEMENT = /^Update the links of Bootr coin \$([A-Za-z0-9_]{1,16}) \(#(\d{1,20}), (0x[0-9a-fA-F]{40})\)\.$/;

const NOT_HOSTED = 'This coin’s contract metadata is not hosted on Bootr, so its links cannot be changed here.';
const NO_DRAFT = 'Bootr holds no launch record for this coin, so its links cannot be changed here.';

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

/** The launch id inside a contract URI this site hosts (`/tokens/<launchId>.json`), else null. */
export function launchIdOfContractUri(metadata: string | null | undefined): string | null {
  const path = ownContractUri(metadata);
  const id = path ? /^\/tokens\/([0-9a-f-]{36})/i.exec(path)?.[1]?.toLowerCase() : null;
  return id && isLaunchId(id) ? id : null;
}

/**
 * PUT /api/agent/:kernel/links {message, signature, links: {website?, x?, telegram?, discord?}} -> CoinLinks
 * The creator changes the coin's own links from the coin page: a SIWE message whose statement is
 * `Update the links of Bootr coin $SYMBOL (#agentId, kernel).` (nonce from `POST /api/agent/nonce`, single use),
 * the indexer confirms the signer created the coin, and the links replace the ones in the coin's launch draft, the
 * file behind its hosted contract URI (`GET /tokens/<launchId>.json`, read fresh on every request), so the
 * document and the coin page change at once. Each link is null (absent, cleared) or a string checked with the
 * launch form's rules (lib/coin-link-rules.ts); `x` may be `@handle` and is stored as `https://x.com/<handle>`;
 * the agent's own account is refused as the project's X link (the page shows it on its own line). The answer
 * is the normalised links. 409 when the coin's contract URI is not hosted here or no draft backs it: such links
 * cannot be edited. Same-origin only; 10 requests per minute per IP. In mock mode the signature is not checked
 * and the mock store is updated.
 */
export async function PUT(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/links'>) {
  const origin = req.headers.get('origin');
  if (!origin || !(isAllowedOrigin(origin) || sameHost(origin, req.headers.get('host')))) return fail(403, 'forbidden', 'cross-origin request rejected');
  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) return fail(429, 'rate_limited', 'Too many requests. Try again in a minute.', {}, { 'Retry-After': String(retryAfter) });
  const { kernel } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', 'kernel must be an address');
  if (Number(req.headers.get('content-length') ?? 0) > 16_384) return fail(413, 'payload_too_large', 'Body too large.');
  let body: { message?: unknown; signature?: unknown; links?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400, 'invalid_json', 'Body is not valid JSON.');
  }
  if (!body.links || typeof body.links !== 'object') return fail(400, 'invalid_request', 'links must be an object with website, x, telegram and discord.');
  const checked = checkLinks(body.links);
  if (!checked.ok) return fail(400, 'invalid_request', checked.message, { field: checked.field });
  const links: CoinLinks = checked.links;

  if (env.useMock) {
    const coin = mock.coinOfKernel(kernel);
    if (!coin) return fail(404, 'unknown_coin', 'No indexed coin has that treasury.');
    if (isAgentsOwnX(links.x, coin.xHandle)) return fail(400, 'invalid_request', AGENT_OWN_X_ERROR, { field: 'x' });
    const r = mock.updateCoinLinks(kernel, links);
    if (!r.ok) return fail(r.status, r.error, r.message);
    return NextResponse.json(r.links, { headers: NO_STORE });
  }

  const v = await verifySiwe(body, { statement: LINKS_STATEMENT });
  if (!v.ok) return fail(v.status, 'siwe_rejected', v.error);
  const [, , agentId, statementKernel] = LINKS_STATEMENT.exec(v.msg.statement ?? '')!;
  if (statementKernel!.toLowerCase() !== kernel.toLowerCase()) return fail(400, 'invalid_request', 'The signed message names another coin.');
  let token: Awaited<ReturnType<typeof fetchTokenCreator>>;
  try {
    token = await fetchTokenCreator(kernel);
  } catch (err) {
    console.warn('coin links: indexer failed', (err as Error).message);
    return fail(502, 'upstream_failed', 'Could not reach the indexer.');
  }
  if (!token) return fail(404, 'unknown_coin', 'No indexed coin has that treasury.');
  if (token.agentId !== agentId || token.creator.toLowerCase() !== v.address.toLowerCase()) {
    return fail(403, 'not_creator', 'Only the wallet that launched the coin can change its links.');
  }
  if (isAgentsOwnX(links.x, token.xHandle)) return fail(400, 'invalid_request', AGENT_OWN_X_ERROR, { field: 'x' });
  const launchId = launchIdOfContractUri(token.metadata);
  if (!launchId) return fail(409, 'links_not_editable', NOT_HOSTED);
  const r = await updateLaunchDraftLinks(launchId, links);
  if (!r.ok) return fail(409, 'links_not_editable', NO_DRAFT);
  return NextResponse.json(links, { headers: NO_STORE });
}
