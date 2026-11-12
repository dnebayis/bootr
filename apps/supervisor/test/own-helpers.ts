/**
 * Own agents (docs/design/byo-agent.md): what the own-agent tests share. A world with the supervisor's app mounted,
 * the internal routes called the way the web calls them (HMAC over the service key), an own coin, and a client
 * connected through the real grant routes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ActResult, ConnectStartResponse, ConnectTokenResponse, OwnErrorBody, TurnOpen } from '@bootr/shared/own-agent';
import { createApp } from '../src/api.js';
import { agents, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import type { AgentState, Turn } from '../src/runtime.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { AGENT_ID, CREATOR, KERNEL, SUPERVISOR_KEY, agentConfig, makeWorld, seedAgent, type TestWorld } from './helpers.js';

/** The flag on, and no waiting for a busy lease (a test that wants `runtime_busy` should get it at once). */
export const OWN_ON: Record<string, string> = { OWN_AGENT_ENABLED: 'true', OWN_LEASE_WAIT_MS: '0' };
/** The flag unset (the state at release), and no waiting for a busy lease. */
export const OWN_OFF: Record<string, string> = { OWN_LEASE_WAIT_MS: '0' };

export interface Answer<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export interface OwnWorld extends TestWorld {
  /** One signed call of an internal route. */
  call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer<T>>;
  /** The same with the body given as its exact text, for what `JSON.stringify` would never write. */
  raw<T = OwnErrorBody>(method: 'GET' | 'POST', path: string, text: string): Promise<Answer<T>>;
  /** `POST /internal/own/run/:op` as the web forwards it: the SHA-256 of the credential first in the body, never the credential. */
  run<T = Record<string, unknown>>(op: string, credential: string, body?: Record<string, unknown>): Promise<Answer<T>>;
  /** Every model call the world's fetch was asked for; an own coin must leave it empty. */
  modelCalls(): number;
}

export async function ownWorld(opts: Parameters<typeof makeWorld>[0] & { flag?: boolean } = {}): Promise<OwnWorld> {
  const { flag = true, ...rest } = opts;
  const world = await makeWorld({ ...rest, config: { ...(flag ? OWN_ON : OWN_OFF), ...(rest.config ?? {}) } });
  // A model call for an own coin is the one thing that must never happen: the fetch throws if it is asked for one.
  const inner = world.ctx.fetch;
  let modelCalls = 0;
  world.ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/v1/chat/completions') || url.includes('/v1/requests/')) {
      modelCalls += 1;
      throw new Error('a model was called');
    }
    return inner(input, init);
  }) as typeof fetch;
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  const raw = async <T>(method: 'GET' | 'POST', path: string, text: string): Promise<Answer<T>> => {
    const res = await app.request(path, { method, ...(method === 'GET' ? {} : { body: text }), headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, method, path, text, nowSec()) } });
    return { status: res.status, body: (await res.json()) as T };
  };
  const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer<T>> => raw<T>(method, path, method === 'GET' ? '' : JSON.stringify(body ?? {}));
  return Object.assign(world, {
    call,
    raw,
    run: <T>(op: string, credential: string, body: Record<string, unknown> = {}) => call<T>('POST', `/internal/own/run/${op}`, { credentialHash: credentialHash(credential), ...body }),
    modelCalls: () => modelCalls,
  });
}

