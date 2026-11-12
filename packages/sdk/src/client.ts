import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import {
  CREDENTIAL_RE,
  type ActRequest,
  type ActResult,
  type AgentStatus,
  type ConnectStartRequest,
  type ConnectStartResponse,
  type ConnectTokenResponse,
  type DueView,
  type FinishRequest,
  type TurnOpen,
  type TurnRequest,
  type UploadPictureRequest,
} from './own-agent.js';
import { pathParams, ROUTES, type RouteName } from './routes.js';
import { launchProblem } from './token-settings.js';
import type {
  AgentPosts,
  Catalog,
  CatalogEndpoint,
  CoinFees,
  FuelEntry,
  Holding,
  LaunchInput,
  LaunchMessage,
  MarketSnapshot,
  ModelList,
  PlatformFeed,
  PlatformSwitches,
  PreparedClaims,
  PreparedLaunch,
  SearchRow,
  SiweAuth,
  Treasury,
} from './types.js';

export const DEFAULT_SITE_URL = 'https://bootr.fun';
const DEFAULT_TIMEOUT_MS = 15_000;
/** A launch pins an image and reads the chain before it answers. */
const LAUNCH_TIMEOUT_MS = 45_000;
const CATALOG_TTL_MS = 5 * 60_000;
/** A step of an own agent's turn can wait for X or the chain; an upload carries megabytes. */
const OWN_STEP_TIMEOUT_MS = 75_000;

export interface BootrOptions {
  /** The site to talk to; every other URL comes from its catalog. Default https://bootr.fun. */
  siteUrl?: string;
  /** Your own fetch, e.g. to go through a proxy from a browser page (most routes send no CORS headers). */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /**
   * Own agents: the credential of a connected client, for every `own…` call that names none. Without it those calls
   * read the credentials file (`BOOTR_CREDENTIALS_FILE`, default `~/.config/bootr/credentials.json`; Node only).
   */
  credential?: string;
  /** Own agents: the credentials file to read instead of the default one. */
  credentialsFile?: string;
}

/** Which connection an `own…` call uses: a credential given here, else the one the credentials file holds for `coin`. */
export interface OwnCallOptions {
  credential?: string;
  /** A symbol, a coin or treasury address, an agent id or a draft id: needed only when the file holds several coins. */
  coin?: string;
  timeoutMs?: number;
}

export type RouteParams = Record<string, string | number | boolean | undefined>;

/** A refusal or a failure from the API. `code` is stable (`rate_limited`, `invalid_request`, ...); match on it. */
export class BootrApiError extends Error {
  override readonly name = 'BootrApiError';
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null,
    readonly details: { field?: string; retryAfter?: number; reason?: string; retryAt?: string } = {},
  ) {
    super(message);
  }
}

const KEY_LIKE = /^(0x)?[0-9a-fA-F]{64}$/;
const SEED_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

/** True for a string shaped like a private key or a seed phrase, which no Bootr call ever takes. */
export function looksLikeKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const words = value.trim().split(/\s+/);
  return (
    KEY_LIKE.test(value.trim()) ||
    (SEED_WORD_COUNTS.has(words.length) && words.every((w) => /^[a-z]+$/.test(w)))
  );
}

export const KEY_REFUSAL =
  'That looks like a private key or a seed phrase. Bootr never needs one and nothing was sent. If it is real, treat it as exposed and move the funds to a new wallet.';

function requireAddress(value: string, name: string): Address {
  if (looksLikeKey(value)) throw new BootrApiError(KEY_REFUSAL, 'key_refused', null);
  if (!isAddress(value, { strict: false }))
    throw new BootrApiError(
      `${name} must be a 0x address of 40 hex characters.`,
      'invalid_request',
      null,
      { field: name },
    );
  return getAddress(value);
}

/** An https address, or this machine itself: `localhost`, a name under `.localhost`, 127.0.0.0/8 or `[::1]`. */
function secureOrLocal(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host);
}

/** The routes of own agents: connecting a client and running the agent. */
const OWN_AGENT_PATH = /^\/api\/agent\/(connect|run)\//;

