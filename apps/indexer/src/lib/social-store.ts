import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

import { indexerEnv } from './env';

/**
 * Off-chain agent social data written by the supervisor (`POST /internal/agent/:kernel/social`).
 *
 * Ponder tables are written only by indexing functions (the API's db handle is read-only), so
 * this lives outside them: in Postgres (`bootr_offchain.agent_social`, same database as Ponder
 * when INDEXER_DATABASE_URL is set) or, in PGlite dev mode, in `.ponder/agent-social.json`.
 * The snapshot block handler mirrors it into `agent` / `token` for GraphQL; REST responses
 * merge it live.
 *
 * `spender` is the agent's x402 spender EOA (`sv_agents.spender`): the supervisor tops it up from the
 * kernel and it pays inference, so the snapshot reads its USDC float alongside the kernel balances.
 */
export type AgentSocial = {
  kernel: string;
  xHandle: string | null;
  lastPostAt: number | null;
  postsCount24h: number;
  status: 'awake' | 'sleeping' | null;
  /** Lowercase hex address of the agent's x402 spender EOA, or null (unknown / not derived yet). */
  spender: string | null;
  updatedAt: number;
};

export type SocialPatch = Partial<Pick<AgentSocial, 'xHandle' | 'lastPostAt' | 'postsCount24h' | 'status' | 'spender'>>;

interface Store {
  all(): Promise<Map<string, AgentSocial>>;
  upsert(kernel: string, patch: SocialPatch): Promise<AgentSocial>;
}

const empty = (kernel: string): AgentSocial => ({
  kernel,
  xHandle: null,
  lastPostAt: null,
  postsCount24h: 0,
  status: null,
  spender: null,
  updatedAt: 0,
});

const merge = (prev: AgentSocial, patch: SocialPatch): AgentSocial => ({
  ...prev,
  ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  updatedAt: Math.floor(Date.now() / 1000),
});

export class FileStore implements Store {
  private cache = new Map<string, AgentSocial>();
  private mtime = -1;
  constructor(private file: string) {}

  private async load() {
    try {
      const s = await stat(this.file);
      if (s.mtimeMs === this.mtime) return;
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, Partial<AgentSocial>>;
      // entries written before a field existed get its default (e.g. `spender: null`)
      this.cache = new Map(Object.entries(raw).map(([k, v]) => [k, { ...empty(k), ...v }]));
      this.mtime = s.mtimeMs;
    } catch {
      /* missing file = empty store */
    }
  }

  async all() {
    await this.load();
    return new Map(this.cache);
  }

  async upsert(kernel: string, patch: SocialPatch) {
    await this.load();
    const next = merge(this.cache.get(kernel) ?? empty(kernel), patch);
    this.cache.set(kernel, next);
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.cache), null, 2));
    await rename(tmp, this.file);
    this.mtime = (await stat(this.file)).mtimeMs;
    return next;
  }
}

class PgStore implements Store {
  private pool: pg.Pool;
  private ready: Promise<void> | undefined;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 2 });
  }

  private init() {
    this.ready ??= this.pool
      .query(
        `CREATE SCHEMA IF NOT EXISTS bootr_offchain;
         CREATE TABLE IF NOT EXISTS bootr_offchain.agent_social (
           kernel text PRIMARY KEY,
           x_handle text,
           last_post_at integer,
           posts_count_24h integer NOT NULL DEFAULT 0,
           status text,
           spender text,
           updated_at integer NOT NULL
         );
         ALTER TABLE bootr_offchain.agent_social ADD COLUMN IF NOT EXISTS spender text;`,
      )
      .then(() => undefined);
    return this.ready;
  }

  private row(r: Record<string, unknown>): AgentSocial {
    return {
      kernel: r.kernel as string,
      xHandle: (r.x_handle as string | null) ?? null,
      lastPostAt: (r.last_post_at as number | null) ?? null,
      postsCount24h: Number(r.posts_count_24h ?? 0),
      status: (r.status as AgentSocial['status']) ?? null,
      spender: (r.spender as string | null) ?? null,
      updatedAt: Number(r.updated_at ?? 0),
    };
  }

  async all() {
    await this.init();
    const res = await this.pool.query('SELECT * FROM bootr_offchain.agent_social');
    return new Map(res.rows.map((r) => [r.kernel as string, this.row(r)]));
  }

  async upsert(kernel: string, patch: SocialPatch) {
    await this.init();
    const prev = await this.pool.query('SELECT * FROM bootr_offchain.agent_social WHERE kernel = $1', [kernel]);
    const next = merge(prev.rows[0] ? this.row(prev.rows[0]) : empty(kernel), patch);
    await this.pool.query(
      `INSERT INTO bootr_offchain.agent_social (kernel, x_handle, last_post_at, posts_count_24h, status, spender, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (kernel) DO UPDATE SET x_handle = $2, last_post_at = $3, posts_count_24h = $4, status = $5, spender = $6, updated_at = $7`,
      [kernel, next.xHandle, next.lastPostAt, next.postsCount24h, next.status, next.spender, next.updatedAt],
    );
    return next;
  }
}

let store: Store | undefined;

export function socialStore(): Store {
  if (!store) {
    const url = indexerEnv().databaseUrl;
    store = url ? new PgStore(url) : new FileStore(path.resolve(process.cwd(), '.ponder', 'agent-social.json'));
  }
  return store;
}

/** Validate a supervisor payload. Returns the patch or an error string. */
export function parseSocialPatch(body: unknown): SocialPatch | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const o = body as Record<string, unknown>;
  const patch: SocialPatch = {};
  if ('xHandle' in o) {
    if (o.xHandle === null || o.xHandle === '') patch.xHandle = null;
    else if (typeof o.xHandle === 'string' && /^@?[A-Za-z0-9_]{1,15}$/.test(o.xHandle)) patch.xHandle = o.xHandle.replace(/^@/, '');
    else return 'xHandle must be an X handle (1-15 of A-Z a-z 0-9 _) or null';
  }
  if ('lastPostAt' in o) {
    if (o.lastPostAt === null) patch.lastPostAt = null;
    else if (Number.isInteger(o.lastPostAt) && (o.lastPostAt as number) >= 0 && (o.lastPostAt as number) < 2 ** 31)
      patch.lastPostAt = o.lastPostAt as number;
    else return 'lastPostAt must be unix seconds or null';
  }
  if ('postsCount24h' in o) {
    if (Number.isInteger(o.postsCount24h) && (o.postsCount24h as number) >= 0 && (o.postsCount24h as number) <= 10_000)
      patch.postsCount24h = o.postsCount24h as number;
    else return 'postsCount24h must be a non-negative integer';
  }
  if ('status' in o) {
    if (o.status === null || o.status === 'awake' || o.status === 'sleeping') patch.status = o.status as AgentSocial['status'];
    else return "status must be 'awake', 'sleeping' or null";
  }
  if ('spender' in o) {
    if (o.spender === null) patch.spender = null;
    else if (typeof o.spender === 'string' && /^0x[0-9a-fA-F]{40}$/.test(o.spender)) patch.spender = o.spender.toLowerCase();
    else return 'spender must be a 20-byte hex address or null';
  }
  if (Object.keys(patch).length === 0) return 'no recognised fields (xHandle, lastPostAt, postsCount24h, status, spender)';
  return patch;
}
