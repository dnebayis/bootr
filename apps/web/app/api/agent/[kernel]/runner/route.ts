import { type NextRequest } from 'next/server';
import { OWN_ERRORS } from '@bootr/shared/own-agent';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { filterAllowedModels } from '@/lib/models';
import { readConfig } from '@/lib/server/admin-config';
import { relayModels } from '@/lib/server/relay-models';
import { getAgentConfig, parseRunnerSwitch, switchAgentRunner } from '@/lib/server/supervisor';
import { authorizeReview, fail, ok, readBody, relay } from '../approvals/review';

/**
 * POST /api/agent/:kernel/runner {message, signature | token, runner: 'hosted' | 'own', model?} -> {runner, revision, notes, token}
 * The creator moves the coin's agent between "My own agent" (it thinks in the creator's own AI client) and "Bootr
 * agent" (Bootr runs it, paid from fuel). Inside the console's signed session, like the inbox and the chat. Nothing
 * changes on chain and nothing is signed beyond the session: the agent service changes one stored value, after the
 * step in progress has finished. `model` is the model the Bootr agent should think with; it is needed only when the
 * stored one is no longer offered (`model_required`), and must be one of `GET /api/models` (`model_not_allowed`).
 * While own agents are switched off on the deployment a switch to `own` answers `own_agent_disabled` and a switch to
 * `hosted` works as always: the agent service decides both. `runner_unchanged` when the agent is already run that way,
 * `settings_changed` when the settings were changed between this route's read of them and the switch.
 * Errors are the own-agent error body `{error, message}` (docs/design/byo-agent.md section 13.3).
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/agent/[kernel]/runner'>) {
  const { kernel } = await ctx.params;
  const body = await readBody<{ message?: unknown; signature?: unknown; token?: unknown; runner?: unknown; model?: unknown }>(req);
  if (body instanceof Response) return body;
  const change = parseRunnerSwitch(body);
  if (!change) return fail(OWN_ERRORS.invalid_request.status, 'invalid_request', `${OWN_ERRORS.invalid_request.message} runner must be hosted or own; model, when sent, is a model id.`);
  const auth = await authorizeReview(req, kernel, body);
  if (!auth.ok) return auth.response;
  if (env.useMock) {
    // Mock mode has no agent service: the mock store stands in for it and, like the rest of mock mode, asks nobody.
    const r = mock.switchRunner(kernel, change, auth.address);
    if (!r.ok) return fail(OWN_ERRORS[r.error].status, r.error, OWN_ERRORS[r.error].message);
    return ok({ ...r.response, token: auth.token });
  }
  try {
    // The same list as GET /api/models: the catalog under the admin allow-list. Only a switch to the Bootr agent needs it.
    const allowedModels = change.runner === 'hosted' ? filterAllowedModels((await relayModels()).models, (await readConfig()).allowedModels).map((m) => m.id) : [];
    // The revision of the settings as they are stored now goes with the request: the agent service refuses a switch
    // whose revision is no longer the stored one (`settings_changed`), so a copy of this request sent again does nothing.
    const stored = await getAgentConfig(auth.agentId);
    if (!stored) return fail(OWN_ERRORS.unknown_coin.status, 'unknown_coin', OWN_ERRORS.unknown_coin.message);
    return ok({ ...(await switchAgentRunner(auth.agentId, { ...change, by: auth.address, allowedModels, expectedRevision: stored.revision })), token: auth.token });
  } catch (err) {
    return relay(err);
  }
}
