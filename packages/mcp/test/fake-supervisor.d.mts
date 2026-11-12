/** Types of `fake-supervisor.mjs` for the TypeScript tests that import it (the web's route tests and the packages' tests). */

export declare const USER_CODE_ALPHABET: string;
export declare const DEVICE_CODE_TTL_S: number;
export declare const DEVICE_POLL_INTERVAL_S: number;
export declare const PICTURE_MAX_BYTES: number;
export declare const OWN_ERRORS: Record<string, { status: number; message: string }>;

export declare const CREATOR: `0x${string}`;
export declare const STRANGER: `0x${string}`;
export interface FakeCoin {
  agentId: string;
  kernel: string;
  token: string;
  symbol: string;
  name: string;
}
export declare const COIN: FakeCoin;
export declare const SECOND_COIN: FakeCoin;
export declare const DRAFT_ID: string;
export declare const HOSTILE_TEXT: string;
export declare const BRIEF: string;
export declare const ACTION_TOOLS: string[];
export declare const TINY_PNG_BASE64: string;

export declare class OwnError extends Error {
  code: string;
  extra: Record<string, unknown>;
  constructor(code: string, extra?: Record<string, unknown>);
}

export declare function errorBody(code: string, extra?: Record<string, unknown>): { error: string; message: string; retryAt?: string; field?: string };

export interface FakeClient {
  clientId: string;
  agentId: string | null;
  draftId: string | null;
  creator: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  revokedAt: number | null;
}

export interface FakeGrant {
  deviceHash: string;
  userCode: string;
  clientName: string;
  coinHint: string | null;
  status: 'pending' | 'approved' | 'redeemed';
  expiresAt: number;
  target: unknown;
  creator: string | null;
  label: string | null;
}

export declare class FakeOwnBackend {
  constructor(options?: { ownEnabled?: boolean; now?: () => number; maxClients?: number });
  ownEnabled: boolean;
  now: () => number;
  maxClients: number;
  grants: Map<string, FakeGrant>;
  clients: Map<string, FakeClient>;
  coins: FakeCoin[];
  creator: string;
  runner: 'own' | 'hosted';
  due: { social: boolean; treasury: boolean; judge: boolean };
  turn: { turnId: string; role: string; clientId: string; reasons: string[]; stepsUsed: number; expiresAt: number } | null;
  closedTurns: Set<string>;
  uploads: { imageId: string; mime: string; bytes: number; alt: string; description: string; sha256: string }[];
  posts: { tool: string; text: string; imageId: string | null }[];
  failNext(code: string, extra?: Record<string, unknown>): void;
  connectStart(body: Record<string, unknown>): { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number; interval: number };
  grantView(code: string): { userCode: string; clientName: string; coinHint: string | null; status: string; expiresAt: string };
  connectApprove(body: Record<string, unknown>): { ok: true; target: unknown; label: string };
  connectToken(body: Record<string, unknown>): Record<string, unknown>;
  connectCoins(creator: string): { coins: FakeCoin[] };
  draftClients(draftId: string): { connected: boolean; clients: { clientId: string; label: string; createdAt: string }[] };
  issueCredential(coin?: FakeCoin, label?: string): string;
  clientsOf(agentId: string): { clients: unknown[]; max: number };
  revokeClients(agentId: string, body: Record<string, unknown>): { clients: unknown[]; max: number };
  run(op: string, body: Record<string, unknown>): unknown;
}

export declare function verifyHmac(key: string, header: string | undefined, method: string, path: string, body: string, nowSec?: number): string | null;

export interface FakeSupervisor {
  url: string;
  backend: FakeOwnBackend;
  seen: { method: string; path: string; body: Record<string, unknown>; authorized: boolean }[];
  control: { status: number | null; raw: string | null; delayMs: number };
  close(): Promise<void>;
}
export declare function startFakeSupervisor(options: { key: string; port?: number; backend?: FakeOwnBackend }): Promise<FakeSupervisor>;

export interface FakeSite {
  url: string;
  backend: FakeOwnBackend;
  seen: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown>; raw: string }[];
  state: { ownAgent: boolean };
  close(): Promise<void>;
}
export declare function startFakeSite(options?: { port?: number; backend?: FakeOwnBackend; ownAgent?: boolean }): Promise<FakeSite>;
