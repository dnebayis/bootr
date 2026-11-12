/**
 * The own-agent routes in `GET /api/catalog` (docs/design/byo-agent.md sections 5.4 and 13.6): the connect and run
 * routes with their auth and limits, listed only while own agents are switched on, so with the flag off the catalog is
 * what it was. The SDK reads its URLs from here and the MCP server reads the flag from `GET /api/platform`.
 * `catalog-own.test.ts` checks each claim against the route it describes.
 *
 * The run routes are the first on this site to take a bearer credential and limits counted per client, which the
 * catalog's types did not have: the two extra shapes are declared here.
 */
import { CLIENT_LABEL_MAX, connectCoinStatement, connectDraftStatement, DEVICE_POLL_INTERVAL_S, OWN_ROLES, PICTURE_DESCRIPTION_MAX, PICTURE_MIMES } from '@bootr/shared/own-agent';
import type { CatalogEndpoint, SiweAuth } from '@/lib/server/catalog';
import { ownAgentEnabled } from '@/lib/server/env';

type JsonSchema = Record<string, unknown>;

/** `Authorization: Bearer <credential>`: what a connected AI client sends. */
export type BearerAuth = { type: 'bearer'; scheme: 'Bearer'; credential: string; note: string };
export type OwnRateLimit = { limit: number; windowSeconds: number; per: 'ip' | 'client' | 'device-code' };
export type OwnCatalogEndpoint = Omit<CatalogEndpoint, 'auth' | 'rateLimit'> & { auth: CatalogEndpoint['auth'] | BearerAuth; rateLimit?: OwnRateLimit };

const JSON_TYPE = 'application/json';
const ERRORS = 'An error is {error, message, retryAt?, field?} with a stable error code.';
const TURN_ID: JsonSchema = { type: 'string', pattern: '^otn_[0-9a-f]{32}$', description: 'The open turn, from POST /api/agent/run/turn.' };
const EMPTY_BODY: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
const perIp = (limit: number): OwnRateLimit => ({ limit, windowSeconds: 60, per: 'ip' });

