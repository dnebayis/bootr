import { type NextRequest } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { env } from '@/lib/env';
import { mockOwn } from '@/lib/mock-own';
import { RateLimiter } from '@/lib/server/ipfs';
import { forwardOwn, ipOf, ownError, ownJson, ownLimited } from '@/lib/server/own-agent';

const limiter = new RateLimiter(30, 60_000);

/**
 * GET /api/agent/connect/coins?creator=<address> -> ConnectCoinsResponse
 * The coins a wallet launched, newest first: what the approval page offers once the wallet is connected. Public facts
 * (who launched a coin is on chain). Reads only, so it answers with own agents switched off too. 30 a minute per IP.
 */
export async function GET(req: NextRequest) {
  const limited = ownLimited(limiter, ipOf(req));
  if (limited) return limited;
  const creator = req.nextUrl.searchParams.get('creator') ?? '';
  if (!isAddress(creator, { strict: false })) return ownError('invalid_request', { field: 'creator', detail: 'creator must be a 0x address of 40 hex characters.' });
  if (env.useMock) return ownJson(mockOwn.coins(creator));
  return forwardOwn('GET', `/internal/own/connect/coins?creator=${getAddress(creator)}`);
}