/** What the web sends in place of a credential: its SHA-256, in hex. */
export function credentialHash(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

/** A credential as the web makes one at the token route: `bootr_agt_` and 32 random bytes. */
export function newCredential(): string {
  return `bootr_agt_${randomBytes(32).toString('base64url')}`;
}

/** One active agent whose stored config says `runner: 'own'` (the test agent of helpers.ts, id 7). */
export function seedOwn(world: TestWorld, over: Parameters<typeof seedAgent>[1] = {}) {
  return seedAgent(world, { ...over, config: { runner: 'own', ...(over?.config ?? {}) } });
}

/** A second coin of another creator, own by default. */
export const OTHER_AGENT_ID = '8';
export const OTHER_KERNEL = '0x2000000000000000000000000000000000000008';
export const OTHER_TOKEN = '0x3000000000000000000000000000000000000008';
export const OTHER_CREATOR = '0x4000000000000000000000000000000000000008';
export function seedOther(world: TestWorld, over: Parameters<typeof seedAgent>[1] = {}) {
  return seedAgent(world, {
    ...over,
    config: { runner: 'own', agentId: OTHER_AGENT_ID, token: { address: OTHER_TOKEN, symbol: 'OTHER', name: 'Other Coin', chainId: 84532 }, kernel: { address: OTHER_KERNEL }, creator: { address: OTHER_CREATOR }, xHandle: 'other_agent', xUserId: '2000', ...(over?.config ?? {}) },
    agent: { agentId: OTHER_AGENT_ID, token: OTHER_TOKEN, kernel: OTHER_KERNEL, creator: OTHER_CREATOR, ...(over?.agent ?? {}) },
    runtime: { agentId: OTHER_AGENT_ID, ...(over?.runtime ?? {}) },
  });
}

export interface Connected {
  credential: string;
  clientId: string;
  userCode: string;
  deviceCode: string;
}

/** Start a grant, approve it as `creator` for a coin, redeem it: the three internal calls of a connection. */
export async function connectClient(world: OwnWorld, opts: { creator?: string; agentId?: string; kernel?: string; label?: string; clientName?: string } = {}): Promise<Connected> {
  const start = await world.call<ConnectStartResponse>('POST', '/internal/own/connect/start', { clientName: opts.clientName ?? 'Claude Code', siteUrl: 'https://bootr.fun' });
  if (start.status !== 200) throw new Error(`connect start: ${start.status} ${JSON.stringify(start.body)}`);
  const approve = await world.call('POST', '/internal/own/connect/approve', {
    userCode: start.body.userCode,
    creator: opts.creator ?? CREATOR,
    ...(opts.label ? { label: opts.label } : {}),
    target: { kind: 'coin', kernel: opts.kernel ?? KERNEL, agentId: opts.agentId ?? AGENT_ID },
  });
  if (approve.status !== 200) throw new Error(`connect approve: ${approve.status} ${JSON.stringify(approve.body)}`);
  // The web makes the credential and sends its hash; the supervisor never sees the credential.
  const credential = newCredential();
  const token = await world.call<ConnectTokenResponse>('POST', '/internal/own/connect/token', { deviceCode: start.body.deviceCode, credentialHash: credentialHash(credential) });
  if (token.status !== 200 || token.body.status !== 'approved') throw new Error(`connect token: ${token.status} ${JSON.stringify(token.body)}`);
  return { credential, clientId: token.body.clientId, userCode: start.body.userCode, deviceCode: start.body.deviceCode };
}

export async function runtimeOf(world: TestWorld, agentId: string = AGENT_ID) {
  return (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agentId) }))!;
}

export async function stateOf(world: TestWorld, agentId: string = AGENT_ID): Promise<AgentState> {
  return (await runtimeOf(world, agentId)).state as unknown as AgentState;
}

export async function turnOf(world: TestWorld, agentId: string = AGENT_ID): Promise<Turn | null> {
  return ((await runtimeOf(world, agentId)).turn as unknown as Turn | null) ?? null;
}

export async function patchState(world: TestWorld, patch: Partial<AgentState>, agentId: string = AGENT_ID): Promise<void> {
  const state = await stateOf(world, agentId);
  await world.db.update(runtimes).set({ state: { ...state, ...patch } as unknown as Record<string, unknown> }).where(eq(runtimes.agentId, agentId));
}

export async function patchConfig(world: TestWorld, patch: Record<string, unknown>, agentId: string = AGENT_ID): Promise<void> {
  const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, agentId) }))!;
  await world.db.update(agents).set({ config: { ...agent.config, ...patch } }).where(eq(agents.agentId, agentId));
}

/** A mention addressed to the test agent from a verified account, so it is eligible for a reply. */
export function mention(postId: string, text = '@bootr_agent what does your coin do?', over: { authorId?: string; createdAt?: string; verified?: boolean } = {}): SenderInboxItem {
  const authorId = over.authorId ?? '42';
  const verified = over.verified ?? true;
  return {
    postId,
    authorId,
    conversationId: postId,
    status: 'pending',
    observedAt: over.createdAt ?? '2026-10-24T11:59:00Z',
    seenAt: null,
    deferredUntil: null,
    post: { id: postId, authorId, text, createdAt: over.createdAt ?? '2026-10-24T11:58:00Z', conversationId: postId, author: { id: authorId, username: `user${authorId}`, verified, verifiedType: verified ? 'blue' : 'none' } },
  };
}

/** A coin whose original post is not due and whose wake is an hour away: nothing is due unless a test makes it so. */
export function quietRuntime(now: number): { config: Record<string, unknown>; runtime: { nextAt: Date } } {
  return { config: { socialStartedAt: new Date(now - 10 * 60_000).toISOString() }, runtime: { nextAt: new Date(now + 3_600_000) } };
}

export async function openSocial(world: OwnWorld, credential: string, body: Record<string, unknown> = {}): Promise<TurnOpen> {
  const res = await world.run<TurnOpen>('turn', credential, { role: 'social', ...body });
  if (res.status !== 200) throw new Error(`open turn: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function act(world: OwnWorld, credential: string, turnId: string, tool: string, input: Record<string, unknown> = {}): Promise<Answer<ActResult>> {
  return world.run<ActResult>('act', credential, { turnId, tool, input });
}

export function finishInput(world: TestWorld, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(world.ctx.now() + 3_600_000).toISOString(), ...over };
}

export { agentConfig };
