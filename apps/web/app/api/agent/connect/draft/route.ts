import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mockOwn } from '@/lib/mock-own';
import { isDraftUuid } from '@/lib/own-agent';
import { RateLimiter } from '@/lib/server/ipfs';
import { forwardOwn, ipOf, ownDisabled, ownError, ownJson, ownLimited } from '@/lib/server/own-agent';

const limiter = new RateLimiter(30, 60_000);

/**
 * GET /api/agent/connect/draft?draft=<uuid> -> DraftClientsResponse
 * Whether an AI client has been approved for a launch that has not happened yet: the launch page polls it while the
 * creator connects their client. The draft id is known only to the browser that holds the draft. 30 a minute per IP.
 */
export async function GET(req: NextRequest) {
  const off = ownDisabled();
  if (off) return off;
  const limited = ownLimited(limiter, ipOf(req));
  if (limited) return limited;
  const draft = req.nextUrl.searchParams.get('draft') ?? '';
  if (!isDraftUuid(draft)) return ownError('invalid_request', { field: 'draft', detail: 'draft must be the id of a launch draft.' });
  if (env.useMock) return ownJson(mockOwn.draft(draft));
  return forwardOwn('GET', `/internal/own/drafts/${draft}/clients`);
}
