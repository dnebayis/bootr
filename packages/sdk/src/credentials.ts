import { CREDENTIAL_RE, type ConnectTarget } from './own-agent.js';

/**
 * Where a connected AI client keeps its credentials: one file on the creator's machine, readable by its owner only
 * (mode 0600), keyed by site and coin. `BOOTR_CREDENTIALS_FILE` moves it; the default is
 * `~/.config/bootr/credentials.json` (`%APPDATA%\bootr\credentials.json` on Windows).
 *
 * A credential lets its holder post as the coin's agent, so nothing here prints one: errors name the file and the
 * coin, never the secret, and `describeCredential` is the only view meant for a person or a model.
 *
 * Node only. The Node modules are loaded when a function runs, so importing the SDK in a browser stays possible.
 */

export interface StoredCredential {
  /** The bearer secret. Never log it, never show it, never put it in a URL or a tool result. */
  credential: string;
  clientId: string;
  label: string;
  target: ConnectTarget;
  expiresAt: string;
  savedAt: string;
}

export interface CredentialsOptions {
  /** The file to use; else `BOOTR_CREDENTIALS_FILE`, else the default path. */
  file?: string;
  env?: Record<string, string | undefined>;
}

/** Why no credential could be chosen. `code` is stable: `not_connected`, `coin_required`, `credentials_unreadable`. */
export class CredentialsError extends Error {
  override readonly name = 'CredentialsError';
  constructor(
    message: string,
    readonly code: 'not_connected' | 'coin_required' | 'credentials_unreadable',
  ) {
    super(message);
  }
}

type FileShape = { version: 1; sites: Record<string, Record<string, StoredCredential>> };

async function node() {
  const [fs, os, path] = await Promise.all([
    import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:fs/promises'),
    import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:os'),
    import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:path'),
  ]);
  return { fs, os, path };
}

function environment(options: CredentialsOptions): Record<string, string | undefined> {
  return options.env ?? (typeof process === 'undefined' ? {} : process.env);
}

/** The path of the credentials file for these options. */
export async function credentialsFile(options: CredentialsOptions = {}): Promise<string> {
  const { os, path } = await node();
  const env = environment(options);
  const named = options.file ?? env.BOOTR_CREDENTIALS_FILE;
  if (named && named.trim()) return path.resolve(named.trim());
  if (os.platform() === 'win32') return path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'bootr', 'credentials.json');
  return path.join(os.homedir(), '.config', 'bootr', 'credentials.json');
}

/** A site as the file keys it: its origin, so `https://bootr.fun/` and `https://bootr.fun` are one site. */
export function siteKey(siteUrl: string): string {
  return new URL(siteUrl).origin;
}

/** A connection as the file keys it: the coin's treasury address, or the launch draft it was approved for. */
export function coinKey(target: ConnectTarget): string {
  return target.kind === 'coin' ? target.coin.kernel.toLowerCase() : `draft:${target.draftId}`;
}

function validEntry(value: unknown): value is StoredCredential {
  const e = value as Partial<StoredCredential> | null;
  if (!e || typeof e !== 'object' || typeof e.credential !== 'string' || !CREDENTIAL_RE.test(e.credential)) return false;
  if (typeof e.clientId !== 'string' || typeof e.label !== 'string' || typeof e.expiresAt !== 'string') return false;
  const t = e.target as ConnectTarget | undefined;
  if (!t || typeof t !== 'object') return false;
  if (t.kind === 'coin') return !!t.coin && typeof t.coin.kernel === 'string' && typeof t.coin.symbol === 'string';
  return t.kind === 'draft' && typeof t.draftId === 'string';
}

async function load(file: string): Promise<FileShape> {
  const { fs } = await node();
  let text: string;
  try {
    // Tighten a file someone made readable to others before trusting it with anything new.
    const stat = await fs.stat(file);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) await fs.chmod(file, 0o600);
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sites: {} };
    throw new CredentialsError(`The credentials file ${file} could not be read. Check its permissions, or remove it and connect again.`, 'credentials_unreadable');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The text is not repeated: it may hold a credential.
    throw new CredentialsError(`The credentials file ${file} is not valid JSON. Remove it and connect again.`, 'credentials_unreadable');
  }
  const sites: FileShape['sites'] = {};
  const given = (raw as { sites?: unknown } | null)?.sites;
  if (given && typeof given === 'object') {
    for (const [site, entries] of Object.entries(given as Record<string, unknown>)) {
      if (!entries || typeof entries !== 'object') continue;
      const kept = Object.entries(entries as Record<string, unknown>).filter(([, e]) => validEntry(e)) as [string, StoredCredential][];
      if (kept.length) sites[site] = Object.fromEntries(kept);
    }
  }
  return { version: 1, sites };
}

