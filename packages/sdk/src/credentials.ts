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

/** How long a change waits for another program's change to the file to finish. */
const LOCK_WAIT_MS = 5000;
/** A lock older than this was left by a program that died in the middle: a change takes milliseconds. */
const LOCK_STALE_MS = 30_000;

/**
 * One change to the credentials file at a time, over every program on this machine: the MCP server of one AI client,
 * that of another and the `bootr` command all read the file, change it and write it back, and two doing so together
 * would each write the other's change away (a connection saved by one, gone after the other's save). The lock is a
 * file beside the credentials file, made with exclusive create and removed when the change is done. It holds nothing
 * but its own existence.
 */
async function locked<T>(file: string, change: () => Promise<T>): Promise<T> {
  const { fs, path } = await node();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      await (await fs.open(lock, 'wx', 0o600)).close();
      break;
    } catch (err) {
      // Anything but "somebody holds it" (a folder that cannot be written, say) is the caller's to hear.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age = await fs.stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await fs.rm(lock, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new CredentialsError(`The credentials file ${file} is being changed by another program. Try again in a moment.`, 'credentials_unreadable');
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
    }
  }
  try {
    return await change();
  } finally {
    await fs.rm(lock, { force: true });
  }
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

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * Whether a connection that came back approved is for what was asked for. `asked` is what the user named when the
 * request was started: a symbol (with or without `$`), or a coin or treasury address. Nothing named fits any target.
 * A launch that has not happened yet never fits a named coin. With `bound`, the coin the site said the request was
 * for (`ConnectStartResponse.coin`), only that very coin fits: a symbol alone can belong to several coins.
 *
 * A client must check this before it keeps a credential: an approval page is where a person can be talked into
 * approving for another coin than the one the client was asked to connect.
 */
export function targetMatches(asked: string | undefined, target: ConnectTarget, bound?: { kernel?: unknown } | null): boolean {
  const kernel = target.kind === 'coin' && typeof target.coin?.kernel === 'string' ? target.coin.kernel.toLowerCase() : null;
  if (bound && typeof bound.kernel === 'string') return kernel !== null && kernel === bound.kernel.toLowerCase();
  const wanted = (asked ?? '').trim().replace(/^\$/, '').toLowerCase();
  if (!wanted) return true;
  if (target.kind !== 'coin' || kernel === null) return false;
  if (ADDRESS_RE.test(wanted)) return kernel === wanted || String(target.coin.token ?? '').toLowerCase() === wanted;
  return String(target.coin.symbol ?? '').toLowerCase() === wanted;
}

/**
 * A connection's coin in words that tell it from every other coin: its symbol and its treasury address (symbols are
 * not unique). Only letters, digits and `_` of the symbol and a well-formed address are shown, whatever was stored.
 */
export function coinLine(target: ConnectTarget): string {
  if (target.kind !== 'coin') return 'a launch that has not happened yet';
  const symbol = String(target.coin?.symbol ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || '?';
  const kernel = String(target.coin?.kernel ?? '');
  return `$${symbol} (treasury address ${/^0x[0-9a-fA-F]{40}$/.test(kernel) ? kernel : 'unknown'})`;
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
  // Read, change and written back under the file's lock, so another program's save in the same moment is not lost.
  await locked(file, async () => {
    const data = await load(file);
    const site = (data.sites[siteKey(siteUrl)] ??= {});
    // A draft's connection becomes the coin's once it is launched: one client, one entry.
    for (const [key, held] of Object.entries(site)) if (held.clientId === entry.clientId) delete site[key];
    // Only the fields of an entry are kept, whatever else the object carried (the token answer has a `status` too).
    const { credential, clientId, label, target, expiresAt } = entry;
    site[coinKey(target)] = { credential, clientId, label, target, expiresAt, savedAt: entry.savedAt ?? new Date().toISOString() };
    await store(file, data);
  });
}

/** Forgets one connection. True when there was one to forget. */
export async function removeCredential(siteUrl: string, entry: Pick<StoredCredential, 'clientId'>, options: CredentialsOptions = {}): Promise<boolean> {
  const file = await credentialsFile(options);
  // Nothing to forget where there is no file: no lock, and no folder made, for a look that changes nothing.
  const { fs } = await node();
  if (!(await fs.stat(file).then(() => true, () => false))) return false;
  return locked(file, async () => {
    const data = await load(file);
    const site = data.sites[siteKey(siteUrl)];
    const key = site ? Object.keys(site).find((k) => site[k]!.clientId === entry.clientId) : undefined;
    if (!site || !key) return false;
    delete site[key];
    if (Object.keys(site).length === 0) delete data.sites[siteKey(siteUrl)];
    await store(file, data);
    return true;
  });
}
