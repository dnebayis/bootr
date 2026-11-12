/**
 * Own agents (docs/design/byo-agent.md section 13.6): the supervisor's internal routes for connecting a creator's AI
 * client and for running a coin's agent from it. Like every `/internal/*` route they sit behind the HMAC of the shared
 * service key (api.ts mounts this directly after the middleware); the web app is the only caller and applies the rate
 * limits and body caps in front. What the web cannot be trusted with alone is decided here again: the credential of a
 * run call is verified in this process (`verifyCredential`: hash, revocation, expiry, coin, creator), and whether a
 * wallet is a coin's creator is read from the row this supervisor wrote from the launch.
 *
 * The flag (`OWN_AGENT_ENABLED`) is asked at the top of the connect and run handlers and nowhere else: with it off
 * they answer `own_agent_disabled` before anything is read. `grant` and `coins` only read and answer either way; the
 * two client routes never look at the flag, since disconnecting a client is never refused.
 *
 * No handler logs a body, a device code or a credential, and no error text carries one.
 */
import { PolicyError } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { SupervisorContext } from '../context.js';
import { agents } from '../db/schema.js';
import type { AuthEnv } from '../hmac.js';
import { rpcErrorText } from '../log.js';
import { OwnError, adoptDraftClients, approveGrant, coinsOf, countClients, disconnectClient, draftClients, grantView, listClients, ownErrorResponse, redeemGrant, revokeClients, startGrant, verifyCredential } from './clients.js';
import { applyRunnerQuota } from './quota.js';
import { ownEnabled, registerOwnRole, setOwnHooks } from './registry.js';
import { ownSocialRole } from './social.js';
import { actTurn, closeOwnTurn, closeTurnOfClients, finishTurn, openTurn, ownDue, ownStatus, uploadPicture } from './turns.js';

type C = Context<AuthEnv>;

export const RUN_OPS = ['status', 'due', 'turn', 'act', 'finish', 'upload', 'disconnect'] as const;
export type RunOp = (typeof RUN_OPS)[number];
/** An upload is a picture of at most 5 MB as base64 with its words; the web caps the public body at 8 MB. */
export const RUN_BODY_MAX_CHARS = 12 * 1024 * 1024;
/** Every other body of these routes is a few fields. */
export const SMALL_BODY_MAX_CHARS = 512 * 1024;

async function bodyOf(c: C, maxChars = SMALL_BODY_MAX_CHARS): Promise<Record<string, unknown>> {
  const raw = c.get('rawBody') ?? '';
  if (raw.length > maxChars) throw new OwnError('payload_too_large');
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    throw new OwnError('invalid_request', { detail: 'The body must be JSON.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OwnError('invalid_request', { detail: 'The body must be a JSON object.' });
  return body as Record<string, unknown>;
}

export function mountOwnRoutes(app: Hono<AuthEnv>, ctx: SupervisorContext): void {
  // The social role and the hooks the other parts of the supervisor call (own/registry.ts); registering again replaces.
  registerOwnRole(ownSocialRole);
  setOwnHooks({
    closeTurn: closeOwnTurn,
    applyRunnerQuota: (c, agentId, runner) => applyRunnerQuota(c, agentId, runner),
    adoptDraftClients: (c, agent) => adoptDraftClients(c, agent),
    countClients: (c, agentId) => countClients(c, agentId),
  });

  /** One answer shape for every route here: the response type, or an `OwnErrorBody` with the status of its code. */
  const answer = (fn: (c: C) => Promise<object>) => async (c: C) => {
    try {
      return c.json(await fn(c));
    } catch (err) {
      let own: OwnError;
      if (err instanceof OwnError) own = err;
      else if (err instanceof PolicyError && err.code === 'runtime_busy') own = new OwnError('runtime_busy', { retryAt: ctx.now() + 5_000 });
      else {
        // Never the body: only where it happened and what was thrown, with any RPC address scrubbed.
        ctx.log.error({ path: new URL(c.req.url).pathname, err: rpcErrorText(err) }, 'own agent: route failed');
        own = new OwnError('supervisor_unavailable');
      }
      const { status, body } = ownErrorResponse(own);
      return c.json(body, status as 400);
    }
  };
  const flagOn = () => {
    if (!ownEnabled(ctx)) throw new OwnError('own_agent_disabled');
  };

  // ---------------------------------------------------------------- connecting a client
  app.post(
    '/internal/own/connect/start',
    answer(async (c) => {
      flagOn();
      return startGrant(ctx, await bodyOf(c));
    }),
  );

  /** Reads only: answered with the flag off too, so an approval page opened earlier can say what became of its code. */
  app.get(
    '/internal/own/connect/grant',
    answer(async (c) => grantView(ctx, c.req.query('code'))),
  );

  app.post(
    '/internal/own/connect/approve',
    answer(async (c) => {
      flagOn();
      return approveGrant(ctx, await bodyOf(c));
    }),
  );

  app.post(
    '/internal/own/connect/token',
    answer(async (c) => {
      flagOn();
      return redeemGrant(ctx, (await bodyOf(c)).deviceCode);
    }),
  );

  /** Reads only: the coins a wallet launched, for the approval page. */
  app.get(
    '/internal/own/connect/coins',
    answer(async (c) => coinsOf(ctx, c.req.query('creator'))),
  );

  app.get(
    '/internal/own/drafts/:draftId/clients',
    answer(async (c) => {
      flagOn();
      return draftClients(ctx, c.req.param('draftId'));
    }),
  );

  // ---------------------------------------------------------------- running the agent
  app.post(
    '/internal/own/run/:op',
    answer(async (c) => {
      // The order of 13.6: the flag, the credential, the coin, then the route's own checks (in own/turns.ts).
      flagOn();
      const op = c.req.param('op') as RunOp;
      if (!(RUN_OPS as readonly string[]).includes(op)) throw new OwnError('invalid_request', { detail: 'No such operation.' });
      const { credential, ...request } = await bodyOf(c, op === 'upload' ? RUN_BODY_MAX_CHARS : SMALL_BODY_MAX_CHARS);
      const verified = await verifyCredential(ctx, credential);
      switch (op) {
        case 'status':
          return ownStatus(ctx, verified);
        case 'due':
          return ownDue(ctx, verified);
        case 'turn':
          return openTurn(ctx, verified, request);
        case 'act':
          return actTurn(ctx, verified, request);
        case 'finish':
          return finishTurn(ctx, verified, request);
        case 'upload':
          return uploadPicture(ctx, verified, request);
        case 'disconnect':
          await disconnectClient(ctx, verified.client);
          await closeTurnOfClients(ctx, verified.agent, [verified.client.id]);
          return { ok: true as const };
      }
    }),
  );

  // ---------------------------------------------------------------- the creator's console (never asks the flag)
  const agentOf = async (c: C) => {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, c.req.param('id') ?? '') });
    if (!agent) throw new OwnError('unknown_coin');
    return agent;
  };

  app.get(
    '/internal/agents/:id/clients',
    answer(async (c) => listClients(ctx, (await agentOf(c)).agentId)),
  );

  /** Body `{ by, clientId }` or `{ by, all: true }`; `by` is the address of the console's signed session and must be the coin's creator. */
  app.post(
    '/internal/agents/:id/clients/revoke',
    answer(async (c) => {
      const agent = await agentOf(c);
      const revoked = await revokeClients(ctx, agent, await bodyOf(c));
      // A revoked credential is refused on its next call; the turn it had open is closed now.
      await closeTurnOfClients(ctx, agent, revoked);
      return listClients(ctx, agent.agentId);
    }),
  );
}
