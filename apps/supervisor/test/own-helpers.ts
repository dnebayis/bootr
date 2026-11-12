/**
 * Own agents (docs/design/byo-agent.md): what the own-agent tests share. A world with the supervisor's app mounted,
 * the internal routes called the way the web calls them (HMAC over the service key), an own coin, and a client
 * connected through the real grant routes.
 */
import { eq } from 'drizzle-orm';
import type { ActResult, ConnectStartResponse, ConnectTokenResponse, DueRole, DueView, OwnErrorBody, OwnRole, TurnOpen } from '@bootr/shared/own-agent';
import { createApp } from '../src/api.js';
import { agents, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { ownHooks } from '../src/own/registry.js';
import { acquireLease, releaseLease, type AgentState, type Turn } from '../src/runtime.js';
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
  /** `POST /internal/own/run/:op` with the credential in the body, as the web forwards it. */
  run<T = Record<string, unknown>>(op: string, credential: string, body?: Record<string, unknown>): Promise<Answer<T>>;
  /** Every model call the world's fetch was asked for; an own coin must leave it empty. */
  modelCalls(): number;
}

/**
 * Mounts the supervisor's app on a world and adds the signed calls of the internal routes, the way the web makes them.
 * The HMAC clock is the world's own, so a test that moves the time still signs a fresh request.
 */
export function withRoutes<W extends TestWorld>(world: W, modelCalls: () => number = () => 0): W & Pick<OwnWorld, 'call' | 'run' | 'modelCalls'> {
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer<T>> => {
    const text = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const res = await app.request(path, { method, ...(method === 'GET' ? {} : { body: text }), headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, method, path, text, nowSec()) } });
    return { status: res.status, body: (await res.json()) as T };
  };
  return Object.assign(world, {
    call,
    run: <T>(op: string, credential: string, body: Record<string, unknown> = {}) => call<T>('POST', `/internal/own/run/${op}`, { ...body, credential }),
    modelCalls,
  });
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
  return withRoutes(world, () => modelCalls);
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
  const token = await world.call<ConnectTokenResponse>('POST', '/internal/own/connect/token', { deviceCode: start.body.deviceCode });
  if (token.status !== 200 || token.body.status !== 'approved') throw new Error(`connect token: ${token.status} ${JSON.stringify(token.body)}`);
  return { credential: token.body.credential, clientId: token.body.clientId, userCode: start.body.userCode, deviceCode: start.body.deviceCode };
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

/** A run call the real routes could not take (`OwnErrorBody`): its code is what a test asserts on. */
export class RouteRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly body: OwnErrorBody,
  ) {
    super(`${code}: ${body.message ?? ''}`);
    this.name = 'RouteRefusal';
  }
}

/**
 * One connected client driving the REAL engine: every call goes through `POST /internal/own/run/:op` with a credential
 * made by the real grant routes, signed as the web signs it. The method names follow the stand-in engine of the role
 * tests (own-w2-engine.ts) so a test moves from one to the other by changing one line; what comes back is what the
 * routes answer (`TurnOpen`, `ActResult`), and a call the routes refuse throws a `RouteRefusal` with its code.
 */
export interface RealEngine {
  world: OwnWorld;
  credential: string;
  clientId: string;
  /** The id of the turn this driver opened last. */
  turnId(): string;
  dueView(): Promise<DueView>;
  due(role: OwnRole): Promise<DueRole>;
  /** `forced`: the creator asks for a social turn while nothing is due (`reason: 'creator_asked'`). */
  open(role: OwnRole, opts?: { jobId?: string; forced?: boolean }): Promise<TurnOpen>;
  act(tool: string, input?: Record<string, unknown>): Promise<ActResult>;
  finish(input?: Record<string, unknown>): Promise<ActResult>;
  /** Close the open turn the way the server does without a finish (`ownHooks.closeTurn`, under the lease, as the runner switch calls it). */
  abandon(why?: 'runner_switched' | 'client_revoked' | 'expired'): Promise<void>;
  /** The special tools (without the MCP prefix) the open turn is offered now, as a second `turn` call lists them. */
  offered(): Promise<string[]>;
  turn(): Promise<Turn | null>;
  state(): Promise<AgentState>;
}

const SPECIAL_TOOLS = ['answer_request', 'judge', 'judge_entry'];

export async function realEngine(w: TestWorld, opts: { agentId?: string; kernel?: string; creator?: string } = {}): Promise<RealEngine> {
  // The run routes exist only with the flag on; a busy lease is waited for as in the service.
  (w.ctx.config as unknown as Record<string, unknown>).OWN_AGENT_ENABLED = true;
  const world = withRoutes(w) as OwnWorld;
  const { credential, clientId } = await connectClient(world, opts);
  const agentId = opts.agentId ?? AGENT_ID;
  let turnId = '';
  const run = async <T>(op: string, body: Record<string, unknown> = {}): Promise<T> => {
    const res = await world.run<T>(op, credential, body);
    if (res.status !== 200) {
      const error = res.body as unknown as OwnErrorBody;
      throw new RouteRefusal(error.error, res.status, error);
    }
    return res.body;
  };
  return {
    world,
    credential,
    clientId,
    turnId: () => turnId,
    dueView: () => run<DueView>('due'),
    due: async (role) => (await run<DueView>('due'))[role],
    async open(role, o = {}) {
      const opened = await run<TurnOpen>('turn', { role, ...(o.jobId ? { jobId: o.jobId } : {}), ...(o.forced ? { reason: 'creator_asked' } : {}) });
      turnId = opened.turnId;
      return opened;
    },
    act: (tool, input = {}) => run<ActResult>('act', { turnId, tool, input }),
    finish: (input = {}) => run<ActResult>('finish', { turnId, ...finishInput(w, input) }),
    async abandon(why = 'expired') {
      const lease = `test-${Math.random().toString(16).slice(2)}`;
      if (!(await acquireLease(w.ctx, agentId, lease))) throw new Error('the runtime is leased');
      try {
        await ownHooks.closeTurn(w.ctx, agentId, why);
      } finally {
        await releaseLease(w.ctx, agentId, lease);
      }
    },
    async offered() {
      const open = (await turnOf(w, agentId))?.own;
      if (!open) return [];
      const again = await run<TurnOpen>('turn', { role: (await turnOf(w, agentId))!.role ?? 'social' });
      return again.tools.map((name) => name.replace(/^bootr_agent_/, '')).filter((name) => SPECIAL_TOOLS.includes(name)).sort();
    },
    turn: () => turnOf(w, agentId),
    state: () => stateOf(w, agentId),
  };
}
