/**
 * Sentences the agent API's refusals share (`app/api/agent/*`). Each says what was wrong and what to do next, names the
 * value where that is safe, and never repeats a signature or an unbounded input. The codes are listed on /docs/api.
 */
import { env } from '@/lib/env';

/** After any refusal that got as far as the nonce: `verifySiwe` spends it on every attempt. */
export const NEW_NONCE = 'Sign a new message with a fresh nonce from POST /api/agent/nonce: the one in this message is spent.';

/** A caller's value as a short quoted string (a non-scalar is named by its type, not repeated). */
export function quoted(value: unknown, max = 64): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return value === null || value === undefined ? 'nothing' : `an ${typeof value}`;
  const line = String(value).replace(/\p{Cc}+/gu, ' ');
  return JSON.stringify(line.length > max ? `${line.slice(0, max)}…` : line);
}

/** The request body when it is a JSON object, else null (`null` and `5` are valid JSON, and nothing a route can read). */
export async function readJsonObject<T extends object>(req: Request): Promise<T | null> {
  const body: unknown = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as T) : null;
}

export function rateLimitMessage(perMinute: number, retryAfter: number): string {
  return `This route takes ${perMinute} requests per minute per IP. Retry in ${retryAfter} seconds.`;
}

export function originRefusal(origin: string | null): string {
  const seen = origin ? `Origin ${quoted(origin, 100)} is not allowed` : 'The request has no Origin header';
  return `${seen}: this route takes requests with Origin: ${env.siteUrl}, authenticated by the creator’s signed message.`;
}

export function kernelMessage(kernel: string): string {
  return `kernel must be the 0x address of the agent’s treasury, got ${quoted(kernel)}.`;
}

export function unknownCoinMessage(kernel: string): string {
  return `No indexed coin has treasury ${kernel}. Use the agent’s treasury (kernel in the indexer), not the coin’s address; a coin launched a moment ago appears once the indexer catches up, so retry in a minute.`;
}

export function otherCoinMessage(signed: string, kernel: string): string {
  return `The signed statement names treasury ${signed}, but the URL names ${kernel}: sign the statement for ${kernel}. ${NEW_NONCE}`;
}

/** Who signed against who had to. Both addresses are public; `action` finishes "can …". */
export function creatorRefusal(action: string, signer: string, token: { creator: string; agentId: string }, signedAgentId: string): string {
  if (token.agentId !== signedAgentId) {
    return `The signed statement names agent #${signedAgentId}, but this treasury belongs to agent #${token.agentId}: sign the statement for #${token.agentId}. ${NEW_NONCE}`;
  }
  return `The message was signed by ${signer}, but this coin’s creator is ${token.creator}. Only the wallet that launched the coin can ${action}: sign with ${token.creator}. ${NEW_NONCE}`;
}
