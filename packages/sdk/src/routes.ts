/**
 * The public routes this client knows, by name. Only the method and the path template live here: the origin, the
 * parameters, the auth and the limits are read from `GET /api/catalog` at run time, so they cannot differ from the
 * deployment being called. `apps/web/app/api/catalog/route.test.ts` fails when a route here leaves the catalog.
 */
export const ROUTES = {
  platform: { method: 'GET', path: '/api/platform' },
  models: { method: 'GET', path: '/api/models' },
  agentPosts: { method: 'GET', path: '/api/agents/{id}/posts' },
  claim: { method: 'GET', path: '/api/agent/claim/{address}' },
  nonce: { method: 'POST', path: '/api/agent/nonce' },
  launch: { method: 'POST', path: '/api/agent/launch' },
  market: { method: 'GET', path: '/market/{token}' },
  treasury: { method: 'GET', path: '/treasury/{kernel}' },
  search: { method: 'GET', path: '/search' },
  coinFees: { method: 'GET', path: '/token/{id}/fees' },
  holdings: { method: 'GET', path: '/holdings/{owner}' },
  fuelHistory: { method: 'GET', path: '/fuel/{from}' },
  feed: { method: 'GET', path: '/platform/feed' },
  // Own agents (docs/design/byo-agent.md): listed by a deployment only while it offers them (`ownAgent` on `platform`).
  connectStart: { method: 'POST', path: '/api/agent/connect/start' },
  connectToken: { method: 'POST', path: '/api/agent/connect/token' },
  ownStatus: { method: 'POST', path: '/api/agent/run/status' },
  ownDue: { method: 'POST', path: '/api/agent/run/due' },
  ownTurn: { method: 'POST', path: '/api/agent/run/turn' },
  ownAct: { method: 'POST', path: '/api/agent/run/act' },
  ownFinish: { method: 'POST', path: '/api/agent/run/finish' },
  ownUpload: { method: 'POST', path: '/api/agent/run/upload' },
  ownDisconnect: { method: 'POST', path: '/api/agent/run/disconnect' },
} as const;

export type RouteName = keyof typeof ROUTES;

/** The `{name}` parameters of a path template. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}
