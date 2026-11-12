/**
 * Own agents (docs/design/byo-agent.md section 13.6): `POST /internal/agents/:id/runner`, the creator's switch between
 * "My own agent" and "Bootr agent". Behind the HMAC of every `/internal/*` route; the web checks the console session
 * and passes the signer as `by`. The route never looks at the flag: `switchRunner` does, for the one direction it
 * guards (a switch to own), so a switch to the Bootr agent keeps working while the feature is off.
 */
import type { Hono } from 'hono';
import { OWN_ERRORS } from '@bootr/shared/own-agent';
import { eq } from 'drizzle-orm';
import type { SupervisorContext } from '../context.js';
import { agents } from '../db/schema.js';
import type { AuthEnv } from '../hmac.js';
import { switchRunner, type RunnerSwitchInput } from './runner-switch.js';

export function mountRunnerRoutes(app: Hono<AuthEnv>, ctx: SupervisorContext): void {
  /** Body `RunnerSwitchRequest` and `{by, allowedModels}`; answers `RunnerSwitchResponse` or an `OwnErrorBody`. */
  app.post('/internal/agents/:id/runner', async (c) => {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, c.req.param('id')) });
    if (!agent) return c.json({ error: 'unknown_coin', message: OWN_ERRORS.unknown_coin.message }, 404);
    const body = (await c.req.json().catch(() => null)) as RunnerSwitchInput | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_request', message: `${OWN_ERRORS.invalid_request.message} A JSON object is expected.` }, 400);
    const result = await switchRunner(ctx, agent, body);
    if (!result.ok) return c.json(result.body, result.status as 400);
    return c.json(result.response);
  });
}
