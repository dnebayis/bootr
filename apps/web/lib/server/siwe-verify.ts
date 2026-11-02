import { SiweMessage } from 'siwe';
import { createPublicClient, http, isAddress, isHex, type Address, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { isAllowedOrigin } from './env';
import { consumeNonce, rememberNonce } from './server-state';

/**
 * One SIWE check for every signed request the site accepts: the console sign-in (cookie-bound nonce), the
 * creator's X claim on the coin page (cookie-bound nonce) and the agent API (nonce returned in JSON by
 * `POST /api/agent/nonce`, single use, 10 minutes). The caller says which nonce it expects; this verifies
 * everything else: nonce consumption, site origin and domain, chain, times, address and the signature
 * (viem: EOA, ERC-1271 and ERC-6492 smart accounts).
 */

export const NONCE_TTL_S = 600;

export type SiweOk = { ok: true; msg: SiweMessage; address: Address };
export type SiweFail = { ok: false; status: number; error: string };

export function issueNonce(now = Date.now()): { nonce: string; exp: number } {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const exp = Math.floor(now / 1000) + NONCE_TTL_S;
  rememberNonce(nonce, exp * 1000, now);
  return { nonce, exp };
}

export async function verifySiwe(
  body: { message?: unknown; signature?: unknown },
  opts: { expectedNonce?: string; statement?: RegExp; now?: number } = {},
): Promise<SiweOk | SiweFail> {
  const now = opts.now ?? Date.now();
  if (typeof body.message !== 'string' || typeof body.signature !== 'string' || !isHex(body.signature)) {
    return { ok: false, status: 400, error: 'message and signature are required' };
  }
  let msg: SiweMessage;
  try {
    msg = new SiweMessage(body.message);
  } catch {
    return { ok: false, status: 400, error: 'Malformed SIWE message' };
  }
  if (opts.expectedNonce !== undefined && msg.nonce !== opts.expectedNonce) return { ok: false, status: 401, error: 'Nonce mismatch' };
  // Consume first: a nonce is spent by any verification attempt, successful or not.
  if (!msg.nonce || !consumeNonce(msg.nonce, now)) return { ok: false, status: 401, error: 'Nonce expired or already used. Request a new nonce.' };
  let uri: URL;
  try {
    uri = new URL(msg.uri);
  } catch {
    return { ok: false, status: 400, error: 'Invalid URI' };
  }
  if (!isAllowedOrigin(uri)) return { ok: false, status: 401, error: 'URI mismatch' };
  if (msg.domain !== uri.host) return { ok: false, status: 401, error: 'Domain mismatch' };
  if (msg.chainId !== 8453 && msg.chainId !== 84532) return { ok: false, status: 401, error: 'Unsupported chain' };
  if (msg.expirationTime && Date.parse(msg.expirationTime) < now) return { ok: false, status: 401, error: 'Message expired' };
  if (msg.notBefore && Date.parse(msg.notBefore) > now) return { ok: false, status: 401, error: 'Message not yet valid' };
  if (!msg.issuedAt || Math.abs(now - Date.parse(msg.issuedAt)) > 10 * 60_000) return { ok: false, status: 401, error: 'Stale message' };
  if (!isAddress(msg.address)) return { ok: false, status: 400, error: 'Invalid address' };
  if (opts.statement && !opts.statement.test(msg.statement ?? '')) return { ok: false, status: 400, error: 'Unexpected statement' };

  const chain = msg.chainId === 8453 ? base : baseSepolia;
  const rpc = msg.chainId === 8453 ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;
  const client = createPublicClient({ chain, transport: http(rpc || undefined) });
  let valid = false;
  try {
    valid = await client.verifyMessage({ address: msg.address, message: body.message, signature: body.signature as Hex });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, error: 'Bad signature' };
  return { ok: true, msg, address: msg.address as Address };
}
