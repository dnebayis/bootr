import { SiweMessage } from 'siwe';
import { isAddress, isHex, recoverMessageAddress, type Address, type Hex } from 'viem';
import { serverPublicClient } from './chain';
import { isAllowedOrigin, siteOrigin } from './env';
import { NEW_NONCE, quoted } from './refusals';
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
/** A stable name for why a signed message was refused; `error` is the sentence that says what to do about it. */
export type SiweFailReason =
  | 'missing_fields'
  | 'malformed_message'
  | 'nonce_mismatch'
  | 'nonce_spent'
  | 'invalid_uri'
  | 'uri_mismatch'
  | 'domain_mismatch'
  | 'unsupported_chain'
  | 'message_expired'
  | 'message_not_yet_valid'
  | 'stale_message'
  | 'invalid_address'
  | 'wrong_statement'
  | 'bad_signature'
  | 'signature_unverifiable';
export type SiweFail = { ok: false; status: number; reason: SiweFailReason; error: string };

export function issueNonce(now = Date.now()): { nonce: string; exp: number } {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const exp = Math.floor(now / 1000) + NONCE_TTL_S;
  rememberNonce(nonce, exp * 1000, now);
  return { nonce, exp };
}

/** The first problems the SIWE parser names ("line 2: invalid EIP-55 address - 0x…"), cut short: they quote the message. */
function parseProblems(err: unknown): string {
  const text = String((err as Error | undefined)?.message ?? err);
  const lines = text.split('\n').filter((l) => /^line \d+:/.test(l));
  return lines.length ? lines.slice(0, 3).map((l) => l.slice(0, 100)).join('; ') : 'it does not follow the EIP-4361 layout';
}

export async function verifySiwe(
  body: { message?: unknown; signature?: unknown },
  opts: {
    expectedNonce?: string;
    statement?: RegExp;
    /** The statement to sign, as a refusal should spell it (`statement` is the pattern it is checked with). */
    statementText?: string;
    now?: number;
  } = {},
): Promise<SiweOk | SiweFail> {
  const now = opts.now ?? Date.now();
  if (typeof body.message !== 'string') return { ok: false, status: 400, reason: 'missing_fields', error: 'message is required: the SIWE text exactly as it was signed.' };
  if (typeof body.signature !== 'string' || !isHex(body.signature)) return { ok: false, status: 400, reason: 'missing_fields', error: 'signature is required: the wallet’s signature of message, as 0x hex.' };
  let msg: SiweMessage;
  try {
    msg = new SiweMessage(body.message);
  } catch (err) {
    return { ok: false, status: 400, reason: 'malformed_message', error: `message is not a valid SIWE message: ${parseProblems(err)}. Build it with a SIWE library; the address must be EIP-55 checksummed and the nonce must come from the site.` };
  }
  if (opts.expectedNonce !== undefined && msg.nonce !== opts.expectedNonce) return { ok: false, status: 401, reason: 'nonce_mismatch', error: 'The nonce in the message is not the one this page issued. Reload the page and sign again.' };
  // Consume first: a nonce is spent by any verification attempt, successful or not. Every refusal below says so.
  if (!msg.nonce || !consumeNonce(msg.nonce, now)) return { ok: false, status: 401, reason: 'nonce_spent', error: 'The nonce has expired, was already used, or was not issued by this site (a nonce lasts 10 minutes and any attempt spends it). Request a new nonce and sign again.' };
  const spent = (status: number, reason: SiweFailReason, problem: string): SiweFail => ({ ok: false, status, reason, error: `${problem} ${NEW_NONCE}` });
  const site = siteOrigin().origin;
  let uri: URL;
  try {
    uri = new URL(msg.uri);
  } catch {
    return spent(400, 'invalid_uri', `uri must be ${site}, got ${quoted(msg.uri, 100)}.`);
  }
  if (!isAllowedOrigin(uri)) return spent(401, 'uri_mismatch', `uri must be ${site}, got ${quoted(msg.uri, 100)}.`);
  if (msg.domain !== uri.host) return spent(401, 'domain_mismatch', `domain must be the host of uri (${uri.host}), got ${quoted(msg.domain, 100)}.`);
  if (msg.chainId !== 8453 && msg.chainId !== 84532) return spent(401, 'unsupported_chain', `chainId must be 8453 (Base) or 84532 (Base Sepolia), got ${msg.chainId}.`);
  if (msg.expirationTime && Date.parse(msg.expirationTime) < now) return spent(401, 'message_expired', `expirationTime ${quoted(msg.expirationTime)} has passed.`);
  if (msg.notBefore && Date.parse(msg.notBefore) > now) return spent(401, 'message_not_yet_valid', `notBefore ${quoted(msg.notBefore)} is still in the future.`);
  if (!msg.issuedAt || Math.abs(now - Date.parse(msg.issuedAt)) > 10 * 60_000) return spent(401, 'stale_message', `issuedAt must be within 10 minutes of now, got ${quoted(msg.issuedAt)}.`);
  if (!isAddress(msg.address)) return spent(400, 'invalid_address', `address is not a valid address: ${quoted(msg.address)}.`);
  if (opts.statement && !opts.statement.test(msg.statement ?? '')) {
    return spent(400, 'wrong_statement', `The statement must be exactly ${opts.statementText ? `"${opts.statementText}"` : 'the one this route documents'}, got ${quoted(msg.statement ?? '', 120)}.`);
  }

  // A smart account's signature (ERC-1271 / ERC-6492) is checked on the chain through a client that refuses CCIP-Read
  // (lib/server/chain.ts): the account is the caller's own contract, so its reverts must not make this server fetch URLs.
  const client = serverPublicClient(msg.chainId);
  let valid = false;
  let unverifiable = false;
  try {
    valid = await client.verifyMessage({ address: msg.address, message: body.message, signature: body.signature as Hex });
  } catch {
    unverifiable = true;
  }
  if (valid) return { ok: true, msg, address: msg.address as Address };
  // An ordinary wallet's signature names its signer, which is usually the whole explanation.
  const recovered = await recoverMessageAddress({ message: body.message, signature: body.signature as Hex }).catch(() => null);
  if (recovered && recovered.toLowerCase() !== msg.address.toLowerCase()) {
    return spent(401, 'bad_signature', `The signature recovered to ${recovered}, but the message names ${msg.address}. Sign with ${msg.address}, or put the signing wallet’s address in the message, and send the text exactly as signed.`);
  }
  if (unverifiable) return spent(401, 'signature_unverifiable', `The signature could not be checked against the chain for ${msg.address}. Try again in a moment.`);
  return spent(401, 'bad_signature', `The signature does not verify for ${msg.address}. Sign the message text exactly as sent, with that wallet.`);
}
