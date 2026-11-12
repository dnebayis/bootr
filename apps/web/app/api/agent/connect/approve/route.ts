import { CONNECT_COIN_STATEMENT, CONNECT_DRAFT_STATEMENT, USER_CODE_RE } from '@bootr/shared/own-agent';
import { type NextRequest } from 'next/server';
import { SiweMessage } from 'siwe';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mockOwn } from '@/lib/mock-own';
import { cleanLabel, readConnectStatement } from '@/lib/own-agent';
import { isAllowedOrigin } from '@/lib/server/env';
import { RateLimiter } from '@/lib/server/ipfs';
import { forwardOwn, ipOf, ownDisabled, ownError, ownJson, ownLimited, readOwnBody, SMALL_BODY_BYTES } from '@/lib/server/own-agent';
import { verifySiwe } from '@/lib/server/siwe-verify';

const limiter = new RateLimiter(10, 60_000);
/** Either statement of docs/design/byo-agent.md section 13.3: for a coin, or for this browser's next launch. */
const STATEMENT = new RegExp(`${CONNECT_COIN_STATEMENT.source}|${CONNECT_DRAFT_STATEMENT.source}`);

function sameHost(origin: string, host: string | null): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * POST /api/agent/connect/approve {userCode, message, signature, label?} -> ConnectApproveResponse
 * The creator's approval from `/connect/<code>`: a SIWE message (nonce from `POST /api/agent/nonce`) whose statement
 * names the coin, or the draft of this browser's next launch, and the code on the creator's screen. This route checks
 * the signature, the nonce, the statement and that its code is the request's code; the address the signature recovers
 * to goes to the agent service, which is the one that says whether that wallet launched the coin. The answer holds no
 * credential: the AI client collects its own. Same origin only, 10 a minute per IP.
 */
export async function POST(req: NextRequest) {
  const off = ownDisabled();
  if (off) return off;
  const origin = req.headers.get('origin');
  if (!origin || !(isAllowedOrigin(origin) || sameHost(origin, req.headers.get('host')))) return ownError('invalid_request', { detail: 'An approval is sent by the Bootr site itself, from the page that shows the code.' });
  const limited = ownLimited(limiter, ipOf(req));
  if (limited) return limited;
  const body = await readOwnBody(req, SMALL_BODY_BYTES);
  if (body instanceof Response) return body;
  const userCode = body.userCode;
  if (typeof userCode !== 'string' || !USER_CODE_RE.test(userCode)) return ownError('invalid_request', { field: 'userCode', detail: 'userCode must be the code the AI client shows, like BCDF-GHJK.' });
  if (body.label !== undefined && typeof body.label !== 'string') return ownError('invalid_request', { field: 'label', detail: 'label must be text.' });
  const label = typeof body.label === 'string' ? cleanLabel(body.label.replace(/\p{C}+/gu, ' ')) : undefined;

  if (env.useMock) {
    // Nothing is signed in mock mode: the message is read for what it says and everyone is the creator.
    let parsed: SiweMessage;
    try {
      parsed = new SiweMessage(String(body.message ?? ''));
    } catch {
      return ownError('siwe_rejected');
    }
    const said = readConnectStatement(parsed.statement ?? '');
    if (!said || said.userCode !== userCode || !isAddress(parsed.address)) return ownError('siwe_rejected');
    const approved = mockOwn.approve({ userCode, creator: parsed.address, label, target: said.target });
    return approved.ok ? ownJson(approved.data) : ownError(approved.error);
  }

  const v = await verifySiwe(body, { statement: STATEMENT });
  if (!v.ok) return ownError('siwe_rejected');
  const said = readConnectStatement(v.msg.statement ?? '');
  // A signature for another code approves nothing here, whatever the request says its code is.
  if (!said || said.userCode !== userCode) return ownError('siwe_rejected');
  return forwardOwn('POST', '/internal/own/connect/approve', { userCode, creator: v.address, ...(label ? { label } : {}), target: said.target });
}