/** The endpoints, whatever the flag says: `ownAgentEndpoints` is what the catalog spreads. */
export function ownAgentEndpointList(site: string, chainId: number): OwnCatalogEndpoint[] {
  const bearer: BearerAuth = {
    type: 'bearer',
    scheme: 'Bearer',
    credential: 'bootr_agt_ and 43 characters, handed to the AI client once by POST /api/agent/connect/token',
    note: 'For one coin and its agent-run routes only. Send no Origin header: a request from a web page is refused. Never put the credential in a URL, a tool argument or a log.',
  };
  const approval: SiweAuth = {
    type: 'siwe',
    standard: 'EIP-4361',
    statement: connectCoinStatement('<symbol>', '<agentId>', '<kernel>', '<code>'),
    domain: new URL(site).host,
    uri: site,
    chainId,
    nonceUrl: `${site}/api/agent/nonce`,
    note: `Signed in the browser by the wallet that launched the coin, on ${site}/connect/<code>. For a launch that has not happened yet the statement is "${connectDraftStatement('<draft>', '<code>')}". The nonce is spent by the first attempt, right or wrong; issuedAt must be within 10 minutes.`,
  };
  const run = (op: string, description: string, body: JsonSchema, shape: string): OwnCatalogEndpoint => ({
    service: 'web',
    method: 'POST',
    url: `${site}/api/agent/run/${op}`,
    description,
    auth: bearer,
    cors: 'none',
    parameters: { body },
    response: { contentType: JSON_TYPE, shape: `${shape}. ${ERRORS}` },
    rateLimit: { limit: 120, windowSeconds: 60, per: 'client' },
  });
  return [
    {
      service: 'web',
      method: 'POST',
      url: `${site}/api/agent/connect/start`,
      description: 'An AI client asks to be connected to a coin’s agent. The answer carries a device code for the client alone and a short code with a link, where the coin’s creator approves with a wallet signature. Nothing is connected by this call.',
      auth: { type: 'none' },
      cors: 'none',
      parameters: {
        body: {
          type: 'object',
          properties: {
            clientName: { type: 'string', maxLength: CLIENT_LABEL_MAX, description: 'What the client calls itself, shown on the approval page.' },
            coin: { type: 'string', maxLength: 64, description: 'A coin the user named (symbol, coin or treasury address), offered first on the approval page. Never trusted.' },
          },
          additionalProperties: false,
        },
      },
      response: { contentType: JSON_TYPE, shape: `{deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval}; deviceCode is a secret for the token route only. ${ERRORS}` },
      rateLimit: perIp(5),
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/api/agent/connect/grant`,
      description: 'What the approval page shows about a connection request: the client’s name, the coin it named and whether the request is still waiting. The code is not a secret.',
      auth: { type: 'none' },
      cors: 'none',
      parameters: { query: { type: 'object', properties: { code: { type: 'string', pattern: '^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$' } }, required: ['code'], additionalProperties: false } },
      response: { contentType: JSON_TYPE, shape: `{userCode, clientName, coinHint|null, status: pending|approved|redeemed|expired, expiresAt}. ${ERRORS}` },
      rateLimit: perIp(30),
    },
    {
      service: 'web',
      method: 'POST',
      url: `${site}/api/agent/connect/approve`,
      description: 'The creator’s approval of a connection request, sent by the approval page: a signed message that names the coin (or the draft of the creator’s next launch) and the code on the creator’s screen. Only the wallet that launched the coin can approve. The answer holds no credential.',
      auth: approval,
      cors: 'none',
      parameters: {
        body: {
          type: 'object',
          properties: {
            userCode: { type: 'string', pattern: '^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$' },
            message: { type: 'string', description: 'The SIWE message text.' },
            signature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
            label: { type: 'string', maxLength: CLIENT_LABEL_MAX, description: 'The creator’s own name for this client. Default: the client’s name.' },
          },
          required: ['userCode', 'message', 'signature'],
        },
      },
      response: { contentType: JSON_TYPE, shape: `{ok: true, target: {kind: coin, coin: {agentId, kernel, token, symbol, name}} | {kind: draft, draftId}, label}. ${ERRORS}` },
      rateLimit: perIp(10),
    },
    {
      service: 'web',
      method: 'POST',
      url: `${site}/api/agent/connect/token`,
      description: 'The AI client’s poll with its device code: pending until the creator has approved, then, once, the credential for that coin’s agent. The same device code afterwards is refused.',
      auth: { type: 'none' },
      cors: 'none',
      parameters: { body: { type: 'object', properties: { deviceCode: { type: 'string' } }, required: ['deviceCode'], additionalProperties: false } },
      response: { contentType: JSON_TYPE, shape: `{status: pending} | {status: approved, credential, clientId, label, target, expiresAt}; the credential is answered once. ${ERRORS}` },
      rateLimit: { limit: 1, windowSeconds: DEVICE_POLL_INTERVAL_S, per: 'device-code' },
    },
    {
      service: 'web',
      method: 'GET',
      url: `${site}/api/agent/connect/draft`,
      description: 'Whether an AI client has been approved for a launch that has not happened yet. The draft id is known only to the browser that holds the draft.',
      auth: { type: 'none' },
      cors: 'none',
      parameters: { query: { type: 'object', properties: { draft: { type: 'string', format: 'uuid' } }, required: ['draft'], additionalProperties: false } },
      response: { contentType: JSON_TYPE, shape: `{connected, clients: [{clientId, label, createdAt}]}. ${ERRORS}` },
      rateLimit: perIp(30),
    },
    run('status', 'Which coin this client is connected to, who runs its agent, the powers that are on and what is left of today’s posts, reads, pictures and extra turns.', EMPTY_BODY, '{coin, runner: hosted|own, client, powers, requireApproval, postsLeftToday, xReadsLeftToday, picturesLeftToday, forcedTurnsLeftToday, fuel, lastTurnAt}'),
    run('due', 'What is due now for each role (social, treasury, judge), the open turn, the holds in force and when to look again. Also at most one call per 20 seconds per client.', EMPTY_BODY, '{coin, now, social, treasury, judge: {on, due, reasons, nextAt, jobs?}, openTurn, holds, nextCheckAt}'),
    run(
      'turn',
      'Opens a turn in one role, or returns the open one of that role: the brief, the first observation, the tools the turn may call and its step budget.',
      {
        type: 'object',
        properties: {
          role: { enum: [...OWN_ROLES] },
          reason: { const: 'creator_asked', description: 'A social turn the creator asks for although nothing is due; a few a day.' },
          jobId: { type: 'string', description: 'The judge role: which job. Default: the oldest waiting one.' },
        },
        required: ['role'],
        additionalProperties: false,
      },
      '{turnId, role, resumed, reasons, brief, observation, tools, stepBudget, stepsUsed, expiresAt}; brief is the only text that carries authority, observation is data',
    ),
    run(
      'act',
      'One tool call inside an open turn: a tool of agentTools by its name, or answer_request, judge_entry or judge. A refused post or a failed read is a result with status failed, not an HTTP error. The same call repeated returns the same action, so nothing is published or paid twice.',
      { type: 'object', properties: { turnId: TURN_ID, tool: { type: 'string', description: 'The tool’s name as agentTools lists it.' }, input: { type: 'object', description: 'The tool’s parameters, as agentTools gives them.' } }, required: ['turnId', 'tool', 'input'], additionalProperties: false },
      '{turnId, tool, actionId|null, status: completed|failed|pending|held, result?, error?, retryAt?, image?, stepsUsed, stepsLeft, turnEnded}',
    ),
    run(
      'finish',
      'Checkpoints the agent’s memory, agenda and summary and ends the turn.',
      { type: 'object', properties: { turnId: TURN_ID, memory: { type: 'string' }, agenda: { type: 'string' }, summary: { type: 'string' }, nextAt: { type: 'string', format: 'date-time', description: 'When the agent wants to look again.' } }, required: ['turnId', 'memory', 'agenda', 'summary', 'nextAt'], additionalProperties: false },
      'The act result, with tool: finish and turnEnded: true when it took',
    ),
    run(
      'upload',
      'One picture for a post of this turn: PNG, JPEG or WebP, at most 5 MB, with its alt text and a one-sentence description. The body is at most 8 MB.',
      {
        type: 'object',
        properties: {
          turnId: TURN_ID,
          mime: { enum: [...PICTURE_MIMES] },
          dataBase64: { type: 'string', description: 'Standard base64 of the file’s bytes.' },
          alt: { type: 'string' },
          description: { type: 'string', maxLength: PICTURE_DESCRIPTION_MAX, description: 'One sentence on what the picture shows.' },
        },
        required: ['turnId', 'mime', 'dataBase64', 'alt', 'description'],
        additionalProperties: false,
      },
      'The act result, with tool: upload_picture and result: {imageId, alt, mime, bytes}; pass imageId to publish_post or publish_reply in the same turn',
    ),
    run('disconnect', 'Ends this client’s connection: its credential stops working at once.', EMPTY_BODY, '{ok: true}'),
    {
      service: 'web',
      method: 'GET',
      url: `${site}/api/agent/connect/coins`,
      description: 'The coins a wallet launched, newest first: what the approval page offers once the wallet is connected.',
      auth: { type: 'none' },
      cors: 'none',
      parameters: { query: { type: 'object', properties: { creator: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } }, required: ['creator'], additionalProperties: false } },
      response: { contentType: JSON_TYPE, shape: `{coins: [{agentId, kernel, token, symbol, name}]}. ${ERRORS}` },
      rateLimit: perIp(30),
    },
  ];
}

/** What `buildCatalog` spreads at the end of its web endpoints: nothing while own agents are switched off. */
export function ownAgentEndpoints(site: string, chainId: number): CatalogEndpoint[] {
  return ownAgentEnabled() ? (ownAgentEndpointList(site, chainId) as CatalogEndpoint[]) : [];
}