/** The path of a catalog URL with its `{name}` parameters kept (`new URL` would encode them). */
function pathOf(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(url)?.[1] ?? '';
}

export class Bootr {
  readonly siteUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly credential: string | undefined;
  private readonly credentialsFile: string | undefined;
  private cached: { at: number; catalog: Promise<Catalog> } | null = null;

  constructor(options: BootrOptions = {}) {
    this.siteUrl = (options.siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, '');
    // Bound to its global: a bare `fetch` taken off `window` throws "Illegal invocation" in a browser.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.credential = options.credential;
    this.credentialsFile = options.credentialsFile;
  }

  private async send(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new BootrApiError(
        `Could not reach ${new URL(url).host}: ${(err as Error).name === 'TimeoutError' ? 'it did not answer in time' : 'the request failed'}. From a browser page this also means the route sends no CORS headers: call it from a server.`,
        'unreachable',
        null,
      );
    }
    const body = (await res.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
      field?: unknown;
      reason?: unknown;
      retryAt?: unknown;
    } | null;
    if (!res.ok) {
      const code = typeof body?.error === 'string' ? body.error : 'http_error';
      const message =
        typeof body?.message === 'string'
          ? body.message
          : `${new URL(url).pathname} answered ${res.status}.`;
      const retryAfter = Number(res.headers.get('retry-after')) || undefined;
      throw new BootrApiError(message, code, res.status, {
        ...(typeof body?.field === 'string' ? { field: body.field } : {}),
        ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
        ...(typeof body?.retryAt === 'string' ? { retryAt: body.retryAt } : {}),
        ...(retryAfter ? { retryAfter } : {}),
      });
    }
    if (body === null)
      throw new BootrApiError(
        `${new URL(url).pathname} did not answer with JSON.`,
        'bad_response',
        res.status,
      );
    return body;
  }

  /** What this deployment offers: endpoints with their parameters, auth and limits. Kept for 5 minutes. */
  catalog(options: { refresh?: boolean } = {}): Promise<Catalog> {
    const fresh = this.cached && Date.now() - this.cached.at < CATALOG_TTL_MS;
    if (!fresh || options.refresh) {
      const catalog = this.send(
        `${this.siteUrl}/api/catalog`,
        { method: 'GET' },
        this.timeoutMs,
      ) as Promise<Catalog>;
      this.cached = { at: Date.now(), catalog };
      catalog.catch(() => {
        this.cached = null;
      });
    }
    return this.cached!.catalog;
  }

  /** The catalog entry of a route. Throws `not_listed` when this deployment does not offer it. */
  async endpoint(route: RouteName): Promise<CatalogEndpoint> {
    const { method, path } = ROUTES[route];
    const found = (await this.catalog()).endpoints.find(
      (e) => e.method === method && pathOf(e.url) === path,
    );
    if (!found)
      throw new BootrApiError(
        // A site lists the connect and run routes only while own agents are on, so for those the plain reason is said.
        OWN_AGENT_PATH.test(path)
          ? `Own agents are switched off on ${this.siteUrl} for now. Nothing was done, and nothing is wrong with your setup.`
          : `${this.siteUrl} does not list ${method} ${path} in its catalog: this deployment does not offer it yet.`,
        'not_listed',
        null,
      );
    return found;
  }

  /**
   * Calls any route by name. `params` fills the path's `{name}` parameters and the rest goes in the query string, or
   * in the JSON body when `body` is given. The named methods below are this with types.
   *
   * `headers` are sent as they are. `sameSite` refuses a route the catalog places on another origin than `siteUrl` and
   * follows no redirect: the own-agent calls set it, so a credential or a device code only ever goes to the site itself.
   */
  async call<T = unknown>(
    route: RouteName,
    params: RouteParams = {},
    options: {
      body?: unknown;
      timeoutMs?: number;
      headers?: Record<string, string>;
      sameSite?: boolean;
    } = {},
  ): Promise<T> {
    const { method, path } = ROUTES[route];
    // A credential or a device code travels with a `sameSite` call, and a credential comes back with one of them:
    // over plain http anyone on the path reads it. Only this machine itself (a local test site) is taken without
    // TLS, and the check comes before anything is asked of the site. (The call then goes to this origin or nowhere.)
    if (options.sameSite && !secureOrLocal(new URL(this.siteUrl)))
      throw new BootrApiError(
        `${new URL(this.siteUrl).origin} is not an https site, so a connection's credential would cross the network in the clear. Use the https address of the site. Nothing was sent.`,
        'insecure_site',
        null,
      );
    const endpoint = await this.endpoint(route);
    const names = pathParams(path);
    let url = endpoint.url;
    for (const name of names) {
      const value = params[name];
      if (value === undefined || value === '')
        throw new BootrApiError(`${name} is required.`, 'invalid_request', null, { field: name });
      if (looksLikeKey(value)) throw new BootrApiError(KEY_REFUSAL, 'key_refused', null);
      // The indexer keys on lowercase addresses; the site's own routes checksum what they read.
      const text =
        endpoint.service === 'indexer' && isAddress(String(value), { strict: false })
          ? String(value).toLowerCase()
          : String(value);
      url = url.replace(`{${name}}`, encodeURIComponent(text));
    }
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (names.includes(name) || value === undefined) continue;
      if (looksLikeKey(value)) throw new BootrApiError(KEY_REFUSAL, 'key_refused', null);
      query.set(name, String(value));
    }
    const qs = query.toString() ? `?${query}` : '';
    if (options.sameSite && new URL(url).origin !== new URL(this.siteUrl).origin)
      throw new BootrApiError(
        `The catalog of ${this.siteUrl} places ${path} on another site. Nothing was sent.`,
        'mismatch',
        null,
      );
    const headers = {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    };
    const init: RequestInit = {
      method,
      ...(options.sameSite ? { redirect: 'error' as const } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };
    return (await this.send(url + qs, init, options.timeoutMs ?? this.timeoutMs)) as T;
  }

  // ---------------- Reads ----------------

  /** The launch form's switches. If `launchesPaused` is true, do not prepare a launch. */
  platform(): Promise<PlatformSwitches> {
    return this.call('platform');
  }

  models(options: { kind?: 'image' } = {}): Promise<ModelList> {
    return this.call('models', options);
  }

  /** A coin's market snapshot, by coin or treasury address. */
  async market(address: string): Promise<MarketSnapshot> {
    return this.call('market', { token: requireAddress(address, 'address') });
  }

  /** An agent's treasury, by treasury or coin address: status, balances and claimable fees. */
  async treasury(address: string): Promise<Treasury> {
    return this.call('treasury', { kernel: requireAddress(address, 'address') });
  }

  /** Up to 20 coins by name, symbol, X handle or address prefix. */
  search(q: string): Promise<SearchRow[]> {
    return this.call('search', { q });
  }

  /**
   * USD accrued and claimed per recipient kind for one coin. On Clanker v5 it also names the paired asset the fees are
   * paid in, each side's tax and the holder dividends.
   */
  async coinFees(token: string): Promise<CoinFees> {
    return this.call('coinFees', { id: requireAddress(token, 'token') });
  }

  async holdings(owner: string): Promise<Holding[]> {
    return this.call('holdings', { owner: requireAddress(owner, 'owner') });
  }

  async fuelHistory(from: string): Promise<FuelEntry[]> {
    return this.call('fuelHistory', { from: requireAddress(from, 'from') });
  }

  /** What happened on Bootr since a unix time, at most 7 days back. */
  feed(options: { since?: number } = {}): Promise<PlatformFeed> {
    return this.call('feed', options);
  }

  /** An agent's latest posts, by ERC-8004 agent id. */
  agentPosts(agentId: string | number, options: { limit?: number } = {}): Promise<AgentPosts> {
    return this.call('agentPosts', { id: agentId, ...options });
  }

  // ---------------- Prepare: nothing below signs or sends ----------------

  /**
   * The creator fees waiting for `address` on every launch path, as unsigned transactions: one claim per locker and
   * asset (WETH on the older paths; on Clanker v5 the coins' paired asset, ETH or USDC). `claimsByAsset` groups them.
   */
  async prepareClaim(address: string): Promise<PreparedClaims> {
    return this.call('claim', { address: requireAddress(address, 'address') });
  }

  /**
   * Step one of a launch: a fresh nonce and the exact message for the wallet to sign. The fields come from the
   * catalog, the nonce from the site. It lasts 10 minutes and the first attempt spends it, right or wrong.
   */
  async launchMessage(address: string): Promise<LaunchMessage> {
    const wallet = requireAddress(address, 'address');
    const auth = (await this.endpoint('launch')).auth as SiweAuth;
    const { nonce, expiresIn } = await this.call<{ nonce: string; expiresIn: number }>('nonce');
    const message = createSiweMessage({
      domain: auth.domain,
      uri: auth.uri,
      version: '1',
      chainId: auth.chainId,
      address: wallet,
      nonce,
      statement: auth.statement,
    });
    return {
      message,
      address: wallet,
      chainId: auth.chainId,
      statement: auth.statement,
      expiresIn,
    };
  }

  /**
   * Step two: with the wallet's signature of that message, the server pins the image, stores the agent's text and
   * answers with the transactions the wallet must send, in order. Refuses an answer that names another wallet or chain.
   *
   * The Clanker v5 fields (`launchThrough`, `token`, `devBuySlippagePct`) are checked here first, with the site's own
   * bounds and messages, so a mistake there sends nothing and leaves the signed message unused.
   */
  async prepareLaunch(input: {
    message: string;
    signature: Hex;
    launch: LaunchInput;
  }): Promise<PreparedLaunch> {
    const signer = parseSiweMessage(input.message).address;
    if (signer && input.launch && typeof input.launch === 'object') {
      const problem = launchProblem(input.launch, signer);
      if (problem)
        throw new BootrApiError(
          `${problem.message} Nothing was sent, so the signed message is still unused.`,
          'invalid_request',
          null,
          { field: problem.field },
        );
    }
    const prepared = await this.call<PreparedLaunch>(
      'launch',
      {},
      { body: input, timeoutMs: Math.max(this.timeoutMs, LAUNCH_TIMEOUT_MS) },
    );
    const signed = parseSiweMessage(input.message);
    if (
      !signed.address ||
      !isAddressEqual(prepared.creator, signed.address) ||
      prepared.chainId !== signed.chainId
    ) {
      throw new BootrApiError(
        'The answer names another wallet or chain than the signed message. Do not send anything from it.',
        'mismatch',
        null,
      );
    }
    return prepared;
  }

  // ---------------- Own agents: a coin's agent run from the creator's own AI client ----------------

  /**
   * Asks to be connected to a coin's agent. The answer holds a `deviceCode` for `connectToken` (a secret: never show
   * it) and a `userCode` with a link where the coin's creator approves with a wallet signature.
   */
  connectStart(request: ConnectStartRequest = {}): Promise<ConnectStartResponse> {
    return this.call('connectStart', {}, { body: request, sameSite: true });
  }

  /**
   * The poll for an approval: `{status: 'pending'}`, then once `{status: 'approved', credential, ...}`. Keep the
   * credential with `saveCredential`; never log it or pass it on. Poll no faster than the start call's `interval`.
   */
  connectToken(deviceCode: string): Promise<ConnectTokenResponse> {
    return this.call('connectToken', {}, { body: { deviceCode }, sameSite: true });
  }

  private fileOptions(): { file?: string } {
    return this.credentialsFile ? { file: this.credentialsFile } : {};
  }

  /** The credential an own-agent call sends: the call's, the client's, else the credentials file's one for `coin`. */
  private async bearer(options: OwnCallOptions): Promise<string> {
    const given = options.credential ?? this.credential;
    if (given !== undefined) {
      if (!CREDENTIAL_RE.test(given))
        throw new BootrApiError(
          'That is not a Bootr client credential. Connect this client to Bootr again. Nothing was sent.',
          'unauthorized',
          null,
        );
      return given;
    }
    const { CredentialsError, findCredential } = await import('./credentials.js');
    try {
      return (await findCredential(this.siteUrl, options.coin, this.fileOptions())).credential;
    } catch (err) {
      if (err instanceof CredentialsError) throw new BootrApiError(err.message, err.code, null);
      throw err;
    }
  }

  private async own<T>(
    route: RouteName,
    body: object,
    options: OwnCallOptions,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const credential = await this.bearer(options);
    return this.call<T>(
      route,
      {},
      {
        body,
        headers: { authorization: `Bearer ${credential}` },
        sameSite: true,
        timeoutMs: options.timeoutMs ?? timeoutMs,
      },
    );
  }

  /** Which coin this client is connected to, who runs its agent and what is left of today's allowances. */
  ownStatus(options: OwnCallOptions = {}): Promise<AgentStatus> {
    return this.own('ownStatus', {}, options);
  }

  /** What is due now, per role, and when to look again. At most one call per 20 seconds per client. */
  ownDue(options: OwnCallOptions = {}): Promise<DueView> {
    return this.own('ownDue', {}, options, OWN_STEP_TIMEOUT_MS);
  }

  /** Opens a turn in one role, or returns the open one of that role. */
  ownTurn(request: TurnRequest, options: OwnCallOptions = {}): Promise<TurnOpen> {
    return this.own('ownTurn', request, options, OWN_STEP_TIMEOUT_MS);
  }

  /**
   * One tool call inside an open turn. A refused post is a result with `status: 'failed'`, not an error. After a
   * timeout, repeat the same call: the server returns the same action and never runs it twice.
   */
  ownAct(request: ActRequest, options: OwnCallOptions = {}): Promise<ActResult> {
    return this.own('ownAct', request, options, OWN_STEP_TIMEOUT_MS);
  }

  /** Checkpoints and ends the turn. */
  ownFinish(request: FinishRequest, options: OwnCallOptions = {}): Promise<ActResult> {
    return this.own('ownFinish', request, options, OWN_STEP_TIMEOUT_MS);
  }

  /** Sends one picture (base64, PNG, JPEG or WebP, at most 5 MB) for a post of this turn. */
  ownUpload(request: UploadPictureRequest, options: OwnCallOptions = {}): Promise<ActResult> {
    return this.own('ownUpload', request, options, OWN_STEP_TIMEOUT_MS);
  }

  /**
   * Ends this client's connection. When the credential came from the credentials file it is removed from it, also
   * when the server says it was already disconnected or ran out.
   */
  async ownDisconnect(options: OwnCallOptions = {}): Promise<{ ok: true }> {
    const fromFile = options.credential === undefined && this.credential === undefined;
    let held: { clientId: string; credential: string } | null = null;
    if (fromFile) {
      const { CredentialsError, findCredential } = await import('./credentials.js');
      try {
        held = await findCredential(this.siteUrl, options.coin, this.fileOptions());
      } catch (err) {
        if (err instanceof CredentialsError) throw new BootrApiError(err.message, err.code, null);
        throw err;
      }
    }
    try {
      await this.own('ownDisconnect', {}, held ? { ...options, credential: held.credential } : options);
    } catch (err) {
      // Already gone on the server: the local copy is of no use either.
      const gone = ['unauthorized', 'credential_revoked', 'credential_expired'];
      if (!(err instanceof BootrApiError) || !gone.includes(err.code)) throw err;
    }
    if (held) {
      const { removeCredential } = await import('./credentials.js');
      await removeCredential(this.siteUrl, held, this.fileOptions());
    }
    return { ok: true };
  }
}

/** A client over the public API. It holds no key and no private state. */
export function createBootr(options: BootrOptions = {}): Bootr {
  return new Bootr(options);
}

/** A claim or launch step as a wallet library takes it (viem's `sendTransaction`, for one). */
export function toTransaction(
  tx: { target: Address; data: Hex; value: string } | { to: Address; data: Hex; value: string },
): { to: Address; data: Hex; value: bigint } {
  return { to: 'target' in tx ? tx.target : tx.to, data: tx.data, value: BigInt(tx.value) };
}
