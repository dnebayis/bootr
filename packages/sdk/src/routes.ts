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
} as const;

export type RouteName = keyof typeof ROUTES;

/** The `{name}` parameters of a path template. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}
