/**
 * Own agents in mock mode (`NEXT_PUBLIC_USE_MOCK=1`, or no indexer configured): what the connect routes and the
 * console's client routes answer when there is no supervisor to ask, so the approval page can be opened, clicked
 * through and tested in a browser. Nothing here is a credential anyone can use: a mock client reaches no agent.
 *
 * Four codes always exist and never change, so parallel browser tests cannot disturb each other: `MOCK_CODES`. A code
 * started through `POST /api/agent/connect/start` lives in memory and moves from pending to approved to redeemed.
 */
import {
  CLIENT_LABEL_MAX,
  DEVICE_CODE_TTL_S,
  DEVICE_POLL_INTERVAL_S,
  OWN_DEFAULTS,
  USER_CODE_ALPHABET,
  type ClientsResponse,
  type ClientView,
  type CoinRef,
  type ConnectApproveResponse,
  type ConnectCoinsResponse,
  type ConnectGrantView,
  type ConnectStartResponse,
  type ConnectTarget,
  type ConnectTokenResponse,
  type DraftClientsResponse,
  type OwnErrorCode,
} from '@bootr/shared/own-agent';
import { mockStore } from '@/lib/mock';

export const MOCK_CODES = {
  /** Waiting for approval, from a client that named no coin. */
  pending: 'BCDF-GHJK',
  /** Waiting for approval, from a client whose hint fits the second mock coin without naming exactly one coin: a hint only. */
  hinted: 'HNTD-CLNT',
  /** Waiting for approval, from a client that named the second mock coin and nothing else: the request is for that coin alone. */
  bound: 'BNDC-CLNT',
  /** Ran out. */
  expired: 'XPRD-XPRD',
  /** Already used. */
  used: 'RDMD-RDMD',
} as const;
/** A wallet that launched nothing: every other wallet is the creator of the mock coins, as everywhere in mock mode. */
export const MOCK_WALLET_WITHOUT_COINS = '0x00000000000000000000000000000000000e2e02';
export const MOCK_CLIENT_NAME = 'Claude Code';

type Grant = { userCode: string; deviceCode: string; clientName: string; coinHint: string | null; status: 'pending' | 'approved' | 'redeemed'; expiresAt: number; target: ConnectTarget | null; label: string | null; approvedAt?: number; bound?: CoinRef | null; creator?: string };

/**
 * The one coin a client's `coin` names, as the agent service decides it: a treasury or coin address. A symbol is a hint
 * only here (the mock's coins are few, and the fixed code `hinted` stands for a symbol several coins share).
 */
function boundCoin(named: unknown): CoinRef | null {
  const wanted = typeof named === 'string' ? named.trim().toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(wanted)) return null;
  const fits = mockCoins().filter((c) => c.kernel.toLowerCase() === wanted || c.token.toLowerCase() === wanted);
  return fits.length === 1 ? fits[0]! : null;
}
type Client = ClientView & { kernel: string | null; draftId: string | null; revoked: boolean; /** The wallet that approved it, lower case. */ creator: string | null };
type State = { grants: Map<string, Grant>; clients: Client[]; seq: number };

const KEY = Symbol.for('bootr.web.mock-own');
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (g[KEY] ??= { grants: new Map(), clients: [], seq: 0 });

const iso = (ms: number) => new Date(ms).toISOString();