async function store(file: string, data: FileShape): Promise<void> {
  const { fs, path } = await node();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written beside the file with its final mode, then moved over it: a reader never sees half a file or a loose mode.
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
}

/** Every connection this machine holds for a site, secrets included: for code, never for display. */
export async function listCredentials(siteUrl: string, options: CredentialsOptions = {}): Promise<StoredCredential[]> {
  const data = await load(await credentialsFile(options));
  return Object.values(data.sites[siteKey(siteUrl)] ?? {});
}

/** One connection in words safe to show: the coin or the draft, the client's label and id, when it runs out. */
export function describeCredential(entry: StoredCredential): { coin: string; kernel: string | null; draftId: string | null; label: string; clientId: string; expiresAt: string } {
  const { target } = entry;
  return {
    coin: target.kind === 'coin' ? `$${target.coin.symbol}` : 'a launch that has not happened yet',
    kernel: target.kind === 'coin' ? target.coin.kernel : null,
    draftId: target.kind === 'draft' ? target.draftId : null,
    label: entry.label,
    clientId: entry.clientId,
    expiresAt: entry.expiresAt,
  };
}

function matches(entry: StoredCredential, coin: string): boolean {
  const wanted = coin.trim().replace(/^[$#]/, '').toLowerCase();
  if (!wanted) return false;
  const { target } = entry;
  if (target.kind === 'draft') return target.draftId.toLowerCase() === wanted;
  const c = target.coin;
  return [c.symbol, c.kernel, c.token, c.agentId].some((v) => typeof v === 'string' && v.toLowerCase() === wanted);
}

/**
 * The connection to use: the one for `coin` (a symbol, a coin or treasury address, an agent id or a draft id), or the
 * only one when no coin is named. Throws `not_connected` when there is none and `coin_required` when several fit.
 */
export async function findCredential(siteUrl: string, coin?: string, options: CredentialsOptions = {}): Promise<StoredCredential> {
  const all = await listCredentials(siteUrl, options);
  const fit = coin === undefined || coin.trim() === '' ? all : all.filter((e) => matches(e, coin));
  if (fit.length === 1) return fit[0]!;
  const names = all.map((e) => describeCredential(e).coin).join(', ');
  if (fit.length === 0) {
    throw new CredentialsError(
      all.length === 0 ? `This client is not connected to a coin on ${siteKey(siteUrl)}. Connect it first.` : `This client is not connected to that coin. It is connected to: ${names}.`,
      'not_connected',
    );
  }
  throw new CredentialsError(`This client is connected to several coins (${names}). Name the coin.`, 'coin_required');
}

/** Keeps a connection, replacing the one for the same coin on the same site. The file is created with mode 0600. */
export async function saveCredential(siteUrl: string, entry: Omit<StoredCredential, 'savedAt'> & { savedAt?: string }, options: CredentialsOptions = {}): Promise<void> {
  if (!CREDENTIAL_RE.test(entry.credential)) throw new CredentialsError('That is not a Bootr client credential. Nothing was saved.', 'credentials_unreadable');
  const file = await credentialsFile(options);
  const data = await load(file);
  const site = (data.sites[siteKey(siteUrl)] ??= {});
  // A draft's connection becomes the coin's once it is launched: one client, one entry.
  for (const [key, held] of Object.entries(site)) if (held.clientId === entry.clientId) delete site[key];
  site[coinKey(entry.target)] = { ...entry, savedAt: entry.savedAt ?? new Date().toISOString() };
  await store(file, data);
}

/** Forgets one connection. True when there was one to forget. */
export async function removeCredential(siteUrl: string, entry: Pick<StoredCredential, 'clientId'>, options: CredentialsOptions = {}): Promise<boolean> {
  const file = await credentialsFile(options);
  const data = await load(file);
  const site = data.sites[siteKey(siteUrl)];
  const key = site ? Object.keys(site).find((k) => site[k]!.clientId === entry.clientId) : undefined;
  if (!site || !key) return false;
  delete site[key];
  if (Object.keys(site).length === 0) delete data.sites[siteKey(siteUrl)];
  await store(file, data);
  return true;
}
