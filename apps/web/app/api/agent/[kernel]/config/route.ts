import { NextResponse, type NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { readConfig } from '@/lib/server/admin-config';
import { isAllowedOrigin } from '@/lib/server/env';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { creatorRefusal, kernelMessage, NEW_NONCE, originRefusal, otherCoinMessage, rateLimitMessage, readJsonObject, unknownCoinMessage } from '@/lib/server/refusals';
import { fetchTokenCreator } from '@/lib/server/sender';
import { verifySiwe } from '@/lib/server/siwe-verify';
import { getAgentConfig, putAgentConfig, SupervisorError, SupervisorUnavailable, validateChanges } from '@/lib/server/supervisor';

const NO_STORE = { 'Cache-Control': 'no-store' };
const limiter = new RateLimiter(10, 60_000);

/** The statement the creator console asks the creator to sign; the agent id and the kernel are read back from it. */
export const CONFIG_STATEMENT = /^Update the agent of Bootr coin \$([A-Za-z0-9_]{1,16}) \(#(\d{1,20}), (0x[0-9a-fA-F]{40})\)\.$/;

function fail(status: number, error: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
}

function sameHost(origin: string, host: string | null): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * GET /api/agent/:kernel/config -> AgentConfig (lib/types)
 * Public read of the agent's current configuration (instructions, powers, cadence, model, revision), proxied to the
 * supervisor with the web's SUPERVISOR_SERVICE_KEY. The kernel is resolved to its ERC-8004 agent id through the
 * indexer. 404 when the coin or its agent is unknown, 503 when the supervisor is not configured or down.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/config'>) {
  const { kernel } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', kernelMessage(kernel), { field: 'kernel' });
  if (env.useMock) return NextResponse.json(mock.agentConfig(kernel), { headers: NO_STORE });
  try {
    const token = await fetchTokenCreator(kernel);
    if (!token) return fail(404, 'unknown_coin', unknownCoinMessage(kernel));
    const config = await getAgentConfig(token.agentId);
    if (!config) return fail(404, 'unknown_agent', UNKNOWN_AGENT(token.agentId));
    return NextResponse.json(config, { headers: NO_STORE });
  } catch (err) {
    return relay(err);
  }
}

/**
 * POST /api/agent/:kernel/config {message, signature, changes} -> AgentConfig
 * The creator edits the agent from the coin page: a SIWE message whose statement is
 * `Update the agent of Bootr coin $SYMBOL (#agentId, kernel).` (nonce from `POST /api/agent/nonce`, single use),
 * the indexer confirms the signer created the coin, and the supervisor applies `changes` with `by = signer` and
 * the admin model allow-list. Same-origin only; 10 requests per minute per IP. In mock mode the signature is not
 * checked and the mock store is updated.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/config'>) {
  const origin = req.headers.get('origin');
  if (!origin || !(isAllowedOrigin(origin) || sameHost(origin, req.headers.get('host')))) return fail(403, 'forbidden', originRefusal(origin));
  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) return fail(429, 'rate_limited', rateLimitMessage(10, retryAfter), {}, { 'Retry-After': String(retryAfter) });
  const { kernel } = await ctx.params;
  if (!isAddress(kernel, { strict: false })) return fail(400, 'invalid_request', kernelMessage(kernel), { field: 'kernel' });
  if (Number(req.headers.get('content-length') ?? 0) > 16_384) return fail(413, 'payload_too_large', 'Body must be at most 16 KB: {message, signature, changes}.');
  const body = await readJsonObject<{ message?: unknown; signature?: unknown; changes?: unknown }>(req);
  if (!body) return fail(400, 'invalid_json', 'Body must be a JSON object: {message, signature, changes}.');
  const changes = validateChanges(body.changes);
  if (!changes.ok) return fail(400, 'invalid_request', changes.message, { field: changes.field });

  if (env.useMock) {
    const by = typeof body.message === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.message) ? body.message : '0x00000000000000000000000000000000000e2e01';
    const r = mock.updateAgentConfig(kernel, changes.changes, by);
    if (!r.ok) return fail(r.status, r.error, r.message);
    return NextResponse.json(r.config, { headers: NO_STORE });
  }

  const v = await verifySiwe(body, { statement: CONFIG_STATEMENT, statementText: 'Update the agent of Bootr coin $<SYMBOL> (#<agentId>, <kernel>).' });
  if (!v.ok) return fail(v.status, 'siwe_rejected', v.error, { reason: v.reason });
  const [, , agentId, statementKernel] = CONFIG_STATEMENT.exec(v.msg.statement ?? '')!;
  if (statementKernel!.toLowerCase() !== kernel.toLowerCase()) return fail(400, 'invalid_request', otherCoinMessage(statementKernel!, kernel), { field: 'statement' });
  try {
    const token = await fetchTokenCreator(kernel);
    if (!token) return fail(404, 'unknown_coin', `${unknownCoinMessage(kernel)} ${NEW_NONCE}`);
    if (token.agentId !== agentId || token.creator.toLowerCase() !== v.address.toLowerCase()) {
      return fail(403, 'not_creator', creatorRefusal('change its agent', v.address, token, agentId!));
    }
    const { allowedModels } = await readConfig();
    const config = await putAgentConfig(agentId, { ...changes.changes, by: v.address, allowedModels });
    return NextResponse.json(config, { headers: NO_STORE });
  } catch (err) {
    return relay(err);
  }
}

function UNKNOWN_AGENT(agentId: string): string {
  return `The agent service does not know agent #${agentId} yet: it picks up a new launch shortly after it is indexed, so retry in a few minutes.`;
}

function relay(err: unknown) {
  // The service answers some refusals with a bare code; repeat it as a sentence.
  if (err instanceof SupervisorError) return fail(err.status, err.code, err.message === err.code ? `The agent service refused this with ${err.code} (HTTP ${err.status}). Check the agent and retry in a few minutes.` : err.message);
  if (err instanceof SupervisorUnavailable) return fail(503, 'supervisor_unavailable', 'The agent service is unavailable right now. Try again in a moment.');
  console.warn('agent config: failed', (err as Error).message);
  return fail(502, 'upstream_failed', 'Could not reach the indexer. Try again in a moment.');
}
