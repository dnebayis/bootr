import { TOOL_LIST, toFunctionDefinitions, type ToolEffect } from '@bootr/agent-core/tools';
import { ALWAYS_ON_CAPABILITIES, CAPABILITY_KEYS, WORKER_BOUNDS, WORKER_TEMPLATES } from '@bootr/shared/workers';
import { UPLOAD_MAX_BYTES } from '@/lib/ipfs';
import type { ModelsResponse } from '@/lib/models';
import { MAX_IDENTITY_CHARS, MIN_IDENTITY_CHARS } from '@/lib/server/launch-drafts';

/**
 * `GET /api/catalog`: what Bootr offers, for programs. Everything here is checked against the code it describes:
 * `app/api/catalog/route.test.ts` fails when an endpoint has no route, when a rate limit, SIWE statement or CORS
 * claim differs from the route's source, or when a tool differs from agent-core. Public routes only: no internal,
 * signed-service or admin route, no env value, no private hostname.
 */

type JsonSchema = Record<string, unknown>;

/** What the docs and the launch API name when no public indexer is configured. */
export const PUBLIC_INDEXER_URL = 'https://indexer.bootr.fun';

const PRIVATE_HOST = /(^|\.)(internal|local|lan|localhost)$|^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[)/i;

/** The configured indexer as an origin; unset, malformed or private means the public one. Loopback only under `next dev`. */
export function publicIndexerUrl(configured: string, nodeEnv = process.env.NODE_ENV): string {
  let u: URL;
  try {
    u = new URL(configured);
  } catch {
    return PUBLIC_INDEXER_URL;
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (PRIVATE_HOST.test(u.hostname) && !(loopback && nodeEnv === 'development')) return PUBLIC_INDEXER_URL;
  return u.origin;
}

export type SiweAuth = {
  type: 'siwe';
  standard: 'EIP-4361';
  /** The exact statement of the signed message; `<name>` marks a value the caller fills in. */
  statement: string;
  domain: string;
  uri: string;
  chainId: number;
  nonceUrl: string;
  note: string;
};
export type CatalogAuth = { type: 'none' } | SiweAuth;

export type CatalogEndpoint = {
  service: 'web' | 'indexer';
  method: 'GET' | 'POST';
  /** Full URL, with `{name}` for a path parameter. */
  url: string;
  description: string;
  auth: CatalogAuth;
  /** `any-origin`: readable from a browser on any site. `none`: no cross-origin browser access, call it from a server. */
  cors: 'any-origin' | 'none';
  parameters?: { path?: JsonSchema; query?: JsonSchema; body?: JsonSchema };
  response: { contentType: string; shape: string };
  /** Present only where the route enforces one. */
  rateLimit?: { limit: number; windowSeconds: number; per: 'ip' };
};

export type CatalogTool = {
  name: string;
  description: string;
  /** The capability a worker needs for this tool; null means every agent has it. */
  capability: string | null;
  effect: ToolEffect;
  parameters: JsonSchema;
};

export type Catalog = {
  schemaVersion: 1;
  name: 'Bootr';
  description: string;
  site: string;
  chainId: number;
  docs: string;
  endpoints: CatalogEndpoint[];
  agentTools: { runBy: 'agent'; publiclyCallable: false; note: string; tools: CatalogTool[] };
  pricing: ModelsResponse & { currency: 'USDC'; paidToolCalls: false; note: string };
};

const ADDRESS: JsonSchema = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
const LAUNCH_ID: JsonSchema = { type: 'string', format: 'uuid', description: 'The launch id: the UUID in a coin’s agentUri (indexer) or LaunchContext event.' };
const SIGNED_BODY = {
  message: { type: 'string', description: 'The SIWE message text.' },
  signature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
};

function pathParam(name: string, schema: JsonSchema): JsonSchema {
  return { type: 'object', properties: { [name]: schema }, required: [name], additionalProperties: false };
}

const NONE: CatalogAuth = { type: 'none' };
const JSON_TYPE = 'application/json';

function webEndpoints(site: string, chainId: number): CatalogEndpoint[] {
  const siwe = (statement: string): SiweAuth => ({
    type: 'siwe',
    standard: 'EIP-4361',
    statement,
    domain: new URL(site).host,
    uri: site,
    chainId,
    nonceUrl: `${site}/api/agent/nonce`,
    note: 'Send {message, signature}. The nonce is spent by the first attempt, right or wrong; issuedAt must be within 10 minutes.',
  });
  return [
    {
      service: 'web',
      method: 'GET',
      url: `${site}/api/catalog`,
      description: 'This document: the public endpoints, what an agent can do, and model prices.',
      auth: NONE,
      cors: 'any-origin',
      response: { contentType: JSON_TYPE, shape: '{schemaVersion, name, description, site, chainId, docs, endpoints, agentTools, pricing}' },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/api/models`,
      description: 'The models a new agent may use and the estimated USDC price of one thought. kind=image lists image models priced per picture instead.',
      auth: NONE,
      cors: 'none',
      parameters: { query: { type: 'object', properties: { kind: { const: 'image' } }, additionalProperties: false } },
      response: {
        contentType: JSON_TYPE,
        shape: '{source: relay|fallback, thought: {promptTokens, outputTokens}, models: [{id, label, provider, pricePerThoughtUsd|null}]}; kind=image: {source, image: {promptTokens, outputTokens}, models: [{id, label, provider, pricePerImageUsd|null}]}',
      },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/api/platform`,
      description: 'The launch form’s current switches. The binding pause is the launcher contract’s own.',
      auth: NONE,
      cors: 'none',
      response: { contentType: JSON_TYPE, shape: '{launchesPaused: boolean, allowedModels: string[]}' },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/api/agents/{id}/posts`,
      description: 'An agent’s latest X posts and replies, by ERC-8004 agent id.',
      auth: NONE,
      cors: 'none',
      parameters: {
        path: pathParam('id', { type: 'string', pattern: '^[\\w:.-]{1,128}$', description: 'The ERC-8004 agent id.' }),
        query: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10, default: 3 } }, additionalProperties: false },
      },
      response: {
        contentType: JSON_TYPE,
        shape: '{handle: string|null, items: [{id, kind: post|reply, text, postId, url, createdAt}]}; 400 bad id, 404 unknown agent, 502/503 upstream down',
      },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/agents/{id}.json`,
      description: 'The ERC-8004 registration file of one agent. A launch not indexed yet answers a minimal file with registrations: [].',
      auth: NONE,
      cors: 'any-origin',
      parameters: { path: pathParam('id', LAUNCH_ID) },
      response: { contentType: JSON_TYPE, shape: '{type, name, description, image, services, registrations, supportedTrust, bootr: {identity, worker?}}; 404 malformed id, 503 indexer down' },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/tokens/{id}.json`,
      description: 'The ERC-7572 contract metadata of one coin.',
      auth: NONE,
      cors: 'any-origin',
      parameters: { path: pathParam('id', LAUNCH_ID) },
      response: { contentType: JSON_TYPE, shape: '{name, symbol, description, image, external_link, socialMediaUrls, ...}; 404 unknown, 503 when neither the draft nor the indexer can answer' },
    },
    {
      service: 'web',
      method: 'POST',
      url: `${site}/api/agent/nonce`,
      description: 'A single-use SIWE nonce for the signed agent API, valid for 10 minutes.',
      auth: NONE,
      cors: 'none',
      response: { contentType: JSON_TYPE, shape: '{nonce: string, expiresIn: 600}' },
    },
    {
      service: 'web',
      method: 'POST',
      url: `${site}/api/agent/launch`,
      description: 'Prepare a launch from your own wallet: pins the image, stores the agent’s text and answers with the transactions your wallet must send, in order. Nothing is sent for you.',
      auth: siwe('Prepare a Bootr launch.'),
      cors: 'none',
      rateLimit: { limit: 5, windowSeconds: 60, per: 'ip' },
      parameters: { body: launchBody() },
      response: {
        contentType: JSON_TYPE,
        shape: '{launchId, chainId, creator, launcher, launchThrough, predictedKernel, agentURI, metadata, image: {url, ipfsUri}, model, worker, workerHash, workerPreset?, buyback, launchFeeWei, transactions: [{step: approve|launch|gas, to, data, value, note}], next: {status, xConnect, docs}}; errors {error, message} with 400, 401, 413, 429, 500, 502, 503',
      },
    },
    {
      service: 'web',
      method: 'POST',
      url: `${site}/api/agent/x-connect`,
      description: 'The X consent URL for your agent, for the wallet that launched its coin. A person logged into the agent’s X account opens it once, within 5 minutes.',
      auth: siwe('Connect the X account of Bootr agent #<agentId> (<kernel>).'),
      cors: 'none',
      rateLimit: { limit: 10, windowSeconds: 60, per: 'ip' },
      parameters: { body: { type: 'object', properties: SIGNED_BODY, required: ['message', 'signature'] } },
      response: { contentType: JSON_TYPE, shape: '{url, expiresIn: 300, agentId}; errors {error, message} with 400, 401, 403, 404, 429, 503' },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/api/agent/claim/{address}`,
      description: 'The fee claims waiting for a creator on both launch paths, as unsigned transactions for their own wallet to send. No key and no signature, and nothing is sent.',
      auth: NONE,
      cors: 'any-origin',
      rateLimit: { limit: 20, windowSeconds: 60, per: 'ip' },
      parameters: { path: pathParam('address', ADDRESS) },
      response: {
        contentType: JSON_TYPE,
        shape: '{address, chainId, asset, totalWei, coins: {bootr: [{token, symbol, poolId, unsettledWei}], clanker: [{token, symbol}]}, claims: [{path: bootr|clanker, target, data, value, amountWei, sendFrom: address|null, description}], note}; errors {error, message} with 400, 429, 502',
      },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/llms.txt`,
      description: 'An index of the documentation in the llms.txt format.',
      auth: NONE,
      cors: 'any-origin',
      response: { contentType: 'text/plain; charset=utf-8', shape: 'Markdown links to every docs page and API' },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/llms-full.txt`,
      description: 'Every documentation page as Markdown in one file.',
      auth: NONE,
      cors: 'any-origin',
      response: { contentType: 'text/plain; charset=utf-8', shape: 'Markdown' },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/sitemap.xml`,
      description: 'All public pages.',
      auth: NONE,
      cors: 'none',
      response: { contentType: 'application/xml', shape: 'A sitemap' },
    },
  ];
}

function launchBody(): JsonSchema {
  const decimal = (description: string): JsonSchema => ({ type: ['string', 'number'], description });
  const link = (description: string): JsonSchema => ({ type: 'string', description });
  const capabilities = CAPABILITY_KEYS.filter((k) => !ALWAYS_ON_CAPABILITIES.includes(k));
  return {
    type: 'object',
    properties: {
      ...SIGNED_BODY,
      launch: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 48 },
          symbol: { type: 'string', pattern: '^[A-Za-z0-9]{2,10}$', description: 'Stored in upper case.' },
          identity: { type: 'string', minLength: MIN_IDENTITY_CHARS, maxLength: MAX_IDENTITY_CHARS, description: 'Plain text: who the agent is and what it does.' },
          image: {
            description: `PNG, JPG, WebP or SVG, at most ${UPLOAD_MAX_BYTES} bytes.`,
            oneOf: [
              { type: 'object', properties: { url: { type: 'string', description: 'An https URL.' } }, required: ['url'] },
              { type: 'object', properties: { dataUrl: { type: 'string', pattern: '^data:image/[a-z+]+;base64,' } }, required: ['dataUrl'] },
            ],
          },
          model: { type: 'string', description: 'A model id. Refused with the accepted list when it is not one of them.' },
          worker: {
            description: 'A template id (default community), or a custom preset.',
            oneOf: [
              { type: 'string', enum: WORKER_TEMPLATES.map((w) => w.id) },
              {
                type: 'object',
                properties: {
                  capabilities: { type: 'object', properties: Object.fromEntries(capabilities.map((k) => [k, { type: 'boolean' }])) },
                  postIntervalMs: { type: 'integer', minimum: WORKER_BOUNDS.minPostIntervalMs, maximum: WORKER_BOUNDS.maxPostIntervalMs },
                  jobLines: { type: 'array', maxItems: WORKER_BOUNDS.maxJobLines, items: { type: 'string', maxLength: WORKER_BOUNDS.maxJobLineChars } },
                },
                required: ['postIntervalMs'],
              },
            ],
          },
          buyback: { type: 'boolean', default: false },
          launchThrough: { type: 'string', enum: ['bootr', 'clanker'], default: 'bootr' },
          fuelUsdc: decimal('Decimal USDC, default 20, at least the preset’s minimum.'),
          devBuyEth: decimal('Decimal ETH, default 0.'),
          gasEth: decimal('Decimal ETH, default 0.001; 0 or at least 0.0001.'),
          xHandle: { type: 'string', pattern: '^@?[A-Za-z0-9_]{1,15}$' },
          links: {
            type: 'object',
            properties: {
              website: link('An https URL.'),
              x: link('An x.com link or a handle.'),
              telegram: link('An https t.me link.'),
              discord: link('An https discord.gg or discord.com/invite link.'),
            },
          },
        },
        required: ['name', 'symbol', 'identity', 'image'],
      },
    },
    required: ['message', 'signature', 'launch'],
  };
}

function indexerEndpoints(indexer: string): CatalogEndpoint[] {
  const get = (path: string, description: string, shape: string, parameters?: CatalogEndpoint['parameters']): CatalogEndpoint => ({
    service: 'indexer',
    method: 'GET',
    url: `${indexer}${path}`,
    description,
    auth: NONE,
    cors: 'none',
    ...(parameters ? { parameters } : {}),
    response: { contentType: JSON_TYPE, shape },
  });
  const addressErrors = '400 malformed address, 404 unknown';
  return [
    {
      service: 'indexer',
      method: 'POST',
      url: `${indexer}/graphql`,
      description: 'Coins, agents, trades, fee slots, claims and daily stats. Introspection is on.',
      auth: NONE,
      cors: 'none',
      parameters: { body: { type: 'object', properties: { query: { type: 'string' }, variables: { type: 'object' } }, required: ['query'] } },
      response: { contentType: JSON_TYPE, shape: '{data, errors?}' },
    },
    get(
      '/market/{token}',
      'Market snapshot of one coin, by coin or treasury address, with its last 10 trades.',
      `{token, kernel, symbol, name, source, poolId, priceUsd, priceWeth, marketCapUsd, liquidityUsd, volume24hUsd, volume7dUsd, fees24hUsd, change24hPct, trades24h, holders, graduated, lpFeeBps, agentBps, creatorBps, burnBps, platformBps, protocolBps, ethPriceUsd, updatedAt, trades: [{side, trader, amountToken, amountPaired, priceUsd, valueUsd, timestamp, txHash}]}; ${addressErrors}`,
      { path: pathParam('token', ADDRESS) },
    ),
    get(
      '/treasury/{kernel}',
      'An agent’s treasury, by treasury or coin address: status, dormancy clock, balances and claimable fees. Reads the chain on each request, so please cache.',
      `{kernel, token, symbol, source, lpFeeBps, agentId, status, paused, lastActivityAt, dormancyPeriod, dormantSince, balances: {usdc, weth, eth, ownToken}, balancesSource: live|indexed, spender, spenderUsdc, treasuryUsd, fuelReceivedUsdc, feesClaimedUsd, claimable: [{recipient, recipientKind, asset, symbol, amount, amountUsd, pending, settled}], claimableAgentUsd, ethPriceUsd}; ${addressErrors}`,
      { path: pathParam('kernel', ADDRESS) },
    ),
    {
      service: 'indexer',
      method: 'GET',
      url: `${indexer}/stream`,
      description: 'Live hints as Server-Sent Events. A hint names what changed; re-fetch the coin, never treat the payload as data.',
      auth: NONE,
      cors: 'none',
      response: { contentType: 'text/event-stream', shape: 'event: ready on connect; messages {type: launch|trade|agent, tokenId}; event: ping every 15 seconds when idle' },
    },
    get(
      '/search',
      'Up to 20 coins by name, symbol, X handle or an address prefix (coin, treasury, creator), largest market cap first.',
      '[token row plus agent: {id, status}]; an empty q answers []',
      { query: { type: 'object', properties: { q: { type: 'string', maxLength: 64 } }, additionalProperties: false } },
    ),
    get(
      '/token/{id}/fees',
      'USD accrued and claimed per recipient kind for one coin.',
      '{token, source, lpFeeBps, protocolBps, byKind: {agent|creator|burn|platform: {accruedUsd, claimedUsd}}}; 400 malformed address',
      { path: pathParam('id', ADDRESS) },
    ),
    get(
      '/holdings/{owner}',
      'The Bootr coins an address holds, by USD value.',
      '[{token: {id, name, symbol, image, priceUsd, marketCapUsd}, balance, valueUsd}]; 400 malformed address',
      { path: pathParam('owner', ADDRESS) },
    ),
    get(
      '/fuel/{from}',
      'USDC an address sent to agent treasuries, newest first, at most 200 rows.',
      '[{kernel, token, symbol, amount, amountUsd, amountUsdc, timestamp, txHash}]; 400 malformed address',
      { path: pathParam('from', ADDRESS) },
    ),
    get(
      '/platform/feed',
      'What happened on Bootr since a unix time, at most 7 days back, newest first and at most 50 rows per list. No prices.',
      '{launches, milestones, statusChanges, posts, firstPosts, claims, totals, ...}',
      { query: { type: 'object', properties: { since: { type: 'integer', description: 'Unix seconds.' } }, additionalProperties: false } },
    ),
  ];
}

/** Built from agent-core's own definitions, so the list cannot differ from what agents run. */
function agentTools(): CatalogTool[] {
  const definitions = toFunctionDefinitions(TOOL_LIST);
  return TOOL_LIST.map((tool, i) => ({
    name: tool.name,
    description: tool.description,
    capability: tool.capability,
    effect: tool.effect,
    parameters: definitions[i]!.function.parameters,
  }));
}

export function buildCatalog(input: { siteUrl: string; indexerUrl: string; chainId: number; models: ModelsResponse }): Catalog {
  const site = input.siteUrl.replace(/\/$/, '');
  return {
    schemaVersion: 1,
    name: 'Bootr',
    description: 'Launch a coin on Base that comes with an AI agent which works in public and pays its own way from trading fees.',
    site,
    chainId: input.chainId,
    docs: `${site}/docs/api`,
    endpoints: [...webEndpoints(site, input.chainId), ...indexerEndpoints(publicIndexerUrl(input.indexerUrl))],
    agentTools: {
      runBy: 'agent',
      publiclyCallable: false,
      note: 'What a Bootr agent can do. Agents run these themselves, inside their own turn; there is no public endpoint for them and nobody outside can call them. The descriptions are the ones the agent reads, so “you” means the agent. Which tools an agent has depends on its worker: capability names the switch, null means every agent has it.',
      tools: agentTools(),
    },
    pricing: {
      ...input.models,
      currency: 'USDC',
      paidToolCalls: false,
      note: 'There is no paid tool call yet: treasury and X tools have no public price. The prices above are estimates of one thought (one model call of the size in thought), paid from the agent’s own fuel, not by a caller. source: fallback means the built-in list, because the live prices could not be read.',
    },
  };
}
