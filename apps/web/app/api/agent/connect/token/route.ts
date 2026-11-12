import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mockOwn } from '@/lib/mock-own';
import { askOwn, mintCredential, ownDisabled, ownError, ownJson, readOwnBody, SMALL_BODY_BYTES, tokenCodeLimited, tokenIpLimited } from '@/lib/server/own-agent';

/** A device code is 32 random bytes as text; anything far from that shape is not asked about. */
const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * POST /api/agent/connect/token {deviceCode} -> ConnectTokenResponse
 * The AI client's poll: `{status: 'pending'}` until the creator has approved on `/connect/<code>`, then, once, the
 * credential for that coin's agent. The same device code afterwards is `grant_used`. One call per polling interval per
 * code (`slow_down`), 60 a minute per IP, and the answer is never cached.
 */
export async function POST(req: NextRequest) {
  const off = ownDisabled();
  if (off) return off;
  const flooded = tokenIpLimited(req);
  if (flooded) return flooded;
  const body = await readOwnBody(req, SMALL_BODY_BYTES);
  if (body instanceof Response) return body;
  const deviceCode = body.deviceCode;
  if (typeof deviceCode !== 'string' || !DEVICE_CODE_RE.test(deviceCode)) return ownError('invalid_request', { field: 'deviceCode', detail: 'deviceCode is required: the one the start call answered with.' });
  const limited = await tokenCodeLimited(deviceCode);
  if (limited) return limited;
  if (env.useMock) {
    const token = mockOwn.token(deviceCode);
    return token.ok ? ownJson(token.data) : ownError(token.error);
  }
  // The credential is made here and only its SHA-256 goes to the agent service, which stores that and nothing else:
  // the credential is in this process for one answer and in no other. A poll that finds the grant still waiting
  // throws its credential away.
  const { credential, credentialHash } = await mintCredential();
  const answer = await askOwn('POST', '/internal/own/connect/token', { deviceCode, credentialHash });
  if (!answer.ok) return answer.response;
  const data = (answer.data ?? {}) as Record<string, unknown>;
  if (data.status !== 'approved') return ownJson({ status: 'pending' }, answer.status);
  // Whatever the service answered under `credential` is not relayed: the one credential is the one made here.
  return ownJson({ ...data, credential }, answer.status);
}
