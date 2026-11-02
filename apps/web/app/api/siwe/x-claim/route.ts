import { NextResponse, type NextRequest } from 'next/server';
import { SiweMessage } from 'siwe';
import { createPublicClient, http, isAddress, isHex, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { NONCE_COOKIE, verifyToken, type NonceToken } from '@/lib/server/session-core';
import { isAllowedOrigin } from '@/lib/server/env';
import { consumeNonce } from '@/lib/server/server-state';
import { cookieBase } from '@/lib/server/session';
import { DRAFT_COOKIE, DRAFT_COOKIE_PATH, DRAFT_TTL_S, fetchTokenCreator, isAgentId, registerDraft } from '@/lib/server/sender';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The statement the coin page asks the creator to sign; the agent id and the kernel are read back from it. */
const CLAIM_STATEMENT = /^Connect the X account of Bootr agent #(\d{1,20}) \((0x[0-9a-fA-F]{40})\)\.$/;

function fail(status: number, error: string) {
  const res = NextResponse.json({ error }, { status, headers: NO_STORE });
  res.cookies.set(NONCE_COOKIE, '', { ...cookieBase, path: '/api/siwe', maxAge: 0 });
  return res;
}

/**
 * POST /api/siwe/x-claim {message, signature}: a coin's creator proves wallet ownership with a SIWE message
 * whose statement names the agent id and its kernel, the indexer confirms that wallet created the coin, and
 * this browser is then registered for the agent id exactly like a launch draft (`POST /api/x/draft`), so
 * `/api/x/start` and `/api/x/status` serve it. Lives under /api/siwe so the nonce cookie reaches it. No
 * session is created: the registration cookie is the only thing granted, and only for that agent.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!origin || !isAllowedOrigin(origin)) return fail(403, 'cross-origin request rejected');
  const nonce = await verifyToken<NonceToken>(req.cookies.get(NONCE_COOKIE)?.value, 'nonce');
  if (!nonce) return fail(401, 'Sign-in expired. Request a new nonce.');

  let body: { message?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  if (typeof body.message !== 'string' || typeof body.signature !== 'string' || !isHex(body.signature)) {
    return fail(400, 'message and signature are required');
  }
  let msg: SiweMessage;
  try {
    msg = new SiweMessage(body.message);
  } catch {
    return fail(400, 'Malformed SIWE message');
  }
  const now = Date.now();
  if (msg.nonce !== nonce.n) return fail(401, 'Nonce mismatch');
  if (!consumeNonce(nonce.n, now)) return fail(401, 'Sign-in expired. Request a new nonce.');
  let uri: URL;
  try {
    uri = new URL(msg.uri);
  } catch {
    return fail(400, 'Invalid URI');
  }
  if (!isAllowedOrigin(uri)) return fail(401, 'URI mismatch');
  if (msg.domain !== uri.host) return fail(401, 'Domain mismatch');
  if (msg.chainId !== 8453 && msg.chainId !== 84532) return fail(401, 'Unsupported chain');
  if (msg.expirationTime && Date.parse(msg.expirationTime) < now) return fail(401, 'Message expired');
  if (!msg.issuedAt || Math.abs(now - Date.parse(msg.issuedAt)) > 10 * 60_000) return fail(401, 'Stale message');
  if (!isAddress(msg.address)) return fail(400, 'Invalid address');
  const m = CLAIM_STATEMENT.exec(msg.statement ?? '');
  if (!m) return fail(400, 'The statement must name the agent and its treasury');
  const [, agentId, kernel] = m;
  if (!isAgentId(agentId)) return fail(400, 'Invalid agent id');

  const chain = msg.chainId === 8453 ? base : baseSepolia;
  const rpc = msg.chainId === 8453 ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;
  const client = createPublicClient({ chain, transport: http(rpc || undefined) });
  let valid = false;
  try {
    valid = await client.verifyMessage({ address: msg.address, message: body.message, signature: body.signature as Hex });
  } catch {
    valid = false;
  }
  if (!valid) return fail(401, 'Bad signature');

  // The indexer is the source of truth for who created the coin whose agent this is.
  const token = await fetchTokenCreator(kernel);
  if (!token) return fail(404, 'Unknown coin');
  if (token.agentId !== agentId || token.creator.toLowerCase() !== msg.address.toLowerCase()) {
    return fail(403, 'Only the coin’s creator can connect its agent’s X account');
  }

  const value = await registerDraft(req.cookies.get(DRAFT_COOKIE)?.value, agentId);
  if (!value) return fail(503, 'X connection is not configured.');
  const res = NextResponse.json({ ok: true, agentId }, { headers: NO_STORE });
  res.cookies.set(NONCE_COOKIE, '', { ...cookieBase, path: '/api/siwe', maxAge: 0 });
  res.cookies.set(DRAFT_COOKIE, value, { ...cookieBase, path: DRAFT_COOKIE_PATH, maxAge: DRAFT_TTL_S });
  return res;
}
