import { NextResponse, type NextRequest } from 'next/server';
import { SiweMessage } from 'siwe';
import { isAddress, isHex, type Hex } from 'viem';
import { serverPublicClient } from '@/lib/server/chain';
import {
  ADMIN_COOKIE,
  NONCE_COOKIE,
  SESSION_TTL_S,
  isAdminAddress,
  newSessionId,
  signToken,
  verifyToken,
  type NonceToken,
} from '@/lib/server/session-core';
import { isAllowedOrigin } from '@/lib/server/env';
import { consumeNonce } from '@/lib/server/server-state';
import { cookieBase } from '@/lib/server/session';

function fail(status: number, error: string) {
  const res = NextResponse.json({ error }, { status });
  res.cookies.set(NONCE_COOKIE, '', { ...cookieBase, path: '/api/siwe', maxAge: 0 });
  return res;
}

/**
 * Verifies a SIWE message + signature:
 *   nonce matches the signed cookie and was issued by this server (single use), domain/uri match the
 *   configured site origin (NEXT_PUBLIC_SITE_URL; request headers such as X-Forwarded-Host are never
 *   trusted), times are valid, the address is in ADMIN_ADDRESSES, and the signature verifies
 *   on-chain-aware (viem: EOA, ERC-1271 and ERC-6492 smart accounts).
 */
export async function POST(req: NextRequest) {
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
  // Consume first: a nonce is spent by any verification attempt, successful or not.
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
  if (msg.notBefore && Date.parse(msg.notBefore) > now) return fail(401, 'Message not yet valid');
  if (!msg.issuedAt || Math.abs(now - Date.parse(msg.issuedAt)) > 10 * 60_000) return fail(401, 'Stale message');
  if (!isAddress(msg.address)) return fail(400, 'Invalid address');
  if (!isAdminAddress(msg.address)) return fail(403, 'Not authorized');

  const client = serverPublicClient(msg.chainId);
  let valid = false;
  try {
    valid = await client.verifyMessage({ address: msg.address, message: body.message, signature: body.signature as Hex });
  } catch {
    valid = false;
  }
  if (!valid) return fail(401, 'Invalid signature');

  const token = await signToken({ k: 'admin', a: msg.address.toLowerCase(), e: Math.floor(now / 1000) + SESSION_TTL_S, s: newSessionId() });
  const res = NextResponse.json({ ok: true, address: msg.address });
  res.cookies.set(ADMIN_COOKIE, token, { ...cookieBase, maxAge: SESSION_TTL_S });
  res.cookies.set(NONCE_COOKIE, '', { ...cookieBase, path: '/api/siwe', maxAge: 0 });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