function random(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomCode(): string {
  const letters = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join('');
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** The mock coins that have an agent, as the approval page lists them. */
export function mockCoins(): CoinRef[] {
  return mockStore()
    .tokens.filter((t) => /^[A-Za-z0-9_]{1,16}$/.test(t.symbol) && /^\d{1,20}$/.test(t.agentId))
    .slice(0, 3)
    .map((t) => ({ agentId: t.agentId, kernel: t.kernel, token: t.id, symbol: t.symbol, name: t.name }));
}

function fixed(code: string, now: number): ConnectGrantView | null {
  const base = { userCode: code, clientName: MOCK_CLIENT_NAME, coinHint: null };
  if (code === MOCK_CODES.pending) return { ...base, status: 'pending', expiresAt: iso(now + DEVICE_CODE_TTL_S * 1000) };
  if (code === MOCK_CODES.hinted) return { ...base, coinHint: mockCoins()[1]?.symbol ?? null, status: 'pending', expiresAt: iso(now + DEVICE_CODE_TTL_S * 1000) };
  if (code === MOCK_CODES.bound) return { ...base, coinHint: mockCoins()[1]?.kernel ?? null, coin: mockCoins()[1] ?? null, status: 'pending', expiresAt: iso(now + DEVICE_CODE_TTL_S * 1000) };
  if (code === MOCK_CODES.expired) return { ...base, status: 'expired', expiresAt: iso(now - 60_000) };
  if (code === MOCK_CODES.used) return { ...base, status: 'redeemed', expiresAt: iso(now + 60_000) };
  return null;
}

function label(input: unknown, fallback: string): string {
  return typeof input === 'string' && input.trim() ? input.trim().slice(0, CLIENT_LABEL_MAX) : fallback;
}

/** The approvals for a coin that no client has collected yet and that have not run out. */
function approvedFor(kernel: string, now: number): Grant[] {
  return [...state.grants.values()].filter((x) => x.status === 'approved' && x.expiresAt > now && x.target?.kind === 'coin' && x.target.coin.kernel.toLowerCase() === kernel);
}

export type MockOwnResult<T> = { ok: true; data: T } | { ok: false; error: OwnErrorCode };
const fail = (error: OwnErrorCode) => ({ ok: false as const, error });

export const mockOwn = {
  start(input: { clientName?: unknown; coin?: unknown }, siteUrl: string, now = Date.now()): ConnectStartResponse {
    const userCode = randomCode();
    const deviceCode = random(32);
    for (const [code, grant] of state.grants) if (grant.expiresAt + 86_400_000 < now) state.grants.delete(code);
    const bound = boundCoin(input.coin);
    state.grants.set(userCode, { userCode, deviceCode, clientName: label(input.clientName, 'AI client'), coinHint: typeof input.coin === 'string' && input.coin ? input.coin.slice(0, 64) : null, status: 'pending', expiresAt: now + DEVICE_CODE_TTL_S * 1000, target: null, label: null, bound });
    const site = siteUrl.replace(/\/+$/, '');
    return { deviceCode, userCode, verificationUri: `${site}/connect`, verificationUriComplete: `${site}/connect/${userCode}`, expiresIn: DEVICE_CODE_TTL_S, interval: DEVICE_POLL_INTERVAL_S, ...(bound ? { coin: bound } : {}) };
  },

  grant(code: string, now = Date.now()): MockOwnResult<ConnectGrantView> {
    const preset = fixed(code, now);
    if (preset) return { ok: true, data: preset };
    const grant = state.grants.get(code);
    if (!grant) return fail('grant_not_found');
    const status = grant.status === 'pending' && grant.expiresAt <= now ? 'expired' : grant.status;
    return { ok: true, data: { userCode: grant.userCode, clientName: grant.clientName, coinHint: grant.coinHint, status, expiresAt: iso(grant.expiresAt), coin: status === 'pending' ? (grant.bound ?? null) : null } };
  },

  /** Everyone is the creator in mock mode; only the wallet without coins is told it is not. */
  approve(input: { userCode: string; creator: string; label?: unknown; target: { kind: 'coin'; kernel: string; agentId: string } | { kind: 'draft'; draftId: string } }, now = Date.now()): MockOwnResult<ConnectApproveResponse> {
    const view = mockOwn.grant(input.userCode, now);
    if (!view.ok) return view;
    if (view.data.status === 'expired') return fail('grant_expired');
    if (view.data.status !== 'pending') return fail('grant_used');
    // A request for one coin is approved for that coin or not at all.
    const bound = view.data.coin;
    if (bound && (input.target.kind !== 'coin' || input.target.agentId !== bound.agentId)) return fail('wrong_coin');
    let target: ConnectTarget;
    if (input.target.kind === 'coin') {
      const kernel = input.target.kernel.toLowerCase();
      const coin = mockCoins().find((c) => c.kernel.toLowerCase() === kernel);
      if (!coin || coin.agentId !== input.target.agentId) return fail('unknown_coin');
      if (input.creator.toLowerCase() === MOCK_WALLET_WITHOUT_COINS) return fail('not_creator');
      const taken = mockOwn.clients(coin.kernel, now);
      if (taken.clients.length + (taken.waiting?.length ?? 0) >= OWN_DEFAULTS.OWN_CLIENTS_PER_AGENT) return fail('too_many_clients');
      target = { kind: 'coin', coin };
    } else {
      target = { kind: 'draft', draftId: input.target.draftId };
    }
    const name = label(input.label, view.data.clientName);
    const grant = state.grants.get(input.userCode);
    // The fixed codes stay as they are: an approval of one answers and changes nothing.
    if (grant) Object.assign(grant, { status: 'approved', target, label: name, approvedAt: now, creator: input.creator.toLowerCase() });
    return { ok: true, data: { ok: true, target, label: name } };
  },

  token(deviceCode: string, now = Date.now()): MockOwnResult<ConnectTokenResponse> {
    const grant = [...state.grants.values()].find((x) => x.deviceCode === deviceCode);
    if (!grant) return fail('grant_not_found');
    if (grant.status === 'redeemed') return fail('grant_used');
    if (grant.status === 'pending') return grant.expiresAt <= now ? fail('grant_expired') : { ok: true, data: { status: 'pending' } };
    grant.status = 'redeemed';
    state.seq += 1;
    const target = grant.target!;
    const client: Client = {
      clientId: `cli_${random(8)}`,
      label: grant.label ?? grant.clientName,
      createdAt: iso(now),
      lastUsedAt: null,
      expiresAt: iso(now + OWN_DEFAULTS.OWN_CLIENT_TTL_DAYS * 86_400_000),
      kernel: target.kind === 'coin' ? target.coin.kernel.toLowerCase() : null,
      draftId: target.kind === 'draft' ? target.draftId : null,
      revoked: false,
      creator: grant.creator ?? null,
    };
    state.clients.push(client);
    // Shaped like a credential so a client can store it; no route of a mock deployment takes it.
    const tail = String(state.seq);
    const credential = `bootr_agt_${'mock'.padEnd(43 - tail.length, 'A')}${tail}`;
    return { ok: true, data: { status: 'approved', credential, clientId: client.clientId, label: client.label, target, expiresAt: client.expiresAt } };
  },

  coins(creator: string): ConnectCoinsResponse {
    return { coins: creator.toLowerCase() === MOCK_WALLET_WITHOUT_COINS ? [] : mockCoins() };
  },

  /** With `creator`, the wallet the launch will be sent from, only the clients that wallet approved. */
  draft(draftId: string, creator: string | null = null): DraftClientsResponse {
    const wallet = creator?.toLowerCase();
    const clients = state.clients
      .filter((c) => !c.revoked && c.draftId === draftId && (!wallet || c.creator === wallet))
      .map(({ clientId, label: l, createdAt }) => ({ clientId, label: l, createdAt }));
    return { connected: clients.length > 0, clients };
  },

  clients(kernel: string, now = Date.now()): ClientsResponse {
    const k = kernel.toLowerCase();
    const clients = state.clients.filter((c) => !c.revoked && c.kernel === k).map(({ clientId, label: l, createdAt, lastUsedAt, expiresAt }) => ({ clientId, label: l, createdAt, lastUsedAt, expiresAt }));
    const waiting = approvedFor(k, now).map((x) => ({ userCode: x.userCode, label: x.label ?? x.clientName, approvedAt: iso(x.approvedAt ?? now), expiresAt: iso(x.expiresAt) }));
    return { clients, max: OWN_DEFAULTS.OWN_CLIENTS_PER_AGENT, waiting };
  },

  revoke(kernel: string, input: { clientId?: string; userCode?: string; all?: boolean }, now = Date.now()): MockOwnResult<ClientsResponse> {
    const k = kernel.toLowerCase();
    const live = state.clients.filter((c) => !c.revoked && c.kernel === k);
    if (input.all === true) {
      for (const x of approvedFor(k, now)) state.grants.delete(x.userCode);
      for (const c of live) c.revoked = true;
    } else if (input.userCode !== undefined) {
      // An approval no client has collected yet: gone, so the client's next poll finds no such request.
      const one = approvedFor(k, now).find((x) => x.userCode === input.userCode);
      if (!one) return fail('client_not_found');
      state.grants.delete(one.userCode);
    } else {
      const one = live.find((c) => c.clientId === input.clientId);
      if (!one) return fail('client_not_found');
      one.revoked = true;
    }
    return { ok: true, data: mockOwn.clients(kernel) };
  },
};
