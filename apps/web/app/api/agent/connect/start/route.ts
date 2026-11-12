import { CLIENT_LABEL_MAX } from '@bootr/shared/own-agent';
import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mockOwn } from '@/lib/mock-own';
import { RateLimiter } from '@/lib/server/ipfs';
import { forwardOwn, ipOf, ownDisabled, ownJson, ownLimited, readOwnBody, SMALL_BODY_BYTES } from '@/lib/server/own-agent';

/** Connection requests a minute per IP, like the launch route. */
const limiter = new RateLimiter(5, 60_000);

/** A name or a coin as a client sent it: one line, no control or invisible characters, cut to `max`. */
function line(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\p{C}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
}

/**
 * POST /api/agent/connect/start {clientName?, coin?} -> ConnectStartResponse
 * An AI client asks to be connected to a coin's agent (docs/design/byo-agent.md section 3.2). The answer carries a
 * device code for the client alone and a short user code with the link `/connect/<code>`, where the coin's creator
 * approves with a wallet signature. Nothing is connected by this call. 5 a minute per IP.
 */
export async function POST(req: NextRequest) {
  const off = ownDisabled();
  if (off) return off;
  const limited = ownLimited(limiter, ipOf(req));
  if (limited) return limited;
  const body = await readOwnBody(req, SMALL_BODY_BYTES);
  if (body instanceof Response) return body;
  const request = { clientName: line(body.clientName, CLIENT_LABEL_MAX), coin: line(body.coin, 64) };
  if (env.useMock) return ownJson(mockOwn.start(request, env.siteUrl));
  return forwardOwn('POST', '/internal/own/connect/start', { ...request, siteUrl: env.siteUrl });
}
