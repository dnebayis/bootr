import { USER_CODE_RE } from '@bootr/shared/own-agent';
import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mockOwn } from '@/lib/mock-own';
import { RateLimiter } from '@/lib/server/ipfs';
import { forwardOwn, ipOf, ownError, ownJson, ownLimited } from '@/lib/server/own-agent';

const limiter = new RateLimiter(30, 60_000);

/**
 * GET /api/agent/connect/grant?code=<userCode> -> ConnectGrantView
 * What the approval page shows about a connection request: the client's name, the coin it named, and whether the
 * request is still waiting. The code is not a secret and is worth nothing without the creator's signature. Reads only,
 * so it answers with own agents switched off too. 30 a minute per IP.
 */
export async function GET(req: NextRequest) {
  const limited = ownLimited(limiter, ipOf(req));
  if (limited) return limited;
  const code = req.nextUrl.searchParams.get('code') ?? '';
  // A code of another shape cannot exist, so nobody is asked about it.
  if (!USER_CODE_RE.test(code)) return ownError('grant_not_found');
  if (env.useMock) {
    const grant = mockOwn.grant(code);
    return grant.ok ? ownJson(grant.data) : ownError(grant.error);
  }
  return forwardOwn('GET', `/internal/own/connect/grant?code=${code}`);
}
